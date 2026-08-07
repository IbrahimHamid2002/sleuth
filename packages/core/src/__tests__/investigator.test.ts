import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProviders } from '../agent/investigator';
import { investigate } from '../agent/investigator';
import { MAX_ITERATIONS } from '../agent/prompts';
import { createSession } from '../agent/session';
import * as providerModule from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import type { DeepDiveSession, FileSummary, RepoMeta } from '../types';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');

  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('../llm/provider', async () => {
  const actual = await vi.importActual<typeof providerModule>('../llm/provider');

  return { ...actual, callWithFallback: vi.fn() };
});

const callWithFallback = vi.mocked(providerModule.callWithFallback);
const emptyProviders: AgentProviders = { reasoningProviders: [], synthesisProviders: [] };

function buildRepoMeta(): RepoMeta {
  return {
    name: 'fixture-repo',
    identifier: 'fixture-repo',
    commitHash: 'abc123',
    rootPath: '/fixture',
    frameworks: [],
    isMonorepo: false,
    monorepoType: 'none',
    workspaceDirs: [],
    packageManager: 'npm',
    subProjects: [],
  };
}

function mockResponseSequence(responses: string[]): void {
  let index = 0;

  callWithFallback.mockImplementation(async () => {
    const response = responses[index];

    index += 1;

    if (response === undefined) {
      throw new Error(`No more scripted LLM responses (call ${index})`);
    }

    return response;
  });
}

function decisionJSON(decision: Record<string, unknown>): string {
  return JSON.stringify(decision);
}

// Iteration 1 merges planning and the first tool-call/finish decision into a
// single combined response ({ plan, thought, action, toolName?, toolArgs? }).
function combinedJSON(decision: Record<string, unknown>): string {
  return JSON.stringify({ plan: 'Inspect foo.ts from a few angles.', ...decision });
}

describe('investigate', () => {
  let sandboxPath: string;
  let session: DeepDiveSession;
  const rateLimiters = new Map<string, TokenBucketRateLimiter>();

  beforeEach(() => {
    sandboxPath = fs.mkdtempSync(join(tmpdir(), 'sleuth-investigator-'));
    fs.writeFileSync(join(sandboxPath, 'foo.ts'), 'export const foo = 1;');

    const summaries: FileSummary[] = [
      {
        path: 'foo.ts',
        purpose: 'Defines foo',
        exports: ['foo'],
        dependencies: [],
        summary: 'A fixture file.',
      },
    ];

    session = createSession(buildRepoMeta(), sandboxPath, summaries);

    vi.mocked(fs.readFileSync).mockClear();
    callWithFallback.mockReset();
  });

  afterEach(() => {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('produces a scratchpad of exactly 3 entries and a final answer for a 3-tool-call-then-finish sequence', async () => {
    mockResponseSequence([
      // iteration 1: combined plan + first decision
      combinedJSON({ thought: 'Read foo.ts', action: 'tool_call', toolName: 'read_file', toolArgs: { path: 'foo.ts' } }),
      // iteration 2
      decisionJSON({
        thought: 'Check its summary too',
        action: 'tool_call',
        toolName: 'get_file_summary',
        toolArgs: { path: 'foo.ts' },
      }),
      // iteration 3
      decisionJSON({ thought: 'List the directory', action: 'tool_call', toolName: 'list_directory', toolArgs: { path: '.' } }),
      // iteration 4: finish
      decisionJSON({ thought: 'I have enough information', action: 'finish' }),
      // synthesis
      'Final answer citing `foo.ts`.',
    ]);

    // Long enough (>12 words) to skip Step 4's short-query fast path, so this
    // test exercises only the full ReAct loop's mechanics, unaffected by it.
    const result = await investigate(
      'Can you walk me through exactly what the foo.ts file does and how it behaves in detail?',
      session,
      emptyProviders,
      rateLimiters,
    );

    expect(result.reasoningTrace).toHaveLength(3);
    expect(result.plan).toBe('Inspect foo.ts from a few angles.');
    expect(result.answer).toBe('Final answer citing `foo.ts`.');
    expect(result.iterations).toBe(4);
    expect(callWithFallback).toHaveBeenCalledTimes(5);
  });

  it(`stops at exactly ${MAX_ITERATIONS} iterations when the model never returns finish`, async () => {
    const laterReasonResponses = Array.from({ length: MAX_ITERATIONS - 1 }, () =>
      decisionJSON({ thought: 'Keep looking', action: 'tool_call', toolName: 'list_directory', toolArgs: { path: '.' } }),
    );

    mockResponseSequence([
      combinedJSON({ thought: 'Keep looking', action: 'tool_call', toolName: 'list_directory', toolArgs: { path: '.' } }),
      ...laterReasonResponses,
      'Final answer after exhausting iterations.',
    ]);

    // Long enough (>12 words) to skip Step 4's short-query fast path.
    const result = await investigate(
      'Please explain the whole repository in detail, covering its structure and every major component thoroughly',
      session,
      emptyProviders,
      rateLimiters,
    );

    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(result.reasoningTrace).toHaveLength(MAX_ITERATIONS);
    // 1 combined call + (MAX_ITERATIONS - 1) further reasoning calls + 1 synthesis call.
    expect(callWithFallback).toHaveBeenCalledTimes(MAX_ITERATIONS + 1);
  });

  it('records malformed JSON as an error observation instead of crashing the loop', async () => {
    mockResponseSequence([
      combinedJSON({ thought: 'List the directory', action: 'tool_call', toolName: 'list_directory', toolArgs: { path: '.' } }),
      'this is not valid JSON {',
      decisionJSON({ thought: 'Done after the hiccup', action: 'finish' }),
      'Final answer despite the malformed step.',
    ]);

    // Long enough (>12 words) to skip Step 4's short-query fast path.
    const result = await investigate(
      'Please explain in detail what foo.ts does, how it works, and why it matters',
      session,
      emptyProviders,
      rateLimiters,
    );

    expect(result.iterations).toBe(3);
    expect(result.reasoningTrace).toHaveLength(2);
    expect(result.reasoningTrace[1].toolName).toBe('none');
    expect(result.reasoningTrace[1].observation).toContain('Error:');
    expect(result.answer).toBe('Final answer despite the malformed step.');
  });

  it('does not re-read a file from disk when it is requested twice across iterations', async () => {
    mockResponseSequence([
      combinedJSON({ thought: 'Read foo.ts', action: 'tool_call', toolName: 'read_file', toolArgs: { path: 'foo.ts' } }),
      decisionJSON({ thought: 'Read foo.ts again', action: 'tool_call', toolName: 'read_file', toolArgs: { path: 'foo.ts' } }),
      decisionJSON({ thought: 'Done', action: 'finish' }),
      'Final answer about foo.ts.',
    ]);

    // Long enough (>12 words) to skip Step 4's short-query fast path.
    const result = await investigate(
      'Could you describe in detail exactly what is contained inside the foo.ts file?',
      session,
      emptyProviders,
      rateLimiters,
    );

    const readFileSpy = vi.mocked(fs.readFileSync);

    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(result.reasoningTrace[1].observation).toContain('[Already examined earlier in this session]');
    expect(result.filesExamined).toEqual(['foo.ts']);
  });

  describe('fast-path doc-first lookup', () => {
    const generatedDocs = {
      readme: 'This project is a small Express API for managing todos.',
      architecture: 'The entry point is src/index.ts, which wires up Express routes.',
      onboarding: 'Run `npm install` then `npm start`.',
    };

    it('answers directly from the docs with zero live tool calls when the fast-path check says answerable', async () => {
      const docSession = createSession(buildRepoMeta(), sandboxPath, [], generatedDocs);

      mockResponseSequence([
        JSON.stringify({ answerable: true, answer: 'It is an Express API for todos (from README.generated.md).' }),
      ]);

      const result = await investigate('What kind of project is this?', docSession, emptyProviders, rateLimiters);

      expect(result.answeredFromDocs).toBe(true);
      expect(result.iterations).toBe(0);
      expect(result.filesExamined).toEqual([]);
      expect(result.reasoningTrace).toEqual([]);
      expect(result.answer).toBe('It is an Express API for todos (from README.generated.md).');
      expect(callWithFallback).toHaveBeenCalledTimes(1);
    });

    it('falls through to the normal investigation when the fast-path check says not answerable', async () => {
      const docSession = createSession(buildRepoMeta(), sandboxPath, [], generatedDocs);

      mockResponseSequence([
        JSON.stringify({ answerable: false }),
        combinedJSON({ thought: 'Docs did not cover this, reading foo.ts', action: 'tool_call', toolName: 'read_file', toolArgs: { path: 'foo.ts' } }),
        decisionJSON({ thought: 'Done', action: 'finish' }),
        'Final answer from real investigation.',
      ]);

      // Long enough (>12 words) to skip Step 4's short-query fast path, so
      // this test's call-count assertion below stays exactly as documented.
      const result = await investigate(
        'Could you explain in detail exactly what the internal helper function does and why it exists?',
        docSession,
        emptyProviders,
        rateLimiters,
      );

      expect(result.answeredFromDocs).toBe(false);
      expect(result.iterations).toBe(2);
      expect(result.answer).toBe('Final answer from real investigation.');
      // 1 fast-path call + 1 combined call + 1 finish call + 1 synthesis call.
      expect(callWithFallback).toHaveBeenCalledTimes(4);
    });

    it('falls through gracefully (no crash) when the fast-path response is malformed', async () => {
      const docSession = createSession(buildRepoMeta(), sandboxPath, [], generatedDocs);

      mockResponseSequence([
        'not valid JSON at all {{{',
        combinedJSON({ thought: 'Investigating for real', action: 'finish' }),
        'Final answer despite the malformed fast-path response.',
      ]);

      // Long enough (>12 words) to skip Step 4's short-query fast path.
      const result = await investigate(
        'Some question that is intentionally long enough to bypass the short query fast path entirely',
        docSession,
        emptyProviders,
        rateLimiters,
      );

      expect(result.answeredFromDocs).toBe(false);
      expect(result.answer).toBe('Final answer despite the malformed fast-path response.');
    });

    it('skips the fast-path call entirely (no generatedDocs on the session) and behaves exactly as before', async () => {
      mockResponseSequence([combinedJSON({ thought: 'No docs available', action: 'finish' }), 'Final answer with no docs.']);

      // Long enough (>12 words) to skip Step 4's short-query fast path, so
      // this test's call-count assertion below stays exactly as documented.
      const result = await investigate(
        'Some question that is intentionally long enough to bypass the short query fast path entirely',
        session,
        emptyProviders,
        rateLimiters,
      );

      expect(result.answeredFromDocs).toBe(false);
      expect(callWithFallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('short-query fast path (Step 4)', () => {
    it('answers a short/simple question directly from file summaries, with zero live tool calls', async () => {
      mockResponseSequence([JSON.stringify({ answerable: true, answer: 'foo.ts defines a simple constant (from file summaries).' })]);

      const result = await investigate('What does foo.ts do?', session, emptyProviders, rateLimiters);

      expect(result.answeredFromSummaries).toBe(true);
      expect(result.answeredFromDocs).toBe(false);
      expect(result.iterations).toBe(0);
      expect(result.reasoningTrace).toEqual([]);
      expect(result.answer).toBe('foo.ts defines a simple constant (from file summaries).');
      expect(callWithFallback).toHaveBeenCalledTimes(1);
    });

    it('falls through to the full investigation when the short-query fast path says not answerable', async () => {
      mockResponseSequence([
        JSON.stringify({ answerable: false }),
        combinedJSON({
          thought: 'Summaries did not cover this, reading foo.ts',
          action: 'tool_call',
          toolName: 'read_file',
          toolArgs: { path: 'foo.ts' },
        }),
        decisionJSON({ thought: 'Done', action: 'finish' }),
        'Final answer from real investigation.',
      ]);

      const result = await investigate('What does foo.ts do?', session, emptyProviders, rateLimiters);

      expect(result.answeredFromSummaries).toBe(false);
      expect(result.answer).toBe('Final answer from real investigation.');
      // 1 short-query fast-path call + 1 combined call + 1 finish call + 1 synthesis call.
      expect(callWithFallback).toHaveBeenCalledTimes(4);
    });

    it('skips the short-query fast path entirely for a long/complex question (never sacrifices correctness for speed)', async () => {
      mockResponseSequence([combinedJSON({ thought: 'Investigating directly', action: 'finish' }), 'Final answer for a long question.']);

      const result = await investigate(
        'Please explain in exhaustive detail exactly how the whole repository is structured and organized',
        session,
        emptyProviders,
        rateLimiters,
      );

      expect(result.answeredFromSummaries).toBe(false);
      // No short-query fast-path call at all (question is long) — just the
      // combined plan+decision call + synthesis.
      expect(callWithFallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('adaptive timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('emits a soft-timeout progress event without aborting when a single step is slow but eventually resolves', async () => {
      vi.useFakeTimers();
      // Advancing 25 virtual seconds through a 2s watchdog interval takes
      // more real wall-clock time than vitest's 5s default test timeout.

      // Only the FIRST call (the reasoning step) is slow — past the soft
      // timeout (15s) but well under the per-step hard watchdog (60s); the
      // second call (synthesis) resolves immediately.
      let callCount = 0;

      callWithFallback.mockImplementation(
        () =>
          new Promise((resolve) => {
            callCount += 1;

            const delayMs = callCount === 1 ? 20_000 : 0;

            setTimeout(() => resolve(combinedJSON({ thought: 'Slow but fine', action: 'finish' })), delayMs);
          }),
      );

      const events: Array<{ type: string; data: unknown }> = [];
      const resultPromise = investigate('Slow question', session, emptyProviders, rateLimiters, (event) => events.push(event));

      await vi.advanceTimersByTimeAsync(25_000);

      const result = await resultPromise;

      expect(events.some((event) => event.type === 'progress')).toBe(true);
      expect(result.answer).toBeDefined();
    }, 15000);

    it('aborts as stuck (not silently hanging) when a single step makes no progress for the whole per-step window, while a fast multi-step run past the old flat 60s total is unaffected', async () => {
      vi.useFakeTimers();

      // Never resolves — simulates a genuinely stuck single call.
      callWithFallback.mockImplementation(() => new Promise(() => {}));

      const resultPromise = investigate('Stuck question', session, emptyProviders, rateLimiters);
      const rejection = expect(resultPromise).rejects.toThrow(/made no progress|stuck/i);

      // Default per-step watchdog is 60s.
      await vi.advanceTimersByTimeAsync(65_000);

      await rejection;
    });
  });
});
