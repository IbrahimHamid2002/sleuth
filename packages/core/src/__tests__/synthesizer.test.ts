import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateTemplateFallback, MERMAID_DISCLAIMER, synthesize } from '../documentation/synthesizer';
import * as providerModule from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import type { AuditEntry, FileSummary, RepoMeta } from '../types';

vi.mock('../llm/provider', async () => {
  const actual = await vi.importActual<typeof providerModule>('../llm/provider');

  return { ...actual, callWithFallback: vi.fn() };
});

const callWithFallback = vi.mocked(providerModule.callWithFallback);

const REPO_META: RepoMeta = {
  name: 'demo-repo',
  identifier: 'demo-repo',
  commitHash: 'abc123',
  rootPath: '/tmp/demo-repo',
  frameworks: ['Express'],
  isMonorepo: false,
  monorepoType: 'none',
  workspaceDirs: [],
  packageManager: 'pnpm',
  subProjects: [{ rootRelativePath: '.', frameworks: ['Express'], packageManager: 'pnpm', entryPoints: ['src/index.ts'] }],
};

const NO_PROVIDERS = [{ name: 'stub', complete: vi.fn() }];
const NO_RATE_LIMITERS = new Map<string, TokenBucketRateLimiter>();

const SUMMARIES: FileSummary[] = [
  {
    path: 'src/foo.ts',
    purpose: 'Implements the foo helper',
    exports: ['foo'],
    dependencies: [],
    summary: 'Small utility module.',
  },
];

const SYMBOL_INDEX = new Map([['foo', [{ path: 'src/foo.ts', line: 3 }]]]);

function promptDocType(prompt: string): 'readme' | 'architecture' | 'onboarding' {
  if (prompt.includes('README.md')) return 'readme';

  if (prompt.includes('ARCHITECTURE.md')) return 'architecture';

  return 'onboarding';
}

describe('synthesize', () => {
  let auditLog: AuditEntry[];

  beforeEach(() => {
    auditLog = [];
    callWithFallback.mockReset();
  });

  it('generates all three documents via the LLM and applies citations to each', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return `${MERMAID_DISCLAIMER}\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\nSee \`foo\`.`;
      }

      return `Generated ${docType} referencing \`foo\`.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(callWithFallback).toHaveBeenCalledTimes(3);
    expect(result.readme).toBe('Generated readme referencing `foo` [src/foo.ts:3].');
    expect(result.onboarding).toBe('Generated onboarding referencing `foo` [src/foo.ts:3].');
    expect(result.architecture).toContain('`foo` [src/foo.ts:3]');
    expect(result.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);

    const successEntries = auditLog.filter((entry) => entry.action === 'llm_success');

    expect(successEntries).toHaveLength(3);
  });

  it('falls back to a deterministic template only for the document whose LLM call fails, leaving the others LLM-generated', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'onboarding') {
        throw new Error('provider unavailable');
      }

      return `Generated ${docType} referencing \`foo\`.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    // 1 call for readme + 1 for architecture + 3 retry attempts for onboarding.
    expect(callWithFallback).toHaveBeenCalledTimes(5);

    expect(result.readme).toBe('Generated readme referencing `foo` [src/foo.ts:3].');
    expect(result.onboarding).toBe(generateTemplateFallback('onboarding', SUMMARIES, REPO_META));
    expect(result.onboarding).toContain('pnpm install');

    const successEntries = auditLog.filter((entry) => entry.action === 'llm_success');
    const fallbackEntries = auditLog.filter((entry) => entry.action === 'template_fallback');

    expect(successEntries).toHaveLength(2);
    expect(fallbackEntries).toHaveLength(1);
    expect(fallbackEntries[0].detail).toContain('onboarding');
  });

  it('always includes the Mermaid disclaimer as the first line of the architecture doc, even if the LLM omits it', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return '```mermaid\nflowchart TD\n  A --> B\n```\n\nNo disclaimer here.';
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(result.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);
  });

  it('always includes the Mermaid disclaimer in the fallback architecture doc when the LLM call fails', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        throw new Error('provider unavailable');
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(result.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);
    expect(result.architecture).toContain('```mermaid');

    const fallbackEntries = auditLog.filter((entry) => entry.action === 'template_fallback');

    expect(fallbackEntries).toHaveLength(1);
    expect(fallbackEntries[0].detail).toContain('architecture');
  });
});
