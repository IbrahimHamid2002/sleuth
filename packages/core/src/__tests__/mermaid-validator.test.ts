import { describe, expect, it } from 'vitest';

import { extractMermaidBlocks, validateMermaidSyntax } from '../documentation/mermaid-validator';

describe('extractMermaidBlocks', () => {
  it('extracts a single fenced mermaid block with correct indices', () => {
    const markdown = 'before\n```mermaid\nflowchart TD\n  A --> B\n```\nafter';
    const blocks = extractMermaidBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('flowchart TD\n  A --> B\n');
    expect(markdown.slice(blocks[0]?.startIndex, blocks[0]?.endIndex)).toBe(blocks[0]?.raw);
  });

  it('extracts multiple blocks in document order', () => {
    const markdown = '```mermaid\nflowchart TD\n  A --> B\n```\ntext\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```';
    const blocks = extractMermaidBlocks(markdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.code).toContain('flowchart');
    expect(blocks[1]?.code).toContain('sequenceDiagram');
  });

  it('returns an empty array when there are no mermaid blocks', () => {
    expect(extractMermaidBlocks('just plain markdown, no diagrams')).toEqual([]);
  });
});

describe('validateMermaidSyntax', () => {
  it('accepts a well-formed flowchart', () => {
    const result = validateMermaidSyntax('flowchart TD\n  CLI["CLI Entrypoint"] --> Core["Core Engine"]');

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a well-formed sequence diagram', () => {
    const result = validateMermaidSyntax('sequenceDiagram\n  User->>API: request\n  API-->>User: response');

    expect(result.valid).toBe(true);
  });

  it('rejects an empty diagram', () => {
    const result = validateMermaidSyntax('   ');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Diagram is empty');
  });

  it('rejects a diagram missing a recognized type keyword', () => {
    const result = validateMermaidSyntax('A --> B');

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('recognized diagram type'))).toBe(true);
  });

  it('rejects unbalanced square brackets', () => {
    const result = validateMermaidSyntax('flowchart TD\n  A[Label --> B');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unbalanced square brackets [ ]');
  });

  it('rejects unbalanced parentheses', () => {
    const result = validateMermaidSyntax('flowchart TD\n  A(Label --> B');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unbalanced parentheses ( )');
  });

  it('rejects an unquoted label with special characters that leave a dangling bracket', () => {
    const result = validateMermaidSyntax('flowchart TD\n  CLI[CLI: entrypoint (main)] --> Core');

    expect(result.valid).toBe(false);
  });

  it('rejects unbalanced double quotes', () => {
    const result = validateMermaidSyntax('flowchart TD\n  A["Label --> B');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unbalanced double quotes');
  });

  it('reports multiple simultaneous errors', () => {
    const result = validateMermaidSyntax('A[Label --> B(');

    expect(result.errors.length).toBeGreaterThan(1);
  });
});
