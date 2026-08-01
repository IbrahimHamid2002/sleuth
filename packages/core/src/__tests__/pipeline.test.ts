import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MERMAID_DISCLAIMER } from '../documentation/synthesizer';
import * as providerModule from '../llm/provider';
import { runPipeline } from '../pipeline';

vi.mock('../llm/provider', async () => {
  const actual = await vi.importActual<typeof providerModule>('../llm/provider');

  return { ...actual, callWithFallback: vi.fn(), createProviderChain: vi.fn(actual.createProviderChain) };
});

const callWithFallback = vi.mocked(providerModule.callWithFallback);
const createProviderChain = vi.mocked(providerModule.createProviderChain);

function buildFixtureRepo(rootDir: string): void {
  mkdirSync(join(rootDir, 'src', 'routes'), { recursive: true });
  mkdirSync(join(rootDir, 'src', 'utils'), { recursive: true });

  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture-repo', dependencies: { express: '^4.18.0' } }, null, 2),
  );
  writeFileSync(join(rootDir, 'tsconfig.json'), '{}');
  writeFileSync(join(rootDir, 'README.md'), '# Fixture Repo\n');
  writeFileSync(
    join(rootDir, 'src', 'index.ts'),
    "import { createApp } from './app';\n\nconst app = createApp();\napp.listen(3000);\n",
  );
  writeFileSync(
    join(rootDir, 'src', 'app.ts'),
    "import express from 'express';\nimport { usersRouter } from './routes/users';\n\nexport function createApp() {\n  const app = express();\n  app.use('/users', usersRouter);\n  return app;\n}\n",
  );
  writeFileSync(
    join(rootDir, 'src', 'routes', 'users.ts'),
    "import { Router } from 'express';\n\nexport const usersRouter = Router();\n\nusersRouter.get('/', (req, res) => {\n  res.json([]);\n});\n",
  );
  writeFileSync(
    join(rootDir, 'src', 'utils', 'helper.ts'),
    'export function helper(x: number): number {\n  return x * 2;\n}\n',
  );
}

function mockLlmResponses(): void {
  callWithFallback.mockImplementation(async (_providers, prompt: string) => {
    if (prompt.includes('--- FILE:')) {
      const paths = [...prompt.matchAll(/--- FILE: (.+?) ---/g)].map((match) => match[1]);

      return JSON.stringify(
        paths.map((path) => ({
          path,
          purpose: `purpose for ${path}`,
          exports: [],
          dependencies: [],
          summary: `summary for ${path}`,
        })),
      );
    }

    if (prompt.includes('README.md')) {
      return 'Generated README referencing `createApp`.';
    }

    if (prompt.includes('ARCHITECTURE.md')) {
      return `${MERMAID_DISCLAIMER}\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\nGenerated architecture referencing \`createApp\`.`;
    }

    return 'Generated onboarding referencing `createApp`.';
  });
}

describe('runPipeline', () => {
  let fixtureDir: string;
  let createdSandboxPaths: string[];
  const originalGroqSummarizerKey = process.env.GROQ_SUMMARIZER_API_KEY;
  const originalGroqSynthesizerKey = process.env.GROQ_SYNTHESIZER_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'sleuth-pipeline-fixture-'));
    createdSandboxPaths = [];
    buildFixtureRepo(fixtureDir);
    callWithFallback.mockReset();
    createProviderChain.mockClear();
    mockLlmResponses();
    process.env.GROQ_SUMMARIZER_API_KEY = 'test-groq-summarizer-key';
    process.env.GROQ_SYNTHESIZER_API_KEY = 'test-groq-synthesizer-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });

    for (const sandboxPath of createdSandboxPaths) {
      rmSync(sandboxPath, { recursive: true, force: true });
    }

    process.env.GROQ_SUMMARIZER_API_KEY = originalGroqSummarizerKey;
    process.env.GROQ_SYNTHESIZER_API_KEY = originalGroqSynthesizerKey;
    process.env.GEMINI_API_KEY = originalGeminiKey;
  });

  it('builds separate provider chains for summarization and synthesis, not a shared one', async () => {
    const result = await runPipeline({ type: 'local', path: fixtureDir }, { skipCache: true });

    createdSandboxPaths.push(result.sandboxPath);

    expect(createProviderChain).toHaveBeenCalledWith('summarizer');
    expect(createProviderChain).toHaveBeenCalledWith('synthesizer');
    expect(createProviderChain).toHaveBeenCalledTimes(2);
  });

  it('produces meta, summaries, and all 3 synthesis documents for a full run', async () => {
    const onProgress = vi.fn();

    const result = await runPipeline({ type: 'local', path: fixtureDir }, { skipCache: true, onProgress });

    createdSandboxPaths.push(result.sandboxPath);

    expect(result.meta.name).toBe(basename(fixtureDir));
    expect(result.meta.frameworks).toContain('express');
    expect(result.meta.subProjects[0]?.entryPoints).toContain('src/index.ts');

    expect(result.summaries).toHaveLength(7);
    expect(result.summaries.every((summary) => summary.summary.length > 0)).toBe(true);

    expect(result.synthesis.readme).toContain('createApp');
    expect(result.synthesis.architecture.startsWith(MERMAID_DISCLAIMER)).toBe(true);
    expect(result.synthesis.onboarding).toContain('createApp');

    expect(result.symbolIndex.get('createApp')?.[0]?.path).toBe('src/app.ts');

    expect(onProgress).toHaveBeenCalledWith('validate', expect.any(String));
    expect(onProgress).toHaveBeenCalledWith('synthesis', expect.any(String));

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs an audit entry for each major pipeline stage', async () => {
    const result = await runPipeline({ type: 'local', path: fixtureDir }, { skipCache: true });

    createdSandboxPaths.push(result.sandboxPath);

    const stages = new Set(result.auditLog.map((entry) => entry.stage));
    const expectedStages = [
      'validation',
      'sandbox',
      'ingestion',
      'framework-detection',
      'discovery',
      'indexing',
      'prioritization',
      'summarization',
      'synthesis',
    ];

    for (const expectedStage of expectedStages) {
      expect(stages.has(expectedStage)).toBe(true);
    }
  });

  it('cleans up the sandbox and leaves no orphaned temp directory when ingestion fails', async () => {
    const sandboxRoot = join(tmpdir(), 'sleuth');
    const before = existsSync(sandboxRoot) ? readdirSync(sandboxRoot) : [];
    const missingPath = join(tmpdir(), 'sleuth-pipeline-does-not-exist', randomUUID());

    await expect(runPipeline({ type: 'local', path: missingPath })).rejects.toThrow(
      'Local path does not exist or is not a directory',
    );

    const after = existsSync(sandboxRoot) ? readdirSync(sandboxRoot) : [];

    expect(after).toEqual(before);
  });

  it('does not clean up the sandbox after a successful run, leaving it for a Deep Dive follow-up', async () => {
    const result = await runPipeline({ type: 'local', path: fixtureDir }, { skipCache: true });

    createdSandboxPaths.push(result.sandboxPath);

    expect(existsSync(result.sandboxPath)).toBe(true);
    expect(existsSync(join(result.sandboxPath, 'src', 'app.ts'))).toBe(true);
  });
});
