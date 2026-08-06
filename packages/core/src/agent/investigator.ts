import {
  AGENT_SYNTHESIS_MAX_TOKENS,
  AGENT_SYNTHESIS_TEMPERATURE,
  INVESTIGATOR_FAST_PATH_MAX_TOKENS,
  INVESTIGATOR_FAST_PATH_TEMPERATURE,
  INVESTIGATOR_REASON_MAX_TOKENS,
  INVESTIGATOR_REASON_TEMPERATURE,
  INVESTIGATOR_SESSION_SAFETY_CAP_MS,
  INVESTIGATOR_SIMPLE_QUERY_MAX_WORDS,
  INVESTIGATOR_SOFT_TIMEOUT_MS,
  INVESTIGATOR_STEP_TIMEOUT_MS,
  INVESTIGATOR_WATCHDOG_TICK_MS,
  MAX_ITERATIONS,
} from '../constants';
import { callWithFallback } from '../llm/provider';
import type { TokenBucketRateLimiter } from '../llm/rate-limiter';
import { AgentDecisionSchema, CombinedPlanAndDecisionSchema, FastPathAnswerSchema } from '../schemas';
import type {
  AgentContext,
  AgentEvent,
  AgentProviders,
  AgentScratchpadEntry,
  DeepDiveSession,
  InvestigationResult,
  LLMProvider,
} from '../types';
import { extractJSON } from '../utils/json-repair';

import { buildCombinedPlanAndDecisionPrompt, buildFastPathPrompt, buildReasonPrompt, buildSimpleQueryFastPathPrompt, buildSynthesisPrompt } from './prompts';
import { touchSession } from './session';
import { TOOLS } from './tools';

export type { AgentEvent, AgentProviders } from '../types';

function isSimpleQuery(question: string): boolean {
  return question.trim().split(/\s+/).filter((word) => word.length > 0).length <= INVESTIGATOR_SIMPLE_QUERY_MAX_WORDS;
}

function emit(onEvent: ((event: AgentEvent) => void) | undefined, type: string, data: unknown): void {
  onEvent?.({ type, data });
}

// Tiered answer lookup, cheap first: tries to answer purely from the 3
// pre-generated docs before the ReAct loop starts. Any failure here just
// falls through to the normal investigation — it must never itself fail.
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
      { maxTokens: INVESTIGATOR_FAST_PATH_MAX_TOKENS, temperature: INVESTIGATOR_FAST_PATH_TEMPERATURE },
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

// Reduced-context fast path for short/simple queries (see isSimpleQuery),
// tried only after tryFastPathFromDocs already missed, using just each
// summarized file's path + one-line purpose instead of the 3 full docs.
async function trySimpleQueryFastPath(
  question: string,
  session: DeepDiveSession,
  reasoningProviders: LLMProvider[],
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const prompt = buildSimpleQueryFastPathPrompt(question, session.repoMeta, [...session.summariesMap.values()]);
    const responseText = await callWithFallback(
      reasoningProviders,
      prompt,
      { maxTokens: INVESTIGATOR_FAST_PATH_MAX_TOKENS, temperature: INVESTIGATOR_FAST_PATH_TEMPERATURE },
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
    // Callers streaming events (e.g. the API's SSE endpoint) close on the
    // first 'answer' event, so a fast-path hit must still emit one.
    emit(onEvent, 'answer', { answer: fastPathAnswer });
    touchSession(session);

    return {
      question,
      answer: fastPathAnswer,
      plan: '(answered directly from the 3 pre-generated documents — no live investigation needed)',
      iterations: 0,
      filesExamined: [],
      answeredFromDocs: true,
      answeredFromSummaries: false,
      reasoningTrace: [],
    };
  }

  emit(onEvent, 'fast_path_miss', { message: 'Pre-generated documents did not cover this — starting a full investigation.' });

  // An ADDITIONAL cheap attempt, only for simple queries and only after the
  // doc-based fast path already missed — an uncertain result here still
  // falls through to the full pipeline, exactly like a doc-fast-path miss.
  if (isSimpleQuery(question)) {
    emit(onEvent, 'simple_query_check', { message: 'Question looks simple — checking file summaries before a full investigation...' });

    const simpleAnswer = await trySimpleQueryFastPath(question, session, providers.reasoningProviders, rateLimiters, signal);

    touchProgress();

    if (simpleAnswer !== undefined) {
      emit(onEvent, 'simple_query_hit', { message: 'Answered from file summaries — no full investigation needed.' });
      emit(onEvent, 'answer', { answer: simpleAnswer });
      touchSession(session);

      return {
        question,
        answer: simpleAnswer,
        plan: '(answered directly from file summaries via the short-query fast path — no live investigation needed)',
        iterations: 0,
        filesExamined: [],
        answeredFromDocs: false,
        answeredFromSummaries: true,
        reasoningTrace: [],
      };
    }

    emit(onEvent, 'simple_query_miss', { message: 'File summaries did not cover this — starting a full investigation.' });
  }

  const ctx: AgentContext = {
    sandboxPath: session.sandboxPath,
    repoMeta: session.repoMeta,
    summariesMap: session.summariesMap,
    visitedFiles: session.visitedFiles,
    generatedDocs: session.generatedDocs,
  };

  const scratchpad: AgentScratchpadEntry[] = [];
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
      // call (quota conservation — see MAX_ITERATIONS for the worst-case call count).
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
          { maxTokens: INVESTIGATOR_REASON_MAX_TOKENS, temperature: INVESTIGATOR_REASON_TEMPERATURE },
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
          { maxTokens: INVESTIGATOR_REASON_MAX_TOKENS, temperature: INVESTIGATOR_REASON_TEMPERATURE },
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

  // The loop above only ever calls the reasoning model while iterating
  // (bounded by MAX_ITERATIONS) or until 'finish' breaks it early — exactly
  // one synthesis call follows, regardless of how the loop ended.
  const filesExamined = [...filesExaminedThisCall];
  const synthesisPrompt = buildSynthesisPrompt({ question, plan, scratchpad, iteration: iterationsUsed }, filesExamined);

  const answer = await callWithFallback(
    providers.synthesisProviders,
    synthesisPrompt,
    { maxTokens: AGENT_SYNTHESIS_MAX_TOKENS, temperature: AGENT_SYNTHESIS_TEMPERATURE },
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
    answeredFromSummaries: false,
    reasoningTrace: scratchpad,
  };
}

export async function investigate(
  question: string,
  session: DeepDiveSession,
  providers: AgentProviders,
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  onEvent?: (event: AgentEvent) => void,
  // Defaults to INVESTIGATOR_STEP_TIMEOUT_MS for every real caller; exposed
  // only so diagnostic tooling can give rate-limited network calls more room
  // per step without loosening the production default.
  timeoutMs: number = INVESTIGATOR_STEP_TIMEOUT_MS,
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

    if (sinceProgress >= INVESTIGATOR_SOFT_TIMEOUT_MS && !softNudgeSentForThisGap) {
      softNudgeSentForThisGap = true;
      emit(onEvent, 'progress', { message: 'Still working on this — it is taking a bit longer than usual...' });
    }

    if (sinceProgress >= timeoutMs) {
      controller.abort(
        new Error(`Deep Dive investigation made no progress for ${Math.round(sinceProgress / 1000)}s (treating as stuck, not slow)`),
      );
    } else if (sinceStart >= INVESTIGATOR_SESSION_SAFETY_CAP_MS) {
      controller.abort(
        new Error(`Deep Dive investigation exceeded the absolute safety-net duration of ${Math.round(INVESTIGATOR_SESSION_SAFETY_CAP_MS / 1000)}s`),
      );
    }
  }, INVESTIGATOR_WATCHDOG_TICK_MS);

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
