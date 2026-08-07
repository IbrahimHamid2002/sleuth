import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentContext, AgentTool } from '../agent/tools';
import { TOOLS } from '../agent/tools';
import type { FileSummary, RepoMeta } from '../types';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');

  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function getTool(name: string): AgentTool {
  const tool = TOOLS.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`No tool registered with name "${name}"`);
  }

  return tool;
}

function buildRepoMeta(): RepoMeta {
  return {
    name: 'fixture-repo',
    identifier: 'fixture-repo',
    commitHash: 'abc123',
    rootPath: '/fixture',
    frameworks: [],
    isMonorepo: false,
    monorepoType: 'none',
    workspaceDirs: [],
    packageManager: 'npm',
    subProjects: [],
  };
}

describe('agent tools', () => {
  let sandboxPath: string;
  let ctx: AgentContext;

  beforeEach(() => {
    sandboxPath = fs.mkdtempSync(join(tmpdir(), 'sleuth-agent-tools-'));
    ctx = {
      sandboxPath,
      repoMeta: buildRepoMeta(),
      summariesMap: new Map<string, FileSummary>(),
      visitedFiles: new Map<string, string>(),
    };
  });

  afterEach(() => {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('returns real content on the first call and cached content on the second call without re-reading disk', async () => {
      const tool = getTool('read_file');

      fs.mkdirSync(join(sandboxPath, 'src'));
      fs.writeFileSync(join(sandboxPath, 'src', 'foo.ts'), 'export const foo = 1;');

      const readSpy = vi.mocked(fs.readFileSync);

      readSpy.mockClear();

      const args = tool.parameters.parse({ path: 'src/foo.ts' });

      const first = await tool.execute(args, ctx);

      expect(first).toBe('export const foo = 1;');
      expect(readSpy).toHaveBeenCalledTimes(1);

      const second = await tool.execute(args, ctx);

      expect(second).toBe('[Already examined earlier in this session]\nexport const foo = 1;');
      expect(readSpy).toHaveBeenCalledTimes(1);
    });

    it('never escapes the sandbox on a path traversal attempt and returns an error string instead of throwing', async () => {
      const tool = getTool('read_file');
      const args = tool.parameters.parse({ path: '../../etc/passwd' });

      let result: string | undefined;

      await expect(
        (async () => {
          result = await tool.execute(args, ctx);
        })(),
      ).resolves.toBeUndefined();

      expect(result).toContain('Error reading file');
      expect(result).not.toContain('root:');
    });
  });

  describe('get_file_summary', () => {
    it('returns the JSON-stringified summary for a known path', async () => {
      const tool = getTool('get_file_summary');
      const summary: FileSummary = {
        path: 'src/foo.ts',
        purpose: 'Defines foo',
        exports: ['foo'],
        dependencies: [],
        summary: 'A fixture file.',
      };

      ctx.summariesMap.set('src/foo.ts', summary);

      const args = tool.parameters.parse({ path: 'src/foo.ts' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(JSON.stringify(summary));
    });

    it('returns the fallback string for an unknown path', async () => {
      const tool = getTool('get_file_summary');
      const args = tool.parameters.parse({ path: 'src/unknown.ts' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('No summary available for this file');
    });
  });

  describe('search_code and find_references', () => {
    beforeEach(() => {
      fs.mkdirSync(join(sandboxPath, 'src'));
      fs.writeFileSync(
        join(sandboxPath, 'src', 'foo.ts'),
        ['export const foo = 1;', 'export function bar() {', '  return foo;', '}', ''].join('\n'),
      );
      fs.writeFileSync(
        join(sandboxPath, 'src', 'baz.ts'),
        ["import { bar } from './foo';", '', 'console.log(bar());', ''].join('\n'),
      );

      ctx.summariesMap.set('src/foo.ts', {
        path: 'src/foo.ts',
        purpose: 'foo',
        exports: ['foo', 'bar'],
        dependencies: [],
        summary: 'foo file',
      });
      ctx.summariesMap.set('src/baz.ts', {
        path: 'src/baz.ts',
        purpose: 'baz',
        exports: [],
        dependencies: ['./foo'],
        summary: 'baz file',
      });
    });

    it('search_code finds case-insensitive substring matches across all analyzed files', async () => {
      const tool = getTool('search_code');
      const args = tool.parameters.parse({ query: 'BAR' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(
        ['src/foo.ts:2: export function bar() {', "src/baz.ts:1: import { bar } from './foo';", 'src/baz.ts:3: console.log(bar());'].join(
          '\n',
        ),
      );
    });

    it('search_code respects maxResults', async () => {
      const tool = getTool('search_code');
      const args = tool.parameters.parse({ query: 'bar', maxResults: 1 });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('src/foo.ts:2: export function bar() {');
    });

    it('find_references matches the symbol as a whole word and returns path:line entries', async () => {
      const tool = getTool('find_references');
      const args = tool.parameters.parse({ symbol: 'bar' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(['src/foo.ts:2', 'src/baz.ts:1', 'src/baz.ts:3'].join('\n'));
    });

    it('find_references does not match a symbol that only appears as a substring of another identifier', async () => {
      const tool = getTool('find_references');
      const args = tool.parameters.parse({ symbol: 'ba' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('No references found');
    });
  });
});
