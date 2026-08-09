import { describe, expect, it } from 'vitest';

import {
  extractMermaidBlocks,
  repairArchitectureDiagramTypesMechanically,
  validateArchitectureDiagramTypes,
  validateMermaidSyntax,
} from '../documentation/mermaid-validator';

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

const VALID_ARCHITECTURE_STRUCTURE = `## High-Level System Diagram

\`\`\`mermaid
graph TD
  CLI["CLI"] --> Core["Core Engine"]
\`\`\`

## Components

Prose describing the components.

## Component Relation Graph

\`\`\`mermaid
graph TD
  A["A"] --> B["B"]
\`\`\`

## System Sequence Diagram

\`\`\`mermaid
sequenceDiagram
  User->>Core: request
  Core-->>User: response
\`\`\`

## System Flowchart

\`\`\`mermaid
flowchart TD
  Start(["Start"]) --> End(["End"])
\`\`\`
`;

describe('validateArchitectureDiagramTypes', () => {
  it('passes a document matching the required 5-section structure with correct diagram types', () => {
    const result = validateArchitectureDiagramTypes(VALID_ARCHITECTURE_STRUCTURE);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('flags "High-Level System Diagram" when it contains a flowchart block instead of graph', () => {
    const doc = VALID_ARCHITECTURE_STRUCTURE.replace(
      '## High-Level System Diagram\n\n```mermaid\ngraph TD',
      '## High-Level System Diagram\n\n```mermaid\nflowchart TD',
    );

    const result = validateArchitectureDiagramTypes(doc);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ heading: 'High-Level System Diagram', problem: 'wrong_diagram_type' }),
    );
  });

  it('flags the old buggy structure (both "Frontend Data Flow Chart" and "Backend Flow Chart" present) as a structural violation', () => {
    const legacyDoc = `## High-Level System Diagram

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

## Components

Prose.

## Frontend Component Relation Graph

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

## Frontend Data Flow Chart

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\`

## Backend Flow Chart

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\`
`;

    const result = validateArchitectureDiagramTypes(legacyDoc);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ heading: 'Frontend Data Flow Chart', problem: 'legacy_heading_present' }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ heading: 'Backend Flow Chart', problem: 'legacy_heading_present' }),
    );
  });

  it('flags a document missing the final "System Flowchart" section entirely', () => {
    const withoutFlowchart = VALID_ARCHITECTURE_STRUCTURE.split('## System Flowchart')[0] ?? '';

    const result = validateArchitectureDiagramTypes(withoutFlowchart);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ heading: 'System Flowchart', problem: 'missing_heading' }));
  });

  it('flags a required heading with no Mermaid block at all', () => {
    const doc = VALID_ARCHITECTURE_STRUCTURE.replace(
      '## Component Relation Graph\n\n```mermaid\ngraph TD\n  A["A"] --> B["B"]\n```',
      '## Component Relation Graph\n\nNo diagram here.',
    );

    const result = validateArchitectureDiagramTypes(doc);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ heading: 'Component Relation Graph', problem: 'missing_diagram' }),
    );
  });

  it('flags a required heading that appears more than once', () => {
    const doc = `${VALID_ARCHITECTURE_STRUCTURE}\n## Components\n\nDuplicate section.\n`;

    const result = validateArchitectureDiagramTypes(doc);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ heading: 'Components', problem: 'duplicate_heading' }));
  });
});

describe('repairArchitectureDiagramTypesMechanically', () => {
  it('swaps a wrong flowchart keyword to graph when the body is otherwise valid graph syntax', () => {
    const doc = VALID_ARCHITECTURE_STRUCTURE.replace(
      '## High-Level System Diagram\n\n```mermaid\ngraph TD',
      '## High-Level System Diagram\n\n```mermaid\nflowchart TD',
    );

    const issues = validateArchitectureDiagramTypes(doc).issues;
    const repaired = repairArchitectureDiagramTypesMechanically(doc, issues);

    expect(validateArchitectureDiagramTypes(repaired)).toEqual({ valid: true, issues: [] });
    expect(repaired).toContain('graph TD\n  CLI["CLI"] --> Core["Core Engine"]');
  });

  it('leaves issues untouched that cannot be mechanically fixed (e.g. a missing section)', () => {
    const withoutFlowchart = VALID_ARCHITECTURE_STRUCTURE.split('## System Flowchart')[0] ?? '';
    const issues = validateArchitectureDiagramTypes(withoutFlowchart).issues;

    const repaired = repairArchitectureDiagramTypesMechanically(withoutFlowchart, issues);

    expect(validateArchitectureDiagramTypes(repaired).valid).toBe(false);
  });
});
