import type { AgentEvent, DeepDiveSession, PipelineResult } from '@sleuth/core';
import { cleanupSandbox } from '@sleuth/core';

export type RunStatus = 'running' | 'complete' | 'error';

export interface RunProgress {
  stage: string;
  detail?: string;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  progress: RunProgress;
  error?: string;
  result?: PipelineResult;
  // True once a Deep Dive session has been started from this run — ownership
  // (and therefore cleanup) of the sandbox transfers to that session's own
  // lifecycle (terminateSession / session-reaper), so this run's own eviction
  // must never delete a directory a live session still reads files from.
  claimedBySession: boolean;
  sandboxCleaned: boolean;
  evicted: boolean;
}

export interface InvestigationRecord {
  events: AgentEvent[];
}

export interface AppState {
  runs: Map<string, RunState>;
  activeRunCount: number;
  sessions: Map<string, DeepDiveSession>;
  investigations: Map<string, InvestigationRecord>;
}

export const MAX_CONCURRENT_RUNS = 2;
export const MAX_STORED_RUNS = 50;

export function createAppState(): AppState {
  return {
    runs: new Map<string, RunState>(),
    activeRunCount: 0,
    sessions: new Map<string, DeepDiveSession>(),
    investigations: new Map<string, InvestigationRecord>(),
  };
}

// A run's sandbox is only ever cleaned up here once nobody else could still
// need it: no Deep Dive session ever claimed it (that session's own
// lifecycle owns cleanup instead) and it actually has a sandboxPath to
// delete — a still-running pipeline hasn't produced one from this layer's
// view yet, and a failed one already cleaned up after itself internally
// (see pipeline.ts's own catch block), so there is nothing to do for either.
export async function cleanupRunSandboxIfOwned(run: RunState): Promise<void> {
  if (run.sandboxCleaned || run.claimedBySession || run.result === undefined) {
    return;
  }

  run.sandboxCleaned = true;

  await cleanupSandbox(run.result.sandboxPath);
}

// Caps stored runs at MAX_STORED_RUNS, evicting the oldest (insertion order,
// which a Map preserves) on overflow. An evicted run whose sandbox nobody has
// claimed yet is cleaned up immediately; one still running when evicted is
// just marked, so its completion handler (routes/analyze.ts) can clean up
// once a sandboxPath actually exists.
export function insertRun(state: AppState, run: RunState): void {
  state.runs.set(run.runId, run);

  if (state.runs.size <= MAX_STORED_RUNS) {
    return;
  }

  const oldestKey = state.runs.keys().next().value;

  if (oldestKey === undefined) {
    return;
  }

  const oldest = state.runs.get(oldestKey);

  state.runs.delete(oldestKey);

  if (oldest !== undefined) {
    oldest.evicted = true;
    void cleanupRunSandboxIfOwned(oldest);
  }
}
