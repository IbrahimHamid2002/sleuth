import type { ProviderRateLimits } from './types';

// From analysis/discovery.ts
export const DISCOVERY_MAX_FILES = 1500;
export const DISCOVERY_MAX_FILE_SIZE_BYTES = 500 * 1024;
export const DISCOVERY_BINARY_DETECTION_BYTES = 512;
export const DISCOVERY_HARDCODED_DIR_EXCLUSIONS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '__pycache__',
  'generated',
  'snapshots',
  '__snapshots__',
  'cypress',
  'e2e',
];
export const DISCOVERY_BINARY_EXTENSIONS = [
  'png',
  'jpg',
  'gif',
  'svg',
  'ico',
  'woff',
  'ttf',
  'eot',
  'mp3',
  'mp4',
  'zip',
  'tar',
  'gz',
  'pdf',
  'exe',
  'dll',
  'so',
];
export const DISCOVERY_LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
export const DISCOVERY_TEST_EXCLUSIONS = ['*.test.*', '*.spec.*', '__tests__/', '*.snap'];

// From analysis/framework-detector.ts
export const FRAMEWORK_MONOREPO_MARKER_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
export const FRAMEWORK_CANDIDATE_WORKSPACE_DIRS = ['apps', 'packages', 'libs', 'shared'];
export const FRAMEWORK_EXCLUDED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '__pycache__',
  'generated',
  'snapshots',
  '__snapshots__',
  'cypress',
  'e2e',
]);

// From analysis/import-graph.ts
export const IMPORT_GRAPH_IMPORT_FROM_REGEX = /import\s+.*?\s+from\s+['"](.+?)['"]/g;
export const IMPORT_GRAPH_REQUIRE_REGEX = /require\(\s*['"](.+?)['"]\s*\)/g;
export const IMPORT_GRAPH_DYNAMIC_IMPORT_REGEX = /import\(\s*['"](.+?)['"]\s*\)/g;
export const IMPORT_GRAPH_SPECIFIER_REGEXES = [
  IMPORT_GRAPH_IMPORT_FROM_REGEX,
  IMPORT_GRAPH_REQUIRE_REGEX,
  IMPORT_GRAPH_DYNAMIC_IMPORT_REGEX,
];
export const IMPORT_GRAPH_RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// From analysis/prioritizer.ts
export const PRIORITIZER_ENTRY_POINT_SIGNATURES = [
  'app.listen(',
  'createServer(',
  'ReactDOM.createRoot(',
  'ReactDOM.render(',
  'NestFactory.create(',
];
export const PRIORITIZER_PATH_SCORE_BASELINE = 20;
export const PRIORITIZER_IMPORT_SCORE_PER_IMPORTER = 4;
export const PRIORITIZER_IMPORT_SCORE_CAP = 40;
export const PRIORITIZER_ENTRY_POINT_BONUS = 30;
export const PRIORITIZER_AUDIT_TOP_FILE_COUNT = 20;
export const PATH_SCORE_RULES: Array<{ pattern: RegExp; score: number }> = [
  {
    // Tier 1 — Critical Anchors
    pattern: /(^|\/)(package\.json|(server|app|main|index)\.(ts|js)x?)$/,
    score: 100,
  },
  {
    // Tier 2 — Config & Docs
    pattern: /(^|\/)(README\.md|tsconfig\.json|vite\.config\.\w+|next\.config\.\w+)$/,
    score: 85,
  },
  {
    // Tier 3 — Backend/Frontend Core
    pattern:
      /(^|\/)(routes|controllers|services|middleware|auth|config|database|models|app|pages|layouts|store|api)\//,
    score: 70,
  },
  {
    // Tier 4 — Supporting Structure
    pattern: /(^|\/)(components|hooks|context|shared|lib)\//,
    score: 55,
  },
  {
    // Tier 5 — Shared Tooling
    pattern: /(^|\/)(docker[^/]*|\.eslintrc[^/]*|prettier[^/]*|nx\.json|turbo\.json)$|(^|\/)\.github\/workflows\//,
    score: 40,
  },
];

// From analysis/symbol-indexer.ts
export const SYMBOL_INDEXER_FUNCTION_REGEX = /export (async )?function (\w+)/g;
export const SYMBOL_INDEXER_CLASS_REGEX = /export class (\w+)/g;
export const SYMBOL_INDEXER_CONST_REGEX = /export (default )?const (\w+)/g;
export const SYMBOL_INDEXER_EXPORT_BLOCK_REGEX = /export \{([^}]+)\}/g;

// From cache/sqlite-cache.ts
export const SUMMARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// From documentation/citation-mapper.ts
export const CITATION_PATTERN = /`(\w+)`/g;

// From documentation/directory-tree.ts
export const DIRECTORY_TREE_MAX_LINES = 400;

// From documentation/mermaid-validator.ts
// Every diagram type mermaid actually supports — a block whose first line
// doesn't start with one of these is either garbage or a hallucinated type.
export const MERMAID_VALID_DIAGRAM_KEYWORDS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'gitGraph',
  'mindmap',
  'timeline',
  'quadrantChart',
];
export const MERMAID_FENCE_PATTERN = /```mermaid\n([\s\S]*?)```/g;
// Catches the most common real breakage: an unquoted node label containing
// ":", "(", ")", or "|", which mermaid parses as syntax, not literal text.
export const MERMAID_UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN = /\[[^\]"]*[():|][^\]"]*\]/;

// From documentation/summarizer.ts
export const SUMMARIZER_PROMPT_VERSION = 'v1';
export const SUMMARIZER_MAX_BATCH_FILES = 5;
export const SUMMARIZER_MAX_BATCH_CHARS = 6000;
export const SUMMARIZER_MAX_TOKENS = 2000;
export const SUMMARIZER_TEMPERATURE = 0.2;
// Concurrent in-flight batches; lowered from 6 to 3 as a stopgap for Groq's
// free-tier TPM ceiling — see llm/rate-limiter.ts's PROVIDER_RATE_LIMITS.
export const SUMMARIZER_MAX_CONCURRENT_BATCHES = 3;

// From documentation/synthesizer.ts
export const DOC_SYNTHESIS_SUMMARY_CHAR_BUDGET = 24000;
export const DOC_SYNTHESIS_MAX_TOKENS = 4000;
export const DOC_SYNTHESIS_TEMPERATURE = 0.3;
export const DOC_SYNTHESIS_CALL_TIMEOUT_MS = 60000;
export const DOC_SYNTHESIS_MAX_ATTEMPTS = 3;
export const DOC_SYNTHESIS_MERMAID_REPAIR_MAX_TOKENS = 1000;
export const DOC_SYNTHESIS_MERMAID_REPAIR_TEMPERATURE = 0.1;
// Bounds worst-case extra LLM calls from a pathologically broken doc — the
// prompt only ever asks for up to 4 diagrams, so this is a generous ceiling.
export const DOC_SYNTHESIS_MAX_MERMAID_REPAIR_ATTEMPTS = 6;
export const MERMAID_DISCLAIMER =
  '> Note: This architecture diagram is an AI-generated approximation based on static analysis, not a guaranteed reverse-engineered UML diagram.';
export const DOC_SYNTHESIS_FRONTEND_FRAMEWORKS = new Set(['react', 'nextjs', 'vite']);
export const DOC_SYNTHESIS_BACKEND_FRAMEWORKS = new Set(['express', 'nestjs', 'nextjs']);
export const DOC_SYNTHESIS_BACKTICK_CITATION_INSTRUCTION =
  "When you reference a specific function, class, or exported symbol by name, wrap it in backticks (e.g. `functionName`) so it can be cross-referenced — never invent file paths or line numbers yourself.";
// Shared by every prompt that asks for a mermaid diagram — calls out the
// exact failure mode (unquoted labels with ":"/"(") with a correct/incorrect example.
export const DOC_SYNTHESIS_MERMAID_SYNTAX_RULES = `CRITICAL Mermaid syntax rules — a single violation breaks every diagram in this document, so follow these exactly for every \`\`\`mermaid block you write:
- The first line inside the fence must be a valid diagram type on its own: "flowchart TD", "graph TD", or "sequenceDiagram".
- Node IDs must be short plain identifiers with no spaces or punctuation (e.g. "CLI", "Core", "F1").
- ALWAYS put human-readable text in a quoted label: CLI["CLI Entrypoint"] — never CLI[CLI Entrypoint] or CLI[CLI: entrypoint (main)].
- Never put ":", "(", ")", or "|" inside an unquoted [ ] label — if the label needs any of those characters, it MUST be wrapped in double quotes.
- Every "[" has a matching "]", every "(" has a matching ")", every "{" has a matching "}", every opening quote has a matching closing quote.
- Use only "-->" or "---" for arrows.

CORRECT:
\`\`\`mermaid
flowchart TD
  CLI["CLI Entrypoint"] --> Core["Core Engine"]
  Core --> LLM["LLM Provider (Groq/Gemini)"]
\`\`\`

INCORRECT (unquoted label containing ":" and "(" breaks parsing):
\`\`\`mermaid
flowchart TD
  CLI[CLI: entrypoint (main)] --> Core
\`\`\``;
// Deterministic license detection — a plain substring check against the real
// directory tree, never an LLM guess of a license type it can't verify.
export const DOC_SYNTHESIS_LICENSE_FILE_PATTERN = /(^|\/)LICEN[SC]E(\.[a-z0-9]+)?$/im;

// From ingestion/clone.ts
// eslint-disable-next-line no-useless-escape -- matches RepoInputSchema's regex verbatim (schemas.ts)
export const CLONE_GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+(\.git)?$/;
export const CLONE_GITHUB_URL_WITH_CAPTURES = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
export const CLONE_MAX_SANDBOX_SIZE_BYTES = 150 * 1024 * 1024;

// From ingestion/local.ts
export const LOCAL_EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

// From agent/tools.ts
export const AGENT_TOOLS_MAX_READ_CHARS = 4000;
export const AGENT_TOOLS_ALREADY_EXAMINED_PREFIX = '[Already examined earlier in this session]\n';
// A bare matching line with no surrounding code gives the agent almost
// nothing to reason about — CONTEXT_LINES is the fixed-window fallback when
// enclosing-block detection doesn't fit within MAX_MATCH_OUTPUT_LINES.
export const AGENT_TOOLS_CONTEXT_LINES = 3;
export const AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES = 18;
export const AGENT_TOOLS_MAX_DOC_SEARCH_RESULTS = 10;

// From agent/prompts.ts
// 7 calls max per question, worst case: 1 combined plan+first-decision call
// (iteration 1) + up to 5 more reasoning calls + 1 final synthesis call.
export const MAX_ITERATIONS = 6;
export const AGENT_DECISION_JSON_SHAPE =
  '{"thought": "<your reasoning>", "action": "tool_call" | "finish", "toolName"?: "<tool name>", "toolArgs"?: { ... }}';
export const COMBINED_PLAN_JSON_SHAPE =
  '{"plan": "<3-5 step investigation plan>", "thought": "<your reasoning for the first action>", "action": "tool_call" | "finish", "toolName"?: "<tool name>", "toolArgs"?: { ... }}';
export const PROMPT_TOOL_ARG_SHAPES: Record<string, string> = {
  search_docs: '{ query: string }',
  read_file: '{ path: string, offset?: number, length?: number }',
  search_code: '{ query: string, maxResults?: number }',
  list_directory: '{ path: string }',
  get_file_summary: '{ path: string }',
  find_references: '{ symbol: string }',
};
// Display/cost limit only, not a coverage limit — search_docs mid-loop can
// still search the full text of a pre-generated doc.
export const PROMPT_FAST_PATH_DOC_CHAR_BUDGET = 3000;
// Display limit only (not a coverage limit — list_directory/search_code can
// still reach any file) so a large repo's file list doesn't dominate the prompt.
export const PROMPT_KNOWN_FILES_DISPLAY_LIMIT = 50;

// From agent/providers.ts
export const DEEP_DIVE_GROQ_MODEL = 'llama-3.3-70b-versatile';
// The Deep Dive ReAct loop (planning, tool-selection, multi-step reasoning,
// final synthesis) is the most cognitively demanding of the 3 roles that can
// fall back to OpenRouter — this is the largest/most capable model in the
// user-provided free-model shortlist, chosen deliberately for reasoning
// quality over speed since it's the sole, final fallback for an interactive path.
export const DEEP_DIVE_OPENROUTER_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
// A rate-limited wait here must fit inside investigator.ts's own
// STEP_TIMEOUT_MS (60s) with real margin left for the completion call itself.
export const DEEP_DIVE_RATE_LIMIT_HARD_WAIT_TIMEOUT_MS = 20_000;
// Live-verified ceiling for llama-3.3-70b-versatile specifically (roughly
// double the shared, more conservative PROVIDER_RATE_LIMITS.groq.tpm).
export const DEEP_DIVE_GROQ_TPM = 12_000;

// From agent/investigator.ts
// "Taking a long time" and "actually failed" are deliberately different
// events (see pipeline.ts's stall watchdog): SOFT_TIMEOUT_MS emits a
// still-working notice without aborting; STEP_TIMEOUT_MS aborts only a
// single stuck step; SESSION_SAFETY_CAP_MS is the absolute backstop.
export const INVESTIGATOR_SOFT_TIMEOUT_MS = 15_000;
export const INVESTIGATOR_STEP_TIMEOUT_MS = 60_000;
export const INVESTIGATOR_SESSION_SAFETY_CAP_MS = 180_000;
export const INVESTIGATOR_WATCHDOG_TICK_MS = 2_000;
export const INVESTIGATOR_REASON_MAX_TOKENS = 1000;
export const INVESTIGATOR_REASON_TEMPERATURE = 0.2;
export const AGENT_SYNTHESIS_MAX_TOKENS = 2000;
export const AGENT_SYNTHESIS_TEMPERATURE = 0.3;
export const INVESTIGATOR_FAST_PATH_MAX_TOKENS = 800;
export const INVESTIGATOR_FAST_PATH_TEMPERATURE = 0.2;
// Step 4's short/simple-query classification threshold: a purely mechanical
// word count (not an LLM call), gating only an ADDITIONAL cheap attempt —
// never a replacement for the full investigation.
export const INVESTIGATOR_SIMPLE_QUERY_MAX_WORDS = 12;

// From llm/provider.ts
export const PROVIDER_SERVER_ERROR_BACKOFFS_MS = [500, 1000, 2000];
export const PROVIDER_DEFAULT_RATE_LIMIT_WAIT_MS = 2000;
export const PROVIDER_RATE_LIMIT_MAX_RETRIES = 3;
// A daily/token-quota-exhausted 429 can carry a huge retry-after — cap a
// single retry's wait so it degrades to "failed, move on" instead of an
// unabortable multi-minute block for callers that don't thread a signal through.
export const PROVIDER_MAX_SINGLE_RATE_LIMIT_WAIT_MS = 15_000;
// Rough chars-per-token ratio for estimating input cost ahead of a call —
// good enough to keep a rate limiter's TPM budget from being blown through.
export const PROVIDER_CHARS_PER_TOKEN_ESTIMATE = 4;

// From llm/rate-limiter.ts
// Spreads out several parallel workers that would otherwise wake on the same
// tick and stampede a shared limiter simultaneously.
export const RATE_LIMITER_POLL_JITTER_MS = 25;
// Central per-provider free-tier ceilings, live-verified via each provider's
// own rate-limit response headers where noted — see rate-limiter.ts history
// for exactly which numbers are confirmed vs. conservative placeholders.
//
// openrouter: rpm=20 matches OpenRouter's published free-tier cap for
// ":free"-suffixed models (20 requests/minute, regardless of daily-request
// tier). tpm is deliberately `null` — OpenRouter doesn't publish a
// tokens-per-minute ceiling the way Groq does, and GUESSING one here is
// exactly the mistake that caused the rate-limiter regression fixed earlier
// this session (a wrong/conservative tpm falsely classifies normal requests
// as "oversized," forcing them through the up-to-65s full-refill escape
// hatch for no real reason). `null` keeps this provider RPM-only-gated,
// same safe default already used for Gemini.
export const PROVIDER_RATE_LIMITS: Record<string, ProviderRateLimits> = {
  groq: { rpm: 28, tpm: 6000 },
  gemini: { rpm: 13, tpm: null },
  openrouter: { rpm: 20, tpm: null },
};

// From pipeline.ts
export const PIPELINE_DEFAULT_MAX_FILES = 150;
// No progress (no stage transition, no file/doc completing) for this long is
// treated as stuck and aborted — duration alone never trips this.
export const PIPELINE_STALL_TIMEOUT_MS = 90 * 1000;
// Absolute safety net regardless of slow-but-real progress.
export const PIPELINE_ABSOLUTE_TIMEOUT_MS = 30 * 60 * 1000;
export const PIPELINE_WATCHDOG_INTERVAL_MS = 5 * 1000;
export const PIPELINE_GITHUB_URL_WITH_CAPTURES = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

// From security/sanitize.ts
export const SANITIZE_MAX_LLM_CONTENT_LENGTH = 8000;
export const SANITIZE_INJECTION_PREFIX_PATTERN = /^(system|instruction|assistant|human):/i;
export const SANITIZE_GHP_TOKEN_PATTERN = /ghp_[A-Za-z0-9]{36}/g;
export const SANITIZE_GITHUB_PAT_TOKEN_PATTERN = /github_pat_[A-Za-z0-9_]{22,}/g;

// From utils/json-repair.ts
export const JSON_REPAIR_CODE_FENCE_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
export const JSON_REPAIR_TRAILING_COMMA_PATTERN = /,(\s*[}\]])/g;
