import {
  ARCHITECTURE_LEGACY_HEADINGS,
  ARCHITECTURE_REQUIRED_SECTIONS,
  MERMAID_FENCE_PATTERN,
  MERMAID_UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN,
  MERMAID_VALID_DIAGRAM_KEYWORDS,
} from '../constants';
import type { ArchitectureDiagramIssue, ArchitectureDiagramValidationResult, MermaidBlock, MermaidValidationResult } from '../types';

export type { ArchitectureDiagramIssue, ArchitectureDiagramValidationResult, MermaidBlock, MermaidValidationResult } from '../types';

export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const pattern = new RegExp(MERMAID_FENCE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({
      raw: match[0],
      code: match[1] ?? '',
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return blocks;
}

function hasBalancedPair(code: string, open: string, close: string): boolean {
  let depth = 0;

  for (const char of code) {
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;

      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
}

// Deterministic, heuristic structural checks — not a real Mermaid parser (no
// full grammar dependency, per CLAUDE.md's no-heavyweight-deps rule). Catches
// the failure modes actually observed: a wrong/missing diagram-type keyword
// and unbalanced brackets/quotes from an unquoted label with special characters.
export function validateMermaidSyntax(code: string): MermaidValidationResult {
  const errors: string[] = [];
  const trimmed = code.trim();

  if (trimmed.length === 0) {
    return { valid: false, errors: ['Diagram is empty'] };
  }

  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const hasKnownKeyword = MERMAID_VALID_DIAGRAM_KEYWORDS.some((keyword) => firstLine.startsWith(keyword));

  if (!hasKnownKeyword) {
    errors.push(`First line "${firstLine}" does not start with a recognized diagram type (expected one of: ${MERMAID_VALID_DIAGRAM_KEYWORDS.join(', ')})`);
  }

  if (!hasBalancedPair(trimmed, '[', ']')) {
    errors.push('Unbalanced square brackets [ ]');
  }

  if (!hasBalancedPair(trimmed, '(', ')')) {
    errors.push('Unbalanced parentheses ( )');
  }

  if (!hasBalancedPair(trimmed, '{', '}')) {
    errors.push('Unbalanced curly braces { }');
  }

  const quoteCount = (trimmed.match(/"/g) ?? []).length;

  if (quoteCount % 2 !== 0) {
    errors.push('Unbalanced double quotes');
  }

  if (MERMAID_UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN.test(trimmed)) {
    errors.push('An unquoted [ ] label contains ":", "(", ")", or "|" — wrap the label in quotes, e.g. A["Label: text"]');
  }

  return { valid: errors.length === 0, errors };
}

interface HeadingSection {
  heading: string;
  bodyStartIndex: number;
  bodyEndIndex: number;
}

// Splits markdown into "## Heading" sections, each mapped to the character
// range of its body (everything up to the next "## " heading, or EOF).
function splitByH2Headings(markdown: string): HeadingSection[] {
  const headingPattern = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headings: Array<{ heading: string; lineStartIndex: number; bodyStartIndex: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(markdown)) !== null) {
    headings.push({
      heading: (match[1] ?? '').trim(),
      lineStartIndex: match.index,
      bodyStartIndex: match.index + match[0].length,
    });
  }

  return headings.map((entry, index) => ({
    heading: entry.heading,
    bodyStartIndex: entry.bodyStartIndex,
    bodyEndIndex: headings[index + 1]?.lineStartIndex ?? markdown.length,
  }));
}

// ARCHITECTURE.md-specific structural check, layered on top of
// validateMermaidSyntax: confirms each of the 5 required headings
// (constants.ts's ARCHITECTURE_REQUIRED_SECTIONS) is present exactly once
// with the correct Mermaid diagram type, and that none of the pre-fix
// duplicate/conditional headings (ARCHITECTURE_LEGACY_HEADINGS) reappear.
export function validateArchitectureDiagramTypes(markdown: string): ArchitectureDiagramValidationResult {
  const issues: ArchitectureDiagramIssue[] = [];
  const sections = splitByH2Headings(markdown);

  for (const legacyHeading of ARCHITECTURE_LEGACY_HEADINGS) {
    if (sections.some((section) => section.heading === legacyHeading)) {
      issues.push({
        heading: legacyHeading,
        problem: 'legacy_heading_present',
        detail: `Legacy heading "## ${legacyHeading}" must not appear — it has been replaced by the current required section structure.`,
      });
    }
  }

  for (const required of ARCHITECTURE_REQUIRED_SECTIONS) {
    const matches = sections.filter((section) => section.heading === required.heading);

    if (matches.length === 0) {
      issues.push({
        heading: required.heading,
        problem: 'missing_heading',
        detail: `Required heading "## ${required.heading}" is missing.`,
      });
      continue;
    }

    if (matches.length > 1) {
      issues.push({
        heading: required.heading,
        problem: 'duplicate_heading',
        detail: `Heading "## ${required.heading}" appears ${matches.length} times — it must appear exactly once.`,
      });
    }

    if (required.diagramType === null) {
      continue;
    }

    const section = matches[0]!;
    const body = markdown.slice(section.bodyStartIndex, section.bodyEndIndex);
    const block = extractMermaidBlocks(body)[0];

    if (!block) {
      issues.push({
        heading: required.heading,
        problem: 'missing_diagram',
        detail: `"## ${required.heading}" has no Mermaid code block — it must contain exactly one, opening with "${required.diagramType}".`,
      });
      continue;
    }

    const firstLine = block.code.trim().split('\n')[0]?.trim() ?? '';

    if (!firstLine.startsWith(required.diagramType)) {
      issues.push({
        heading: required.heading,
        problem: 'wrong_diagram_type',
        detail: `"## ${required.heading}" must open with "${required.diagramType}", found "${firstLine}".`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

const DIAGRAM_KEYWORD_SWAP_PATTERN = /^(flowchart|graph)(\s+(TD|LR|TB|RL|BT))?/;

function swapDiagramTypeKeyword(code: string, requiredType: 'flowchart' | 'graph'): string | null {
  const trimmed = code.trim();
  const newlineIndex = trimmed.indexOf('\n');
  const firstLine = newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? '' : trimmed.slice(newlineIndex);
  const match = firstLine.match(DIAGRAM_KEYWORD_SWAP_PATTERN);

  if (!match) {
    return null;
  }

  const direction = match[2] ?? ' TD';

  return `${requiredType}${direction}${rest}`;
}

// "graph" and "flowchart" share identical node/edge syntax, so a diagram
// body written as one is trivially valid as the other — swapping just the
// keyword is a free, deterministic fix for the most common wrong_diagram_type
// defect (see bug report: "High-Level System Diagram" filled with a
// `flowchart` block that should be `graph`) and is preferred over spending an
// LLM call on it. `sequenceDiagram` has an incompatible grammar and can never
// be mechanically derived this way — those issues are left for the caller's
// LLM re-prompt / deterministic-fallback path.
export function repairArchitectureDiagramTypesMechanically(markdown: string, issues: ArchitectureDiagramIssue[]): string {
  let result = markdown;

  for (const issue of issues) {
    if (issue.problem !== 'wrong_diagram_type') {
      continue;
    }

    const required = ARCHITECTURE_REQUIRED_SECTIONS.find((section) => section.heading === issue.heading);

    if (!required || (required.diagramType !== 'graph' && required.diagramType !== 'flowchart')) {
      continue;
    }

    const section = splitByH2Headings(result).find((candidate) => candidate.heading === issue.heading);

    if (!section) {
      continue;
    }

    const body = result.slice(section.bodyStartIndex, section.bodyEndIndex);
    const block = extractMermaidBlocks(body)[0];

    if (!block) {
      continue;
    }

    const swapped = swapDiagramTypeKeyword(block.code, required.diagramType);

    if (swapped === null) {
      continue;
    }

    const absoluteStart = section.bodyStartIndex + block.startIndex;
    const absoluteEnd = section.bodyStartIndex + block.endIndex;

    result = result.slice(0, absoluteStart) + `\`\`\`mermaid\n${swapped}\n\`\`\`` + result.slice(absoluteEnd);
  }

  return result;
}
