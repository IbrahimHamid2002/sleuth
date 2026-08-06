import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

import { AGENT_TOOLS_ALREADY_EXAMINED_PREFIX, AGENT_TOOLS_CONTEXT_LINES, AGENT_TOOLS_MAX_DOC_SEARCH_RESULTS, AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES, AGENT_TOOLS_MAX_READ_CHARS } from '../constants';
import { ToolArgsSchemas } from '../schemas';
import { assertSafePath } from '../security/path-guard';
import type { AgentTool } from '../types';

export type { AgentContext, AgentTool } from '../types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSandboxFile(relativePath: string, sandboxPath: string): string {
  const safePath = assertSafePath(join(sandboxPath, relativePath), sandboxPath);

  return readFileSync(safePath, 'utf-8');
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

// Walks outward from a match to find the smallest enclosing indentation block
// via indentation alone — a heuristic, not a real parser. Returns null when
// the match is already at top-level indentation, so the caller falls back to
// a fixed window.
function detectEnclosingBlock(lines: string[], matchIndex: number): [number, number] | null {
  const matchIndent = indentOf(lines[matchIndex] ?? '');

  if (matchIndent === 0) {
    return null;
  }

  let start = 0;

  for (let i = matchIndex - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';

    if (line.trim().length === 0) {
      continue;
    }

    if (indentOf(line) < matchIndent) {
      start = i;
      break;
    }
  }

  const blockIndent = indentOf(lines[start] ?? '');
  let end = lines.length - 1;

  for (let i = matchIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (line.trim().length === 0) {
      continue;
    }

    if (indentOf(line) <= blockIndent) {
      end = i - 1;
      break;
    }
  }

  return [start, end];
}

// Renders one match as a bounded, readable block: enclosing block when it
// fits, else a fixed context window, always capped at MAX_MATCH_OUTPUT_LINES.
// The matched line is prefixed ">>" so the agent can tell match from context.
function formatMatchBlock(path: string, lines: string[], matchIndex: number): string {
  const enclosing = detectEnclosingBlock(lines, matchIndex);
  let start: number;
  let end: number;

  if (enclosing !== null && enclosing[1] - enclosing[0] + 1 <= AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES) {
    [start, end] = enclosing;
  } else {
    start = Math.max(0, matchIndex - AGENT_TOOLS_CONTEXT_LINES);
    end = Math.min(lines.length - 1, matchIndex + AGENT_TOOLS_CONTEXT_LINES);
  }

  if (end - start + 1 > AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES) {
    start = Math.max(start, matchIndex - Math.floor(AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES / 2));
    end = Math.min(end, start + AGENT_TOOLS_MAX_MATCH_OUTPUT_LINES - 1);
  }

  const rendered: string[] = [];

  for (let i = start; i <= end; i += 1) {
    const marker = i === matchIndex ? '>>' : '  ';

    rendered.push(`${marker} ${path}:${i + 1}: ${lines[i]}`);
  }

  return rendered.join('\n');
}

const readFileTool: AgentTool = {
  name: 'read_file',
  description:
    'Reads real file content directly from the repository — this is the AUTHORITATIVE source for how code actually behaves. Always call this (not get_file_summary) before finalizing any answer that describes implementation details, logic, or behavior. Returns up to 4000 characters at a time starting at "offset" (default 0); pass "length" to change the chunk size. If the response says more content exists, call again with the given offset to continue — never assume a large file has been fully seen until the response says there is no more.',
  parameters: ToolArgsSchemas.read_file,
  execute: async (args, ctx) => {
    const { path, offset = 0, length = AGENT_TOOLS_MAX_READ_CHARS } = args as z.infer<typeof ToolArgsSchemas.read_file>;

    let fullContent = ctx.visitedFiles.get(path);

    if (fullContent === undefined) {
      try {
        fullContent = readSandboxFile(path, ctx.sandboxPath);
      } catch (err) {
        return `Error reading file "${path}": ${(err as Error).message}`;
      }

      ctx.visitedFiles.set(path, fullContent);
    } else if (offset === 0 && length === AGENT_TOOLS_MAX_READ_CHARS) {
      // Exact-duplicate default request already served this session — signal
      // that explicitly rather than silently re-returning the same content.
      return `${AGENT_TOOLS_ALREADY_EXAMINED_PREFIX}${fullContent.slice(0, AGENT_TOOLS_MAX_READ_CHARS)}`;
    }

    const totalLength = fullContent.length;

    // An already-exhausted offset used to return a degenerate "Showing chars
    // 4000-4000 of 914" message that a confused agent looped on for several
    // iterations — an explicit, actionable message heads that off.
    if (offset > 0 && offset >= totalLength) {
      return `File "${path}" is only ${totalLength} characters long — offset ${offset} is past the end of the file. There is no more content to read; call again with a smaller offset (e.g. 0) only if you need to re-read an earlier part.`;
    }

    const slice = fullContent.slice(offset, offset + length);
    const end = offset + slice.length;
    const hasMore = end < totalLength;

    if (!hasMore && offset === 0) {
      return slice;
    }

    const continuation = hasMore ? ` Call again with offset=${end} to continue.` : ' End of file.';

    return `Showing chars ${offset}-${end} of ${totalLength}.${continuation}\n\n${slice}`;
  },
};

const searchCodeTool: AgentTool = {
  name: 'search_code',
  description:
    'Case-insensitive substring search across all analyzed files. Returns each match as a bounded block of surrounding code (enclosing function/block when detectable, otherwise a few lines of context), with the matched line prefixed ">>". Use this to locate candidate files/lines, then confirm behavior with read_file if the question requires understanding real logic.',
  parameters: ToolArgsSchemas.search_code,
  execute: async (args, ctx) => {
    const { query, maxResults } = args as z.infer<typeof ToolArgsSchemas.search_code>;
    const needle = query.toLowerCase();
    const blocks: string[] = [];

    for (const path of ctx.summariesMap.keys()) {
      if (blocks.length >= maxResults) {
        break;
      }

      try {
        const lines = readSandboxFile(path, ctx.sandboxPath).split('\n');

        for (const [index, line] of lines.entries()) {
          if (blocks.length >= maxResults) {
            break;
          }

          if (line.toLowerCase().includes(needle)) {
            blocks.push(formatMatchBlock(path, lines, index));
          }
        }
      } catch {
        continue;
      }
    }

    return blocks.length > 0 ? blocks.join('\n\n') : 'No matches found';
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
  description:
    'Returns a previously LLM-generated summary for a file. NAVIGATION AID ONLY — use it to triage which file is likely relevant to the question, never as the basis for a factual claim about how the code actually behaves, its logic, or its implementation. Any such claim requires a follow-up read_file call on the real source first; this summary has not been verified against it.',
  parameters: ToolArgsSchemas.get_file_summary,
  execute: async (args, ctx) => {
    const { path } = args as z.infer<typeof ToolArgsSchemas.get_file_summary>;
    const summary = ctx.summariesMap.get(path);

    return summary !== undefined ? JSON.stringify(summary) : 'No summary available for this file';
  },
};

const findReferencesTool: AgentTool = {
  name: 'find_references',
  description:
    'Finds whole-word occurrences of a symbol across all analyzed files. Returns each match as a bounded block of surrounding code (enclosing function/block when detectable, otherwise a few lines of context), with the matched line prefixed ">>". Use this to locate candidate files/lines, then confirm behavior with read_file if the question requires understanding real logic.',
  parameters: ToolArgsSchemas.find_references,
  execute: async (args, ctx) => {
    const { symbol } = args as z.infer<typeof ToolArgsSchemas.find_references>;
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const blocks: string[] = [];

    for (const path of ctx.summariesMap.keys()) {
      try {
        const lines = readSandboxFile(path, ctx.sandboxPath).split('\n');

        lines.forEach((line, index) => {
          if (pattern.test(line)) {
            blocks.push(formatMatchBlock(path, lines, index));
          }
        });
      } catch {
        continue;
      }
    }

    return blocks.length > 0 ? blocks.join('\n\n') : 'No references found';
  },
};

// Mid-loop fallback for the pre-generated docs: investigator.ts's fast-path
// step already tries these whole before the ReAct loop starts; this tool
// covers cases that missed, or when the model wants to re-check a term.
const searchDocsTool: AgentTool = {
  name: 'search_docs',
  description:
    'Searches the 3 pre-generated repository documents (README, ARCHITECTURE, ONBOARDING) for a keyword or phrase. ALWAYS try this (or rely on the fast-path doc check already done for you) BEFORE read_file/search_code/find_references/list_directory — these docs already summarize the whole repository, so answering from them is far cheaper and faster than a live source investigation. Only escalate to the other tools if these docs do not cover the question.',
  parameters: ToolArgsSchemas.search_docs,
  execute: async (args, ctx) => {
    const { query } = args as z.infer<typeof ToolArgsSchemas.search_docs>;

    if (ctx.generatedDocs === undefined) {
      return 'No pre-generated documents are available for this session — proceed to the live source-code tools.';
    }

    const needle = query.toLowerCase();
    const docs: Array<{ label: string; content: string }> = [
      { label: 'README.generated.md', content: ctx.generatedDocs.readme },
      { label: 'ARCHITECTURE.md', content: ctx.generatedDocs.architecture },
      { label: 'ONBOARDING.md', content: ctx.generatedDocs.onboarding },
    ];
    const blocks: string[] = [];

    for (const doc of docs) {
      if (blocks.length >= AGENT_TOOLS_MAX_DOC_SEARCH_RESULTS) {
        break;
      }

      const lines = doc.content.split('\n');

      for (const [index, line] of lines.entries()) {
        if (blocks.length >= AGENT_TOOLS_MAX_DOC_SEARCH_RESULTS) {
          break;
        }

        if (line.toLowerCase().includes(needle)) {
          blocks.push(formatMatchBlock(doc.label, lines, index));
        }
      }
    }

    return blocks.length > 0
      ? blocks.join('\n\n')
      : 'No matches found in the pre-generated documents — this likely needs a live source-code tool instead';
  },
};

export const TOOLS: AgentTool[] = [
  searchDocsTool,
  readFileTool,
  searchCodeTool,
  listDirectoryTool,
  getFileSummaryTool,
  findReferencesTool,
];
