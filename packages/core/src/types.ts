export interface RepoInput {
  type: 'local' | 'github';
  path?: string;
  url?: string;
  pat?: string; // never persisted beyond request scope
}

export interface SubProjectProfile {
  rootRelativePath: string;
  frameworks: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  entryPoints: string[];
}

export interface FrameworkProfile {
  frameworks: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  isMonorepo: boolean;
  monorepoType: 'workspace' | 'ad-hoc' | 'none';
  workspaceDirs: string[];
  subProjects: SubProjectProfile[];
}

export interface RepoMeta {
  name: string;
  identifier: string;
  commitHash: string;
  rootPath: string;
  frameworks: string[];
  isMonorepo: boolean;
  monorepoType: 'workspace' | 'ad-hoc' | 'none';
  workspaceDirs: string[];
  packageManager: 'npm' | 'yarn' | 'pnpm';
  subProjects: SubProjectProfile[];
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
  // The 3 pre-generated docs from the summarization pipeline (readme,
  // architecture, onboarding), if available — the agent checks these first,
  // before any live tool call over raw source, since they're already a
  // summary of the whole repo and answering from them is far cheaper/faster
  // than a fresh investigation. Undefined only for a session built without a
  // completed pipeline run (e.g. some tests).
  generatedDocs?: SynthesisResult;
}

export interface InvestigationResult {
  question: string;
  answer: string;
  plan: string;
  iterations: number;
  filesExamined: string[];
  // True when the deterministic fast-path step answered directly from the 3
  // pre-generated docs, with zero live tool calls — see agent/investigator.ts.
  answeredFromDocs: boolean;
  reasoningTrace: Array<{
    thought: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    observation: string;
  }>;
}
