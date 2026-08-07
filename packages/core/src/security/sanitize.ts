const MAX_LLM_CONTENT_LENGTH = 8000;
const INJECTION_PREFIX_PATTERN = /^(system|instruction|assistant|human):/i;
const GHP_TOKEN_PATTERN = /ghp_[A-Za-z0-9]{36}/g;
const GITHUB_PAT_TOKEN_PATTERN = /github_pat_[A-Za-z0-9_]{22,}/g;

export function sanitizeForLLM(content: string): string {
  const truncated = content.slice(0, MAX_LLM_CONTENT_LENGTH);

  return truncated
    .split('\n')
    .map((line) =>
      INJECTION_PREFIX_PATTERN.test(line)
        ? `[FILTERED]: ${line.replace(INJECTION_PREFIX_PATTERN, '').trimStart()}`
        : line,
    )
    .join('\n');
}

export function redactSecrets(text: string): string {
  return text.replace(GHP_TOKEN_PATTERN, '[REDACTED_TOKEN]').replace(GITHUB_PAT_TOKEN_PATTERN, '[REDACTED_TOKEN]');
}
