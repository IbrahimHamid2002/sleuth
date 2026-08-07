import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real, network-hitting integration test — deliberately NOT part of the
// mocked unit-test suite in cli.test.ts (see CLAUDE.md §6: mocked dry-run
// first, real network/LLM calls only exercised deliberately afterward).
// Skips itself when no live keys are available (CI/contributors without
// keys configured) instead of failing the whole suite.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
// Small, stable, single-purpose public repo (one ~130-line source file plus
// README/package.json) — enough real content to exercise summarization and
// synthesis without a long-running clone/LLM pass.
const TARGET_REPO_URL = 'https://github.com/jonschlinkert/kind-of';
const BUILD_TIMEOUT_MS = 180_000;
// Generous: Groq's free-tier TPM budget (6000) is smaller than what 3
// *parallel* synthesis calls (~4-5.5k each incl. maxTokens=4000) demand at
// once, so a cold TokenBucketRateLimiter needs its full 65s hardWaitTimeoutMs
// escalation before falling through to OpenRouter/Gemini for calls that lose
// the race for budget — and documentation/synthesizer.ts's
// callWithRetryAndTimeout retries the whole provider chain up to
// DOC_SYNTHESIS_MAX_ATTEMPTS (3) times per doc, so when every provider is
// genuinely down (the invalid-key test below) that 65s wait can recur on
// each attempt, up to ~3x per doc. This is real, observed pipeline behavior
// (see prompts.md's executive summary), not test flakiness, and happens even
// with invalid keys since the local budget check runs before any HTTP
// call/auth failure.
const CHILD_TIMEOUT_MS = 280_000;
const ANALYZE_AND_ASK_TEST_TIMEOUT_MS = 2 * CHILD_TIMEOUT_MS + 40_000;
const ANALYZE_ONLY_TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 40_000;

function loadDotEnvIntoProcessEnv(envFilePath: string): void {
  if (!existsSync(envFilePath)) {
    return;
  }

  for (const line of readFileSync(envFilePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIntoProcessEnv(join(REPO_ROOT, '.env'));

const hasLiveKeys =
  (process.env.GROQ_SUMMARIZER_API_KEY ?? '') !== '' &&
  (process.env.GROQ_SYNTHESIZER_API_KEY ?? '') !== '' &&
  (process.env.GROQ_DEEP_DIVE_AGENT_API_KEY ?? '') !== '';

interface LastSessionOnDisk {
  sandboxPath: string;
  summaries: Array<{ path: string; purpose: string; summary: string }>;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      env,
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    });

    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const asExecError = err as { status?: number; stdout?: string; stderr?: string; message: string };

    return {
      status: asExecError.status ?? 1,
      stdout: asExecError.stdout ?? '',
      stderr: asExecError.stderr ?? asExecError.message,
    };
  }
}

function isolatedHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readLastSession(homeDir: string): LastSessionOnDisk {
  return JSON.parse(readFileSync(join(homeDir, '.sleuth', 'last-session.json'), 'utf-8')) as LastSessionOnDisk;
}

function cleanupSandboxIfPresent(sandboxPath: string | undefined): void {
  if (sandboxPath !== undefined && existsSync(sandboxPath)) {
    rmSync(sandboxPath, { recursive: true, force: true });
  }
}

describe.skipIf(!hasLiveKeys)('sleuth analyze — real CLI E2E', () => {
  beforeAll(() => {
    execSync('npm run build -w @sleuth/core -w @sleuth/cli', { cwd: REPO_ROOT, stdio: 'pipe' });
  }, BUILD_TIMEOUT_MS);

  it(
    'runs the live LLM path against a real public repo and generates non-placeholder docs, then answers a Deep Dive question',
    () => {
      const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-e2e-out-'));
      const homeDir = isolatedHome('sleuth-e2e-home-');
      let sandboxPath: string | undefined;

      try {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };

        const analyzeResult = runCli(['analyze', TARGET_REPO_URL, '--output', outputDir, '--max-files', '5'], env);

        expect(analyzeResult.status, `analyze exited non-zero:\n${analyzeResult.stderr}`).toBe(0);

        const generatedFiles = ['README.generated.md', 'ARCHITECTURE.md', 'ONBOARDING.md'];

        for (const fileName of generatedFiles) {
          const filePath = join(outputDir, fileName);

          expect(existsSync(filePath), `${fileName} was not generated`).toBe(true);

          const content = readFileSync(filePath, 'utf-8');

          expect(content.length).toBeGreaterThan(0);
          // Literal string requested for this check — verified absent, though
          // the codebase's actual placeholder text differs (see next assertions).
          expect(content).not.toContain('No summary generated');
          // The real fallback marker used by documentation/synthesizer.ts
          // (generateReadmeFallback/generateArchitectureFallback/
          // generateOnboardingFallback) when the AI-generated doc could not be
          // produced — its absence is what actually proves the live LLM path
          // ran successfully rather than silently degrading.
          expect(content).not.toContain('generated by a deterministic fallback');
        }

        // Product decision: README.generated.md no longer carries a License
        // section (license detection never worked — see prompts.md) or a
        // Project Structure section (duplicated ARCHITECTURE.md's own
        // Directory Structure section verbatim).
        const readmeContent = readFileSync(join(outputDir, 'README.generated.md'), 'utf-8');

        expect(readmeContent).not.toContain('## License');
        expect(readmeContent).not.toContain('## Project Structure');

        const session = readLastSession(homeDir);

        sandboxPath = session.sandboxPath;

        expect(session.summaries.length).toBeGreaterThan(0);

        const placeholderSummaries = session.summaries.filter(
          (summary) => summary.purpose === 'Could not summarize' && summary.summary === 'Parse error',
        );

        // A handful of individual per-file placeholder fallbacks (documentation/
        // summarizer.ts's fallbackSummary) are an acceptable, tracked partial
        // failure per CLAUDE.md §2 rule 5 — but the live LLM path must not
        // degrade to placeholders across the board.
        expect(placeholderSummaries.length).toBeLessThan(session.summaries.length);

        const askResult = runCli(
          ['ask', 'How does this library distinguish a Buffer from a typed array like Uint8Array?'],
          env,
        );

        expect(askResult.status, `ask exited non-zero:\n${askResult.stderr}`).toBe(0);
        expect(askResult.stdout).toContain('Answer:');
        expect(askResult.stdout.split('Answer:')[1]?.trim().length).toBeGreaterThan(0);
      } finally {
        cleanupSandboxIfPresent(sandboxPath);
        rmSync(outputDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
    ANALYZE_AND_ASK_TEST_TIMEOUT_MS,
  );

  it(
    'falls through to the deterministic-fallback docs (not a crash) when every configured LLM key is invalid',
    () => {
      const outputDir = mkdtempSync(join(tmpdir(), 'sleuth-e2e-fallback-out-'));
      const homeDir = isolatedHome('sleuth-e2e-fallback-home-');
      let sandboxPath: string | undefined;

      try {
        // Deliberately invalid but non-empty values: non-empty keeps
        // ensureGroqApiKey from prompting interactively (which would hang a
        // spawned subprocess with no stdin), while every real provider call
        // 401s, forcing summarizer/synthesizer through their deterministic
        // fallback paths (CLAUDE.md §2 rule 5) using a real GitHub clone.
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          GROQ_SUMMARIZER_API_KEY: 'invalid-test-key',
          GROQ_SYNTHESIZER_API_KEY: 'invalid-test-key',
          GROQ_DEEP_DIVE_AGENT_API_KEY: 'invalid-test-key',
          OPENROUTER_API_KEY: 'invalid-test-key',
          GEMINI_API_KEY: 'invalid-test-key',
        };

        const analyzeResult = runCli(['analyze', TARGET_REPO_URL, '--output', outputDir, '--max-files', '5'], env);

        expect(
          analyzeResult.status,
          `analyze should still exit 0 via the deterministic fallback, got:\n${analyzeResult.stderr}`,
        ).toBe(0);

        for (const fileName of ['README.generated.md', 'ARCHITECTURE.md', 'ONBOARDING.md']) {
          const content = readFileSync(join(outputDir, fileName), 'utf-8');

          expect(content).toContain('generated by a deterministic fallback');
        }

        const session = readLastSession(homeDir);

        sandboxPath = session.sandboxPath;

        expect(session.summaries.every((summary) => summary.purpose === 'Could not summarize')).toBe(true);
      } finally {
        cleanupSandboxIfPresent(sandboxPath);
        rmSync(outputDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
    ANALYZE_ONLY_TEST_TIMEOUT_MS,
  );
});

afterAll(() => {
  // Defensive backstop: if either test above threw before its own finally
  // could run, sweep any sleuth-e2e-* temp dirs this file created — this
  // must never leave a temp clone directory behind (CLAUDE.md §4 rule 1).
  const base = tmpdir();

  for (const entry of readdirSync(base)) {
    if (entry.startsWith('sleuth-e2e-')) {
      rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
});
