export interface MermaidBlock {
  raw: string;
  code: string;
  startIndex: number;
  endIndex: number;
}

export interface MermaidValidationResult {
  valid: boolean;
  errors: string[];
}

// Every diagram type mermaid actually supports — a block whose first line
// doesn't start with one of these is either garbage or a hallucinated
// diagram type, and will fail to render regardless of anything else being
// syntactically fine.
const VALID_DIAGRAM_KEYWORDS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'gitGraph',
  'mindmap',
  'timeline',
  'quadrantChart',
];

const MERMAID_FENCE_PATTERN = /```mermaid\n([\s\S]*?)```/g;

// The single most common real-world breakage: an unquoted node label like
// A[Label: text (detail)] — mermaid interprets ":", "(", ")", and "|" inside
// an unquoted [ ] label as syntax, not literal text, which corrupts parsing
// even though brackets/quotes still balance overall. Quoted labels
// (containing a ") are exempt — the character class excludes ".
const UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN = /\[[^\]"]*[():|][^\]"]*\]/;

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
// full grammar dependency per CLAUDE.md §4 rule 7's no-heavyweight-deps
// constraint). Catches the failure modes actually observed breaking rendered
// diagrams: wrong/missing diagram-type keyword and unbalanced
// brackets/quotes from an unquoted label containing special characters.
export function validateMermaidSyntax(code: string): MermaidValidationResult {
  const errors: string[] = [];
  const trimmed = code.trim();

  if (trimmed.length === 0) {
    return { valid: false, errors: ['Diagram is empty'] };
  }

  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const hasKnownKeyword = VALID_DIAGRAM_KEYWORDS.some((keyword) => firstLine.startsWith(keyword));

  if (!hasKnownKeyword) {
    errors.push(`First line "${firstLine}" does not start with a recognized diagram type (expected one of: ${VALID_DIAGRAM_KEYWORDS.join(', ')})`);
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

  if (UNQUOTED_LABEL_WITH_SPECIAL_CHARS_PATTERN.test(trimmed)) {
    errors.push('An unquoted [ ] label contains ":", "(", ")", or "|" — wrap the label in quotes, e.g. A["Label: text"]');
  }

  return { valid: errors.length === 0, errors };
}
