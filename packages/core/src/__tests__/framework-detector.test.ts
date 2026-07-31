import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectFrameworks } from '../analysis/framework-detector';

function writePackageJson(repoRoot: string, content: unknown): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify(content));
}

describe('detectFrameworks', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'sleuth-framework-detector-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('detects a pure React app', () => {
    writePackageJson(repoRoot, { dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual(['react']);
    expect(profile.packageManager).toBe('npm');
    expect(profile.isMonorepo).toBe(false);
    expect(profile.workspaceDirs).toEqual([]);
  });

  it('detects a Next.js app and does not also report react', () => {
    writePackageJson(repoRoot, { dependencies: { next: '^14.0.0', react: '^18.0.0' } });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual(['nextjs']);
  });

  it('detects an Express API', () => {
    writePackageJson(repoRoot, { dependencies: { express: '^4.19.0' } });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual(['express']);
  });

  it('detects a NestJS API', () => {
    writePackageJson(repoRoot, { dependencies: { '@nestjs/core': '^10.0.0' } });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual(['nestjs']);
  });

  it('detects a pnpm monorepo with apps/ and packages/ directories', () => {
    writePackageJson(repoRoot, { devDependencies: { vite: '^5.0.0' } });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '');
    mkdirSync(join(repoRoot, 'apps'), { recursive: true });
    mkdirSync(join(repoRoot, 'packages'), { recursive: true });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual(['vite']);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.isMonorepo).toBe(true);
    expect(profile.workspaceDirs).toEqual(['apps', 'packages']);
  });

  it('detects monorepo via package.json workspaces field and excludes non-existent candidate dirs', () => {
    writePackageJson(repoRoot, { workspaces: ['packages/*'] });
    mkdirSync(join(repoRoot, 'packages'), { recursive: true });

    const profile = detectFrameworks(repoRoot);

    expect(profile.isMonorepo).toBe(true);
    expect(profile.workspaceDirs).toEqual(['packages']);
  });

  it('detects yarn as the package manager via yarn.lock', () => {
    writePackageJson(repoRoot, {});
    writeFileSync(join(repoRoot, 'yarn.lock'), '');

    const profile = detectFrameworks(repoRoot);

    expect(profile.packageManager).toBe('yarn');
  });

  it('handles a repo with no package.json at all without throwing', () => {
    const profile = detectFrameworks(join(tmpdir(), 'sleuth-nonexistent-repo', randomUUID()));

    expect(profile).toEqual({
      frameworks: [],
      packageManager: 'npm',
      isMonorepo: false,
      monorepoType: 'none',
      workspaceDirs: [],
      subProjects: [],
    });
  });

  it('handles a malformed package.json gracefully', () => {
    writeFileSync(join(repoRoot, 'package.json'), '{ not valid json');

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual([]);
    expect(profile.isMonorepo).toBe(false);
  });

  it('detects an ad-hoc multi-package repo via generically-named sub-folders (client/server)', () => {
    mkdirSync(join(repoRoot, 'server'), { recursive: true });
    mkdirSync(join(repoRoot, 'client'), { recursive: true });
    writeFileSync(join(repoRoot, 'server', 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    writeFileSync(
      join(repoRoot, 'client', 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0', vite: '^5.0.0' } }),
    );

    const profile = detectFrameworks(repoRoot);

    expect([...profile.frameworks].sort()).toEqual(['express', 'react', 'vite']);
    expect(profile.isMonorepo).toBe(true);
    expect(profile.monorepoType).toBe('ad-hoc');
    expect([...profile.workspaceDirs].sort()).toEqual(['client', 'server']);
    expect(profile.subProjects).toHaveLength(2);

    const serverProject = profile.subProjects.find((subProject) => subProject.rootRelativePath === 'server');
    const clientProject = profile.subProjects.find((subProject) => subProject.rootRelativePath === 'client');

    expect(serverProject?.frameworks).toEqual(['express']);
    expect(serverProject?.entryPoints).toEqual([]);
    expect(clientProject?.frameworks).toEqual(['react', 'vite']);
    expect(clientProject?.entryPoints).toEqual([]);
  });

  it('treats a single root-level package.json (no nested ones) as monorepoType none, matching prior single-project behavior', () => {
    writePackageJson(repoRoot, { dependencies: { express: '^4.0.0' } });

    const profile = detectFrameworks(repoRoot);

    expect(profile.monorepoType).toBe('none');
    expect(profile.isMonorepo).toBe(false);
    expect(profile.subProjects).toHaveLength(1);
    expect(profile.subProjects[0]).toEqual({
      rootRelativePath: '',
      frameworks: ['express'],
      packageManager: 'npm',
      entryPoints: [],
    });
  });

  it('handles zero package.json anywhere (root or nested) without throwing', () => {
    mkdirSync(join(repoRoot, 'empty-dir'), { recursive: true });

    const profile = detectFrameworks(repoRoot);

    expect(profile.frameworks).toEqual([]);
    expect(profile.subProjects).toEqual([]);
    expect(profile.monorepoType).toBe('none');
    expect(profile.isMonorepo).toBe(false);
  });
});
