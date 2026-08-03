import type { AgentProviders, DeepDiveSession, InvestigationResult, LLMProvider } from '@sleuth/core';
import { createProviderChain, createSession, investigate, terminateSession,TokenBucketRateLimiter } from '@sleuth/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import type { LastSession } from './analyze';
import { getSessionFile } from './analyze';

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
  console.log(chalk.green('\nAnswer: ') + result.answer + '\n');
}

function renderReasoningTrace(result: InvestigationResult): void {
  console.log(chalk.dim(`\nPlan: ${result.plan}`));

  result.reasoningTrace.forEach((step, index) => {
    console.log(chalk.yellow(`\n[${index + 1}] Thought: `) + step.thought);
    console.log(chalk.blue('    Tool: ') + `${step.toolName}(${JSON.stringify(step.toolArgs)})`);
    console.log(chalk.gray('    Observation: ') + step.observation);
  });

  renderAnswer(result);
}

export async function runAskCommand(question?: string): Promise<void> {
  const lastSession = loadLastSession();

  if (lastSession === undefined || !existsSync(lastSession.sandboxPath)) {
    console.error(chalk.red('Error: no active session found. Run `sleuth analyze <target>` first.'));
    process.exit(1);

    return;
  }

  const session: DeepDiveSession = createSession(lastSession.repoMeta, lastSession.sandboxPath, lastSession.summaries);
  const providers = buildAgentProviders();
  const rateLimiters = buildRateLimiters(providers);

  if (question !== undefined) {
    const result = await investigate(question, session, providers, rateLimiters);

    renderAnswer(result);

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

    const result = await investigate(answer, session, providers, rateLimiters);

    renderReasoningTrace(result);
  }
}
