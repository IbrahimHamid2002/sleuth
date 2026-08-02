import { randomUUID } from 'node:crypto';

import { cleanupSandbox } from '../ingestion/sandbox-manager';
import type { DeepDiveSession, FileSummary, RepoMeta } from '../types';

export function createSession(repoMeta: RepoMeta, sandboxPath: string, summaries: FileSummary[]): DeepDiveSession {
  const summariesMap = new Map<string, FileSummary>(summaries.map((summary) => [summary.path, summary]));
  const now = Date.now();

  return {
    sessionId: randomUUID(),
    repoMeta,
    sandboxPath,
    summariesMap,
    visitedFiles: new Map<string, string>(),
    createdAt: now,
    lastActivityAt: now,
  };
}

export function touchSession(session: DeepDiveSession): void {
  session.lastActivityAt = Date.now();
}

export async function terminateSession(session: DeepDiveSession): Promise<void> {
  session.summariesMap.clear();
  session.visitedFiles.clear();

  await cleanupSandbox(session.sandboxPath);
}
