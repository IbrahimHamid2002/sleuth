import { describe, expect, it } from 'vitest';

import { buildSymbolIndex, indexSymbols } from '../analysis/symbol-indexer';
import type { FileNode } from '../types';

describe('indexSymbols', () => {
  it('extracts functions, classes, consts, and export-block members with correct 1-indexed line numbers', () => {
    const content = [
      'export function foo() {}',
      'export async function bar() {}',
      'export class Baz {}',
      'export const qux = 1;',
      'export default const nope = 2;',
      'export { alpha, beta , gamma};',
      'const notExported = 1;',
    ].join('\n');

    const symbols = indexSymbols('fixture.ts', content);

    expect(symbols).toEqual([
      { name: 'foo', type: 'function', line: 1 },
      { name: 'bar', type: 'function', line: 2 },
      { name: 'Baz', type: 'class', line: 3 },
      { name: 'qux', type: 'const', line: 4 },
      { name: 'nope', type: 'const', line: 5 },
      { name: 'alpha', type: 'export', line: 6 },
      { name: 'beta', type: 'export', line: 6 },
      { name: 'gamma', type: 'export', line: 6 },
    ]);
  });

  it('returns an empty array when a file has no matching export patterns', () => {
    expect(indexSymbols('fixture.ts', 'const local = 1;\nfunction helper() {}')).toEqual([]);
  });
});

describe('buildSymbolIndex', () => {
  it('maps each symbol name to every file/line location that exports it', () => {
    const files: FileNode[] = [
      { path: 'a.ts', type: 'file', size: 10 },
      { path: 'b.ts', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      ['a.ts', 'export const shared = 1;'],
      ['b.ts', 'export function shared() {}'],
    ]);

    const index = buildSymbolIndex(files, contentCache);

    expect(index.get('shared')).toEqual([
      { path: 'a.ts', line: 1 },
      { path: 'b.ts', line: 1 },
    ]);
  });
});
