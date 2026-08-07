export type { AgentEvent, AgentProviders } from './agent/investigator';
export { investigate } from './agent/investigator';
export {
  buildCombinedPlanAndDecisionPrompt,
  buildFastPathPrompt,
  buildReasonPrompt,
  buildSynthesisPrompt,
  MAX_ITERATIONS,
} from './agent/prompts';
export { buildDeepDiveAgentProviders, buildDeepDiveAgentRateLimiters } from './agent/providers';
export { createSession, terminateSession, touchSession } from './agent/session';
export type { AgentContext, AgentTool } from './agent/tools';
export { TOOLS } from './agent/tools';
export type { DiscoveryResult } from './analysis/discovery';
export { discoverFiles } from './analysis/discovery';
export { detectFrameworks } from './analysis/framework-detector';
export type { ImportGraph } from './analysis/import-graph';
export { buildImportGraph } from './analysis/import-graph';
export { computePathScore, detectEntryPoints, prioritizeFiles, scoreFile } from './analysis/prioritizer';
export { buildSymbolIndex, indexSymbols } from './analysis/symbol-indexer';
export { SummaryCache } from './cache/sqlite-cache';
export { mapCitations } from './documentation/citation-mapper';
export { buildDirectoryTree } from './documentation/directory-tree';
export type { SummarizeFilesResult } from './documentation/summarizer';
export { summarizeFiles } from './documentation/summarizer';
export { generateTemplateFallback, MERMAID_DISCLAIMER, synthesize } from './documentation/synthesizer';
export { cloneRepo } from './ingestion/clone';
export { ingestLocal } from './ingestion/local';
export { cleanupSandbox, createSandbox, getSandboxSizeBytes } from './ingestion/sandbox-manager';
export type { PooledAccount } from './llm/account-pool';
export { AccountPool, createGroqAccountPool } from './llm/account-pool';
export type { HeartbeatEvent } from './llm/heartbeat-bus';
export { heartbeatBus } from './llm/heartbeat-bus';
export type { LLMProvider, ProviderChainConfig } from './llm/provider';
export { callWithFallback, createProviderChain, estimateTokenCost, GeminiProvider, GroqProvider, OpenRouterProvider } from './llm/provider';
export type { HeadroomSnapshot, ProviderRateLimits } from './llm/rate-limiter';
export {
  buildRateLimitersForProviders,
  PROVIDER_RATE_LIMITS,
  RateLimitEscalationError,
  TokenBucketRateLimiter,
} from './llm/rate-limiter';
export type { PipelineOptions, PipelineResult } from './pipeline';
export { PipelineWatchdog, runPipeline } from './pipeline';
export {
  AgentDecisionSchema,
  CombinedPlanAndDecisionSchema,
  FastPathAnswerSchema,
  FileSummarySchema,
  RepoInputSchema,
  ToolArgsSchemas,
} from './schemas';
export { assertSafePath } from './security/path-guard';
export { redactSecrets, sanitizeForLLM } from './security/sanitize';
export type {
  AgentDecision,
  AuditEntry,
  DeepDiveSession,
  FileNode,
  FileSummary,
  FrameworkProfile,
  InvestigationResult,
  RepoInput,
  RepoMeta,
  SubProjectProfile,
  Symbol,
  SynthesisResult,
} from './types';
export { extractJSON } from './utils/json-repair';
