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
    it('returns real content on the first call and cached content on the second identical call without re-reading disk', async () => {
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

    describe('pagination', () => {
      beforeEach(() => {
        fs.mkdirSync(join(sandboxPath, 'src'));
      });

      it('defaults to the raw content with no pagination metadata when the file fits in one chunk', async () => {
        const smallContent = 'a'.repeat(3000);

        fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), smallContent);

        const tool = getTool('read_file');
        const args = tool.parameters.parse({ path: 'src/big.ts' });
        const result = await tool.execute(args, ctx);

        expect(result).toBe(smallContent);
        expect(result).not.toContain('Showing chars');
      });

      it('paginates a file larger than the default chunk and includes continuation metadata', async () => {
        const tool = getTool('read_file');
        const largeContent = 'a'.repeat(5000) + 'b'.repeat(2500);

        fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), largeContent);

        const firstArgs = tool.parameters.parse({ path: 'src/big.ts' });
        const firstResult = await tool.execute(firstArgs, ctx);

        expect(firstResult).toContain('Showing chars 0-4000 of 7500.');
        expect(firstResult).toContain('Call again with offset=4000 to continue.');
        expect(firstResult).toContain('a'.repeat(100));

        const secondArgs = tool.parameters.parse({ path: 'src/big.ts', offset: 4000 });
        const secondResult = await tool.execute(secondArgs, ctx);

        expect(secondResult).toContain('Showing chars 4000-7500 of 7500.');
        expect(secondResult).toContain('End of file.');
        expect(secondResult).toContain('b'.repeat(100));

        const firstBody = firstResult.slice(firstResult.indexOf('\n\n') + 2);
        const secondBody = secondResult.slice(secondResult.indexOf('\n\n') + 2);

        expect(firstBody + secondBody).toBe(largeContent);
      });

      it('does not re-read the file from disk when paginating a second chunk', async () => {
        const largeContent = 'a'.repeat(5000);

        fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), largeContent);

        const readSpy = vi.mocked(fs.readFileSync);
        const tool = getTool('read_file');

        readSpy.mockClear();

        await tool.execute(tool.parameters.parse({ path: 'src/big.ts' }), ctx);
        await tool.execute(tool.parameters.parse({ path: 'src/big.ts', offset: 4000 }), ctx);

        expect(readSpy).toHaveBeenCalledTimes(1);
      });

      it('respects an explicit length parameter', async () => {
        fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), 'a'.repeat(100));

        const tool = getTool('read_file');
        const args = tool.parameters.parse({ path: 'src/big.ts', offset: 0, length: 10 });
        const result = await tool.execute(args, ctx);

        expect(result).toContain('Showing chars 0-10 of 100.');
        expect(result).toContain('Call again with offset=10 to continue.');
      });

      it('returns a clear, actionable message instead of a degenerate range when offset is past the end of the file', async () => {
        fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), 'a'.repeat(914));

        const tool = getTool('read_file');
        const args = tool.parameters.parse({ path: 'src/big.ts', offset: 4000 });
        const result = await tool.execute(args, ctx);

        expect(result).toBe(
          'File "src/big.ts" is only 914 characters long — offset 4000 is past the end of the file. There is no more content to read; call again with a smaller offset (e.g. 0) only if you need to re-read an earlier part.',
        );
        expect(result).not.toContain('Showing chars');
      });
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

    // All three matches below sit at top-level (indent 0) in files short enough
    // that the fixed +/-CONTEXT_LINES window ends up covering the whole file —
    // deterministic and exact, so asserted with toBe rather than toContain.
    const expectedBarBlocks = [
      [
        '   src/foo.ts:1: export const foo = 1;',
        '>> src/foo.ts:2: export function bar() {',
        '   src/foo.ts:3:   return foo;',
        '   src/foo.ts:4: }',
        '   src/foo.ts:5: ',
      ].join('\n'),
      [
        ">> src/baz.ts:1: import { bar } from './foo';",
        '   src/baz.ts:2: ',
        '   src/baz.ts:3: console.log(bar());',
        '   src/baz.ts:4: ',
      ].join('\n'),
      [
        "   src/baz.ts:1: import { bar } from './foo';",
        '   src/baz.ts:2: ',
        '>> src/baz.ts:3: console.log(bar());',
        '   src/baz.ts:4: ',
      ].join('\n'),
    ];

    it('search_code finds case-insensitive substring matches and returns each as a context block with the match line marked ">>"', async () => {
      const tool = getTool('search_code');
      const args = tool.parameters.parse({ query: 'BAR' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(expectedBarBlocks.join('\n\n'));
    });

    it('search_code respects maxResults (counting matches, not rendered lines)', async () => {
      const tool = getTool('search_code');
      const args = tool.parameters.parse({ query: 'bar', maxResults: 1 });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(expectedBarBlocks[0]);
    });

    it('find_references matches the symbol as a whole word and returns each as a context block with the match line marked ">>"', async () => {
      const tool = getTool('find_references');
      const args = tool.parameters.parse({ symbol: 'bar' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe(expectedBarBlocks.join('\n\n'));
    });

    it('find_references does not match a symbol that only appears as a substring of another identifier', async () => {
      const tool = getTool('find_references');
      const args = tool.parameters.parse({ symbol: 'ba' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('No references found');
    });
  });

  describe('search_code and find_references — context block shape', () => {
    it('prefers the enclosing function block over a fixed window when the match is indented and the block is small', async () => {
      fs.mkdirSync(join(sandboxPath, 'src'));
      fs.writeFileSync(
        join(sandboxPath, 'src', 'module.ts'),
        [
          'export const TOP = 1;',
          '',
          'export function outer() {',
          '  const value = helper();',
          '  return value;',
          '}',
          '',
          'function helper() {',
          '  return TOP + 1;',
          '}',
          '',
        ].join('\n'),
      );
      ctx.summariesMap.set('src/module.ts', {
        path: 'src/module.ts',
        purpose: 'module',
        exports: [],
        dependencies: [],
        summary: 'module file',
      });

      const tool = getTool('find_references');
      const args = tool.parameters.parse({ symbol: 'helper' });
      const result = await tool.execute(args, ctx);
      const blocks = result.split('\n\n');

      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toBe(
        [
          '   src/module.ts:3: export function outer() {',
          '>> src/module.ts:4:   const value = helper();',
          '   src/module.ts:5:   return value;',
        ].join('\n'),
      );
      // Proves this came from enclosing-block detection, not the fixed window
      // or the whole file: the unrelated top-level line is excluded.
      expect(blocks[0]).not.toContain('TOP');
    });

    it('falls back to a bounded fixed window instead of an oversized enclosing block', async () => {
      const bodyLines = Array.from({ length: 25 }, (_, i) => (i === 12 ? '  const NEEDLE = i;' : `  const line${i} = ${i};`));
      const fileContent = ['function big() {', ...bodyLines, '}', ''].join('\n');

      fs.mkdirSync(join(sandboxPath, 'src'));
      fs.writeFileSync(join(sandboxPath, 'src', 'big.ts'), fileContent);
      ctx.summariesMap.set('src/big.ts', {
        path: 'src/big.ts',
        purpose: 'big',
        exports: [],
        dependencies: [],
        summary: 'big file',
      });

      const tool = getTool('search_code');
      const args = tool.parameters.parse({ query: 'NEEDLE' });
      const result = await tool.execute(args, ctx);
      const renderedLines = result.split('\n');

      // The enclosing function body is 27 lines (well over the cap) — a bounded
      // fixed window must have been used instead.
      expect(renderedLines.length).toBeLessThanOrEqual(18);
      expect(result).not.toContain('function big() {');
      expect(result).toContain('>> src/big.ts:14:   const NEEDLE = i;');
    });
  });

  describe('search_docs', () => {
    it('finds matches across all 3 generated docs and labels each block by which doc it came from', async () => {
      ctx.generatedDocs = {
        readme: 'This project is an Express API.\nIt has a health check endpoint.',
        architecture: 'The entry point is src/index.ts.\nExpress routes live in src/routes.',
        onboarding: 'Run npm install first.\nThen run npm start.',
      };

      const tool = getTool('search_docs');
      const args = tool.parameters.parse({ query: 'express' });
      const result = await tool.execute(args, ctx);

      expect(result).toContain('README.generated.md:1');
      expect(result).toContain('ARCHITECTURE.md:2');
      expect(result).toContain('>> README.generated.md:1: This project is an Express API.');
      expect(result).toContain('>> ARCHITECTURE.md:2: Express routes live in src/routes.');
    });

    it('returns a clear "no matches" message when the query is not found in any doc', async () => {
      ctx.generatedDocs = {
        readme: 'This project is an Express API.',
        architecture: 'The entry point is src/index.ts.',
        onboarding: 'Run npm install first.',
      };

      const tool = getTool('search_docs');
      const args = tool.parameters.parse({ query: 'kubernetes' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('No matches found in the pre-generated documents — this likely needs a live source-code tool instead');
    });

    it('returns a clear message instead of crashing when no generatedDocs are available on the session', async () => {
      const tool = getTool('search_docs');
      const args = tool.parameters.parse({ query: 'anything' });
      const result = await tool.execute(args, ctx);

      expect(result).toBe('No pre-generated documents are available for this session — proceed to the live source-code tools.');
    });
  });
});
