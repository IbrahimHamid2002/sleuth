import type { LLMProvider } from '../llm/provider';
import { callWithFallback } from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import { AgentDecisionSchema, CombinedPlanAndDecisionSchema, FastPathAnswerSchema } from '../schemas';
import type { DeepDiveSession, InvestigationResult } from '../types';
import { extractJSON } from '../utils/json-repair';

import { buildCombinedPlanAndDecisionPrompt, buildFastPathPrompt, buildReasonPrompt, buildSynthesisPrompt, MAX_ITERATIONS } from './prompts';
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

// "Taking a long time" and "actually failed" are deliberately different
// events (same principle as pipeline.ts's stall watchdog): a flat wall-clock
// timeout used to kill a multi-step investigation that was making real
// progress just because the total crossed 60s. This is now 3 separate knobs:
//  - SOFT_TIMEOUT_MS: no progress for this long -> emit a "still working"
//    progress event, but keep going. Never aborts anything.
//  - STEP_TIMEOUT_MS (the exported `timeoutMs` default): the per-step
//    watchdog, RESET every time a step completes (a reasoning call resolves,
//    a tool finishes executing). Only a SINGLE step stuck for this long is
//    treated as genuinely stuck and aborted — a session making steady
//    progress across many steps never trips this even past 60s total.
//  - SESSION_SAFETY_CAP_MS: an absolute backstop regardless of how much
//    progress happened, in case something pathological keeps resetting the
//    per-step watchdog without the investigation ever actually finishing.
const SOFT_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 60_000;
const SESSION_SAFETY_CAP_MS = 180_000;
const WATCHDOG_TICK_MS = 2_000;

// Raised from 250: at 250 tokens the "thought" field routinely got cut off
// mid-sentence before the model could reason through more than a shallow
// observation, which fed directly into shallow final answers (the "thought"
// budget structurally discouraged a deliberate, multi-step investigation).
// Still the 8B model — this is a token-budget change only.
const REASON_MAX_TOKENS = 1000;
const REASON_TEMPERATURE = 0.2;
const SYNTHESIS_MAX_TOKENS = 2000;
const SYNTHESIS_TEMPERATURE = 0.3;
// The fast-path doc-only check may need to write a full answer, not just a
// small JSON decision, so it gets more headroom than a bare reasoning step.
const FAST_PATH_MAX_TOKENS = 800;
const FAST_PATH_TEMPERATURE = 0.2;

interface ScratchpadEntry {
  thought: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  observation: string;
}

function emit(onEvent: ((event: AgentEvent) => void) | undefined, type: string, data: unknown): void {
  onEvent?.({ type, data });
}

// Part B fix #1 (tiered answer lookup, cheap first): tries to answer purely
// from the 3 pre-generated docs, with zero live tool calls. Called
// unconditionally before the ReAct loop starts (see runInvestigation) — this
// is what makes "check the docs first" structural rather than a tool the
// model might skip. Any failure here (timeout, malformed response, no docs
// available) just means "fall through to the normal investigation"; it is
// purely an optimization and must never itself cause a failure.
async function tryFastPathFromDocs(
  question: string,
  session: DeepDiveSession,
  reasoningProviders: LLMProvider[],
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (session.generatedDocs === undefined) {
    return undefined;
  }

  try {
    const prompt = buildFastPathPrompt(question, session.repoMeta, session.generatedDocs);
    const responseText = await callWithFallback(
      reasoningProviders,
      prompt,
      { maxTokens: FAST_PATH_MAX_TOKENS, temperature: FAST_PATH_TEMPERATURE },
      rateLimiters,
      signal,
    );
    const parsed = FastPathAnswerSchema.parse(extractJSON(responseText));

    if (parsed.answerable && parsed.answer !== undefined && parsed.answer.trim().length > 0) {
      return parsed.answer;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function runInvestigation(
  question: string,
  session: DeepDiveSession,
  providers: AgentProviders,
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent: ((event: AgentEvent) => void) | undefined,
  signal: AbortSignal,
  touchProgress: () => void,
): Promise<InvestigationResult> {
  emit(onEvent, 'planning', { question });
  emit(onEvent, 'fast_path_check', { message: 'Checking existing analysis documents before searching source...' });

  const fastPathAnswer = await tryFastPathFromDocs(question, session, providers.reasoningProviders, rateLimiters, signal);

  touchProgress();

  if (fastPathAnswer !== undefined) {
    emit(onEvent, 'fast_path_hit', { message: 'Answered from the pre-generated documents — no source investigation needed.' });
    touchSession(session);

    return {
      question,
      answer: fastPathAnswer,
      plan: '(answered directly from the 3 pre-generated documents — no live investigation needed)',
      iterations: 0,
      filesExamined: [],
      answeredFromDocs: true,
      reasoningTrace: [],
    };
  }

  emit(onEvent, 'fast_path_miss', { message: 'Pre-generated documents did not cover this — starting a full investigation.' });

  const ctx: AgentContext = {
    sandboxPath: session.sandboxPath,
    repoMeta: session.repoMeta,
    summariesMap: session.summariesMap,
    visitedFiles: session.visitedFiles,
    generatedDocs: session.generatedDocs,
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
      touchProgress();

      continue;
    }

    touchProgress();
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
      touchProgress();

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
      touchProgress();

      continue;
    }

    const toolArgs = argsValidation.data as Record<string, unknown>;

    emit(onEvent, 'tool_call', { toolName: tool.name, toolArgs });

    const observation = await tool.execute(toolArgs, ctx);

    touchProgress();
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

  touchProgress();
  emit(onEvent, 'answer', { answer });

  return {
    question,
    answer,
    plan,
    iterations: iterationsUsed,
    filesExamined,
    answeredFromDocs: false,
    reasoningTrace: scratchpad,
  };
}

export async function investigate(
  question: string,
  session: DeepDiveSession,
  providers: AgentProviders,
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent?: (event: AgentEvent) => void,
  // PRD §4.7's 60s bound stays the default per-step watchdog for every real
  // caller (see the STEP_TIMEOUT_MS comment above for what "per-step" means
  // now); this is exposed only so diagnostic tooling (manual-test-agent.ts)
  // can give real, possibly rate-limited network calls more per-step room
  // without loosening the production default.
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<InvestigationResult> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let softNudgeSentForThisGap = false;

  const touchProgress = (): void => {
    lastProgressAt = Date.now();
    softNudgeSentForThisGap = false;
  };

  const watchdogId = setInterval(() => {
    const now = Date.now();
    const sinceProgress = now - lastProgressAt;
    const sinceStart = now - startedAt;

    if (sinceProgress >= SOFT_TIMEOUT_MS && !softNudgeSentForThisGap) {
      softNudgeSentForThisGap = true;
      emit(onEvent, 'progress', { message: 'Still working on this — it is taking a bit longer than usual...' });
    }

    if (sinceProgress >= timeoutMs) {
      controller.abort(
        new Error(`Deep Dive investigation made no progress for ${Math.round(sinceProgress / 1000)}s (treating as stuck, not slow)`),
      );
    } else if (sinceStart >= SESSION_SAFETY_CAP_MS) {
      controller.abort(
        new Error(`Deep Dive investigation exceeded the absolute safety-net duration of ${Math.round(SESSION_SAFETY_CAP_MS / 1000)}s`),
      );
    }
  }, WATCHDOG_TICK_MS);

  try {
    return await Promise.race([
      runInvestigation(question, session, providers, rateLimiters, onEvent, controller.signal, touchProgress),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          const { reason } = controller.signal;

          reject(reason instanceof Error ? reason : new Error(`Deep Dive investigation exceeded ${timeoutMs}ms timeout`));
        });
      }),
    ]);
  } finally {
    clearInterval(watchdogId);
  }
}
