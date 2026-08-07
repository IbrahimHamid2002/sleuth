import type { RepoInput } from '@sleuth/core';
import { redactSecrets, runPipeline } from '@sleuth/core';
import chalk from 'chalk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import ora from 'ora';

import { ensureGroqApiKey } from './config';
import { ANALYZE_CACHE_HIT_COUNT_PATTERN, ANALYZE_CACHE_HIT_RATE_PATTERN, ANALYZE_GITHUB_URL_PATTERN } from './constants';
import type { LastSession } from './types';

export type { AnalyzeOptions, LastSession } from './types';

// Resolved lazily (not a module-level constant) so tests can point HOME/
// USERPROFILE at a sandbox directory before invoking a command, without
// depending on import order.
export function getSessionDir(): string {
  return join(homedir(), '.sleuth');
}

export function getSessionFile(): string {
  return join(getSessionDir(), 'last-session.json');
}

function buildRepoInput(target: string, token?: string): RepoInput {
  if (ANALYZE_GITHUB_URL_PATTERN.test(target)) {
    return { type: 'github', url: target, pat: token };
  }

  return { type: 'local', path: target };
}

function persistLastSession(session: LastSession): void {
  mkdirSync(getSessionDir(), { recursive: true });
  writeFileSync(getSessionFile(), JSON.stringify(session, null, 2), 'utf-8');
}

function printSummaryBox(filesAnalyzed: number, cacheHitRate: string, failedFileCount: number, durationMs: number): void {
  const lines = [
    `Files analyzed:   ${filesAnalyzed}`,
    `Cache hit rate:   ${cacheHitRate}`,
    `Duration:         ${(durationMs / 1000).toFixed(1)}s`,
  ];

  if (failedFileCount > 0) {
    lines.push(`Partial issues:   ${failedFileCount} file(s) could not be summarized (see below)`);
  }

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
  opts: { token?: string; maxFiles?: string; output?: string; resume?: boolean },
): Promise<void> {
  const repoInput = buildRepoInput(target, opts.token);
  const outputDir = opts.output ?? process.cwd();

  await ensureGroqApiKey('GROQ_SUMMARIZER_API_KEY');

  const spinner = ora(
    opts.resume === true ? 'Resuming previous run (reusing any cached file summaries)...' : 'Starting analysis...',
  ).start();

  // Core logs stray console.warn lines (e.g. a missing LLM API key) while the
  // pipeline runs, independent of the spinner — without clearing the
  // spinner's line first, ora's redraw and the warning interleave into garbled output.
  const originalWarn = console.warn;

  console.warn = (...args: Parameters<typeof console.warn>): void => {
    spinner.clear();
    originalWarn(...args);
  };

  try {
    const result = await runPipeline(repoInput, {
      maxFiles: opts.maxFiles !== undefined ? Number(opts.maxFiles) : undefined,
      onProgress: (stage, detail) => {
        // Duration alone is never treated as failure (see pipeline.ts's stall
        // watchdog) — this text is purely informational so the user can see
        // the run progressing, however long a large repo legitimately takes.
        spinner.text = redactSecrets(detail !== undefined ? `${stage}: ${detail}` : stage);
      },
    });

    spinner.succeed('Analysis complete');

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'README.generated.md'), result.synthesis.readme, 'utf-8');
    writeFileSync(join(outputDir, 'ARCHITECTURE.md'), result.synthesis.architecture, 'utf-8');
    writeFileSync(join(outputDir, 'ONBOARDING.md'), result.synthesis.onboarding, 'utf-8');

    const cacheEntry = result.auditLog.find(
      (entry) => entry.stage === 'summarization' && ANALYZE_CACHE_HIT_RATE_PATTERN.test(entry.detail),
    );
    const cacheRateMatch = cacheEntry !== undefined ? ANALYZE_CACHE_HIT_RATE_PATTERN.exec(cacheEntry.detail) : null;
    const cacheHitRate = cacheRateMatch !== null ? `${cacheRateMatch[1]}%` : 'n/a';
    const cacheCountMatch = cacheEntry !== undefined ? ANALYZE_CACHE_HIT_COUNT_PATTERN.exec(cacheEntry.detail) : null;
    const cacheHitCount = cacheCountMatch !== null ? Number(cacheCountMatch[1]) : 0;

    printSummaryBox(result.summaries.length, cacheHitRate, result.failedFiles.length, result.durationMs);

    if (result.failedFiles.length > 0) {
      console.log(chalk.yellow(`⚠ ${result.failedFiles.length} file(s) could not be summarized and used a placeholder instead:`));

      for (const path of result.failedFiles) {
        console.log(chalk.yellow(`  - ${redactSecrets(path)}`));
      }

      console.log(chalk.dim('  (the rest of the analysis completed normally — re-run to retry just these)\n'));
    }

    // Caching (and therefore resuming) is always on — `--resume` only makes
    // it visible/confirmable, it never gates the underlying behavior, so a
    // user who forgets the flag after an interruption still benefits from it.
    if (opts.resume === true) {
      if (cacheHitCount > 0) {
        console.log(chalk.cyan(`↻ Resumed: ${cacheHitCount} file(s) reused from a previous run, no re-summarization needed.`));
      } else {
        console.log(chalk.yellow('⚠ --resume was passed, but no cached progress was found for this target — this ran as a fresh analysis.'));
      }
    }

    persistLastSession({
      sandboxPath: result.sandboxPath,
      repoMeta: result.meta,
      summaries: result.summaries,
      synthesis: result.synthesis,
    });

    console.log(chalk.cyan("💡 Run `sleuth ask` to continue investigating this repo"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${redactSecrets(message)}`));

    if (/stalled/i.test(message)) {
      console.error(chalk.dim('  This means the run made no progress at all for a while, not that it was simply slow.'));
    }

    console.error(
      chalk.dim(
        '  Any files already summarized before this were cached — re-run the same command to resume from where it left off (or add --resume to confirm).',
      ),
    );

    process.exit(1);
  } finally {
    console.warn = originalWarn;
  }
}
