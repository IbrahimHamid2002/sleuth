import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FrameworkProfile, SubProjectProfile } from '../types';

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

const MONOREPO_MARKER_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
const CANDIDATE_WORKSPACE_DIRS = ['apps', 'packages', 'libs', 'shared'];

const EXCLUDED_SCAN_DIRS = new Set([
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
]);

function readPackageJsonAt(packageJsonPath: string): PackageJsonShape | undefined {
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

function detectPackageManagerAt(dirPath: string): 'npm' | 'yarn' | 'pnpm' {
  if (existsSync(join(dirPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (existsSync(join(dirPath, 'yarn.lock'))) {
    return 'yarn';
  }

  return 'npm';
}

function hasFormalMonorepoMarkers(repoRoot: string, rootPackageJson: PackageJsonShape | undefined): boolean {
  if (MONOREPO_MARKER_FILES.some((markerFile) => existsSync(join(repoRoot, markerFile)))) {
    return true;
  }

  return Boolean(rootPackageJson?.workspaces);
}

function detectWorkspaceDirs(repoRoot: string): string[] {
  return CANDIDATE_WORKSPACE_DIRS.filter((dirName) => {
    const dirPath = join(repoRoot, dirName);

    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  });
}

function findNestedPackageJsonDirs(repoRoot: string): string[] {
  let entries;

  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !EXCLUDED_SCAN_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .filter((dirName) => existsSync(join(repoRoot, dirName, 'package.json')))
    .sort();
}

function buildSubProjectProfile(repoRoot: string, rootRelativePath: string): SubProjectProfile {
  const projectDir = rootRelativePath === '' ? repoRoot : join(repoRoot, rootRelativePath);
  const packageJson = readPackageJsonAt(join(projectDir, 'package.json'));

  return {
    rootRelativePath,
    frameworks: detectFrameworksFromDeps(packageJson),
    packageManager: detectPackageManagerAt(projectDir),
    entryPoints: [],
  };
}

export function detectFrameworks(repoRoot: string): FrameworkProfile {
  const rootPackageJson = readPackageJsonAt(join(repoRoot, 'package.json'));
  const isFormalWorkspace = hasFormalMonorepoMarkers(repoRoot, rootPackageJson);

  const subProjects: SubProjectProfile[] = [];

  if (rootPackageJson !== undefined) {
    subProjects.push(buildSubProjectProfile(repoRoot, ''));
  }

  if (!isFormalWorkspace) {
    for (const dirName of findNestedPackageJsonDirs(repoRoot)) {
      subProjects.push(buildSubProjectProfile(repoRoot, dirName));
    }
  }

  const monorepoType: FrameworkProfile['monorepoType'] = isFormalWorkspace
    ? 'workspace'
    : subProjects.length > 1
      ? 'ad-hoc'
      : 'none';

  const frameworks = [...new Set(subProjects.flatMap((subProject) => subProject.frameworks))];

  const workspaceDirs = isFormalWorkspace
    ? detectWorkspaceDirs(repoRoot)
    : subProjects.map((subProject) => subProject.rootRelativePath).filter((path) => path !== '');

  const packageManager =
    rootPackageJson !== undefined ? detectPackageManagerAt(repoRoot) : (subProjects[0]?.packageManager ?? 'npm');

  return {
    frameworks,
    packageManager,
    isMonorepo: monorepoType === 'workspace' || subProjects.length > 1,
    monorepoType,
    workspaceDirs,
    subProjects,
  };
}
