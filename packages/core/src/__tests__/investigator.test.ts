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

    const result = await investigate('What does foo.ts do?', session, emptyProviders, rateLimiters);

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

    const result = await investigate('Explain the whole repo', session, emptyProviders, rateLimiters);

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

    const result = await investigate('Explain foo.ts', session, emptyProviders, rateLimiters);

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

    const result = await investigate('What is in foo.ts?', session, emptyProviders, rateLimiters);

    const readFileSpy = vi.mocked(fs.readFileSync);

    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(result.reasoningTrace[1].observation).toContain('[Already examined earlier in this session]');
    expect(result.filesExamined).toEqual(['foo.ts']);
  });
});
