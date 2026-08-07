import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import simpleGit from 'simple-git';

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

function isExcludedPath(candidatePath: string): boolean {
  return candidatePath.split(sep).some((segment) => EXCLUDED_DIR_NAMES.has(segment));
}

function listSortedRelativeFiles(rootDir: string, currentDir: string = rootDir): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = join(currentDir, entry.name);

    if (isExcludedPath(entryPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...listSortedRelativeFiles(rootDir, entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath.slice(rootDir.length));
    }
  }

  return files.sort();
}

function computeSyntheticHash(sourcePath: string): string {
  const sortedListing = listSortedRelativeFiles(sourcePath).join('\n');

  return createHash('sha256').update(sortedListing).digest('hex');
}

export async function ingestLocal(sourcePath: string, targetDir: string): Promise<{ commitHash: string }> {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`Local path does not exist or is not a directory: ${sourcePath}`);
  }

  cpSync(sourcePath, targetDir, {
    recursive: true,
    filter: (src) => !isExcludedPath(src),
  });

  const hasGitFolder = existsSync(join(sourcePath, '.git'));

  const commitHash = hasGitFolder
    ? (await simpleGit(sourcePath).revparse(['HEAD'])).trim()
    : computeSyntheticHash(sourcePath);

  return { commitHash };
}
