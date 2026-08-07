import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupSandbox, createSandbox, getSandboxSizeBytes } from '../ingestion/sandbox-manager';

describe('createSandbox', () => {
  let sandboxPath: string;

  afterEach(async () => {
    await cleanupSandbox(sandboxPath);
  });

  it('creates a real, empty, writable directory', () => {
    sandboxPath = createSandbox();

    expect(existsSync(sandboxPath)).toBe(true);
    expect(readdirSync(sandboxPath)).toEqual([]);

    const testFile = join(sandboxPath, 'write-test.txt');

    writeFileSync(testFile, 'ok');

    expect(existsSync(testFile)).toBe(true);
  });
});

describe('cleanupSandbox', () => {
  it('removes the sandbox directory completely', async () => {
    const sandboxPath = createSandbox();

    writeFileSync(join(sandboxPath, 'file.txt'), 'content');

    await cleanupSandbox(sandboxPath);

    expect(existsSync(sandboxPath)).toBe(false);
  });

  it('does not throw when called on a non-existent path', async () => {
    const nonExistentPath = join(tmpdir(), 'sleuth', `does-not-exist-${randomUUID()}`);

    await expect(cleanupSandbox(nonExistentPath)).resolves.toBeUndefined();
  });
});

describe('getSandboxSizeBytes', () => {
  let sandboxPath: string;

  afterEach(async () => {
    await cleanupSandbox(sandboxPath);
  });

  it('sums file sizes across a fixture directory with known sizes', () => {
    sandboxPath = createSandbox();

    writeFileSync(join(sandboxPath, 'a.txt'), 'a'.repeat(10));
    mkdirSync(join(sandboxPath, 'nested'));
    writeFileSync(join(sandboxPath, 'nested', 'b.txt'), 'b'.repeat(25));
    mkdirSync(join(sandboxPath, 'nested', 'deeper'));
    writeFileSync(join(sandboxPath, 'nested', 'deeper', 'c.txt'), 'c'.repeat(5));

    expect(getSandboxSizeBytes(sandboxPath)).toBe(40);
  });
});
