import { basename, resolve } from 'node:path';

import { discoverFiles } from './analysis/discovery';
import { detectFrameworks } from './analysis/framework-detector';
import { buildImportGraph } from './analysis/import-graph';
import { detectEntryPoints, prioritizeFiles } from './analysis/prioritizer';
import { buildSymbolIndex } from './analysis/symbol-indexer';
import { SummaryCache } from './cache/sqlite-cache';
import { summarizeFiles } from './documentation/summarizer';
import { synthesize } from './documentation/synthesizer';
import { cloneRepo } from './ingestion/clone';
import { ingestLocal } from './ingestion/local';
import { cleanupSandbox, createSandbox } from './ingestion/sandbox-manager';
import type { LLMProvider } from './llm/provider';
import { createProviderChain } from './llm/provider';
import { TokenBucketRateLimiter } from './llm/rate-limiter';
import { RepoInputSchema } from './schemas';
import type { AuditEntry, FileSummary, RepoInput, RepoMeta, SynthesisResult } from './types';

export interface PipelineOptions {
  maxFiles?: number;
  skipCache?: boolean;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface PipelineResult {
  meta: RepoMeta;
  summaries: FileSummary[];
  synthesis: SynthesisResult;
  symbolIndex: Map<string, Array<{ path: string; line: number }>>;
  auditLog: AuditEntry[];
  sandboxPath: string;
  durationMs: number;
  // Files whose LLM summarization failed after retries (fell back to a
  // placeholder summary) — a non-empty list is a partial-success signal, not
  // a pipeline failure: see the stall-watchdog comment on runPipeline below
  // for why "took a while" and "failed" are deliberately different things now.
  failedFiles: string[];
}

const DEFAULT_MAX_FILES = 150;
// No progress at all (no stage transition, no file/doc completing) for this
// long is treated as genuinely stuck and aborted. Duration alone — a big repo
// legitimately taking a while — must never trip this on its own; every stage
// below touches the watchdog as it makes real, verifiable progress.
const STALL_TIMEOUT_MS = 90 * 1000;
// Final safety net regardless of how much (slow-but-real) progress is
// happening — catches a pathological case where something keeps touching
// progress just often enough to dodge the stall watchdog without actually
// finishing. Deliberately generous: large repos are expected to legitimately
// take minutes now that summarization runs in parallel and per-call waits are
// capped (see provider.ts's MAX_SINGLE_RATE_LIMIT_WAIT_MS).
const ABSOLUTE_TIMEOUT_MS = 30 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 5 * 1000;

// Conservative free-tier RPM ceilings — under-provisioning just slows the run,
// while guessing too high risks 429s the retry budget in provider.ts can't absorb.
// Kept a couple RPM below the actual free-tier ceiling as a safety buffer so we
// never pace requests right up against the real limit.
const GROQ_FREE_TIER_RPM = 28;
const GEMINI_FREE_TIER_RPM = 13;

const GITHUB_URL_WITH_CAPTURES = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

function pushAudit(auditLog: AuditEntry[], stage: string, action: string, detail: string): void {
  auditLog.push({ timestamp: Date.now(), stage, action, detail });
}

function deriveRepoIdentity(input: RepoInput): { name: string; identifier: string } {
  if (input.type === 'github') {
    const match = GITHUB_URL_WITH_CAPTURES.exec(input.url ?? '');

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

function buildRateLimiters(providers: LLMProvider[]): Map<string, TokenBucketRateLimiter> {
  const rateLimiters = new Map<string, TokenBucketRateLimiter>();

  for (const provider of providers) {
    const requestsPerMinute = provider.name === 'groq' ? GROQ_FREE_TIER_RPM : GEMINI_FREE_TIER_RPM;

    rateLimiters.set(provider.name, new TokenBucketRateLimiter(requestsPerMinute, requestsPerMinute / 60));
  }

  return rateLimiters;
}

async function executePipeline(
  input: RepoInput,
  options: PipelineOptions,
  auditLog: AuditEntry[],
  startedAt: number,
  onSandboxCreated: (sandboxPath: string) => void,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

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
  const summarizerRateLimiters = buildRateLimiters(summarizerProviders);

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
  const synthesizerRateLimiters = buildRateLimiters(synthesizerProviders);
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

// "Taking a long time" and "actually failed" are deliberately different
// events: a stall watchdog replaces the old flat wall-clock kill-timeout.
// Every stage of executePipeline below touches `lastProgressAt` (via the
// wrapped onProgress) as it makes real, verifiable progress — a stage
// transition, a completed summarization batch, a doc finishing synthesis.
// Only a genuine STALL (no progress at all for STALL_TIMEOUT_MS) or the
// generous ABSOLUTE_TIMEOUT_MS safety net aborts the run; duration alone
// never does. Genuine errors (bad auth, repo not found, invalid input) still
// throw immediately from inside executePipeline, unaffected by any of this.
export async function runPipeline(input: RepoInput, options: PipelineOptions = {}): Promise<PipelineResult> {
  const startedAt = Date.now();
  const auditLog: AuditEntry[] = [];
  let sandboxPath: string | undefined;
  let lastProgressAt = startedAt;

  const touchProgress = (): void => {
    lastProgressAt = Date.now();
  };

  const wrappedOnProgress = (stage: string, detail?: string): void => {
    touchProgress();
    options.onProgress?.(stage, detail);
  };

  const abortController = new AbortController();

  const watchdogId = setInterval(() => {
    const now = Date.now();
    const sinceProgress = now - lastProgressAt;
    const sinceStart = now - startedAt;

    if (sinceProgress >= STALL_TIMEOUT_MS) {
      abortController.abort(
        new Error(`Pipeline stalled — no progress for ${Math.round(sinceProgress / 1000)}s (treating as stuck, not slow)`),
      );
    } else if (sinceStart >= ABSOLUTE_TIMEOUT_MS) {
      abortController.abort(
        new Error(`Pipeline exceeded the absolute safety-net duration of ${Math.round(ABSOLUTE_TIMEOUT_MS / 1000)}s`),
      );
    }
  }, WATCHDOG_INTERVAL_MS);

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
  }
}
