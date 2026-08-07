import { SANITIZE_GHP_TOKEN_PATTERN, SANITIZE_GITHUB_PAT_TOKEN_PATTERN, SANITIZE_INJECTION_PREFIX_PATTERN, SANITIZE_MAX_LLM_CONTENT_LENGTH } from '../constants';

export function sanitizeForLLM(content: string): string {
  const truncated = content.slice(0, SANITIZE_MAX_LLM_CONTENT_LENGTH);

  return truncated
    .split('\n')
    .map((line) =>
      SANITIZE_INJECTION_PREFIX_PATTERN.test(line)
        ? `[FILTERED]: ${line.replace(SANITIZE_INJECTION_PREFIX_PATTERN, '').trimStart()}`
        : line,
    )
    .join('\n');
}

export function redactSecrets(text: string): string {
  return text.replace(SANITIZE_GHP_TOKEN_PATTERN, '[REDACTED_TOKEN]').replace(SANITIZE_GITHUB_PAT_TOKEN_PATTERN, '[REDACTED_TOKEN]');
}
