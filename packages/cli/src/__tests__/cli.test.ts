import * as core from '@sleuth/core';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionFile, runAnalyzeCommand } from '../analyze';
import { runAskCommand } from '../ask';

vi.mock('ora', () => {
  const spinner = {
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
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
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;

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
    });

    await runAnalyzeCommand('/local/path/bar', { output: outputDir });

    const persisted = JSON.parse(readFileSync(getSessionFile(), 'utf-8')) as {
      sandboxPath: string;
      repoMeta: core.RepoMeta;
      summaries: core.FileSummary[];
    };

    expect(persisted.sandboxPath).toBe(sandboxPath);
    expect(persisted.repoMeta).toEqual(meta);
    expect(persisted.summaries).toEqual(summaries);

    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sandboxPath, { recursive: true, force: true });
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
});
