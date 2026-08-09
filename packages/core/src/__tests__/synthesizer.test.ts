import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateArchitectureDiagramTypes } from '../documentation/mermaid-validator';
import {
  buildArchitecturePrompt,
  buildReadmePrompt,
  generateTemplateFallback,
  MERMAID_DISCLAIMER,
  synthesize,
} from '../documentation/synthesizer';
import * as providerModule from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import type { AuditEntry, FileNode, FileSummary, RepoMeta } from '../types';

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
  frameworks: ['express'],
  isMonorepo: false,
  monorepoType: 'none',
  workspaceDirs: [],
  packageManager: 'pnpm',
  subProjects: [{ rootRelativePath: '.', frameworks: ['express'], packageManager: 'pnpm', entryPoints: ['src/index.ts'] }],
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

const FILES: FileNode[] = [
  { path: 'src/foo.ts', type: 'file', size: 100 },
  { path: 'package.json', type: 'file', size: 50 },
];

const SYMBOL_INDEX = new Map([['foo', [{ path: 'src/foo.ts', line: 3 }]]]);

function promptDocType(prompt: string): 'readme' | 'architecture' | 'onboarding' {
  if (prompt.includes('README.md')) return 'readme';

  if (prompt.includes('ARCHITECTURE.md')) return 'architecture';

  return 'onboarding';
}

const VALID_ARCHITECTURE_DOC = `${MERMAID_DISCLAIMER}

## Directory Structure

\`\`\`
├── src/
│   └── foo.ts
└── package.json
\`\`\`

## High-Level System Diagram

\`\`\`mermaid
graph TD
  A["Entry"] --> B["Core"]
\`\`\`

## Components

See \`foo\`.

## Component Relation Graph

\`\`\`mermaid
graph TD
  A["Entry"] --> B["Core"]
\`\`\`

## System Sequence Diagram

\`\`\`mermaid
sequenceDiagram
  User->>Core: request
  Core-->>User: response
\`\`\`

## System Flowchart

\`\`\`mermaid
flowchart TD
  Start(["Start"]) --> End(["End"])
\`\`\``;

// Old, now-retired prompt structure: duplicate frontend/backend sequence
// sections instead of one merged "System Sequence Diagram", and the wrong
// diagram type ("flowchart" instead of "graph") under "High-Level System
// Diagram" — the exact two defects TASK 22A fixes.
const LEGACY_STRUCTURE_ARCHITECTURE_DOC = `${MERMAID_DISCLAIMER}

## Directory Structure

\`\`\`
├── src/
│   └── foo.ts
└── package.json
\`\`\`

## High-Level System Diagram

\`\`\`mermaid
flowchart TD
  A["Entry"] --> B["Core"]
\`\`\`

## Components

See \`foo\`.

## Frontend Component Relation Graph

\`\`\`mermaid
graph TD
  A["Entry"] --> B["Core"]
\`\`\`

## Frontend Data Flow Chart

\`\`\`mermaid
sequenceDiagram
  User->>Frontend: click
  Frontend-->>User: render
\`\`\`

## Backend Flow Chart

\`\`\`mermaid
sequenceDiagram
  Frontend->>Backend: request
  Backend-->>Frontend: response
\`\`\``;

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
        return VALID_ARCHITECTURE_DOC;
      }

      return `Generated ${docType} referencing \`foo\`.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(callWithFallback).toHaveBeenCalledTimes(3);
    expect(result.readme).toBe('Generated readme referencing `foo` [src/foo.ts:3].');
    expect(result.onboarding).toBe('Generated onboarding referencing `foo` [src/foo.ts:3].');
    expect(result.architecture).toContain('`foo` [src/foo.ts:3]');
    expect(result.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);

    const successEntries = auditLog.filter((entry) => entry.action === 'llm_success');

    expect(successEntries).toHaveLength(3);
  });

  it('threads the caller-supplied AbortSignal through to every callWithFallback call', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      return docType === 'architecture' ? VALID_ARCHITECTURE_DOC : `Generated ${docType}.`;
    });

    const controller = new AbortController();

    await synthesize(
      SUMMARIES,
      REPO_META,
      FILES,
      SYMBOL_INDEX,
      NO_PROVIDERS,
      NO_RATE_LIMITERS,
      auditLog,
      undefined,
      controller.signal,
    );

    expect(callWithFallback).toHaveBeenCalledTimes(3);

    for (const call of callWithFallback.mock.calls) {
      const signalArg = call[4] as AbortSignal;

      expect(signalArg.aborted).toBe(false);
    }
  });

  it('calls onProgress once per document as each one finishes, independent of overall success/failure', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'onboarding') {
        throw new Error('simulated failure');
      }

      return docType === 'architecture' ? VALID_ARCHITECTURE_DOC : `Generated ${docType}.`;
    });

    const onProgress = vi.fn();

    await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledWith('synthesis', 'readme generation finished');
    expect(onProgress).toHaveBeenCalledWith('synthesis', 'architecture generation finished');
    expect(onProgress).toHaveBeenCalledWith('synthesis', 'onboarding generation finished');
  });

  it('falls back to a deterministic template only for the document whose LLM call fails, leaving the others LLM-generated', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'onboarding') {
        throw new Error('provider unavailable');
      }

      if (docType === 'architecture') {
        return VALID_ARCHITECTURE_DOC;
      }

      return `Generated ${docType} referencing \`foo\`.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    // 1 call for readme + 1 for architecture + 3 retry attempts for onboarding.
    expect(callWithFallback).toHaveBeenCalledTimes(5);

    expect(result.readme).toBe('Generated readme referencing `foo` [src/foo.ts:3].');
    expect(result.onboarding).toBe(generateTemplateFallback('onboarding', SUMMARIES, REPO_META, ''));
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

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

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

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(result.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);
    expect(result.architecture).toContain('```mermaid');

    const fallbackEntries = auditLog.filter((entry) => entry.action === 'template_fallback');

    expect(fallbackEntries).toHaveLength(1);
    expect(fallbackEntries[0].detail).toContain('architecture');
  });

  it('grounds the README and ARCHITECTURE prompts in the exact deterministic directory tree, not the LLM', async () => {
    let architecturePrompt = '';
    let readmePrompt = '';

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        architecturePrompt = prompt;

        return VALID_ARCHITECTURE_DOC;
      }

      if (docType === 'readme') {
        readmePrompt = prompt;
      }

      return `Generated ${docType}.`;
    });

    await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(architecturePrompt).toContain('src/');
    expect(architecturePrompt).toContain('foo.ts');
    expect(readmePrompt).toContain('src/');
    expect(readmePrompt).toContain('foo.ts');
  });

  it('always requires all 5 architecture sections with their fixed diagram types, regardless of detected frameworks', () => {
    const backendOnlyMeta: RepoMeta = { ...REPO_META, frameworks: ['express'] };
    const frontendOnlyMeta: RepoMeta = { ...REPO_META, frameworks: ['react'] };

    for (const meta of [backendOnlyMeta, frontendOnlyMeta]) {
      const prompt = buildArchitecturePrompt(SUMMARIES, meta, 'tree');

      expect(prompt).toContain('"## High-Level System Diagram" — MUST contain exactly one ```mermaid code block opening with "graph"');
      expect(prompt).toContain('"## Component Relation Graph" — MUST contain exactly one ```mermaid code block opening with "graph"');
      expect(prompt).toContain('"## System Sequence Diagram" — MUST contain exactly one ```mermaid code block opening with "sequenceDiagram"');
      expect(prompt).toContain('"## System Flowchart" — this MUST be the final section');
      expect(prompt).not.toContain('Not applicable');
    }
  });

  it('instructs the model never to produce the retired duplicate/conditional headings', () => {
    const prompt = buildArchitecturePrompt(SUMMARIES, REPO_META, 'tree');

    expect(prompt).toContain('Frontend Component Relation Graph');
    expect(prompt).toContain('Frontend Data Flow Chart');
    expect(prompt).toContain('Backend Flow Chart');
    expect(prompt).toContain('retired headings');
  });

  it('does not ask the LLM for a README License or Project Structure section — that content lives in ARCHITECTURE.md', () => {
    const prompt = buildReadmePrompt(SUMMARIES, REPO_META, 'tree');

    // The old enumerated-section instructions are gone, not just renamed —
    // this phrasing was unique to the removed "## Project Structure" item.
    expect(prompt).not.toContain('reproduced verbatim inside a plain');
    expect(prompt).toContain('Do NOT include a "## Project Structure" or "## Directory Structure" section');
    expect(prompt).toContain('Do NOT include a "## License" section.');
  });

  it('omits the License and Project Structure sections from the deterministic README fallback template', () => {
    const fallback = generateTemplateFallback('readme', SUMMARIES, REPO_META, 'tree');

    expect(fallback).not.toContain('## License');
    expect(fallback).not.toContain('## Project Structure');
    expect(fallback).toContain('## Getting Started');
  });

  it('repairs an invalid Mermaid diagram via one LLM call and splices in the corrected version', async () => {
    // Structurally complete (all 5 required sections, correct types) except
    // for one syntactically-broken diagram — isolates Mermaid syntax repair
    // from the separate structural-validation pass tested below.
    const brokenArchitectureDoc = VALID_ARCHITECTURE_DOC.replace(
      '```mermaid\ngraph TD\n  A["Entry"] --> B["Core"]\n```\n\n## Components',
      '```mermaid\ngraph TD\n  A[Label: broken (oops)] --> B\n```\n\n## Components',
    );

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      if (prompt.includes('<broken_mermaid>')) {
        return 'graph TD\n  A["Label: fixed"] --> B["Node"]';
      }

      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return brokenArchitectureDoc;
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(result.architecture).toContain('A["Label: fixed"] --> B["Node"]');
    expect(result.architecture).not.toContain('Label: broken (oops)');
    expect(validateArchitectureDiagramTypes(result.architecture).valid).toBe(true);

    const repairedEntries = auditLog.filter((entry) => entry.action === 'mermaid_repaired');

    expect(repairedEntries).toHaveLength(1);
    // The syntax fix alone already satisfies the structural contract (the
    // fixed diagram already opens with "graph"), so no structural-repair
    // call is needed on top of it.
    expect(auditLog.some((entry) => entry.action === 'architecture_structure_fallback')).toBe(false);
  });

  it('strips an unrepairable Mermaid diagram, then structurally repairs the resulting missing-diagram violation via one re-prompt', async () => {
    const brokenArchitectureDoc = VALID_ARCHITECTURE_DOC.replace(
      '```mermaid\ngraph TD\n  A["Entry"] --> B["Core"]\n```\n\n## Components',
      '```mermaid\ngraph TD\n  A[Label: broken (oops)] --> B\n```\n\n## Components',
    );

    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      if (prompt.includes('<broken_mermaid>')) {
        // The "repaired" diagram is still invalid — repair attempt fails to fix it,
        // so the block gets stripped, leaving "High-Level System Diagram" with no
        // diagram at all — a structural violation the mermaid-syntax repair alone
        // can't see.
        return 'A[still: broken (oops)] --> B';
      }

      if (prompt.includes('<broken_architecture_doc>')) {
        return VALID_ARCHITECTURE_DOC;
      }

      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return brokenArchitectureDoc;
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(result.architecture).not.toContain('Label: broken (oops)');
    expect(result.architecture).not.toContain('Diagram omitted');
    expect(validateArchitectureDiagramTypes(result.architecture).valid).toBe(true);

    const strippedEntries = auditLog.filter((entry) => entry.action === 'mermaid_stripped');
    const structureRepairedEntries = auditLog.filter((entry) => entry.action === 'architecture_structure_repaired');

    expect(strippedEntries).toHaveLength(1);
    expect(structureRepairedEntries).toHaveLength(1);
  });

  it('never ships the old, buggy structure unmodified — repairs it or falls back to the deterministic template', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      if (prompt.includes('<broken_architecture_doc>')) {
        return VALID_ARCHITECTURE_DOC;
      }

      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return LEGACY_STRUCTURE_ARCHITECTURE_DOC;
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(validateArchitectureDiagramTypes(result.architecture).valid).toBe(true);
    expect(result.architecture).not.toContain('## Frontend Data Flow Chart');
    expect(result.architecture).not.toContain('## Backend Flow Chart');
  });

  it('falls back to the deterministic template when the structural repair re-prompt is also invalid', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        // Every attempt — initial and the one structural re-prompt — returns
        // the same buggy structure, so repair can never succeed.
        return LEGACY_STRUCTURE_ARCHITECTURE_DOC;
      }

      return `Generated ${docType}.`;
    });

    const result = await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    expect(validateArchitectureDiagramTypes(result.architecture).valid).toBe(true);
    expect(result.architecture).toContain('generated by a deterministic fallback');

    const fallbackEntries = auditLog.filter((entry) => entry.action === 'architecture_structure_fallback');

    expect(fallbackEntries).toHaveLength(1);
  });

  it('leaves a valid Mermaid diagram untouched (no repair call made)', async () => {
    callWithFallback.mockImplementation(async (_providers, prompt: string) => {
      const docType = promptDocType(prompt);

      if (docType === 'architecture') {
        return VALID_ARCHITECTURE_DOC;
      }

      return `Generated ${docType}.`;
    });

    await synthesize(SUMMARIES, REPO_META, FILES, SYMBOL_INDEX, NO_PROVIDERS, NO_RATE_LIMITERS, auditLog);

    // Exactly 3 calls total (readme, architecture, onboarding) — no 4th
    // repair call, since the architecture doc's diagram was already valid.
    expect(callWithFallback).toHaveBeenCalledTimes(3);
    expect(auditLog.some((entry) => entry.action === 'mermaid_repaired' || entry.action === 'mermaid_stripped')).toBe(
      false,
    );
  });
});
