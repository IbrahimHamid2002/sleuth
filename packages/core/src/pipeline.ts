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
}

const DEFAULT_MAX_FILES = 150;
const PIPELINE_TIMEOUT_MS = 5 * 60 * 1000;

// Conservative free-tier RPM ceilings — under-provisioning just slows the run,
// while guessing too high risks 429s the retry budget in provider.ts can't absorb.
const GROQ_FREE_TIER_RPM = 30;
const GEMINI_FREE_TIER_RPM = 15;

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

  const summarizerProviders = createProviderChain('summarizer');
  const summarizerRateLimiters = buildRateLimiters(summarizerProviders);

  let summaries: FileSummary[];

  try {
    summaries = await summarizeFiles(
      prioritized,
      contentCache,
      repoMeta,
      summarizerProviders,
      summarizerRateLimiters,
      cache,
      auditLog,
      (completed, total) => options.onProgress?.('summarization', `${completed}/${total} files summarized`),
    );
  } finally {
    cache.close();
  }

  options.onProgress?.('synthesis', 'Synthesizing README/ARCHITECTURE/ONBOARDING');
  const synthesizerProviders = createProviderChain('synthesizer');
  const synthesizerRateLimiters = buildRateLimiters(synthesizerProviders);
  const synthesis = await synthesize(summaries, repoMeta, symbolIndex, synthesizerProviders, synthesizerRateLimiters, auditLog);

  const durationMs = Date.now() - startedAt;

  return { meta: repoMeta, summaries, synthesis, symbolIndex, auditLog, sandboxPath, durationMs };
}

export async function runPipeline(input: RepoInput, options: PipelineOptions = {}): Promise<PipelineResult> {
  const startedAt = Date.now();
  const auditLog: AuditEntry[] = [];
  let sandboxPath: string | undefined;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), PIPELINE_TIMEOUT_MS);

  try {
    return await Promise.race([
      executePipeline(input, options, auditLog, startedAt, (createdSandboxPath) => {
        sandboxPath = createdSandboxPath;
      }),
      new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener('abort', () =>
          reject(new Error(`Pipeline exceeded ${PIPELINE_TIMEOUT_MS}ms timeout`)),
        );
      }),
    ]);
  } catch (err) {
    if (sandboxPath !== undefined) {
      await cleanupSandbox(sandboxPath);
    }

    throw err instanceof Error ? err : new Error(`Pipeline failed: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
