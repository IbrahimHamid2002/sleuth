import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../analysis/discovery';
import type { AuditEntry } from '../types';

describe('discoverFiles', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'sleuth-discovery-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('discovers normal source files while excluding gitignored, binary, symlinked, node_modules, and oversized files', () => {
    // Normal source files.
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const a = 1;');
    writeFileSync(join(repoRoot, 'README.md'), '# Fixture repo');

    // .gitignore excluding a specific subfolder.
    writeFileSync(join(repoRoot, '.gitignore'), 'ignored-folder/\n');
    mkdirSync(join(repoRoot, 'ignored-folder'), { recursive: true });
    writeFileSync(join(repoRoot, 'ignored-folder', 'file.ts'), 'export const b = 2;');

    // A binary file containing an actual null byte, with a non-hardcoded extension so
    // it can only be caught by null-byte sniffing, not the static extension list.
    writeFileSync(join(repoRoot, 'asset.bin'), Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64]));

    // node_modules folder (hardcoded exclusion).
    mkdirSync(join(repoRoot, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};');

    // A symlink pointing outside the fixture dir.
    const outsideDir = mkdtempSync(join(tmpdir(), 'sleuth-discovery-outside-'));

    writeFileSync(join(outsideDir, 'secret.ts'), 'export const secret = true;');

    const linkPath = join(repoRoot, 'linked-dir');

    try {
      // Windows requires elevated privileges for file/dir symlinks but not
      // for junctions, so use a junction on win32 and a real symlink elsewhere.
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';

      symlinkSync(outsideDir, linkPath, linkType);
    } catch (err) {
      rmSync(outsideDir, { recursive: true, force: true });
      throw new Error(
        `Could not create symlink/junction fixture required for this test: ${(err as Error).message}`,
      );
    }

    // A file over the 500KB per-file size cap.
    writeFileSync(join(repoRoot, 'large-file.txt'), 'a'.repeat(600 * 1024));

    const auditLog: AuditEntry[] = [];

    let result;

    try {
      result = discoverFiles(repoRoot, auditLog);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    const paths = result.files.map((f) => f.path).sort();

    expect(paths).toEqual(['.gitignore', 'README.md', 'src/index.ts']);

    expect(result.contentCache.get('src/index.ts')).toBe('export const a = 1;');
    expect(result.contentCache.get('README.md')).toBe('# Fixture repo');
    expect(result.contentCache.has('ignored-folder/file.ts')).toBe(false);
    expect(result.contentCache.has('asset.bin')).toBe(false);
    expect(result.contentCache.has('node_modules/some-pkg/index.js')).toBe(false);
    expect(result.contentCache.has('large-file.txt')).toBe(false);
    expect(result.contentCache.has('linked-dir/secret.ts')).toBe(false);

    const summaryEntry = auditLog.find((entry) => /^Discovered \d+ files, skipped \d+/.test(entry.detail));

    expect(summaryEntry).toBeDefined();
    expect(summaryEntry?.detail).toBe('Discovered 3 files, skipped 5 ignored/binary/oversized');
  });

  it(
    'caps discovery at 1500 files and pushes a warning audit entry',
    () => {
      const fileCount = 1600;

      for (let i = 0; i < fileCount; i++) {
        writeFileSync(join(repoRoot, `file-${i}.ts`), `export const v${i} = ${i};`);
      }

      const auditLog: AuditEntry[] = [];
      const result = discoverFiles(repoRoot, auditLog);

      expect(result.files.length).toBe(1500);

      const warningEntry = auditLog.find((entry) =>
        entry.detail.includes('Discovery capped at 1500 files — analysis may be incomplete for very large repos'),
      );

      expect(warningEntry).toBeDefined();
    },
    20000,
  );
});
