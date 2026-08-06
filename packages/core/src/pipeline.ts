import { basename, resolve } from 'node:path';

import { discoverFiles } from './analysis/discovery';
import { detectFrameworks } from './analysis/framework-detector';
import { buildImportGraph } from './analysis/import-graph';
import { detectEntryPoints, prioritizeFiles } from './analysis/prioritizer';
import { buildSymbolIndex } from './analysis/symbol-indexer';
import { SummaryCache } from './cache/sqlite-cache';
import {
  PIPELINE_ABSOLUTE_TIMEOUT_MS,
  PIPELINE_DEFAULT_MAX_FILES,
  PIPELINE_GITHUB_URL_WITH_CAPTURES,
  PIPELINE_STALL_TIMEOUT_MS,
  PIPELINE_WATCHDOG_INTERVAL_MS,
} from './constants';
import { summarizeFiles } from './documentation/summarizer';
import { synthesize } from './documentation/synthesizer';
import { cloneRepo } from './ingestion/clone';
import { ingestLocal } from './ingestion/local';
import { cleanupSandbox, createSandbox } from './ingestion/sandbox-manager';
import { heartbeatBus } from './llm/heartbeat-bus';
import { createProviderChain } from './llm/provider';
import { buildRateLimitersForProviders } from './llm/rate-limiter';
import { RepoInputSchema } from './schemas';
import type { AuditEntry, FileSummary, HeartbeatEvent, PipelineOptions, PipelineResult, RepoInput, RepoMeta } from './types';

export type { PipelineOptions, PipelineResult } from './types';

function pushAudit(auditLog: AuditEntry[], stage: string, action: string, detail: string): void {
  auditLog.push({ timestamp: Date.now(), stage, action, detail });
}

function deriveRepoIdentity(input: RepoInput): { name: string; identifier: string } {
  if (input.type === 'github') {
    const match = PIPELINE_GITHUB_URL_WITH_CAPTURES.exec(input.url ?? '');

    if (match === null) {
      throw new Error(`Invalid GitHub repository URL: ${input.url}`);
    }

    const [, owner, repo] = match;

    if (owner === undefined || repo === undefined) {
      throw new Error(`Invalid GitHub repository URL: ${input.url}`);
    }

    return { name: repo, identifier: `${owner}/${repo}` };
  }

  const resolvedPath = resolve(input.path ?? '');

  return { name: basename(resolvedPath), identifier: resolvedPath };
}

async function executePipeline(
  input: RepoInput,
  options: PipelineOptions,
  auditLog: AuditEntry[],
  startedAt: number,
  onSandboxCreated: (sandboxPath: string) => void,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const maxFiles = options.maxFiles ?? PIPELINE_DEFAULT_MAX_FILES;

  options.onProgress?.('validate', 'Validating repository input');
  const validatedInput = RepoInputSchema.parse(input);

  pushAudit(auditLog, 'validation', 'complete', 'Repository input validated');

  options.onProgress?.('sandbox', 'Creating sandbox directory');
  const sandboxPath = createSandbox();

  onSandboxCreated(sandboxPath);
  pushAudit(auditLog, 'sandbox', 'complete', `Sandbox created at ${sandboxPath}`);

  options.onProgress?.(
    'ingest',
    validatedInput.type === 'github' ? `Cloning ${validatedInput.url}` : `Copying local path ${validatedInput.path}`,
  );

  const { commitHash } =
    validatedInput.type === 'github'
      ? await cloneRepo(validatedInput.url!, validatedInput.pat, sandboxPath)
      : await ingestLocal(validatedInput.path!, sandboxPath);

  pushAudit(auditLog, 'ingestion', 'complete', `Ingested repository at commit ${commitHash}`);

  options.onProgress?.('frameworks', 'Detecting frameworks and monorepo structure');
  const frameworkProfile = detectFrameworks(sandboxPath);

  pushAudit(
    auditLog,
    'framework-detection',
    'complete',
    `Detected frameworks: ${frameworkProfile.frameworks.join(', ') || 'none'} (monorepo: ${frameworkProfile.monorepoType})`,
  );

  options.onProgress?.('discovery', 'Discovering files');
  const { files, contentCache } = discoverFiles(sandboxPath, auditLog);

  options.onProgress?.('indexing', 'Building import graph and symbol index');
  const importGraph = buildImportGraph(files, contentCache);
  const symbolIndex = buildSymbolIndex(files, contentCache);

  pushAudit(
    auditLog,
    'indexing',
    'complete',
    `Indexed ${symbolIndex.size} unique symbols across ${files.length} files`,
  );

  options.onProgress?.('prioritization', 'Detecting entry points and prioritizing files');
  const entryPoints = detectEntryPoints(files, contentCache, frameworkProfile.subProjects);

  for (const subProject of frameworkProfile.subProjects) {
    subProject.entryPoints = entryPoints.bySubProject.get(subProject.rootRelativePath) ?? [];
  }

  const prioritized = prioritizeFiles(files, importGraph, entryPoints.global, auditLog, maxFiles);

  const repoIdentity = deriveRepoIdentity(validatedInput);
  const repoMeta: RepoMeta = {
    name: repoIdentity.name,
    identifier: repoIdentity.identifier,
    commitHash,
    rootPath: sandboxPath,
    frameworks: frameworkProfile.frameworks,
    isMonorepo: frameworkProfile.isMonorepo,
    monorepoType: frameworkProfile.monorepoType,
    workspaceDirs: frameworkProfile.workspaceDirs,
    packageManager: frameworkProfile.packageManager,
    subProjects: frameworkProfile.subProjects,
  };

  options.onProgress?.('summarization', 'Summarizing files');
  const cache = new SummaryCache(options.skipCache === true ? ':memory:' : undefined);

  cache.initialize();

  const summarizerProviders = createProviderChain({
    groqApiKeyEnvVar: 'GROQ_SUMMARIZER_API_KEY',
    groqModel: 'llama-3.1-8b-instant',
    // High-volume, simple structured-JSON extraction per file/batch — the
    // smallest/fastest free model in the shortlist keeps pace with the
    // per-file loop without needing deep reasoning.
    openrouterModel: 'google/gemma-4-26b-a4b-it:free',
  });
  const summarizerRateLimiters = buildRateLimitersForProviders(summarizerProviders);

  let summaries: FileSummary[];
  let failedFiles: string[];
  const summarizationStartedAt = Date.now();

  try {
    const result = await summarizeFiles(
      prioritized,
      contentCache,
      repoMeta,
      summarizerProviders,
      summarizerRateLimiters,
      cache,
      auditLog,
      (completed, total) => {
        const elapsedS = Math.round((Date.now() - summarizationStartedAt) / 1000);
        const etaS = completed > 0 ? Math.round((elapsedS / completed) * (total - completed)) : undefined;
        const etaSuffix = etaS !== undefined && etaS > 0 && completed < total ? `, ~${etaS}s remaining` : '';

        options.onProgress?.('summarization', `${completed}/${total} files summarized (${elapsedS}s elapsed${etaSuffix})`);
      },
      signal,
    );

    summaries = result.summaries;
    failedFiles = result.failedFiles;
  } finally {
    cache.close();
  }

  if (failedFiles.length > 0) {
    pushAudit(
      auditLog,
      'summarization',
      'partial_failure',
      `${failedFiles.length} file(s) could not be summarized and fell back to a placeholder — run continues (not a pipeline failure): ${failedFiles.join(', ')}`,
    );
  }

  options.onProgress?.('synthesis', 'Synthesizing README/ARCHITECTURE/ONBOARDING');
  const synthesizerProviders = createProviderChain({
    groqApiKeyEnvVar: 'GROQ_SYNTHESIZER_API_KEY',
    groqModel: 'llama-3.3-70b-versatile',
    // Long-form structured document generation (README/ARCHITECTURE/
    // ONBOARDING) needs solid instruction-following and coherence — a
    // capable general-purpose model, not the smallest one in the shortlist.
    openrouterModel: 'openai/gpt-oss-20b:free',
  });
  const synthesizerRateLimiters = buildRateLimitersForProviders(synthesizerProviders);
  const synthesis = await synthesize(
    summaries,
    repoMeta,
    files,
    symbolIndex,
    synthesizerProviders,
    synthesizerRateLimiters,
    auditLog,
    options.onProgress,
    signal,
  );

  const durationMs = Date.now() - startedAt;

  return { meta: repoMeta, summaries, synthesis, symbolIndex, auditLog, sandboxPath, durationMs, failedFiles };
}

// "Taking a long time" and "actually failed" are deliberately different: a
// stall watchdog replaces a flat wall-clock kill-timeout. Progress is
// signaled via an `onProgress` stage transition and via a bare liveness pulse
// on the shared `heartbeatBus` (for waits, like a rate limiter's poll loop,
// that have no `onProgress` callback to reach) — either counts as "not
// stalled." Only a genuine stall (no pulse of either kind for
// PIPELINE_STALL_TIMEOUT_MS) or the absolute safety net aborts the run.
export class PipelineWatchdog {
  private lastPulseAt: number;
  private readonly listener: (event: HeartbeatEvent) => void;

  constructor() {
    this.lastPulseAt = Date.now();

    this.listener = (): void => {
      this.lastPulseAt = Date.now();
    };

    heartbeatBus.on('pulse', this.listener);
  }

  // For stages that don't go through a rate limiter (discovery, parsing,
  // scoring) and so never emit a heartbeatBus pulse of their own — call this
  // at a stage boundary to register the same kind of liveness signal.
  touch(source: string, detail?: string): void {
    heartbeatBus.pulse(source, detail);
  }

  msSinceLastPulse(): number {
    return Date.now() - this.lastPulseAt;
  }

  dispose(): void {
    heartbeatBus.off('pulse', this.listener);
  }
}

export async function runPipeline(input: RepoInput, options: PipelineOptions = {}): Promise<PipelineResult> {
  const startedAt = Date.now();
  const auditLog: AuditEntry[] = [];
  let sandboxPath: string | undefined;

  const watchdog = new PipelineWatchdog();

  const wrappedOnProgress = (stage: string, detail?: string): void => {
    watchdog.touch(stage, detail);
    options.onProgress?.(stage, detail);
  };

  const abortController = new AbortController();

  const watchdogId = setInterval(() => {
    const now = Date.now();
    const sinceProgress = watchdog.msSinceLastPulse();
    const sinceStart = now - startedAt;

    if (sinceProgress >= PIPELINE_STALL_TIMEOUT_MS) {
      abortController.abort(
        new Error(`Pipeline stalled — no progress for ${Math.round(sinceProgress / 1000)}s (treating as stuck, not slow)`),
      );
    } else if (sinceStart >= PIPELINE_ABSOLUTE_TIMEOUT_MS) {
      abortController.abort(
        new Error(`Pipeline exceeded the absolute safety-net duration of ${Math.round(PIPELINE_ABSOLUTE_TIMEOUT_MS / 1000)}s`),
      );
    }
  }, PIPELINE_WATCHDOG_INTERVAL_MS);

  try {
    return await Promise.race([
      executePipeline(
        input,
        { ...options, onProgress: wrappedOnProgress },
        auditLog,
        startedAt,
        (createdSandboxPath) => {
          sandboxPath = createdSandboxPath;
        },
        abortController.signal,
      ),
      new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener('abort', () => {
          const { reason } = abortController.signal;

          reject(reason instanceof Error ? reason : new Error('Pipeline aborted'));
        });
      }),
    ]);
  } catch (err) {
    if (sandboxPath !== undefined) {
      await cleanupSandbox(sandboxPath);
    }

    throw err instanceof Error ? err : new Error(`Pipeline failed: ${String(err)}`);
  } finally {
    clearInterval(watchdogId);
    watchdog.dispose();
  }
}
