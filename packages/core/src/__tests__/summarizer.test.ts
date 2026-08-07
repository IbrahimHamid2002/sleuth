import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryCache } from '../cache/sqlite-cache';
import { summarizeFiles } from '../documentation/summarizer';
import * as providerModule from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import type { AuditEntry, FileNode, FileSummary, RepoMeta } from '../types';

vi.mock('../llm/provider', async () => {
  const actual = await vi.importActual<typeof providerModule>('../llm/provider');

  return { ...actual, callWithFallback: vi.fn() };
});

const callWithFallback = vi.mocked(providerModule.callWithFallback);

const REPO_META: RepoMeta = {
  name: 'demo-repo',
  identifier: 'demo-repo',
  commitHash: 'abc123',
  rootPath: '/tmp/demo-repo',
  frameworks: [],
  isMonorepo: false,
  monorepoType: 'none',
  workspaceDirs: [],
  packageManager: 'npm',
  subProjects: [],
};

const NO_PROVIDERS = [{ name: 'stub', complete: vi.fn() }];
const NO_RATE_LIMITERS = new Map<string, TokenBucketRateLimiter>();

function makeFile(path: string, size = 10): FileNode {
  return { path, type: 'file', size };
}

function summaryFor(path: string): FileSummary {
  return {
    path,
    purpose: `purpose for ${path}`,
    exports: ['thing'],
    dependencies: [],
    summary: `summary for ${path}`,
  };
}

describe('summarizeFiles', () => {
  let cache: SummaryCache;
  let auditLog: AuditEntry[];

  beforeEach(() => {
    cache = new SummaryCache(':memory:');
    cache.initialize();
    auditLog = [];
    callWithFallback.mockReset();
  });

  it('produces zero LLM calls on a second run for cached files', async () => {
    const contentCache = new Map([['src/a.ts', 'export const a = 1;']]);
    const files = [makeFile('src/a.ts')];

    callWithFallback.mockResolvedValue(JSON.stringify([summaryFor('src/a.ts')]));

    const first = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(first.summaries).toEqual([summaryFor('src/a.ts')]);
    expect(first.failedFiles).toEqual([]);
    expect(callWithFallback).toHaveBeenCalledTimes(1);

    callWithFallback.mockClear();

    const second = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(second.summaries).toEqual([summaryFor('src/a.ts')]);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('substitutes per-file fallback summaries when the LLM response is malformed JSON, without throwing', async () => {
    const contentCache = new Map([
      ['src/a.ts', 'export const a = 1;'],
      ['src/b.ts', 'export const b = 2;'],
    ]);
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    callWithFallback.mockResolvedValue('this is not valid json at all {{{');

    const result = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(result.summaries).toEqual([
      { path: 'src/a.ts', purpose: 'Could not summarize', exports: [], dependencies: [], summary: 'Parse error' },
      { path: 'src/b.ts', purpose: 'Could not summarize', exports: [], dependencies: [], summary: 'Parse error' },
    ]);
    expect(result.failedFiles.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('falls back only for elements that individually fail schema validation', async () => {
    const contentCache = new Map([
      ['src/a.ts', 'export const a = 1;'],
      ['src/b.ts', 'export const b = 2;'],
    ]);
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    callWithFallback.mockResolvedValue(
      JSON.stringify([summaryFor('src/a.ts'), { path: 'src/b.ts', purpose: 123, exports: [], dependencies: [], summary: 'x' }]),
    );

    const result = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(result.summaries[0]).toEqual(summaryFor('src/a.ts'));
    expect(result.summaries[1]).toEqual({
      path: 'src/b.ts',
      purpose: 'Could not summarize',
      exports: [],
      dependencies: [],
      summary: 'Parse error',
    });
    expect(result.failedFiles).toEqual(['src/b.ts']);
  });

  it('groups files into batches of at most 5 files or 6000 combined characters', async () => {
    const contentCache = new Map<string, string>();
    const files: FileNode[] = [];

    // 6 small files -> should split into two batches by the 5-file cap (5 + 1).
    for (let i = 0; i < 6; i += 1) {
      const path = `src/small-${i}.ts`;

      contentCache.set(path, 'x'.repeat(100));
      files.push(makeFile(path));
    }

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      return JSON.stringify(paths.map((path) => summaryFor(path)));
    });

    await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(callWithFallback).toHaveBeenCalledTimes(2);

    const firstBatchPrompt = callWithFallback.mock.calls[0][1] as string;
    const secondBatchPrompt = callWithFallback.mock.calls[1][1] as string;
    const firstBatchFileCount = [...firstBatchPrompt.matchAll(/--- FILE: /g)].length;
    const secondBatchFileCount = [...secondBatchPrompt.matchAll(/--- FILE: /g)].length;

    expect(firstBatchFileCount).toBe(5);
    expect(secondBatchFileCount).toBe(1);
  });

  it('starts a new batch when the combined character limit would be exceeded, even under the file-count cap', async () => {
    const contentCache = new Map<string, string>([
      ['src/big-1.ts', 'x'.repeat(4000)],
      ['src/big-2.ts', 'y'.repeat(4000)],
    ]);
    const files = [makeFile('src/big-1.ts'), makeFile('src/big-2.ts')];

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      return JSON.stringify(paths.map((path) => summaryFor(path)));
    });

    await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(callWithFallback).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress once per batch with a running completed count', async () => {
    const contentCache = new Map<string, string>();
    const files: FileNode[] = [];

    for (let i = 0; i < 7; i += 1) {
      const path = `src/f-${i}.ts`;

      contentCache.set(path, 'z'.repeat(50));
      files.push(makeFile(path));
    }

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      return JSON.stringify(paths.map((path) => summaryFor(path)));
    });

    const onProgress = vi.fn();

    await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog, onProgress);

    // 7 files -> batches of 5 and 2 -> two onProgress calls. Batches now run
    // concurrently (see MAX_CONCURRENT_BATCHES), so assert the set of
    // "completed" values reported rather than a strict call order — order
    // isn't a contract once batches can finish out of sequence.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map(([completed]) => completed).sort((a, b) => a - b)).toEqual([5, 7]);
    expect(onProgress.mock.calls.every(([, total]) => total === 7)).toBe(true);
  });

  it('processes more batches than MAX_CONCURRENT_BATCHES without dropping any', async () => {
    const contentCache = new Map<string, string>();
    const files: FileNode[] = [];

    // 40 files at 5/batch -> 8 batches, more than the concurrency cap (6).
    for (let i = 0; i < 40; i += 1) {
      const path = `src/many-${i}.ts`;

      contentCache.set(path, 'w'.repeat(10));
      files.push(makeFile(path));
    }

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      return JSON.stringify(paths.map((path) => summaryFor(path)));
    });

    const result = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(callWithFallback).toHaveBeenCalledTimes(8);
    expect(result.summaries).toHaveLength(40);
    expect(result.failedFiles).toEqual([]);
    expect(result.summaries.every((summary) => summary.purpose !== 'Could not summarize')).toBe(true);
  });

  it('isolates a failed batch from other, unrelated batches — only the failed batch falls back', async () => {
    const contentCache = new Map<string, string>();
    const files: FileNode[] = [];

    // 10 files at 5/batch -> exactly 2 batches; fail only the first.
    for (let i = 0; i < 10; i += 1) {
      const path = `src/iso-${i}.ts`;

      contentCache.set(path, 'v'.repeat(10));
      files.push(makeFile(path));
    }

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      if (paths.some((path) => path.startsWith('src/iso-0') || path === 'src/iso-1.ts')) {
        throw new Error('simulated exhausted-retries failure for this batch');
      }

      return JSON.stringify(paths.map((path) => summaryFor(path)));
    });

    const result = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    const failedPaths = new Set(result.failedFiles);
    const okSummaries = result.summaries.filter((summary) => !failedPaths.has(summary.path));

    expect(result.failedFiles.length).toBeGreaterThan(0);
    expect(result.failedFiles.length).toBeLessThan(10);
    expect(okSummaries.every((summary) => summary.purpose !== 'Could not summarize')).toBe(true);

    const fallbackDetail = auditLog.find((entry) => entry.action === 'file_fallback');

    expect(fallbackDetail?.detail).toContain('batch call failed');
  });

  it('treats an already-aborted signal as a per-file failure instead of hanging or throwing', async () => {
    const contentCache = new Map([['src/a.ts', 'export const a = 1;']]);
    const files = [makeFile('src/a.ts')];
    const controller = new AbortController();

    controller.abort();

    const result = await summarizeFiles(
      files,
      contentCache,
      REPO_META,
      NO_PROVIDERS,
      NO_RATE_LIMITERS,
      cache,
      auditLog,
      undefined,
      controller.signal,
    );

    expect(result.failedFiles).toEqual(['src/a.ts']);
    expect(result.summaries[0]).toEqual({
      path: 'src/a.ts',
      purpose: 'Could not summarize',
      exports: [],
      dependencies: [],
      summary: 'Parse error',
    });
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('logs the final cache hit rate to the audit log', async () => {
    const contentCache = new Map([
      ['src/a.ts', 'export const a = 1;'],
      ['src/b.ts', 'export const b = 2;'],
    ]);
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    callWithFallback.mockResolvedValue(JSON.stringify([summaryFor('src/a.ts'), summaryFor('src/b.ts')]));

    await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);
    callWithFallback.mockClear();
    await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    const summaryEntries = auditLog.filter((entry) => entry.stage === 'summarization');

    expect(summaryEntries).toHaveLength(2);
    expect(summaryEntries[1].detail).toContain('2/2 files served from cache');
  });
});
