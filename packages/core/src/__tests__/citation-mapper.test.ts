import { describe, expect, it } from 'vitest';

import { mapCitations } from '../documentation/citation-mapper';

describe('mapCitations', () => {
  it('appends [path:line] for an identifier found in the symbol index', () => {
    const symbolIndex = new Map([['createSandbox', [{ path: 'src/ingestion/sandbox-manager.ts', line: 12 }]]]);

    const result = mapCitations('Call `createSandbox` to set up the workspace.', symbolIndex);

    expect(result).toBe('Call `createSandbox` [src/ingestion/sandbox-manager.ts:12] to set up the workspace.');
  });

  it('leaves unmatched identifiers untouched rather than fabricating a citation', () => {
    const symbolIndex = new Map<string, Array<{ path: string; line: number }>>();

    const result = mapCitations('Call `mysteryFunction` here.', symbolIndex);

    expect(result).toBe('Call `mysteryFunction` here.');
  });

  it('uses the first matching location when a symbol has multiple locations', () => {
    const symbolIndex = new Map([
      [
        'handler',
        [
          { path: 'src/a.ts', line: 5 },
          { path: 'src/b.ts', line: 10 },
        ],
      ],
    ]);

    const result = mapCitations('See `handler`.', symbolIndex);

    expect(result).toBe('See `handler` [src/a.ts:5].');
  });

  it('annotates every occurrence of a repeated identifier', () => {
    const symbolIndex = new Map([['foo', [{ path: 'src/foo.ts', line: 1 }]]]);

    const result = mapCitations('`foo` calls `foo` again.', symbolIndex);

    expect(result).toBe('`foo` [src/foo.ts:1] calls `foo` [src/foo.ts:1] again.');
  });

  it('leaves text with no backtick-wrapped identifiers unchanged', () => {
    const symbolIndex = new Map([['foo', [{ path: 'src/foo.ts', line: 1 }]]]);

    const result = mapCitations('No identifiers here.', symbolIndex);

    expect(result).toBe('No identifiers here.');
  });
});
