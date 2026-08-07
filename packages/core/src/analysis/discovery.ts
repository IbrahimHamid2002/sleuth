import ignore, { type Ignore } from 'ignore';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  DISCOVERY_BINARY_DETECTION_BYTES,
  DISCOVERY_BINARY_EXTENSIONS,
  DISCOVERY_HARDCODED_DIR_EXCLUSIONS,
  DISCOVERY_LOCKFILE_NAMES,
  DISCOVERY_MAX_FILE_SIZE_BYTES,
  DISCOVERY_MAX_FILES,
  DISCOVERY_TEST_EXCLUSIONS,
} from '../constants';
import type { AuditEntry, DiscoveryResult, FileNode } from '../types';

export type { DiscoveryResult } from '../types';

function buildIgnoreMatcher(repoRoot: string): Ignore {
  const ignoreMatcher = ignore();

  ignoreMatcher.add(DISCOVERY_HARDCODED_DIR_EXCLUSIONS);
  ignoreMatcher.add(['*.lock', ...DISCOVERY_LOCKFILE_NAMES]);
  ignoreMatcher.add(DISCOVERY_BINARY_EXTENSIONS.map((ext) => `*.${ext}`));
  ignoreMatcher.add(DISCOVERY_TEST_EXCLUSIONS);

  const gitignorePath = join(repoRoot, '.gitignore');

  if (existsSync(gitignorePath)) {
    ignoreMatcher.add(readFileSync(gitignorePath, 'utf-8'));
  }

  return ignoreMatcher;
}

function isBinaryFile(filePath: string): boolean {
  const fd = openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(DISCOVERY_BINARY_DETECTION_BYTES);
    const bytesRead = readSync(fd, buffer, 0, DISCOVERY_BINARY_DETECTION_BYTES, 0);

    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function discoverFiles(repoRoot: string, auditLog: AuditEntry[]): DiscoveryResult {
  const resolvedRoot = resolve(repoRoot);
  const ignoreMatcher = buildIgnoreMatcher(resolvedRoot);
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
      if (files.length >= DISCOVERY_MAX_FILES) {
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

      if (ignoreMatcher.ignores(matchPath)) {
        skippedCount++;
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);

        if (capped) {
          return;
        }
      } else if (entry.isFile()) {
        if (stats.size > DISCOVERY_MAX_FILE_SIZE_BYTES) {
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
