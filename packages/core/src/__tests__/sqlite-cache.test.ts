import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SummaryCache } from '../cache/sqlite-cache';
import type { FileSummary } from '../types';

const SAMPLE_SUMMARY: FileSummary = {
  path: 'src/foo.ts',
  purpose: 'Does foo things',
  exports: ['foo'],
  dependencies: ['bar'],
  summary: 'A short summary of foo.ts',
};

describe('SummaryCache', () => {
  let cache: SummaryCache;

  beforeEach(() => {
    cache = new SummaryCache(':memory:');
    cache.initialize();
  });

  afterEach(() => {
    cache.close();
  });

  it('returns the same summary that was set', () => {
    const key = cache.buildKey('repo-1', 'commit-1', 'src/foo.ts', cache.hashContent('foo content'), 'v1');

    cache.set(key, 'src/foo.ts', cache.hashContent('foo content'), SAMPLE_SUMMARY);

    expect(cache.get(key)).toEqual(SAMPLE_SUMMARY);
  });

  it('returns null and increments misses for a non-existent key', () => {
    cache.resetStats();

    expect(cache.get('does-not-exist')).toBeNull();
    expect(cache.getStats()).toEqual({ hits: 0, misses: 1 });
  });

  it('returns null for an entry older than 7 days without deleting the row', () => {
    const key = cache.buildKey('repo-1', 'commit-1', 'src/stale.ts', 'content-hash', 'v1');
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;

    cache.set(key, 'src/stale.ts', 'content-hash', SAMPLE_SUMMARY);

    const internal = cache as unknown as { db: Database.Database };

    internal.db.prepare('UPDATE summaries SET created_at = ? WHERE cache_key = ?').run(eightDaysAgoMs, key);

    expect(cache.get(key)).toBeNull();
  });

  it('produces a deterministic key for identical inputs', () => {
    const keyA = cache.buildKey('repo-1', 'commit-1', 'src/foo.ts', 'hash-1', 'v1');
    const keyB = cache.buildKey('repo-1', 'commit-1', 'src/foo.ts', 'hash-1', 'v1');

    expect(keyA).toBe(keyB);
  });

  it('produces a different content hash when content changes', () => {
    expect(cache.hashContent('content A')).not.toBe(cache.hashContent('content B'));
  });
});
