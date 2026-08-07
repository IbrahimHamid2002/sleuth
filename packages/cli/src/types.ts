import type { FileSummary, RepoMeta, SynthesisResult } from '@sleuth/core';

import { CONFIG_KEYS } from './constants';

// From analyze.ts
export interface AnalyzeOptions {
  token?: string;
  maxFiles?: string;
  output?: string;
  resume?: boolean;
}

export interface LastSession {
  sandboxPath: string;
  repoMeta: RepoMeta;
  summaries: FileSummary[];
  // The 3 pre-generated docs from this run, carried into the Deep Dive
  // session so `ask` can check them before falling back to live file tools.
  synthesis: SynthesisResult;
}

// From config.ts
export type ConfigKey = (typeof CONFIG_KEYS)[number];
