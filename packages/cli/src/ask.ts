import type { DeepDiveSession, InvestigationResult } from '@sleuth/core';
import { buildDeepDiveAgentProviders, buildDeepDiveAgentRateLimiters, createSession, investigate, redactSecrets, terminateSession } from '@sleuth/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { getSessionFile } from './analyze';
import { ensureGroqApiKey } from './config';
import { ASK_EXIT_WORDS } from './constants';
import type { LastSession } from './types';

function loadLastSession(): LastSession | undefined {
  const sessionFile = getSessionFile();

  if (!existsSync(sessionFile)) {
    return undefined;
  }

  try {
    const raw = readFileSync(sessionFile, 'utf-8');

    return JSON.parse(raw) as LastSession;
  } catch {
    return undefined;
  }
}

function renderAnswer(result: InvestigationResult): void {
  if (result.answeredFromDocs) {
    console.log(chalk.cyan('\n⚡ Answered from existing analysis documents (no source investigation needed).'));
  } else if (result.answeredFromSummaries) {
    console.log(chalk.cyan('\n⚡ Answered from file summaries (short question, no full investigation needed).'));
  }

  console.log(chalk.green('\nAnswer: ') + result.answer + '\n');
}

// "Made no progress for a while" and "genuinely failed" must read
// differently to the user (same principle as pipeline.ts's stall watchdog) —
// any failure must show a clean message, never an unhandled stack trace.
function renderInvestigationError(err: unknown): void {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));

  console.error(chalk.red(`Error: ${message}`));

  if (/made no progress|stuck/i.test(message)) {
    console.error(chalk.dim('  This means the investigation stopped making progress, not that it was simply slow.'));
  } else if (/rate.?limit|quota/i.test(message)) {
    console.error(chalk.dim('  This looks like an LLM provider rate limit/quota issue — try again once it resets.'));
  }
}

function renderReasoningTrace(result: InvestigationResult): void {
  if (result.answeredFromDocs || result.answeredFromSummaries) {
    renderAnswer(result);

    return;
  }

  console.log(chalk.dim(`\nPlan: ${result.plan}`));

  result.reasoningTrace.forEach((step, index) => {
    console.log(chalk.yellow(`\n[${index + 1}] Thought: `) + step.thought);
    console.log(chalk.blue('    Tool: ') + `${step.toolName}(${JSON.stringify(step.toolArgs)})`);
    console.log(chalk.gray('    Observation: ') + step.observation);
  });

  renderAnswer(result);
}

// Fired as the investigation actually progresses (fast-path check, "still
// working" nudges, each tool call) so the user has visible confidence
// something is happening, not silence until the final answer or a timeout.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: mirrors AgentEvent's own `data: any` in core (see investigator.ts) — payload shape genuinely varies per event type
function renderLiveStatus(event: { type: string; data: any }): void {
  switch (event.type) {
    case 'fast_path_check':
    case 'fast_path_miss':
    case 'simple_query_check':
    case 'simple_query_miss':
      console.log(chalk.dim(`🔎 ${event.data.message}`));
      break;
    case 'fast_path_hit':
    case 'simple_query_hit':
    case 'progress':
      console.log(chalk.dim(`⏳ ${event.data.message}`));
      break;
    case 'tool_call':
      console.log(chalk.dim(`   → ${event.data.toolName}(${JSON.stringify(event.data.toolArgs)})`));
      break;
    default:
      break;
  }
}

export async function runAskCommand(question?: string): Promise<void> {
  const lastSession = loadLastSession();

  if (lastSession === undefined || !existsSync(lastSession.sandboxPath)) {
    console.error(chalk.red('Error: no active session found. Run `sleuth analyze <target>` first.'));
    process.exit(1);

    return;
  }

  await ensureGroqApiKey('GROQ_DEEP_DIVE_AGENT_API_KEY');

  const session: DeepDiveSession = createSession(
    lastSession.repoMeta,
    lastSession.sandboxPath,
    lastSession.summaries,
    lastSession.synthesis,
  );
  const providers = buildDeepDiveAgentProviders();
  const rateLimiters = buildDeepDiveAgentRateLimiters(providers);

  if (question !== undefined) {
    try {
      const result = await investigate(question, session, providers, rateLimiters, renderLiveStatus);

      renderAnswer(result);
    } catch (err) {
      renderInvestigationError(err);
      process.exit(1);
    }

    return;
  }

  for (;;) {
    const { answer } = await inquirer.prompt<{ answer: string }>([
      { type: 'input', name: 'answer', message: "🔍 Ask a question (or 'exit'): " },
    ]);

    const trimmed = answer.trim().toLowerCase();

    if (ASK_EXIT_WORDS.has(trimmed)) {
      await terminateSession(session);
      rmSync(getSessionFile(), { force: true });
      console.log(chalk.cyan('👋 Session ended. Sandbox cleaned up.'));
      break;
    }

    try {
      const result = await investigate(answer, session, providers, rateLimiters, renderLiveStatus);

      renderReasoningTrace(result);
    } catch (err) {
      // A single failed question must not kill the whole interactive
      // session — same "one failure isn't the whole run failing" principle
      // as the pipeline's per-file isolation.
      renderInvestigationError(err);
    }
  }
}
