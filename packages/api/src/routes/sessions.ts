import type { DeepDiveSession } from '@sleuth/core';
import { buildDeepDiveAgentProviders, buildDeepDiveAgentRateLimiters, createSession, investigate, redactSecrets, terminateSession, touchSession } from '@sleuth/core';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import type { AppState, InvestigationRecord } from '../state';

// Safety net so a stream can never hang forever if `investigate()` never
// emits an 'answer' event (e.g. it rejects before producing one).
const SSE_SAFETY_TIMEOUT_MS = 65_000;
const SSE_POLL_INTERVAL_MS = 200;

const StartSessionRequestSchema = z.object({ runId: z.string() });
const AskRequestSchema = z.object({ question: z.string().min(1) });

function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

// See routes/analyze.ts's findRun for why: `noUncheckedIndexedAccess` types
// Express route params as `string | undefined` even though the route
// pattern guarantees they're present whenever the handler runs.
function findSession(state: AppState, sessionId: string | undefined): DeepDiveSession | undefined {
  return sessionId !== undefined ? state.sessions.get(sessionId) : undefined;
}

function findInvestigation(state: AppState, investigationId: string | undefined): InvestigationRecord | undefined {
  return investigationId !== undefined ? state.investigations.get(investigationId) : undefined;
}

export function createSessionsRouter(state: AppState): Router {
  const router = Router();

  router.post('/sessions/start', (req: Request, res: Response): void => {
    const parseResult = StartSessionRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.issues.map((issue) => issue.message).join('; ') });

      return;
    }

    const run = state.runs.get(parseResult.data.runId);

    if (run === undefined) {
      res.status(404).json({ error: 'Run not found' });

      return;
    }

    if (run.status !== 'complete' || run.result === undefined) {
      res.status(400).json({ error: `Run status is "${run.status}", not "complete"` });

      return;
    }

    const session = createSession(run.result.meta, run.result.sandboxPath, run.result.summaries, run.result.synthesis);

    run.claimedBySession = true;
    state.sessions.set(session.sessionId, session);

    res.json({ sessionId: session.sessionId });
  });

  router.post('/sessions/:sessionId/ask', (req: Request, res: Response): void => {
    const session = findSession(state, req.params.sessionId);

    if (session === undefined) {
      res.status(404).json({ error: 'Session not found' });

      return;
    }

    const parseResult = AskRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.issues.map((issue) => issue.message).join('; ') });

      return;
    }

    const investigationId = uuidv4();
    const record: InvestigationRecord = { events: [] };

    state.investigations.set(investigationId, record);

    const providers = buildDeepDiveAgentProviders();
    const rateLimiters = buildDeepDiveAgentRateLimiters(providers);

    touchSession(session);

    investigate(parseResult.data.question, session, providers, rateLimiters, (event) => {
      record.events.push(event);
    }).catch((err: unknown) => {
      record.events.push({ type: 'error', data: { message: errorMessage(err) } });
    });

    res.json({ investigationId });
  });

  router.get('/sessions/:sessionId/investigations/:id/stream', (req: Request, res: Response): void => {
    const session = findSession(state, req.params.sessionId);

    if (session === undefined) {
      res.status(404).end();

      return;
    }

    const record = findInvestigation(state, req.params.id);

    if (record === undefined) {
      res.status(404).end();

      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Sends the header block immediately instead of letting Node buffer it
    // until the first res.write() — the client must see the stream open
    // right away, not only once the first event happens to be available.
    res.flushHeaders();

    let sentCount = 0;
    let closed = false;

    const closeStream = (): void => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(pollId);
      clearTimeout(safetyTimeoutId);
      req.off('close', closeStream);
      res.end();
    };

    const pollId = setInterval(() => {
      while (sentCount < record.events.length) {
        const event = record.events[sentCount];

        sentCount += 1;

        if (event === undefined) {
          continue;
        }

        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);

        if (event.type === 'answer') {
          closeStream();

          return;
        }
      }
    }, SSE_POLL_INTERVAL_MS);

    const safetyTimeoutId = setTimeout(closeStream, SSE_SAFETY_TIMEOUT_MS);

    req.on('close', closeStream);
  });

  router.post('/sessions/:sessionId/end', (req: Request, res: Response): void => {
    const { sessionId } = req.params;
    const session = findSession(state, sessionId);

    if (session === undefined || sessionId === undefined) {
      res.status(404).json({ error: 'Session not found' });

      return;
    }

    terminateSession(session)
      .then(() => {
        state.sessions.delete(sessionId);
        res.json({ success: true });
      })
      .catch((err: unknown) => {
        res.status(500).json({ error: errorMessage(err) });
      });
  });

  return router;
}
