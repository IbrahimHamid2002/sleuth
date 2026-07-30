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

export const ToolArgsSchemas = {
  read_file: z.object({ path: z.string() }),
  search_code: z.object({ query: z.string(), maxResults: z.number().default(20) }),
  list_directory: z.object({ path: z.string() }),
  get_file_summary: z.object({ path: z.string() }),
  find_references: z.object({ symbol: z.string() }),
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
  .refine((d) => (d.type === 'local' ? !!d.path : !!d.url), {
    message: 'path required for local, url required for github',
  });
