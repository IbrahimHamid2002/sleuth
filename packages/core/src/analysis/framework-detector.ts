import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FrameworkProfile {
  frameworks: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  isMonorepo: boolean;
  workspaceDirs: string[];
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

const MONOREPO_MARKER_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
const CANDIDATE_WORKSPACE_DIRS = ['apps', 'packages', 'libs', 'shared'];

function readPackageJson(repoRoot: string): PackageJsonShape | undefined {
  const packageJsonPath = join(repoRoot, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

function detectFrameworksFromDeps(packageJson: PackageJsonShape | undefined): string[] {
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const frameworks: string[] = [];

  if ('next' in deps) {
    frameworks.push('nextjs');
  } else if ('react' in deps) {
    frameworks.push('react');
  }

  if ('express' in deps) {
    frameworks.push('express');
  }

  if ('@nestjs/core' in deps) {
    frameworks.push('nestjs');
  }

  if ('vite' in deps) {
    frameworks.push('vite');
  }

  return frameworks;
}

function detectPackageManager(repoRoot: string): 'npm' | 'yarn' | 'pnpm' {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (existsSync(join(repoRoot, 'yarn.lock'))) {
    return 'yarn';
  }

  return 'npm';
}

function detectIsMonorepo(repoRoot: string, packageJson: PackageJsonShape | undefined): boolean {
  if (MONOREPO_MARKER_FILES.some((markerFile) => existsSync(join(repoRoot, markerFile)))) {
    return true;
  }

  return Boolean(packageJson?.workspaces);
}

function detectWorkspaceDirs(repoRoot: string): string[] {
  return CANDIDATE_WORKSPACE_DIRS.filter((dirName) => {
    const dirPath = join(repoRoot, dirName);

    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  });
}

export function detectFrameworks(repoRoot: string): FrameworkProfile {
  const packageJson = readPackageJson(repoRoot);
  const isMonorepo = detectIsMonorepo(repoRoot, packageJson);

  return {
    frameworks: detectFrameworksFromDeps(packageJson),
    packageManager: detectPackageManager(repoRoot),
    isMonorepo,
    workspaceDirs: isMonorepo ? detectWorkspaceDirs(repoRoot) : [],
  };
}
