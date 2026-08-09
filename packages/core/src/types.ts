import type { z } from 'zod';

import type { TokenBucketRateLimiter } from './llm/rate-limiter';

export interface RepoInput {
  type: 'local' | 'github';
  path?: string;
  url?: string;
  pat?: string; // never persisted beyond request scope
}

export interface SubProjectProfile {
  rootRelativePath: string;
  frameworks: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  entryPoints: string[];
}

export interface FrameworkProfile {
  frameworks: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  isMonorepo: boolean;
  monorepoType: 'workspace' | 'ad-hoc' | 'none';
  workspaceDirs: string[];
  subProjects: SubProjectProfile[];
}

export interface RepoMeta {
  name: string;
  identifier: string;
  commitHash: string;
  rootPath: string;
  frameworks: string[];
  isMonorepo: boolean;
  monorepoType: 'workspace' | 'ad-hoc' | 'none';
  workspaceDirs: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  subProjects: SubProjectProfile[];
}

export interface FileNode {
  path: string;
  type: 'file' | 'directory';
  size: number;
  score?: number;
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'export' | 'const';
  line: number;
}

export interface FileSummary {
  path: string;
  purpose: string;
  exports: string[];
  dependencies: string[];
  summary: string;
}

export interface SynthesisResult {
  readme: string;
  architecture: string;
  onboarding: string;
}

// `action` is a free-form label, not a closed enum, but a few values carry
// specific meaning callers rely on: documentation/synthesizer.ts pushes
// stage: 'synthesis', action: 'fallback_used' at the exact point a
// deterministic template replaces an LLM-generated document (whether because
// every provider failed or the response failed its Zod-validated exit path)
// — this is the ONLY place that fact is recorded; the shipped Markdown itself
// must never mention it (see synthesizer.ts's generate*Fallback functions).
export interface AuditEntry {
  timestamp: number;
  stage: string;
  action: string;
  detail: string;
}

export interface AgentDecision {
  thought: string;
  action: 'tool_call' | 'finish';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface DeepDiveSession {
  sessionId: string;
  repoMeta: RepoMeta;
  sandboxPath: string;
  summariesMap: Map<string, FileSummary>;
  visitedFiles: Map<string, string>;
  createdAt: number;
  lastActivityAt: number;
  // The 3 pre-generated docs from the summarization pipeline (readme,
  // architecture, onboarding), if available — the agent checks these first,
  // before any live tool call over raw source, since they're already a
  // summary of the whole repo and answering from them is far cheaper/faster
  // than a fresh investigation. Undefined only for a session built without a
  // completed pipeline run (e.g. some tests).
  generatedDocs?: SynthesisResult;
}

export interface InvestigationResult {
  question: string;
  answer: string;
  plan: string;
  iterations: number;
  filesExamined: string[];
  // True when the deterministic fast-path step answered directly from the 3
  // pre-generated docs, with zero live tool calls — see agent/investigator.ts.
  answeredFromDocs: boolean;
  // True when the short/simple-query fast path answered directly from file
  // summaries (path + one-line purpose only, NOT the 3 full docs), with zero
  // live tool calls — a distinct, cheaper data source than answeredFromDocs
  // above, only ever attempted for queries classified "simple" and only
  // after the doc-based fast path already missed. See
  // agent/investigator.ts's isSimpleQuery/trySimpleQueryFastPath.
  answeredFromSummaries: boolean;
  reasoningTrace: Array<{
    thought: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    observation: string;
  }>;
}

// From analysis/discovery.ts
export interface DiscoveryResult {
  files: FileNode[];
  contentCache: Map<string, string>;
}

// From analysis/framework-detector.ts
export interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

// From analysis/import-graph.ts
export interface ImportGraph {
  inDegree: Map<string, number>;
  // Every resolved importer -> imported edge, in discovery order — the raw
  // material for documentation/synthesizer.ts's deterministic ARCHITECTURE
  // fallback diagram (real file-to-file relationships, not a fabricated
  // chain). `inDegree` alone can't reconstruct this: it only ever kept the
  // aggregate count per target, never which files pointed at it.
  edges: Array<{ from: string; to: string }>;
}

// From cache/sqlite-cache.ts
export interface SummaryRow {
  summary_json: string;
  created_at: number;
}

// From documentation/directory-tree.ts
export interface TreeNode {
  children: Map<string, TreeNode>;
  isFile: boolean;
}

// From documentation/mermaid-validator.ts
export interface MermaidBlock {
  raw: string;
  code: string;
  startIndex: number;
  endIndex: number;
}

export interface MermaidValidationResult {
  valid: boolean;
  errors: string[];
}

// ARCHITECTURE.md's fixed diagram-type contract per required heading — shared
// by documentation/synthesizer.ts (to build the prompt) and
// documentation/mermaid-validator.ts (to validate the LLM's output against
// it), so the two can never drift apart.
export type ArchitectureDiagramType = 'graph' | 'sequenceDiagram' | 'flowchart';

export interface ArchitectureRequiredSection {
  heading: string;
  // null means the section is prose-only and must NOT contain a diagram.
  diagramType: ArchitectureDiagramType | null;
}

export type ArchitectureDiagramIssueProblem =
  | 'missing_heading'
  | 'missing_diagram'
  | 'wrong_diagram_type'
  | 'duplicate_heading'
  | 'legacy_heading_present';

export interface ArchitectureDiagramIssue {
  heading: string;
  problem: ArchitectureDiagramIssueProblem;
  detail: string;
}

export interface ArchitectureDiagramValidationResult {
  valid: boolean;
  issues: ArchitectureDiagramIssue[];
}

// From documentation/summarizer.ts
export interface SummarizeFilesResult {
  summaries: FileSummary[];
  failedFiles: string[];
}

export interface PendingFile {
  file: FileNode;
  cacheKey: string;
  contentHash: string;
}

// From documentation/synthesizer.ts
export type DocType = 'readme' | 'architecture' | 'onboarding';

// From agent/tools.ts
export interface AgentContext {
  sandboxPath: string;
  repoMeta: RepoMeta;
  summariesMap: Map<string, FileSummary>;
  visitedFiles: Map<string, string>;
  // The 3 pre-generated docs, when available — lets search_docs and the
  // investigator's fast-path step answer without a single live tool call.
  generatedDocs?: SynthesisResult;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: args are Zod-validated against `parameters` by the caller before execute() runs, so a concrete type here would just duplicate that per-tool contract
  execute: (args: any, ctx: AgentContext) => Promise<string>;
}

// From agent/prompts.ts
// The formatting-only view of a scratchpad step used when rendering a
// reasoning prompt — a subset of AgentScratchpadEntry (below), no toolArgs.
export interface PromptScratchpadEntry {
  thought: string;
  toolName: string;
  observation: string;
}

export interface ReasoningState {
  question: string;
  plan: string;
  scratchpad: PromptScratchpadEntry[];
  iteration: number;
}

// From agent/investigator.ts
// Event payload shapes differ per event type (a thought string, tool args, an
// observation string, the final answer) with no meaningful common shape —
// same pattern as AgentTool.execute's `any` above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: see comment above
export type AgentEvent = { type: string; data: any };

// Built by agent/providers.ts's buildDeepDiveAgentProviders() — both arrays
// are the SAME shared provider list (Groq pooled multi-account, then
// OpenRouter as the sole final fallback). Kept as two named fields since the
// investigator calls them out separately and a future caller may split them.
export interface AgentProviders {
  reasoningProviders: LLMProvider[];
  synthesisProviders: LLMProvider[];
}

// The full scratchpad entry produced during an investigation, including the
// tool args actually sent — see PromptScratchpadEntry above for the leaner
// view used just for prompt formatting.
export interface AgentScratchpadEntry {
  thought: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  observation: string;
}

// From llm/provider.ts
export interface LLMProvider {
  name: string;
  complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string>;
}

export interface ProviderChainConfig {
  groqApiKeyEnvVar: string;
  groqModel: string;
  openrouterApiKeyEnvVar?: string;
  // Required (unlike geminiModel) — OpenRouter has no single sensible
  // universal default across roles, so every call site must consciously
  // choose which free model fits its own task (see constants.ts's
  // PROVIDER_RATE_LIMITS comment and agent/providers.ts's DEEP_DIVE_OPENROUTER_MODEL
  // for the reasoning behind each role's choice).
  openrouterModel: string;
  geminiApiKeyEnvVar?: string;
  geminiModel?: string;
}

// From llm/rate-limiter.ts
export interface ProviderRateLimits {
  rpm: number | null;
  // Real LLM tokens/minute. `null` = not (yet) live-verified for this
  // provider — the limiter stays RPM-only instead of enforcing a guess.
  tpm: number | null;
}

// Non-blocking snapshot of whether a bucket could satisfy an estimated token
// cost right now, and if not, how it's positioned relative to other buckets —
// used by llm/account-pool.ts's AccountPool to rank several accounts before
// committing to one, without mutating any of them.
export interface HeadroomSnapshot {
  ready: boolean;
  // Number.POSITIVE_INFINITY when this bucket has no tpm ceiling at all.
  tokenHeadroom: number;
  requestHeadroom: number;
  msUntilReady: number;
}

// From llm/account-pool.ts
export interface PooledAccount {
  provider: LLMProvider;
  limiter: TokenBucketRateLimiter;
}

// From llm/heartbeat-bus.ts
// A single pulse: some component did real, verifiable work at `timestamp`.
export interface HeartbeatEvent {
  source: string;
  detail: string | undefined;
  timestamp: number;
}

// From pipeline.ts
export interface PipelineOptions {
  maxFiles?: number;
  skipCache?: boolean;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface PipelineResult {
  meta: RepoMeta;
  summaries: FileSummary[];
  synthesis: SynthesisResult;
  symbolIndex: Map<string, Array<{ path: string; line: number }>>;
  auditLog: AuditEntry[];
  sandboxPath: string;
  durationMs: number;
  // Files whose LLM summarization failed after retries (fell back to a
  // placeholder summary) — a non-empty list is a partial-success signal, not
  // a pipeline failure.
  failedFiles: string[];
}
