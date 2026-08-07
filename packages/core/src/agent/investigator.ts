import type { LLMProvider } from '../llm/provider';
import { callWithFallback } from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import { AgentDecisionSchema, CombinedPlanAndDecisionSchema } from '../schemas';
import type { DeepDiveSession, InvestigationResult } from '../types';
import { extractJSON } from '../utils/json-repair';

import { buildCombinedPlanAndDecisionPrompt, buildReasonPrompt, buildSynthesisPrompt, MAX_ITERATIONS } from './prompts';
import { touchSession } from './session';
import type { AgentContext } from './tools';
import { TOOLS } from './tools';

// Event payload shapes differ per event type (a thought string, tool args, an
// observation string, the final answer) with no meaningful common shape —
// same pattern as AgentTool.execute's `any` in ./tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: see comment above
export type AgentEvent = { type: string; data: any };

// The agent uses its own dedicated Groq key (GROQ_DEEP_DIVE_AGENT_API_KEY) via
// two separate provider chains built by the caller: a fast 8B model for
// planning/reasoning (cheap, high-volume, latency-sensitive) and the smarter
// 70B model reserved for the single final synthesis call, where answer
// quality actually matters.
export interface AgentProviders {
  reasoningProviders: LLMProvider[];
  synthesisProviders: LLMProvider[];
}

const AGENT_TIMEOUT_MS = 60_000;
// Reasoning/planning calls only ever need to return a small JSON object, never
// long prose — kept tight to reduce both latency and the risk of the model
// wasting its budget on a truncated response.
const REASON_MAX_TOKENS = 250;
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
  providers: AgentProviders,
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent: ((event: AgentEvent) => void) | undefined,
  signal: AbortSignal,
): Promise<InvestigationResult> {
  emit(onEvent, 'planning', { question });

  const ctx: AgentContext = {
    sandboxPath: session.sandboxPath,
    repoMeta: session.repoMeta,
    summariesMap: session.summariesMap,
    visitedFiles: session.visitedFiles,
  };

  const scratchpad: ScratchpadEntry[] = [];
  const filesExaminedThisCall = new Set<string>();
  let iterationsUsed = 0;
  let plan = '(no plan available — the initial planning response could not be parsed)';

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    if (signal.aborted) {
      break;
    }

    iterationsUsed = iteration;

    let decision: ReturnType<typeof AgentDecisionSchema.parse>;

    try {
      // Iteration 1 merges planning and the first tool-call decision into one
      // call (quota conservation — see MAX_ITERATIONS's comment for the
      // resulting worst-case call count).
      if (iteration === 1) {
        const combinedPrompt = buildCombinedPlanAndDecisionPrompt(
          question,
          session.repoMeta,
          [...session.summariesMap.keys()],
          [...session.visitedFiles.keys()],
        );
        const responseText = await callWithFallback(
          providers.reasoningProviders,
          combinedPrompt,
          { maxTokens: REASON_MAX_TOKENS, temperature: REASON_TEMPERATURE },
          rateLimiters,
          signal,
        );
        const parsed = CombinedPlanAndDecisionSchema.parse(extractJSON(responseText));

        plan = parsed.plan;
        decision = parsed;
      } else {
        const reasonPrompt = buildReasonPrompt(
          { question, plan, scratchpad, iteration },
          session.repoMeta,
          [...session.summariesMap.keys()],
          [...session.visitedFiles.keys()],
        );
        const responseText = await callWithFallback(
          providers.reasoningProviders,
          reasonPrompt,
          { maxTokens: REASON_MAX_TOKENS, temperature: REASON_TEMPERATURE },
          rateLimiters,
          signal,
        );

        decision = AgentDecisionSchema.parse(extractJSON(responseText));
      }
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

    // Early exit: once the model returns 'finish', no further reasoning calls
    // are made — synthesis runs immediately below with whatever scratchpad
    // exists so far.
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

  // The loop above only ever calls the reasoning model while iterating (bounded
  // by MAX_ITERATIONS) or until 'finish' breaks it early — no reasoning call is
  // ever made once either condition is hit. Exactly one synthesis call follows,
  // regardless of how the loop ended.
  const filesExamined = [...filesExaminedThisCall];
  const synthesisPrompt = buildSynthesisPrompt({ question, plan, scratchpad, iteration: iterationsUsed }, filesExamined);

  const answer = await callWithFallback(
    providers.synthesisProviders,
    synthesisPrompt,
    { maxTokens: SYNTHESIS_MAX_TOKENS, temperature: SYNTHESIS_TEMPERATURE },
    rateLimiters,
    signal,
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
  providers: AgentProviders,
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent?: (event: AgentEvent) => void,
  // PRD §4.7's 60s hard bound stays the default for every real caller; this is
  // exposed only so diagnostic tooling (manual-test-agent.ts) can give real,
  // possibly rate-limited network calls more wall-clock room without loosening
  // the production default.
  timeoutMs: number = AGENT_TIMEOUT_MS,
): Promise<InvestigationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      runInvestigation(question, session, providers, rateLimiters, onEvent, controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error(`Deep Dive investigation exceeded ${timeoutMs}ms timeout`)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
