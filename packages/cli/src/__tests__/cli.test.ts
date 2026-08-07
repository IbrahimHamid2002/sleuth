import * as core from '@sleuth/core';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ora from 'ora';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionFile, runAnalyzeCommand } from '../analyze';
import { runAskCommand } from '../ask';
import { getConfigFile, hydrateEnvFromConfig, readConfig, runConfigListCommand, runConfigSetCommand } from '../config';

vi.mock('ora', () => {
  const spinner = {
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    clear: vi.fn(),
    text: '',
  };

  spinner.start.mockReturnValue(spinner);

  return { default: vi.fn(() => spinner) };
});

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

vi.mock('@sleuth/core', async () => {
  const actual = await vi.importActual<typeof import('@sleuth/core')>('@sleuth/core');

  return { ...actual, runPipeline: vi.fn(), investigate: vi.fn() };
});

const runPipeline = vi.mocked(core.runPipeline);
const investigate = vi.mocked(core.investigate);
const promptMock = vi.mocked(inquirer.prompt);

let homeDir: string;
let previousUserProfile: string | undefined;
let previousHome: string | undefined;
let previousGeminiKey: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

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

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-home-'));
  previousUserProfile = process.env.USERPROFILE;
  previousHome = process.env.HOME;
  previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  // A fallback key is always "available" by default so ensureGroqApiKey never
  // prompts mid-test unless a test explicitly unsets it to exercise that path.
  process.env.GEMINI_API_KEY = 'test-gemini-fallback-key';

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });

  if (previousUserProfile !== undefined) {
    process.env.USERPROFILE = previousUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }

  if (previousHome !== undefined) {
    process.env.HOME = previousHome;
  } else {
    delete process.env.HOME;
  }

  if (previousGeminiKey !== undefined) {
    process.env.GEMINI_API_KEY = previousGeminiKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }

  vi.clearAllMocks();
});

describe('runAnalyzeCommand', () => {
  it('writes README/ARCHITECTURE/ONBOARDING to the expected output dir', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [
        { timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'Cache hit rate: 50.0% (1/2 files served from cache)' },
      ],
      sandboxPath,
      durationMs: 4200,
      failedFiles: [],
    });

    await runAnalyzeCommand('https://github.com/foo/bar', { output: outputDir });

    expect(readFileSync(join(outputDir, 'README.generated.md'), 'utf-8')).toBe('# README');
    expect(readFileSync(join(outputDir, 'ARCHITECTURE.md'), 'utf-8')).toBe('# ARCHITECTURE');
    expect(readFileSync(join(outputDir, 'ONBOARDING.md'), 'utf-8')).toBe('# ONBOARDING');
    expect(exitSpy).not.toHaveBeenCalled();

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('persists last-session.json with sandboxPath, repoMeta, and summaries', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));
    const meta = fakeRepoMeta();
    const summaries = fakeSummaries();

    runPipeline.mockResolvedValue({
      meta,
      summaries,
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [],
      sandboxPath,
      durationMs: 100,
      failedFiles: [],
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir });

    const persisted = JSON.parse(readFileSync(getSessionFile(), 'utf-8')) as {
      sandboxPath: string;
      repoMeta: core.RepoMeta;
      summaries: core.FileSummary[];
      synthesis: core.SynthesisResult;
    };

    expect(persisted.sandboxPath).toBe(sandboxPath);
    expect(persisted.repoMeta).toEqual(meta);
    expect(persisted.summaries).toEqual(summaries);
    expect(persisted.synthesis).toEqual({ readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' });

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('reports failedFiles as a partial-issue warning, not a pipeline failure', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [
        { timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'Cache hit rate: 0.0% (0/2 files served from cache)' },
      ],
      sandboxPath,
      durationMs: 4200,
      failedFiles: ['src/broken.ts'],
    });

    await runAnalyzeCommand('https://github.com/foo/bar', { output: outputDir });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('src/broken.ts');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Partial issues');

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('reports a resumed run when --resume is passed and cached files were reused', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [
        { timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'Cache hit rate: 100.0% (5/5 files served from cache)' },
      ],
      sandboxPath,
      durationMs: 100,
      failedFiles: [],
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir, resume: true });

    expect(logSpy.mock.calls.flat().join('\n')).toContain('Resumed: 5 file(s)');

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('warns when --resume is passed but nothing was actually cached', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [
        { timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'Cache hit rate: 0.0% (0/5 files served from cache)' },
      ],
      sandboxPath,
      durationMs: 100,
      failedFiles: [],
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir, resume: true });

    expect(logSpy.mock.calls.flat().join('\n')).toContain('ran as a fresh analysis');

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('does not mention resuming at all when --resume is not passed', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [
        { timestamp: Date.now(), stage: 'summarization', action: 'complete', detail: 'Cache hit rate: 100.0% (5/5 files served from cache)' },
      ],
      sandboxPath,
      durationMs: 100,
      failedFiles: [],
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir });

    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Resumed');

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('surfaces a stall-specific hint (not just "Analysis failed") when the pipeline reports a stall', async () => {
    runPipeline.mockRejectedValue(new Error('Pipeline stalled — no progress for 90s (treating as stuck, not slow)'));

    await runAnalyzeCommand('/local/path/bar', {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('made no progress at all');
  });
});

describe('runAskCommand', () => {
  it('prints guidance and exits(1) when no prior session exists', async () => {
    await runAskCommand();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sleuth analyze'));
    expect(investigate).not.toHaveBeenCalled();
  });

  it("terminates cleanly and deletes last-session.json on a scripted 'exit' input", async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries() }, null, 2),
      'utf-8',
    );

    promptMock.mockResolvedValueOnce({ answer: 'exit' });

    await runAskCommand();

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(investigate).not.toHaveBeenCalled();
    expect(existsSync(getSessionFile())).toBe(false);
    expect(existsSync(sandboxPath)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Session ended'));
  });

  it('carries the persisted synthesis docs from last-session.json into the Deep Dive session', async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));
    const synthesis = { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' };

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries(), synthesis }, null, 2),
      'utf-8',
    );

    investigate.mockResolvedValue({
      question: 'q',
      answer: 'a',
      plan: 'p',
      iterations: 0,
      filesExamined: [],
      answeredFromDocs: true,
      reasoningTrace: [],
    });

    await runAskCommand('What does this do?');

    expect(investigate).toHaveBeenCalledTimes(1);

    const sessionArg = investigate.mock.calls[0]?.[1] as core.DeepDiveSession;

    expect(sessionArg.generatedDocs).toEqual(synthesis);

    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('tells the user when a single-shot answer came straight from the pre-generated docs', async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries() }, null, 2),
      'utf-8',
    );

    investigate.mockResolvedValue({
      question: 'q',
      answer: 'It is an Express API.',
      plan: 'p',
      iterations: 0,
      filesExamined: [],
      answeredFromDocs: true,
      reasoningTrace: [],
    });

    await runAskCommand('What kind of project is this?');

    expect(logSpy.mock.calls.flat().join('\n')).toContain('Answered from existing analysis documents');

    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('renders live status events (fast-path check, progress nudge, tool calls) as they fire, not just at the end', async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries() }, null, 2),
      'utf-8',
    );

    investigate.mockImplementation(async (_question, _session, _providers, _rateLimiters, onEvent) => {
      onEvent?.({ type: 'fast_path_check', data: { message: 'Checking existing analysis documents before searching source...' } });
      onEvent?.({ type: 'progress', data: { message: 'Still working on this — it is taking a bit longer than usual...' } });
      onEvent?.({ type: 'tool_call', data: { toolName: 'read_file', toolArgs: { path: 'src/index.ts' } } });

      return {
        question: 'q',
        answer: 'a',
        plan: 'p',
        iterations: 2,
        filesExamined: ['src/index.ts'],
        answeredFromDocs: false,
        reasoningTrace: [],
      };
    });

    await runAskCommand('A complex question');

    const output = logSpy.mock.calls.flat().join('\n');

    expect(output).toContain('Checking existing analysis documents');
    expect(output).toContain('Still working on this');
    expect(output).toContain('read_file');

    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('fails cleanly (no unhandled crash) with a specific message on a genuine single-shot investigation error', async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries() }, null, 2),
      'utf-8',
    );

    investigate.mockRejectedValue(new Error('All LLM providers failed: groq: rate limit exceeded'));

    await expect(runAskCommand('A question')).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('rate limit exceeded');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('rate limit/quota issue');

    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('does not kill the interactive REPL session when one question fails — the loop continues', async () => {
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    mkdirSync(join(homeDir, '.sleuth'), { recursive: true });
    writeFileSync(
      getSessionFile(),
      JSON.stringify({ sandboxPath, repoMeta: fakeRepoMeta(), summaries: fakeSummaries() }, null, 2),
      'utf-8',
    );

    investigate.mockRejectedValueOnce(new Error('Deep Dive investigation made no progress for 60s (treating as stuck, not slow)'));
    promptMock.mockResolvedValueOnce({ answer: 'a failing question' }).mockResolvedValueOnce({ answer: 'exit' });

    await runAskCommand();

    expect(investigate).toHaveBeenCalledTimes(1);
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('stopped making progress');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Session ended'));

    rmSync(sandboxPath, { recursive: true, force: true });
  });
});

describe('config', () => {
  it('runConfigSetCommand persists a key, and runConfigListCommand shows it masked', () => {
    runConfigSetCommand('GROQ_SUMMARIZER_API_KEY', 'gsk_abcdefghijklmnop');

    expect(readConfig().GROQ_SUMMARIZER_API_KEY).toBe('gsk_abcdefghijklmnop');
    expect(existsSync(getConfigFile())).toBe(true);

    runConfigListCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('GROQ_SUMMARIZER_API_KEY'));
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('gsk_abcdefghijklmnop');
  });

  it('runConfigSetCommand rejects an unknown key and exits(1)', () => {
    runConfigSetCommand('NOT_A_REAL_KEY', 'whatever');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    expect((readConfig() as Record<string, string>).NOT_A_REAL_KEY).toBeUndefined();
  });

  it('hydrateEnvFromConfig fills process.env from the persisted config without overriding an already-set var', () => {
    runConfigSetCommand('GROQ_SUMMARIZER_API_KEY', 'from-config');
    runConfigSetCommand('GROQ_SYNTHESIZER_API_KEY', 'from-config-too');
    process.env.GROQ_SYNTHESIZER_API_KEY = 'already-exported';

    hydrateEnvFromConfig();

    expect(process.env.GROQ_SUMMARIZER_API_KEY).toBe('from-config');
    expect(process.env.GROQ_SYNTHESIZER_API_KEY).toBe('already-exported');

    delete process.env.GROQ_SUMMARIZER_API_KEY;
    delete process.env.GROQ_SYNTHESIZER_API_KEY;
  });

  it('runAnalyzeCommand prompts once for each missing key when none is available anywhere, and persists each entered value under its own name', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_SUMMARIZER_API_KEY;
    delete process.env.GROQ_SYNTHESIZER_API_KEY;
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;

    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));

    promptMock.mockResolvedValueOnce({
      GROQ_SUMMARIZER_API_KEY: 'summarizer-key',
      GROQ_SYNTHESIZER_API_KEY: 'synthesizer-key',
      GROQ_DEEP_DIVE_AGENT_API_KEY: 'agent-key',
      GEMINI_API_KEY: '',
    });
    runPipeline.mockResolvedValue({
      meta: fakeRepoMeta(),
      summaries: fakeSummaries(),
      synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
      symbolIndex: new Map(),
      auditLog: [],
      sandboxPath,
      durationMs: 50,
      failedFiles: [],
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir });

    expect(promptMock).toHaveBeenCalledTimes(1);
    const askedNames = promptMock.mock.calls[0]?.[0];

    expect(Array.isArray(askedNames) ? askedNames.map((q: { name: string }) => q.name) : []).toEqual([
      'GROQ_SUMMARIZER_API_KEY',
      'GROQ_SYNTHESIZER_API_KEY',
      'GROQ_DEEP_DIVE_AGENT_API_KEY',
      'GEMINI_API_KEY',
    ]);
    expect(process.env.GROQ_SUMMARIZER_API_KEY).toBe('summarizer-key');
    expect(process.env.GROQ_SYNTHESIZER_API_KEY).toBe('synthesizer-key');
    expect(process.env.GROQ_DEEP_DIVE_AGENT_API_KEY).toBe('agent-key');
    expect(readConfig().GROQ_SUMMARIZER_API_KEY).toBe('summarizer-key');
    expect(readConfig().GROQ_SYNTHESIZER_API_KEY).toBe('synthesizer-key');
    expect(readConfig().GROQ_DEEP_DIVE_AGENT_API_KEY).toBe('agent-key');
    // Blank answer for the optional Gemini key is never persisted.
    expect(readConfig().GEMINI_API_KEY).toBeUndefined();

    delete process.env.GROQ_SUMMARIZER_API_KEY;
    delete process.env.GROQ_SYNTHESIZER_API_KEY;
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });

  it('clears the spinner before a console.warn fired mid-pipeline, and restores console.warn afterward', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-cli-out-'));
    const sandboxPath = mkdtempSync(join(tmpdir(), 'sleuth-cli-sandbox-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runPipeline.mockImplementation(async () => {
      console.warn('GEMINI_API_KEY is not set — skipping Gemini provider');

      return {
        meta: fakeRepoMeta(),
        summaries: fakeSummaries(),
        synthesis: { readme: '# README', architecture: '# ARCHITECTURE', onboarding: '# ONBOARDING' },
        symbolIndex: new Map(),
        auditLog: [],
        sandboxPath,
        durationMs: 10,
        failedFiles: [],
      };
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir });

    const spinner = vi.mocked(ora)();

    expect(spinner.clear).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('GEMINI_API_KEY is not set — skipping Gemini provider');
    expect(console.warn).toBe(warnSpy);

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
  });
});
