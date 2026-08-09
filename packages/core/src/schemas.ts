import { z } from 'zod';

export const FileSummarySchema = z.object({
  path: z.string(),
  purpose: z.string().max(500),
  exports: z.array(z.string().max(100)).max(50),
  dependencies: z.array(z.string().max(100)).max(50),
  summary: z.string().max(1000),
});

export const AgentDecisionSchema = z.object({
  thought: z.string(),
  action: z.enum(['tool_call', 'finish']),
  toolName: z.string().optional(),
  toolArgs: z.record(z.unknown()).optional(),
});

// The Deep Dive agent's first iteration merges planning and its first
// tool-call decision into one LLM call (quota conservation) — this is that
// combined response shape, an AgentDecision plus a "plan" field.
export const CombinedPlanAndDecisionSchema = AgentDecisionSchema.extend({
  plan: z.string(),
});

// The deterministic fast-path step's response shape (see
// agent/prompts.ts's buildFastPathPrompt) — checks whether the 3
// pre-generated docs alone can confidently answer a question before any live
// tool call runs.
export const FastPathAnswerSchema = z.object({
  answerable: z.boolean(),
  answer: z.string().optional(),
});

// documentation/synthesizer.ts's exit path for every README/ARCHITECTURE/
// ONBOARDING LLM call (CLAUDE.md §2 rule 5: every LLM call site needs a
// Zod-validated exit path). Synthesis output is free-form Markdown, not
// structured JSON, so this is deliberately loose — it only guards the one
// real failure mode raw text can have (blank/whitespace-only), never
// rejecting genuine prose. A tighter schema here would risk exactly the
// false-negative-into-fallback failure mode this task investigated.
export const SynthesisDocumentSchema = z.string().trim().min(1, 'synthesis output is empty or whitespace-only');

export const ToolArgsSchemas = {
  read_file: z.object({
    path: z.string(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().positive().optional(),
  }),
  search_code: z.object({ query: z.string(), maxResults: z.number().default(20) }),
  list_directory: z.object({ path: z.string() }),
  get_file_summary: z.object({ path: z.string() }),
  find_references: z.object({ symbol: z.string() }),
  search_docs: z.object({ query: z.string() }),
};

export const RepoInputSchema = z
  .object({
    type: z.enum(['local', 'github']),
    path: z.string().optional(),
    url: z
      .string()
      // eslint-disable-next-line no-useless-escape -- hyphen kept escaped intentionally for safety, not a lint miss
      .regex(/^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+(\.git)?$/)
      .optional(),
    pat: z.string().optional(),
  })
  .refine((repoInput) => (repoInput.type === 'local' ? !!repoInput.path : !!repoInput.url), {
    message: 'path required for local, url required for github',
  });
