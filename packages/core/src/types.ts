export interface RepoInput {
  type: 'local' | 'github';
  path?: string;
  url?: string;
  pat?: string; // never persisted beyond request scope
}

export interface RepoMeta {
  name: string;
  identifier: string;
  commitHash: string;
  rootPath: string;
  frameworks: string[];
  isMonorepo: boolean;
  workspaceDirs: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
}

export interface FileNode {
  path: string;
  type: 'file' | 'directory';
  size: number;
  score?: number;
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'export' | 'const';
  line: number;
}

export interface FileSummary {
  path: string;
  purpose: string;
  exports: string[];
  dependencies: string[];
  summary: string;
}

export interface SynthesisResult {
  readme: string;
  architecture: string;
  onboarding: string;
}

export interface AuditEntry {
  timestamp: number;
  stage: string;
  action: string;
  detail: string;
}

export interface AgentDecision {
  thought: string;
  action: 'tool_call' | 'finish';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface DeepDiveSession {
  sessionId: string;
  repoMeta: RepoMeta;
  sandboxPath: string;
  summariesMap: Map<string, FileSummary>;
  visitedFiles: Map<string, string>;
  createdAt: number;
  lastActivityAt: number;
}

export interface InvestigationResult {
  question: string;
  answer: string;
  plan: string;
  iterations: number;
  filesExamined: string[];
  reasoningTrace: Array<{
    thought: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    observation: string;
  }>;
}
