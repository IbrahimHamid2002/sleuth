import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactSecrets } from '../security/sanitize';

export function createSandbox(): string {
  const sandboxPath = join(tmpdir(), 'sleuth', randomUUID());

  mkdirSync(sandboxPath, { recursive: true });

  return sandboxPath;
}

export async function cleanupSandbox(sandboxPath: string): Promise<void> {
  try {
    await rm(sandboxPath, { recursive: true, force: true });
  } catch (err) {
    // Cleanup must never throw (CLAUDE.md §4 rule 1) — a failed rm here would
    // otherwise crash a pipeline/session teardown path. Path is redacted in
    // case it ever carries a token-bearing clone URL segment.
    console.warn(
      `Failed to clean up sandbox at ${redactSecrets(sandboxPath)}: ${(err as Error).message}`,
    );
  }
}

export function getSandboxSizeBytes(sandboxPath: string): number {
  let totalBytes = 0;

  for (const entry of readdirSync(sandboxPath, { withFileTypes: true })) {
    const entryPath = join(sandboxPath, entry.name);

    if (entry.isDirectory()) {
      totalBytes += getSandboxSizeBytes(entryPath);
    } else if (entry.isFile()) {
      totalBytes += statSync(entryPath).size;
    }
  }

  return totalBytes;
}
