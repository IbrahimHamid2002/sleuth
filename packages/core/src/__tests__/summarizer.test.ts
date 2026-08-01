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

    expect(first).toEqual([summaryFor('src/a.ts')]);
    expect(callWithFallback).toHaveBeenCalledTimes(1);

    callWithFallback.mockClear();

    const second = await summarizeFiles(files, contentCache, REPO_META, NO_PROVIDERS, NO_RATE_LIMITERS, cache, auditLog);

    expect(second).toEqual([summaryFor('src/a.ts')]);
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

    expect(result).toEqual([
      { path: 'src/a.ts', purpose: 'Could not summarize', exports: [], dependencies: [], summary: 'Parse error' },
      { path: 'src/b.ts', purpose: 'Could not summarize', exports: [], dependencies: [], summary: 'Parse error' },
    ]);
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

    expect(result[0]).toEqual(summaryFor('src/a.ts'));
    expect(result[1]).toEqual({
      path: 'src/b.ts',
      purpose: 'Could not summarize',
      exports: [],
      dependencies: [],
      summary: 'Parse error',
    });
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

    // 7 files -> batches of 5 and 2 -> two onProgress calls.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 5, 7);
    expect(onProgress).toHaveBeenNthCalledWith(2, 7, 7);
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
