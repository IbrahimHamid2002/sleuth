import * as core from '@sleuth/core';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../index';

vi.mock('@sleuth/core', async () => {
  const actual = await vi.importActual<typeof import('@sleuth/core')>('@sleuth/core');

  return { ...actual, runPipeline: vi.fn(), investigate: vi.fn() };
});

const runPipeline = vi.mocked(core.runPipeline);
const investigate = vi.mocked(core.investigate);

function fakeRepoMeta(): core.RepoMeta {
  return {
    name: 'bar',
    identifier: 'foo/bar',
    commitHash: 'abc123',
    rootPath: '/sandbox/bar',
    frameworks: ['express'],
    isMonorepo: false,
    monorepoType: 'none',
    workspaceDirs: [],
    packageManager: 'npm',
    subProjects: [],
  };
}

function fakeSummaries(): core.FileSummary[] {
  return [{ path: 'src/index.ts', purpose: 'entry point', exports: [], dependencies: [], summary: 'starts the app' }];
}

function fakePipelineResult(): core.PipelineResult {
  return {
    meta: fakeRepoMeta(),
    summaries: fakeSummaries(),
    synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
    symbolIndex: new Map(),
    auditLog: [{ timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'ok' }],
    sandboxPath: '/tmp/sleuth/fake-sandbox',
    durationMs: 1234,
    failedFiles: [],
  };
}

function fakeInvestigationResult(question: string): core.InvestigationResult {
  return {
    question,
    answer: 'This is the answer.',
    plan: 'investigate',
    iterations: 1,
    filesExamined: [],
    answeredFromDocs: false,
    answeredFromSummaries: false,
    reasoningTrace: [],
  };
}

// Deferred promise so a test can control exactly when a mocked `runPipeline`
// call resolves — needed to keep a run "in flight" long enough to assert
// concurrency limits before letting it finish.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

async function waitForRunStatus(app: Express, runId: string, wantedStatus: string): Promise<{ status: string }> {
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await request(app).get(`/api/runs/${runId}/status`);

    if (res.body.status === wantedStatus) {
      return res.body;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for run ${runId} to reach status "${wantedStatus}"`);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runPipeline.mockReset();
  investigate.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('POST /api/analyze validation', () => {
  it('rejects a request with both url and localPath', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/analyze').send({ url: 'https://github.com/foo/bar', localPath: '/tmp/foo' });

    expect(res.status).toBe(400);
  });

  it('rejects a request with neither url nor localPath', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/analyze').send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/analyze concurrency limit', () => {
  it('returns 429 once more than 2 runs are in flight', async () => {
    const { app } = createApp();
    const pending = [deferred<core.PipelineResult>(), deferred<core.PipelineResult>()];
    let callIndex = 0;

    runPipeline.mockImplementation(async () => {
      const current = pending[callIndex];

      callIndex += 1;

      return current !== undefined ? current.promise : fakePipelineResult();
    });

    const first = await request(app).post('/api/analyze').send({ url: 'https://github.com/foo/repo-one' });
    const second = await request(app).post('/api/analyze').send({ url: 'https://github.com/foo/repo-two' });
    const third = await request(app).post('/api/analyze').send({ url: 'https://github.com/foo/repo-three' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(third.status).toBe(429);

    pending.forEach((entry) => entry.resolve(fakePipelineResult()));
  });
});

describe('Full analyze -> results -> Deep Dive flow', () => {
  it('runs a pipeline, fetches results, and completes a Deep Dive session end-to-end', async () => {
    const { app } = createApp();

    runPipeline.mockResolvedValue(fakePipelineResult());
    investigate.mockImplementation(async (question, _session, _providers, _rateLimiters, onEvent) => {
      onEvent?.({ type: 'thinking', data: { thought: 'looking into it' } });
      onEvent?.({ type: 'answer', data: { answer: 'This is the answer.' } });

      return fakeInvestigationResult(question);
    });

    const analyzeRes = await request(app).post('/api/analyze').send({ url: 'https://github.com/foo/bar' });

    expect(analyzeRes.status).toBe(202);

    const { runId } = analyzeRes.body as { runId: string };

    await waitForRunStatus(app, runId, 'complete');

    const resultsRes = await request(app).get(`/api/runs/${runId}/results`);

    expect(resultsRes.status).toBe(200);
    expect(resultsRes.body.meta.identifier).toBe('foo/bar');
    expect(resultsRes.body.synthesis.readme).toContain('README');
    expect(resultsRes.body.summaries).toHaveLength(1);
    expect(resultsRes.body.durationMs).toBe(1234);

    const startRes = await request(app).post('/api/sessions/start').send({ runId });

    expect(startRes.status).toBe(200);

    const { sessionId } = startRes.body as { sessionId: string };

    const askRes = await request(app).post(`/api/sessions/${sessionId}/ask`).send({ question: 'How does auth work?' });

    expect(askRes.status).toBe(200);

    const { investigationId } = askRes.body as { investigationId: string };

    const streamRes = await request(app).get(`/api/sessions/${sessionId}/investigations/${investigationId}/stream`);

    expect(streamRes.status).toBe(200);
    expect(streamRes.text).toContain('event: answer');
    expect(streamRes.text).toContain('This is the answer.');

    const endRes = await request(app).post(`/api/sessions/${sessionId}/end`);

    expect(endRes.status).toBe(200);
    expect(endRes.body).toEqual({ success: true });

    const askAfterEndRes = await request(app).post(`/api/sessions/${sessionId}/ask`).send({ question: 'anything?' });

    expect(askAfterEndRes.status).toBe(404);
  });
});
