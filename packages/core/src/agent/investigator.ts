import type { LLMProvider } from '../llm/provider';
import { callWithFallback } from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import { AgentDecisionSchema } from '../schemas';
import type { DeepDiveSession, InvestigationResult } from '../types';
import { extractJSON } from '../utils/json-repair';

import { buildPlanPrompt, buildReasonPrompt, buildSynthesisPrompt, MAX_ITERATIONS } from './prompts';
import { touchSession } from './session';
import type { AgentContext } from './tools';
import { TOOLS } from './tools';

// Event payload shapes differ per event type (a thought string, tool args, an
// observation string, the final answer) with no meaningful common shape —
// same pattern as AgentTool.execute's `any` in ./tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: see comment above
export type AgentEvent = { type: string; data: any };

const AGENT_TIMEOUT_MS = 60_000;
const PLAN_MAX_TOKENS = 400;
const PLAN_TEMPERATURE = 0.3;
const REASON_MAX_TOKENS = 800;
const REASON_TEMPERATURE = 0.2;
const SYNTHESIS_MAX_TOKENS = 2000;
const SYNTHESIS_TEMPERATURE = 0.3;

interface ScratchpadEntry {
  thought: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  observation: string;
}

function emit(onEvent: ((event: AgentEvent) => void) | undefined, type: string, data: unknown): void {
  onEvent?.({ type, data });
}

async function runInvestigation(
  question: string,
  session: DeepDiveSession,
  providers: LLMProvider[],
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<InvestigationResult> {
  emit(onEvent, 'planning', { question });

  const plan = await callWithFallback(
    providers,
    buildPlanPrompt(question, session.repoMeta, session.summariesMap.size),
    { maxTokens: PLAN_MAX_TOKENS, temperature: PLAN_TEMPERATURE },
    rateLimiters,
  );

  const ctx: AgentContext = {
    sandboxPath: session.sandboxPath,
    repoMeta: session.repoMeta,
    summariesMap: session.summariesMap,
    visitedFiles: session.visitedFiles,
  };

  const scratchpad: ScratchpadEntry[] = [];
  const filesExaminedThisCall = new Set<string>();
  let iterationsUsed = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    iterationsUsed = iteration;

    const reasonPrompt = buildReasonPrompt({ question, plan, scratchpad, iteration }, [...session.visitedFiles.keys()]);

    let decision: ReturnType<typeof AgentDecisionSchema.parse>;

    try {
      const responseText = await callWithFallback(
        providers,
        reasonPrompt,
        { maxTokens: REASON_MAX_TOKENS, temperature: REASON_TEMPERATURE },
        rateLimiters,
      );

      decision = AgentDecisionSchema.parse(extractJSON(responseText));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      scratchpad.push({
        thought: '(unparseable model response)',
        toolName: 'none',
        toolArgs: {},
        observation: `Error: failed to parse a valid decision from the model response: ${message}`,
      });

      touchSession(session);

      continue;
    }

    emit(onEvent, 'thinking', { thought: decision.thought });

    if (decision.action === 'finish') {
      break;
    }

    const toolName = decision.toolName;
    const tool = toolName !== undefined ? TOOLS.find((candidate) => candidate.name === toolName) : undefined;

    if (tool === undefined) {
      scratchpad.push({
        thought: decision.thought,
        toolName: toolName ?? 'unknown',
        toolArgs: decision.toolArgs ?? {},
        observation: `Error: unknown tool "${toolName ?? '(none given)'}"`,
      });

      touchSession(session);

      continue;
    }

    // `tool.parameters` IS the matching ToolArgsSchemas entry for this tool
    // (see tools.ts) — validating through it avoids a second, redundant lookup.
    const argsValidation = tool.parameters.safeParse(decision.toolArgs ?? {});

    if (!argsValidation.success) {
      scratchpad.push({
        thought: decision.thought,
        toolName: tool.name,
        toolArgs: decision.toolArgs ?? {},
        observation: `Error: invalid arguments for tool "${tool.name}": ${argsValidation.error.message}`,
      });

      touchSession(session);

      continue;
    }

    const toolArgs = argsValidation.data as Record<string, unknown>;

    emit(onEvent, 'tool_call', { toolName: tool.name, toolArgs });

    const observation = await tool.execute(toolArgs, ctx);

    emit(onEvent, 'observation', { toolName: tool.name, observation });

    scratchpad.push({ thought: decision.thought, toolName: tool.name, toolArgs, observation });

    if (tool.name === 'read_file') {
      const path = toolArgs.path;

      if (typeof path === 'string' && session.visitedFiles.has(path)) {
        filesExaminedThisCall.add(path);
      }
    }

    touchSession(session);
  }

  const filesExamined = [...filesExaminedThisCall];
  const synthesisPrompt = buildSynthesisPrompt({ question, plan, scratchpad, iteration: iterationsUsed }, filesExamined);

  const answer = await callWithFallback(
    providers,
    synthesisPrompt,
    { maxTokens: SYNTHESIS_MAX_TOKENS, temperature: SYNTHESIS_TEMPERATURE },
    rateLimiters,
  );

  emit(onEvent, 'answer', { answer });

  return {
    question,
    answer,
    plan,
    iterations: iterationsUsed,
    filesExamined,
    reasoningTrace: scratchpad,
  };
}

export async function investigate(
  question: string,
  session: DeepDiveSession,
  providers: LLMProvider[],
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent?: (event: AgentEvent) => void,
): Promise<InvestigationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    return await Promise.race([
      runInvestigation(question, session, providers, rateLimiters, onEvent),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error(`Deep Dive investigation exceeded ${AGENT_TIMEOUT_MS}ms timeout`)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
