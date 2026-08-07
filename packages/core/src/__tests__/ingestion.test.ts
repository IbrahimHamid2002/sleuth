import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneRepo } from '../ingestion/clone';
import { ingestLocal } from '../ingestion/local';

const cloneMock = vi.fn();
const revparseMock = vi.fn();

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    clone: cloneMock,
    revparse: revparseMock,
  })),
}));

describe('cloneRepo', () => {
  let targetDir: string;
  const fetchMock = vi.fn();

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), 'sleuth-clone-test-'));
    cloneMock.mockReset();
    revparseMock.mockReset();
    revparseMock.mockResolvedValue('abc123\n');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('clones a valid GitHub URL with the correct depth/branch args', async () => {
    cloneMock.mockResolvedValue(undefined);

    const result = await cloneRepo('https://github.com/foo/bar', undefined, targetDir);

    expect(cloneMock).toHaveBeenCalledWith('https://github.com/foo/bar', targetDir, [
      '--depth',
      '1',
      '--single-branch',
    ]);
    expect(result.commitHash).toBe('abc123');
  });

  it('rejects an invalid URL before attempting to clone', async () => {
    await expect(cloneRepo('https://gitlab.com/foo/bar', undefined, targetDir)).rejects.toThrow(
      'Invalid GitHub repository URL',
    );
    expect(cloneMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embeds the PAT in the clone URL and the pre-check header, but never leaks it in a thrown error', async () => {
    const pat = `ghp_${'x'.repeat(36)}`;

    cloneMock.mockRejectedValue(
      new Error(`fatal: Authentication failed for 'https://${pat}@github.com/foo/bar/'`),
    );

    let thrownError: Error | undefined;

    try {
      await cloneRepo('https://github.com/foo/bar', pat, targetDir);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/foo/bar', {
      headers: { Authorization: `token ${pat}` },
    });
    expect(cloneMock).toHaveBeenCalledWith(`https://${pat}@github.com/foo/bar`, targetDir, [
      '--depth',
      '1',
      '--single-branch',
    ]);
    expect(thrownError?.message).toBe('Authentication failed — check your token');
    expect(thrownError?.message).not.toContain(pat);
  });

  it('throws a clear auth error when the pre-check gets a 401, without attempting to clone', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));

    await expect(cloneRepo('https://github.com/foo/bar', 'ghp_bad', targetDir)).rejects.toThrow(
      'Authentication failed — check your token',
    );
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('throws "Repository not found" when the pre-check gets a 404 (private repo, no/wrong PAT), without attempting to clone', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));

    await expect(cloneRepo('https://github.com/foo/bar', undefined, targetDir)).rejects.toThrow(
      'Repository not found',
    );
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('treats a rate-limited 403 from the pre-check as inconclusive and still attempts the clone', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), { status: 403 }),
    );
    cloneMock.mockResolvedValue(undefined);

    const result = await cloneRepo('https://github.com/foo/bar', undefined, targetDir);

    expect(cloneMock).toHaveBeenCalled();
    expect(result.commitHash).toBe('abc123');
  });

  it('treats a genuine (non-rate-limit) 403 from the pre-check as an auth failure, without attempting to clone', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));

    await expect(cloneRepo('https://github.com/foo/bar', 'ghp_bad', targetDir)).rejects.toThrow(
      'Authentication failed — check your token',
    );
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('does not block cloning when the pre-check itself fails (e.g. GitHub API unreachable)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    cloneMock.mockResolvedValue(undefined);

    const result = await cloneRepo('https://github.com/foo/bar', undefined, targetDir);

    expect(result.commitHash).toBe('abc123');
  });
});

describe('ingestLocal', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'sleuth-local-src-'));
    targetDir = join(tmpdir(), 'sleuth-local-dest-', randomUUID());
    revparseMock.mockReset();
    revparseMock.mockResolvedValue('mockedhash\n');
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('excludes node_modules and .git when copying a local folder', async () => {
    mkdirSync(join(sourceDir, 'src'));
    writeFileSync(join(sourceDir, 'src', 'index.ts'), 'export {};');
    mkdirSync(join(sourceDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(sourceDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};');
    mkdirSync(join(sourceDir, '.git'));
    writeFileSync(join(sourceDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    await ingestLocal(sourceDir, targetDir);

    expect(existsSync(join(targetDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(targetDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(targetDir, '.git'))).toBe(false);
  });

  it('reads the commit hash via simple-git when a .git folder is present', async () => {
    mkdirSync(join(sourceDir, '.git'));
    writeFileSync(join(sourceDir, 'file.txt'), 'content');
    revparseMock.mockResolvedValue('deadbeef\n');

    const result = await ingestLocal(sourceDir, targetDir);

    expect(revparseMock).toHaveBeenCalledWith(['HEAD']);
    expect(result.commitHash).toBe('deadbeef');
  });

  it('generates a deterministic synthetic hash when no .git folder is present', async () => {
    writeFileSync(join(sourceDir, 'file.txt'), 'content');

    const result = await ingestLocal(sourceDir, targetDir);

    expect(revparseMock).not.toHaveBeenCalled();
    expect(result.commitHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws a clear error for a non-existent local path', async () => {
    const missingPath = join(tmpdir(), 'sleuth-does-not-exist', randomUUID());

    await expect(ingestLocal(missingPath, targetDir)).rejects.toThrow(
      'Local path does not exist or is not a directory',
    );
  });
});
