import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { SUMMARY_CACHE_TTL_MS } from '../constants';
import type { FileSummary, SummaryRow } from '../types';

export class SummaryCache {
  private readonly db: Database.Database;
  private hits = 0;
  private misses = 0;

  constructor(dbPath: string = join(homedir(), '.sleuth', 'cache.sqlite')) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        cache_key      TEXT PRIMARY KEY,
        file_path      TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        summary_json   TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_path ON summaries(file_path);
    `);
  }

  buildKey(repoId: string, commitHash: string, filePath: string, contentHash: string, promptVersion: string): string {
    return createHash('sha256')
      .update([repoId, commitHash, filePath, contentHash, promptVersion].join(':'))
      .digest('hex');
  }

  hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  get(key: string): FileSummary | null {
    const row = this.db
      .prepare<[string], SummaryRow>('SELECT summary_json, created_at FROM summaries WHERE cache_key = ?')
      .get(key);

    if (row === undefined || Date.now() - row.created_at >= SUMMARY_CACHE_TTL_MS) {
      this.misses += 1;

      return null;
    }

    this.hits += 1;

    return JSON.parse(row.summary_json) as FileSummary;
  }

  set(key: string, filePath: string, contentHash: string, summary: FileSummary): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO summaries (cache_key, file_path, content_hash, summary_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(key, filePath, contentHash, JSON.stringify(summary), Date.now());
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  close(): void {
    this.db.close();
  }
}
