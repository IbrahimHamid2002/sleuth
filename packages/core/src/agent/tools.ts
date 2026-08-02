import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

import { ToolArgsSchemas } from '../schemas';
import { assertSafePath } from '../security/path-guard';
import type { FileSummary, RepoMeta } from '../types';

export interface AgentContext {
  sandboxPath: string;
  repoMeta: RepoMeta;
  summariesMap: Map<string, FileSummary>;
  visitedFiles: Map<string, string>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- justified: args are Zod-validated against `parameters` by the caller before execute() runs, so a concrete type here would just duplicate that per-tool contract
  execute: (args: any, ctx: AgentContext) => Promise<string>;
}

const MAX_READ_CHARS = 4000;
const ALREADY_EXAMINED_PREFIX = '[Already examined earlier in this session]\n';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSandboxFile(relativePath: string, sandboxPath: string): string {
  const safePath = assertSafePath(join(sandboxPath, relativePath), sandboxPath);

  return readFileSync(safePath, 'utf-8');
}

const readFileTool: AgentTool = {
  name: 'read_file',
  description:
    'Reads the content of a file in the repository (truncated to 4000 characters). Prefer get_file_summary when a summary already exists.',
  parameters: ToolArgsSchemas.read_file,
  execute: async (args, ctx) => {
    const { path } = args as z.infer<typeof ToolArgsSchemas.read_file>;
    const cached = ctx.visitedFiles.get(path);

    if (cached !== undefined) {
      return `${ALREADY_EXAMINED_PREFIX}${cached}`;
    }

    try {
      const content = readSandboxFile(path, ctx.sandboxPath).slice(0, MAX_READ_CHARS);

      ctx.visitedFiles.set(path, content);

      return content;
    } catch (err) {
      return `Error reading file "${path}": ${(err as Error).message}`;
    }
  },
};

const searchCodeTool: AgentTool = {
  name: 'search_code',
  description:
    'Case-insensitive substring search across all analyzed files. Returns matching "path:line: <line content>" entries.',
  parameters: ToolArgsSchemas.search_code,
  execute: async (args, ctx) => {
    const { query, maxResults } = args as z.infer<typeof ToolArgsSchemas.search_code>;
    const needle = query.toLowerCase();
    const matches: string[] = [];

    for (const path of ctx.summariesMap.keys()) {
      if (matches.length >= maxResults) {
        break;
      }

      try {
        const lines = readSandboxFile(path, ctx.sandboxPath).split('\n');

        for (const [index, line] of lines.entries()) {
          if (matches.length >= maxResults) {
            break;
          }

          if (line.toLowerCase().includes(needle)) {
            matches.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        }
      } catch {
        continue;
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found';
  },
};

const listDirectoryTool: AgentTool = {
  name: 'list_directory',
  description: 'Lists entries in a directory within the repository sandbox. Directories are suffixed with "/".',
  parameters: ToolArgsSchemas.list_directory,
  execute: async (args, ctx) => {
    const { path } = args as z.infer<typeof ToolArgsSchemas.list_directory>;

    try {
      const safePath = assertSafePath(join(ctx.sandboxPath, path), ctx.sandboxPath);
      const entries = readdirSync(safePath, { withFileTypes: true });

      return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join('\n');
    } catch (err) {
      return `Error listing directory "${path}": ${(err as Error).message}`;
    }
  },
};

const getFileSummaryTool: AgentTool = {
  name: 'get_file_summary',
  description: 'Returns the previously generated summary for a file, if one exists. Prefer this over read_file when possible.',
  parameters: ToolArgsSchemas.get_file_summary,
  execute: async (args, ctx) => {
    const { path } = args as z.infer<typeof ToolArgsSchemas.get_file_summary>;
    const summary = ctx.summariesMap.get(path);

    return summary !== undefined ? JSON.stringify(summary) : 'No summary available for this file';
  },
};

const findReferencesTool: AgentTool = {
  name: 'find_references',
  description: 'Finds whole-word occurrences of a symbol across all analyzed files. Returns matching "path:line" entries.',
  parameters: ToolArgsSchemas.find_references,
  execute: async (args, ctx) => {
    const { symbol } = args as z.infer<typeof ToolArgsSchemas.find_references>;
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const matches: string[] = [];

    for (const path of ctx.summariesMap.keys()) {
      try {
        const lines = readSandboxFile(path, ctx.sandboxPath).split('\n');

        lines.forEach((line, index) => {
          if (pattern.test(line)) {
            matches.push(`${path}:${index + 1}`);
          }
        });
      } catch {
        continue;
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'No references found';
  },
};

export const TOOLS: AgentTool[] = [
  readFileTool,
  searchCodeTool,
  listDirectoryTool,
  getFileSummaryTool,
  findReferencesTool,
];
