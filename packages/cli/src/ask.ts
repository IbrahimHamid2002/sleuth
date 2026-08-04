import type { AgentProviders, DeepDiveSession, InvestigationResult, LLMProvider } from '@sleuth/core';
import { createProviderChain, createSession, investigate, redactSecrets, terminateSession,TokenBucketRateLimiter } from '@sleuth/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import type { LastSession } from './analyze';
import { getSessionFile } from './analyze';
import { ensureGroqApiKey } from './config';

const EXIT_WORDS = new Set(['exit', 'quit', 'bye', 'goodbye']);

// Mirrors pipeline.ts's conservative free-tier RPM ceilings — kept a couple
// RPM below the assumed real ceiling as a safety buffer.
const GROQ_FREE_TIER_RPM = 28;
const GEMINI_FREE_TIER_RPM = 13;

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

function buildAgentProviders(): AgentProviders {
  return {
    reasoningProviders: createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
    }),
    synthesisProviders: createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.3-70b-versatile',
    }),
  };
}

function buildRateLimiters(providers: AgentProviders): Map<string, TokenBucketRateLimiter> {
  const rateLimiters = new Map<string, TokenBucketRateLimiter>();
  const allProviders: LLMProvider[] = [...providers.reasoningProviders, ...providers.synthesisProviders];

  for (const provider of allProviders) {
    if (!rateLimiters.has(provider.name)) {
      const requestsPerMinute = provider.name === 'groq' ? GROQ_FREE_TIER_RPM : GEMINI_FREE_TIER_RPM;

      rateLimiters.set(provider.name, new TokenBucketRateLimiter(requestsPerMinute, requestsPerMinute / 60));
    }
  }

  return rateLimiters;
}

function renderAnswer(result: InvestigationResult): void {
  if (result.answeredFromDocs) {
    console.log(chalk.cyan('\n⚡ Answered from existing analysis documents (no source investigation needed).'));
  }

  console.log(chalk.green('\nAnswer: ') + result.answer + '\n');
}

// "Made no progress for a while" and "genuinely failed" must read differently
// to the user (same principle as pipeline.ts's stall watchdog / analyze.ts's
// stall hint) — and any failure at all must show a clean message, never an
// unhandled stack trace, so a real error (like exhausted LLM quota) still
// fails cleanly instead of crashing the process.
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
  if (result.answeredFromDocs) {
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
// working" nudges past the soft timeout, each tool call) so the user has
// visible confidence something is happening — not silence until the final
// answer or a timeout. Renders live, in addition to (not instead of) the
// full recap renderReasoningTrace prints once the investigation finishes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: mirrors AgentEvent's own `data: any` in core (see investigator.ts) — payload shape genuinely varies per event type
function renderLiveStatus(event: { type: string; data: any }): void {
  switch (event.type) {
    case 'fast_path_check':
    case 'fast_path_miss':
      console.log(chalk.dim(`🔎 ${event.data.message}`));
      break;
    case 'fast_path_hit':
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
  const providers = buildAgentProviders();
  const rateLimiters = buildRateLimiters(providers);

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

    if (EXIT_WORDS.has(trimmed)) {
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
      // session — the same "one failure isn't the whole run failing"
      // principle as the pipeline's per-file isolation.
      renderInvestigationError(err);
    }
  }
}
