import type { FileSummary, RepoInput, RepoMeta } from '@sleuth/core';
import { redactSecrets, runPipeline } from '@sleuth/core';
import chalk from 'chalk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import ora from 'ora';

const GITHUB_URL_PATTERN = /github\.com/i;
const CACHE_HIT_RATE_PATTERN = /Cache hit rate: ([\d.]+)%/;

// Resolved lazily (not a module-level constant) so tests can point HOME/
// USERPROFILE at a sandbox directory before invoking a command, without
// depending on import order.
export function getSessionDir(): string {
  return join(homedir(), '.sleuth');
}

export function getSessionFile(): string {
  return join(getSessionDir(), 'last-session.json');
}

export interface AnalyzeOptions {
  token?: string;
  maxFiles?: string;
  output?: string;
}

export interface LastSession {
  sandboxPath: string;
  repoMeta: RepoMeta;
  summaries: FileSummary[];
}

function buildRepoInput(target: string, token?: string): RepoInput {
  if (GITHUB_URL_PATTERN.test(target)) {
    return { type: 'github', url: target, pat: token };
  }

  return { type: 'local', path: target };
}

function persistLastSession(session: LastSession): void {
  mkdirSync(getSessionDir(), { recursive: true });
  writeFileSync(getSessionFile(), JSON.stringify(session, null, 2), 'utf-8');
}

function printSummaryBox(filesAnalyzed: number, cacheHitRate: string, durationMs: number): void {
  const lines = [
    `Files analyzed:   ${filesAnalyzed}`,
    `Cache hit rate:   ${cacheHitRate}`,
    `Duration:         ${(durationMs / 1000).toFixed(1)}s`,
  ];
  const width = Math.max(...lines.map((line) => line.length)) + 2;
  const border = '─'.repeat(width);

  console.log(chalk.green(`\n┌${border}┐`));

  for (const line of lines) {
    console.log(chalk.green('│ ') + line.padEnd(width - 1) + chalk.green('│'));
  }

  console.log(chalk.green(`└${border}┘\n`));
}

export async function runAnalyzeCommand(
  target: string,
  opts: { token?: string; maxFiles?: string; output?: string },
): Promise<void> {
  const repoInput = buildRepoInput(target, opts.token);
  const outputDir = opts.output ?? process.cwd();

  const spinner = ora('Starting analysis...').start();

  try {
    const result = await runPipeline(repoInput, {
      maxFiles: opts.maxFiles !== undefined ? Number(opts.maxFiles) : undefined,
      onProgress: (stage, detail) => {
        spinner.text = redactSecrets(detail !== undefined ? `${stage}: ${detail}` : stage);
      },
    });

    spinner.succeed('Analysis complete');

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'README.generated.md'), result.synthesis.readme, 'utf-8');
    writeFileSync(join(outputDir, 'ARCHITECTURE.md'), result.synthesis.architecture, 'utf-8');
    writeFileSync(join(outputDir, 'ONBOARDING.md'), result.synthesis.onboarding, 'utf-8');

    const cacheEntry = result.auditLog.find(
      (entry) => entry.stage === 'summarization' && CACHE_HIT_RATE_PATTERN.test(entry.detail),
    );
    const cacheMatch = cacheEntry !== undefined ? CACHE_HIT_RATE_PATTERN.exec(cacheEntry.detail) : null;
    const cacheHitRate = cacheMatch !== null ? `${cacheMatch[1]}%` : 'n/a';

    printSummaryBox(result.summaries.length, cacheHitRate, result.durationMs);

    persistLastSession({ sandboxPath: result.sandboxPath, repoMeta: result.meta, summaries: result.summaries });

    console.log(chalk.cyan("💡 Run `sleuth ask` to continue investigating this repo"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${redactSecrets(message)}`));
    process.exit(1);
  }
}
