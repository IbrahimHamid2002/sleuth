import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

function realpathOfNonExistentPath(targetPath: string): string {
  const missingSegments: string[] = [];
  let current = targetPath;

  while (!existsSync(current)) {
    missingSegments.unshift(basename(current));
    const parent = dirname(current);

    if (parent === current) {
      throw new Error('Path traversal blocked');
    }

    current = parent;
  }

  return join(realpathSync(current), ...missingSegments);
}

export function assertSafePath(targetPath: string, sandboxRoot: string): string {
  const resolvedSandboxRoot = realpathSync(resolve(sandboxRoot));
  const resolvedTarget = resolve(targetPath);

  const realTarget = existsSync(resolvedTarget)
    ? realpathSync(resolvedTarget)
    : realpathOfNonExistentPath(resolvedTarget);

  const isInsideSandbox =
    realTarget === resolvedSandboxRoot || realTarget.startsWith(resolvedSandboxRoot + sep);

  if (!isInsideSandbox) {
    throw new Error('Path traversal blocked');
  }

  return realTarget;
}
