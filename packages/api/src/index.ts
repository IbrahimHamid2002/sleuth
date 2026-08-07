import { redactSecrets } from '@sleuth/core';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { pathToFileURL } from 'node:url';

import { createAnalyzeRouter } from './routes/analyze';
import { createSessionsRouter } from './routes/sessions';
import { startSessionReaper } from './session-reaper';
import type { AppState } from './state';
import { createAppState } from './state';

const DEFAULT_PORT = '3001';

function buildAllowedOrigins(): string[] {
  return [process.env.WEB_ORIGIN, 'http://localhost:5173'].filter(
    (origin): origin is string => origin !== undefined,
  );
}

export interface App {
  app: express.Express;
  state: AppState;
}

// Exported (not just bootstrapped below) so tests can build an isolated app +
// in-memory state per test run via supertest, without starting a real server
// or the session reaper's interval.
export function createApp(): App {
  const app = express();
  const state = createAppState();

  app.use(cors({ origin: buildAllowedOrigins() }));
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction): void => {
    console.log(redactSecrets(`${req.method} ${req.path}`));
    next();
  });

  app.use('/api', createAnalyzeRouter(state));
  app.use('/api', createSessionsRouter(state));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));

    console.error(`Unhandled error: ${message}`);
    res.status(500).json({ error: message });
  });

  return { app, state };
}

const isMainModule = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  const { app, state } = createApp();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  startSessionReaper(state.sessions);

  app.listen(port, () => {
    console.log(`Sleuth API listening on port ${port}`);
  });
}
