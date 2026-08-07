import { describe, expect, it } from 'vitest';

import { buildDirectoryTree } from '../documentation/directory-tree';

describe('buildDirectoryTree', () => {
  it('returns a placeholder for an empty file list', () => {
    expect(buildDirectoryTree([])).toBe('(no files discovered)');
  });

  it('renders a single top-level file with no nesting', () => {
    expect(buildDirectoryTree(['package.json'])).toBe('└── package.json');
  });

  it('nests directories and sorts directories before files, alphabetically within each group', () => {
    const tree = buildDirectoryTree(['src/index.ts', 'package.json', 'src/utils/helper.ts', 'README.md']);

    expect(tree).toBe(
      ['├── src/', '│   ├── utils/', '│   │   └── helper.ts', '│   └── index.ts', '├── package.json', '└── README.md'].join(
        '\n',
      ),
    );
  });

  it('groups files under the same directory node instead of duplicating the directory', () => {
    const tree = buildDirectoryTree(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    expect(tree.match(/src\//g)).toHaveLength(1);
    expect(tree).toContain('a.ts');
    expect(tree).toContain('b.ts');
    expect(tree).toContain('c.ts');
  });

  it('is deterministic — the same input always produces the same output', () => {
    const paths = ['src/index.ts', 'src/app.ts', 'src/routes/users.ts', 'package.json'];

    expect(buildDirectoryTree(paths)).toBe(buildDirectoryTree([...paths]));
  });

  it('truncates very large trees with a note instead of producing unbounded output', () => {
    const manyPaths = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    const tree = buildDirectoryTree(manyPaths);

    expect(tree).toContain('truncated');
    expect(tree.split('\n').length).toBeLessThan(500);
  });
});
