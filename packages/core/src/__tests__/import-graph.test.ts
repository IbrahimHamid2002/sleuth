import { describe, expect, it } from 'vitest';

import { buildImportGraph } from '../analysis/import-graph';
import type { FileNode } from '../types';

describe('buildImportGraph', () => {
  it('resolves relative imports (static, require, dynamic), handles circular imports without looping, and skips bare specifiers and unresolvable paths', () => {
    const files: FileNode[] = [
      { path: 'src/a.ts', type: 'file', size: 10 },
      { path: 'src/b.ts', type: 'file', size: 10 },
      { path: 'src/c.ts', type: 'file', size: 10 },
      { path: 'lib/util.ts', type: 'file', size: 10 },
      { path: 'src/index.ts', type: 'file', size: 10 },
      { path: 'src/components/Button/index.tsx', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      [
        'src/a.ts',
        [
          "import { b } from './b';",
          "import { util } from '../lib/util';",
          "const loadC = () => import('./c');",
          "import('./missing');",
        ].join('\n'),
      ],
      // Circular import back to a.ts, via require() this time.
      ['src/b.ts', "const a = require('./a');"],
      ['src/c.ts', 'export const c = 1;'],
      ['lib/util.ts', 'export const util = 1;'],
      [
        'src/index.ts',
        ["import Button from './components/Button';", "import react from 'react';"].join('\n'),
      ],
      ['src/components/Button/index.tsx', 'export const Button = () => null;'],
    ]);

    const { inDegree } = buildImportGraph(files, contentCache);

    expect(inDegree.get('src/b.ts')).toBe(1);
    expect(inDegree.get('lib/util.ts')).toBe(1);
    expect(inDegree.get('src/c.ts')).toBe(1);
    expect(inDegree.get('src/a.ts')).toBe(1);
    expect(inDegree.get('src/components/Button/index.tsx')).toBe(1);

    // Bare specifier ('react') and unresolvable relative path ('./missing') never
    // appear as keys — they must not be resolved or counted.
    expect(inDegree.has('react')).toBe(false);
    expect(inDegree.has('src/missing.ts')).toBe(false);
    expect(inDegree.size).toBe(5);
  });

  it('accumulates multiple importers of the same target file', () => {
    const files: FileNode[] = [
      { path: 'src/a.ts', type: 'file', size: 10 },
      { path: 'src/b.ts', type: 'file', size: 10 },
      { path: 'src/shared.ts', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      ['src/a.ts', "import { x } from './shared';"],
      ['src/b.ts', "import { y } from './shared';"],
      ['src/shared.ts', 'export const x = 1;\nexport const y = 2;'],
    ]);

    const { inDegree } = buildImportGraph(files, contentCache);

    expect(inDegree.get('src/shared.ts')).toBe(2);
  });
});
