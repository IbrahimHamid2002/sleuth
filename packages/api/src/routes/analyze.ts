import type { RepoInput } from '@sleuth/core';
import { redactSecrets, runPipeline } from '@sleuth/core';
import archiver from 'archiver';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import type { AppState, RunState } from '../state';
import { cleanupRunSandboxIfOwned, insertRun, MAX_CONCURRENT_RUNS } from '../state';

// `summaries` in a completed PipelineResult is already sorted descending by
// PriorityScore — see pipeline.ts, which summarizes `prioritized` (the
// already-sorted output of prioritizeFiles) and summarizeFiles.ts, which
// preserves input order 1:1 in its return value. FileSummary itself carries
// no `score` field, so "top 50 by score" is simply the first 50 of this array.
const TOP_SUMMARIES_COUNT = 50;

const AnalyzeRequestSchema = z
  .object({
    url: z.string().optional(),
    localPath: z.string().optional(),
    pat: z.string().optional(),
  })
  .refine((data) => (data.url !== undefined) !== (data.localPath !== undefined), {
    message: 'Exactly one of url or localPath must be provided',
  });

function buildRepoInput(url: string | undefined, localPath: string | undefined, pat: string | undefined): RepoInput {
  return url !== undefined ? { type: 'github', url, pat } : { type: 'local', path: localPath };
}

function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

// `noUncheckedIndexedAccess` types Express's params index signature as
// `string | undefined` even though the route pattern (`:runId`) guarantees
// it's present whenever the handler actually runs — this narrows it in one
// place instead of an unreachable-in-practice guard in every handler.
function findRun(state: AppState, runId: string | undefined): RunState | undefined {
  return runId !== undefined ? state.runs.get(runId) : undefined;
}

export function createAnalyzeRouter(state: AppState): Router {
  const router = Router();

  router.post('/analyze', (req: Request, res: Response): void => {
    const parseResult = AnalyzeRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.issues.map((issue) => issue.message).join('; ') });

      return;
    }

    if (state.activeRunCount >= MAX_CONCURRENT_RUNS) {
      res.status(429).json({ error: 'Server busy, try again shortly' });

      return;
    }

    const { url, localPath, pat } = parseResult.data;
    const repoInput = buildRepoInput(url, localPath, pat);
    const run: RunState = {
      runId: uuidv4(),
      status: 'running',
      progress: { stage: 'queued' },
      claimedBySession: false,
      sandboxCleaned: false,
      evicted: false,
    };

    insertRun(state, run);
    state.activeRunCount += 1;

    runPipeline(repoInput, {
      onProgress: (stage, detail) => {
        run.progress = { stage, detail };
      },
    })
      .then((result) => {
        run.status = 'complete';
        run.result = result;
        run.progress = { stage: 'complete' };

        if (run.evicted) {
          void cleanupRunSandboxIfOwned(run);
        }
      })
      .catch((err: unknown) => {
        run.status = 'error';
        run.error = errorMessage(err);
      })
      .finally(() => {
        state.activeRunCount -= 1;
      });

    res.status(202).json({ runId: run.runId });
  });

  router.get('/runs/:runId/status', (req: Request, res: Response): void => {
    const run = findRun(state, req.params.runId);

    if (run === undefined) {
      res.status(404).json({ error: 'Run not found' });

      return;
    }

    res.json({
      status: run.status,
      progress: run.progress,
      ...(run.error !== undefined ? { error: run.error } : {}),
    });
  });

  router.get('/runs/:runId/results', (req: Request, res: Response): void => {
    const run = findRun(state, req.params.runId);

    if (run === undefined) {
      res.status(404).json({ error: 'Run not found' });

      return;
    }

    if (run.status !== 'complete' || run.result === undefined) {
      res.status(400).json({ error: `Run status is "${run.status}", not "complete"` });

      return;
    }

    const { meta, synthesis, auditLog, durationMs, summaries } = run.result;

    res.json({
      meta,
      synthesis,
      summaries: summaries.slice(0, TOP_SUMMARIES_COUNT),
      auditLog,
      durationMs,
    });
  });

  router.get('/runs/:runId/download', (req: Request, res: Response): void => {
    const run = findRun(state, req.params.runId);

    if (run === undefined) {
      res.status(404).json({ error: 'Run not found' });

      return;
    }

    if (run.status !== 'complete' || run.result === undefined) {
      res.status(400).json({ error: `Run status is "${run.status}", not "complete"` });

      return;
    }

    const { synthesis } = run.result;
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="sleuth-docs-${run.runId}.zip"`);

    archive.on('error', (err: Error) => {
      res.destroy(err);
    });

    archive.pipe(res);
    archive.append(synthesis.readme, { name: 'README.generated.md' });
    archive.append(synthesis.architecture, { name: 'ARCHITECTURE.md' });
    archive.append(synthesis.onboarding, { name: 'ONBOARDING.md' });
    void archive.finalize();
  });

  return router;
}
