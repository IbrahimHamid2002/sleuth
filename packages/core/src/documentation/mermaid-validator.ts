import { MERMAID_FENCE_PATTERN, MERMAID_UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN, MERMAID_VALID_DIAGRAM_KEYWORDS } from '../constants';
import type { MermaidBlock, MermaidValidationResult } from '../types';

export type { MermaidBlock, MermaidValidationResult } from '../types';

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
