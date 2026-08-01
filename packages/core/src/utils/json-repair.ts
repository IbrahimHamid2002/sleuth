const CODE_FENCE_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
const TRAILING_COMMA_PATTERN = /,(\s*[}\]])/g;

function stripCodeFence(raw: string): string {
  const match = CODE_FENCE_PATTERN.exec(raw);

  return match?.[1] ?? raw;
}

function trimToJsonBounds(text: string): string {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const candidates = [firstBrace, firstBracket].filter((index) => index !== -1);

  if (candidates.length === 0) {
    return text;
  }

  const start = Math.min(...candidates);
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);

  if (end === -1 || end < start) {
    return text;
  }

  return text.slice(start, end + 1);
}

export function extractJSON(raw: string): unknown {
  const trimmed = trimToJsonBounds(stripCodeFence(raw));

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    try {
      return JSON.parse(trimmed.replace(TRAILING_COMMA_PATTERN, '$1'));
    } catch {
      throw err;
    }
  }
}
