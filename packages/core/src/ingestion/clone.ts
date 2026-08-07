import simpleGit from 'simple-git';

import { redactSecrets } from '../security/sanitize';

import { cleanupSandbox, getSandboxSizeBytes } from './sandbox-manager';

// eslint-disable-next-line no-useless-escape -- matches RepoInputSchema's regex verbatim (schemas.ts)
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+(\.git)?$/;
const MAX_SANDBOX_SIZE_BYTES = 100 * 1024 * 1024;

function buildAuthenticatedUrl(url: string, pat: string): string {
  const authUrl = new URL(url);

  authUrl.username = pat;

  return authUrl.toString();
}

function toClearError(err: unknown): Error {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));

  if (/not found/i.test(message) || /repository .* does not exist/i.test(message)) {
    return new Error('Repository not found');
  }

  if (/authentication failed/i.test(message) || /could not read username|invalid credentials|403/i.test(message)) {
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

  const cloneUrl = pat ? buildAuthenticatedUrl(url, pat) : url;

  try {
    await simpleGit().clone(cloneUrl, targetDir, ['--depth', '1', '--single-branch']);
  } catch (err) {
    throw toClearError(err);
  }

  if (getSandboxSizeBytes(targetDir) > MAX_SANDBOX_SIZE_BYTES) {
    await cleanupSandbox(targetDir);
    throw new Error('Repository exceeds 100MB size limit');
  }

  const commitHash = (await simpleGit(targetDir).revparse(['HEAD'])).trim();

  return { commitHash };
}
