import simpleGit from 'simple-git';

import { redactSecrets } from '../security/sanitize';

import { cleanupSandbox, getSandboxSizeBytes } from './sandbox-manager';

// eslint-disable-next-line no-useless-escape -- matches RepoInputSchema's regex verbatim (schemas.ts)
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+(\.git)?$/;
const GITHUB_URL_WITH_CAPTURES = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const MAX_SANDBOX_SIZE_BYTES = 150 * 1024 * 1024;

function buildAuthenticatedUrl(url: string, pat: string): string {
  const authUrl = new URL(url);

  authUrl.username = pat;

  return authUrl.toString();
}

// Confirms the supplied PAT (or anonymous access, if none) actually has read
// access to this exact repo via GitHub's REST API, BEFORE ever invoking `git
// clone`. This is the real security boundary — git's own credential
// resolution can silently fall back to ambient host credentials (Windows
// Credential Manager, a cached `gh` token, etc.) if the PAT embedded in the
// clone URL is rejected, masking a wrong/missing PAT. Disabling that fallback
// at the git-config/env layer (`-c credential.helper=`, `GIT_CONFIG_NOSYSTEM`)
// was tried and reverted: newer Git Credential Manager versions treat ANY
// environment-based override of a "sensitive" setting (credential.helper,
// GIT_CONFIG_GLOBAL, even an inherited GIT_EDITOR) as unsafe and refuse to run
// at all when git is spawned with a hidden window — which is simple-git's
// default on Windows — regardless of whether the PAT is valid. Checking
// access independently, ahead of time, sidesteps that entirely.
async function verifyRepoAccess(url: string, pat: string | undefined): Promise<void> {
  const match = GITHUB_URL_WITH_CAPTURES.exec(url);

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
  if (!GITHUB_URL_PATTERN.test(url)) {
    throw new Error('Invalid GitHub repository URL');
  }

  await verifyRepoAccess(url, pat);

  const cloneUrl = pat ? buildAuthenticatedUrl(url, pat) : url;

  try {
    // No custom env/config here deliberately: `verifyRepoAccess` above is the
    // actual security boundary, so git can run with its own defaults. Forwarding
    // ANY of the calling process's env (e.g. via `.env({ ...process.env, ... })`)
    // is itself risky — a parent shell's pre-existing GIT_EDITOR/EDITOR (or
    // similar) gets inherited and can trip the same "unsafe config" hardening
    // credential.helper overrides did, for a variable this code never touched.
    await simpleGit().clone(cloneUrl, targetDir, ['--depth', '1', '--single-branch']);
  } catch (err) {
    throw toClearError(err);
  }

  if (getSandboxSizeBytes(targetDir) > MAX_SANDBOX_SIZE_BYTES) {
    await cleanupSandbox(targetDir);
    throw new Error('Repository exceeds 150MB size limit');
  }

  const commitHash = (await simpleGit(targetDir).revparse(['HEAD'])).trim();

  return { commitHash };
}
