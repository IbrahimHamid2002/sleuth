import assert from 'node:assert/strict';
import test from 'node:test';

import { FileSummarySchema, RepoInputSchema } from '../schemas.ts';

test('valid FileSummary passes validation', () => {
  const result = FileSummarySchema.safeParse({
    path: 'src/index.ts',
    purpose: 'Entry point',
    exports: ['main'],
    dependencies: ['./utils'],
    summary: 'Bootstraps the application.',
  });

  assert.equal(result.success, true);
});

test('FileSummary with oversized arrays (>50 items) fails validation', () => {
  const result = FileSummarySchema.safeParse({
    path: 'src/index.ts',
    purpose: 'Entry point',
    exports: Array.from({ length: 51 }, (_, i) => `export${i}`),
    dependencies: ['./utils'],
    summary: 'Bootstraps the application.',
  });

  assert.equal(result.success, false);
});

test('valid github RepoInput passes validation', () => {
  const result = RepoInputSchema.safeParse({
    type: 'github',
    url: 'https://github.com/owner/repo',
  });

  assert.equal(result.success, true);
});

test('github RepoInput missing url fails validation', () => {
  const result = RepoInputSchema.safeParse({
    type: 'github',
  });

  assert.equal(result.success, false);
});

test('valid local RepoInput passes validation', () => {
  const result = RepoInputSchema.safeParse({
    type: 'local',
    path: '/home/user/project',
  });

  assert.equal(result.success, true);
});

test('local RepoInput missing path fails validation', () => {
  const result = RepoInputSchema.safeParse({
    type: 'local',
  });

  assert.equal(result.success, false);
});
