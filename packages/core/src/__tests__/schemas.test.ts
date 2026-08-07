import { describe, expect, it } from 'vitest';

import {
  AgentDecisionSchema,
  FileSummarySchema,
  RepoInputSchema,
  ToolArgsSchemas,
} from '../schemas';

const validFileSummary = {
  path: 'src/index.ts',
  purpose: 'Entry point',
  exports: ['main'],
  dependencies: ['./utils'],
  summary: 'Bootstraps the application.',
};

describe('FileSummarySchema', () => {
  it('passes for a valid FileSummary', () => {
    expect(FileSummarySchema.safeParse(validFileSummary).success).toBe(true);
  });

  it.each(['path', 'purpose', 'exports', 'dependencies', 'summary'] as const)(
    'fails when %s is missing',
    (field) => {
      const withFieldRemoved: Record<string, unknown> = { ...validFileSummary };

      delete withFieldRemoved[field];

      expect(FileSummarySchema.safeParse(withFieldRemoved).success).toBe(false);
    },
  );

  it.each([
    ['path', 42],
    ['purpose', 42],
    ['exports', 'not-an-array'],
    ['dependencies', 'not-an-array'],
    ['summary', 42],
  ] as const)('fails when %s has the wrong type', (field, badValue) => {
    expect(FileSummarySchema.safeParse({ ...validFileSummary, [field]: badValue }).success).toBe(
      false,
    );
  });

  it('passes when purpose is exactly 500 characters', () => {
    const result = FileSummarySchema.safeParse({ ...validFileSummary, purpose: 'a'.repeat(500) });

    expect(result.success).toBe(true);
  });

  it('fails when purpose exceeds 500 characters', () => {
    const result = FileSummarySchema.safeParse({ ...validFileSummary, purpose: 'a'.repeat(501) });

    expect(result.success).toBe(false);
  });

  it('passes when summary is exactly 1000 characters', () => {
    const result = FileSummarySchema.safeParse({ ...validFileSummary, summary: 'a'.repeat(1000) });

    expect(result.success).toBe(true);
  });

  it('fails when summary exceeds 1000 characters', () => {
    const result = FileSummarySchema.safeParse({ ...validFileSummary, summary: 'a'.repeat(1001) });

    expect(result.success).toBe(false);
  });

  it.each(['exports', 'dependencies'] as const)(
    'passes when %s is an empty array',
    (field) => {
      expect(FileSummarySchema.safeParse({ ...validFileSummary, [field]: [] }).success).toBe(
        true,
      );
    },
  );

  it.each(['exports', 'dependencies'] as const)(
    'passes when %s has exactly 50 items',
    (field) => {
      const items = Array.from({ length: 50 }, (_, i) => `item${i}`);

      expect(
        FileSummarySchema.safeParse({ ...validFileSummary, [field]: items }).success,
      ).toBe(true);
    },
  );

  it.each(['exports', 'dependencies'] as const)(
    'fails when %s has more than 50 items',
    (field) => {
      const items = Array.from({ length: 51 }, (_, i) => `item${i}`);

      expect(
        FileSummarySchema.safeParse({ ...validFileSummary, [field]: items }).success,
      ).toBe(false);
    },
  );

  it.each(['exports', 'dependencies'] as const)(
    'passes when a %s item is exactly 100 characters',
    (field) => {
      expect(
        FileSummarySchema.safeParse({ ...validFileSummary, [field]: ['a'.repeat(100)] }).success,
      ).toBe(true);
    },
  );

  it.each(['exports', 'dependencies'] as const)(
    'fails when a %s item exceeds 100 characters',
    (field) => {
      expect(
        FileSummarySchema.safeParse({ ...validFileSummary, [field]: ['a'.repeat(101)] }).success,
      ).toBe(false);
    },
  );

  it('strips unknown fields but still passes', () => {
    const result = FileSummarySchema.safeParse({ ...validFileSummary, extra: 'unexpected' });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).not.toHaveProperty('extra');
    }
  });
});

describe('AgentDecisionSchema', () => {
  it('passes for a tool_call action with toolName and toolArgs', () => {
    const result = AgentDecisionSchema.safeParse({
      thought: 'I should read the file',
      action: 'tool_call',
      toolName: 'read_file',
      toolArgs: { path: 'src/index.ts' },
    });

    expect(result.success).toBe(true);
  });

  it('passes for a finish action without toolName or toolArgs', () => {
    const result = AgentDecisionSchema.safeParse({
      thought: 'I have enough information',
      action: 'finish',
    });

    expect(result.success).toBe(true);
  });

  it('passes for a tool_call action even without toolName/toolArgs (no cross-field constraint)', () => {
    const result = AgentDecisionSchema.safeParse({
      thought: 'thinking',
      action: 'tool_call',
    });

    expect(result.success).toBe(true);
  });

  it('fails for an invalid action value', () => {
    const result = AgentDecisionSchema.safeParse({
      thought: 'thinking',
      action: 'invalid_action',
    });

    expect(result.success).toBe(false);
  });

  it('fails when thought is missing', () => {
    const result = AgentDecisionSchema.safeParse({ action: 'finish' });

    expect(result.success).toBe(false);
  });

  it('accepts an arbitrary toolArgs shape', () => {
    const result = AgentDecisionSchema.safeParse({
      thought: 'thinking',
      action: 'tool_call',
      toolArgs: { anyKey: 123, nested: { a: true } },
    });

    expect(result.success).toBe(true);
  });
});

describe('ToolArgsSchemas', () => {
  describe('read_file', () => {
    it('passes with a path', () => {
      expect(ToolArgsSchemas.read_file.safeParse({ path: 'src/index.ts' }).success).toBe(true);
    });

    it('fails without a path', () => {
      expect(ToolArgsSchemas.read_file.safeParse({}).success).toBe(false);
    });

    it('fails when path is not a string', () => {
      expect(ToolArgsSchemas.read_file.safeParse({ path: 123 }).success).toBe(false);
    });
  });

  describe('search_code', () => {
    it('defaults maxResults to 20 when omitted', () => {
      const result = ToolArgsSchemas.search_code.safeParse({ query: 'foo' });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.maxResults).toBe(20);
      }
    });

    it('passes with an explicit maxResults', () => {
      const result = ToolArgsSchemas.search_code.safeParse({ query: 'foo', maxResults: 5 });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.maxResults).toBe(5);
      }
    });

    it('fails without a query', () => {
      expect(ToolArgsSchemas.search_code.safeParse({}).success).toBe(false);
    });

    it('fails when maxResults is not a number', () => {
      expect(
        ToolArgsSchemas.search_code.safeParse({ query: 'foo', maxResults: 'five' }).success,
      ).toBe(false);
    });
  });

  describe('list_directory', () => {
    it('passes with a path', () => {
      expect(ToolArgsSchemas.list_directory.safeParse({ path: 'src' }).success).toBe(true);
    });

    it('fails without a path', () => {
      expect(ToolArgsSchemas.list_directory.safeParse({}).success).toBe(false);
    });
  });

  describe('get_file_summary', () => {
    it('passes with a path', () => {
      expect(ToolArgsSchemas.get_file_summary.safeParse({ path: 'src/index.ts' }).success).toBe(
        true,
      );
    });

    it('fails without a path', () => {
      expect(ToolArgsSchemas.get_file_summary.safeParse({}).success).toBe(false);
    });
  });

  describe('find_references', () => {
    it('passes with a symbol', () => {
      expect(ToolArgsSchemas.find_references.safeParse({ symbol: 'FileSummary' }).success).toBe(
        true,
      );
    });

    it('fails without a symbol', () => {
      expect(ToolArgsSchemas.find_references.safeParse({}).success).toBe(false);
    });
  });
});

describe('RepoInputSchema', () => {
  it('fails for an invalid type value', () => {
    const result = RepoInputSchema.safeParse({ type: 'ftp', path: '/tmp/repo' });

    expect(result.success).toBe(false);
  });

  it('passes for a valid local RepoInput', () => {
    const result = RepoInputSchema.safeParse({ type: 'local', path: '/home/user/project' });

    expect(result.success).toBe(true);
  });

  it('fails for a local RepoInput missing path', () => {
    const result = RepoInputSchema.safeParse({ type: 'local' });

    expect(result.success).toBe(false);
  });

  it('fails for a local RepoInput with only a url', () => {
    const result = RepoInputSchema.safeParse({
      type: 'local',
      url: 'https://github.com/owner/repo',
    });

    expect(result.success).toBe(false);
  });

  it('passes for a valid github RepoInput', () => {
    const result = RepoInputSchema.safeParse({
      type: 'github',
      url: 'https://github.com/owner/repo',
    });

    expect(result.success).toBe(true);
  });

  it('passes for a valid github RepoInput with a .git suffix', () => {
    const result = RepoInputSchema.safeParse({
      type: 'github',
      url: 'https://github.com/owner/repo.git',
    });

    expect(result.success).toBe(true);
  });

  it('fails for a github RepoInput missing url', () => {
    const result = RepoInputSchema.safeParse({ type: 'github' });

    expect(result.success).toBe(false);
  });

  it('fails for a github RepoInput with only a path', () => {
    const result = RepoInputSchema.safeParse({ type: 'github', path: '/home/user/project' });

    expect(result.success).toBe(false);
  });

  it.each([
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com/owner',
    'not-a-url',
  ])('fails for a malformed github url: %s', (url) => {
    const result = RepoInputSchema.safeParse({ type: 'github', url });

    expect(result.success).toBe(false);
  });

  it('passes when an optional pat is included with a valid local input', () => {
    const result = RepoInputSchema.safeParse({
      type: 'local',
      path: '/home/user/project',
      pat: 'ghp_xxxxxxxxxxxx',
    });

    expect(result.success).toBe(true);
  });

  it('passes when an optional pat is included with a valid github input', () => {
    const result = RepoInputSchema.safeParse({
      type: 'github',
      url: 'https://github.com/owner/repo',
      pat: 'ghp_xxxxxxxxxxxx',
    });

    expect(result.success).toBe(true);
  });
});
