import simpleGit from 'simple-git';

import { CLONE_GITHUB_URL_PATTERN, CLONE_GITHUB_URL_WITH_CAPTURES, CLONE_MAX_SANDBOX_SIZE_BYTES } from '../constants';
import { redactSecrets } from '../security/sanitize';

import { cleanupSandbox, getSandboxSizeBytes } from './sandbox-manager';

function buildAuthenticatedUrl(url: string, pat: string): string {
  const authUrl = new URL(url);

  authUrl.username = pat;

  return authUrl.toString();
}

// Confirms the PAT (or anonymous access) actually has read access to this
// exact repo via GitHub's REST API, BEFORE ever invoking `git clone` — the
// real security boundary, since git's own credential resolution can silently
// fall back to ambient host credentials if the PAT in the clone URL is
// rejected. Disabling that fallback at the git-config layer was tried and
// reverted: newer Git Credential Manager treats any such override as unsafe
// and refuses to run when git is spawned hidden (simple-git's Windows default).
async function verifyRepoAccess(url: string, pat: string | undefined): Promise<void> {
  const match = CLONE_GITHUB_URL_WITH_CAPTURES.exec(url);

  if (match === null) {
    return;
  }

  const [, owner, repo] = match;
  const headers: Record<string, string> = pat !== undefined ? { Authorization: `token ${pat}` } : {};

  let response: Response;

  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  } catch {
    // GitHub API unreachable — don't block on a best-effort pre-check; the
    // clone attempt below (and its own error handling) remains authoritative.
    return;
  }

  if (response.status === 401) {
    throw new Error('Authentication failed — check your token');
  }

  if (response.status === 404) {
    throw new Error('Repository not found');
  }

  if (response.status === 403) {
    const body = await response.text().catch(() => '');

    // GitHub's unauthenticated rate limit (60/hr per IP) also returns 403 —
    // distinguish that from a genuine access-denied so a busy shared server
    // doesn't wrongly block legitimate clones.
    if (!/rate limit/i.test(body)) {
      throw new Error('Authentication failed — check your token');
    }
  }
}

function toClearError(err: unknown): Error {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));

  if (/not found/i.test(message) || /repository .* does not exist/i.test(message)) {
    return new Error('Repository not found');
  }

  if (
    /authentication failed/i.test(message) ||
    /could not read username|could not read password|invalid credentials|403|terminal prompts disabled/i.test(message)
  ) {
    return new Error('Authentication failed — check your token');
  }

  if (/could not resolve host|network is unreachable|timed out|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return new Error('Network error');
  }

  return new Error(`Clone failed: ${message}`);
}

export async function cloneRepo(
  url: string,
  pat: string | undefined,
  targetDir: string,
): Promise<{ commitHash: string }> {
  if (!CLONE_GITHUB_URL_PATTERN.test(url)) {
    throw new Error('Invalid GitHub repository URL');
  }

  await verifyRepoAccess(url, pat);

  const cloneUrl = pat ? buildAuthenticatedUrl(url, pat) : url;

  try {
    // No custom env/config here deliberately: `verifyRepoAccess` above is the
    // real security boundary, so git can run with its own defaults —
    // forwarding the calling process's env risks inheriting a pre-existing
    // GIT_EDITOR/EDITOR that trips the same "unsafe config" hardening.
    await simpleGit().clone(cloneUrl, targetDir, ['--depth', '1', '--single-branch']);
  } catch (err) {
    throw toClearError(err);
  }

  if (getSandboxSizeBytes(targetDir) > CLONE_MAX_SANDBOX_SIZE_BYTES) {
    await cleanupSandbox(targetDir);
    throw new Error('Repository exceeds 150MB size limit');
  }

  const commitHash = (await simpleGit(targetDir).revparse(['HEAD'])).trim();

  return { commitHash };
}
