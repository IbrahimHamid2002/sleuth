import { describe, expect, it } from 'vitest';

import { buildCombinedPlanAndDecisionPrompt, buildReasonPrompt } from '../agent/prompts';
import type { RepoMeta } from '../types';

function buildRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    name: 'fixture-repo',
    identifier: 'fixture-repo',
    commitHash: 'abc123',
    rootPath: '/fixture',
    frameworks: [],
    isMonorepo: false,
    monorepoType: 'none',
    workspaceDirs: [],
    packageManager: 'npm',
    subProjects: [],
    ...overrides,
  };
}

describe('buildCombinedPlanAndDecisionPrompt', () => {
  it('lists real summarized file paths so the model has something to copy instead of inventing one', () => {
    const prompt = buildCombinedPlanAndDecisionPrompt(
      'What is the entry point?',
      buildRepoMeta(),
      ['src/index.ts', 'src/app.ts'],
      [],
    );

    expect(prompt).toContain('- src/index.ts');
    expect(prompt).toContain('- src/app.ts');
    expect(prompt).toContain('never invented or paraphrased');
  });

  it('lists detected entry points from repoMeta.subProjects', () => {
    const repoMeta = buildRepoMeta({
      subProjects: [
        { rootRelativePath: '.', frameworks: [], packageManager: 'npm', entryPoints: ['src/main.ts'] },
      ],
    });

    const prompt = buildCombinedPlanAndDecisionPrompt('What is the entry point?', repoMeta, [], []);

    expect(prompt).toContain('- src/main.ts');
  });

  it('falls back to explicit placeholders when there are no known files or entry points', () => {
    const prompt = buildCombinedPlanAndDecisionPrompt('What is the entry point?', buildRepoMeta(), [], []);

    expect(prompt).toContain('(no files summarized yet)');
    expect(prompt).toContain('(none detected)');
  });

  it('truncates a large known-files list rather than dumping every path unbounded', () => {
    const manyPaths = Array.from({ length: 60 }, (_, index) => `src/file${index}.ts`);

    const prompt = buildCombinedPlanAndDecisionPrompt('Question', buildRepoMeta(), manyPaths, []);

    expect(prompt).toContain('- src/file0.ts');
    expect(prompt).toContain('more file(s) not shown');
    expect(prompt).not.toContain('- src/file59.ts');
  });
});

describe('buildReasonPrompt', () => {
  it('re-lists real known file paths and entry points on every reasoning iteration, not just iteration 1', () => {
    const repoMeta = buildRepoMeta({
      subProjects: [{ rootRelativePath: '.', frameworks: [], packageManager: 'npm', entryPoints: ['src/main.ts'] }],
    });
    const state = { question: 'What is the entry point?', plan: 'Check the entry point.', scratchpad: [], iteration: 2 };

    const prompt = buildReasonPrompt(state, repoMeta, ['src/index.ts'], []);

    expect(prompt).toContain('- src/index.ts');
    expect(prompt).toContain('- src/main.ts');
    expect(prompt).toContain('never invented or paraphrased');
  });
});
