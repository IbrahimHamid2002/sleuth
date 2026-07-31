import ignore, { type Ignore } from 'ignore';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { AuditEntry, FileNode } from '../types';

export interface DiscoveryResult {
  files: FileNode[];
  contentCache: Map<string, string>;
}

const MAX_FILES = 1500;
const MAX_FILE_SIZE_BYTES = 500 * 1024;
const BINARY_DETECTION_BYTES = 512;

const HARDCODED_DIR_EXCLUSIONS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '__pycache__',
  'generated',
  'snapshots',
  '__snapshots__',
  'cypress',
  'e2e',
];

const BINARY_EXTENSIONS = [
  'png',
  'jpg',
  'gif',
  'svg',
  'ico',
  'woff',
  'ttf',
  'eot',
  'mp3',
  'mp4',
  'zip',
  'tar',
  'gz',
  'pdf',
  'exe',
  'dll',
  'so',
];

const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

const TEST_EXCLUSIONS = ['*.test.*', '*.spec.*', '__tests__/', '*.snap'];

function buildIgnoreMatcher(repoRoot: string): Ignore {
  const ig = ignore();

  ig.add(HARDCODED_DIR_EXCLUSIONS);
  ig.add(['*.lock', ...LOCKFILE_NAMES]);
  ig.add(BINARY_EXTENSIONS.map((ext) => `*.${ext}`));
  ig.add(TEST_EXCLUSIONS);

  const gitignorePath = join(repoRoot, '.gitignore');

  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, 'utf-8'));
  }

  return ig;
}

function isBinaryFile(filePath: string): boolean {
  const fd = openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(BINARY_DETECTION_BYTES);
    const bytesRead = readSync(fd, buffer, 0, BINARY_DETECTION_BYTES, 0);

    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function discoverFiles(repoRoot: string, auditLog: AuditEntry[]): DiscoveryResult {
  const resolvedRoot = resolve(repoRoot);
  const ig = buildIgnoreMatcher(resolvedRoot);
  const files: FileNode[] = [];
  const contentCache = new Map<string, string>();
  let skippedCount = 0;
  let capped = false;

  function walk(dir: string): void {
    if (capped) {
      return;
    }

    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        capped = true;

        return;
      }

      const fullPath = join(dir, entry.name);
      const relativePath = relative(resolvedRoot, fullPath).split(sep).join('/');
      const stats = lstatSync(fullPath);

      if (stats.isSymbolicLink()) {
        skippedCount++;
        continue;
      }

      const matchPath = entry.isDirectory() ? `${relativePath}/` : relativePath;

      if (ig.ignores(matchPath)) {
        skippedCount++;
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);

        if (capped) {
          return;
        }
      } else if (entry.isFile()) {
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          skippedCount++;
          continue;
        }

        if (isBinaryFile(fullPath)) {
          skippedCount++;
          continue;
        }

        files.push({ path: relativePath, type: 'file', size: stats.size });
        contentCache.set(relativePath, readFileSync(fullPath, 'utf-8'));
      }
    }
  }

  walk(resolvedRoot);

  if (capped) {
    auditLog.push({
      timestamp: Date.now(),
      stage: 'discovery',
      action: 'warning',
      detail: 'Discovery capped at 1500 files — analysis may be incomplete for very large repos',
    });
  }

  auditLog.push({
    timestamp: Date.now(),
    stage: 'discovery',
    action: 'complete',
    detail: `Discovered ${files.length} files, skipped ${skippedCount} ignored/binary/oversized`,
  });

  return { files, contentCache };
}
