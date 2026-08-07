import type { AuditEntry, FileNode, SubProjectProfile } from '../types';

import type { ImportGraph } from './import-graph';

const ENTRY_POINT_SIGNATURES = [
  'app.listen(',
  'createServer(',
  'ReactDOM.createRoot(',
  'ReactDOM.render(',
  'NestFactory.create(',
];

const PATH_SCORE_BASELINE = 20;
const IMPORT_SCORE_PER_IMPORTER = 4;
const IMPORT_SCORE_CAP = 40;
const ENTRY_POINT_BONUS = 30;
const AUDIT_TOP_FILE_COUNT = 20;

export const PATH_SCORE_RULES: Array<{ pattern: RegExp; score: number }> = [
  {
    // Tier 1 — Critical Anchors
    pattern: /(^|\/)(package\.json|(server|app|main|index)\.(ts|js)x?)$/,
    score: 100,
  },
  {
    // Tier 2 — Config & Docs
    pattern: /(^|\/)(README\.md|tsconfig\.json|vite\.config\.\w+|next\.config\.\w+)$/,
    score: 85,
  },
  {
    // Tier 3 — Backend/Frontend Core
    pattern:
      /(^|\/)(routes|controllers|services|middleware|auth|config|database|models|app|pages|layouts|store|api)\//,
    score: 70,
  },
  {
    // Tier 4 — Supporting Structure
    pattern: /(^|\/)(components|hooks|context|shared|lib)\//,
    score: 55,
  },
  {
    // Tier 5 — Shared Tooling
    pattern: /(^|\/)(docker[^/]*|\.eslintrc[^/]*|prettier[^/]*|nx\.json|turbo\.json)$|(^|\/)\.github\/workflows\//,
    score: 40,
  },
];

export function computePathScore(path: string): number {
  for (const rule of PATH_SCORE_RULES) {
    if (rule.pattern.test(path)) {
      return rule.score;
    }
  }

  return PATH_SCORE_BASELINE;
}

function scanForEntryPointSignatures(files: FileNode[], contentCache: Map<string, string>): string[] {
  const matched: string[] = [];

  for (const file of files) {
    const content = contentCache.get(file.path);

    if (content === undefined) {
      continue;
    }

    if (ENTRY_POINT_SIGNATURES.some((signature) => content.includes(signature))) {
      matched.push(file.path);
    }
  }

  return matched;
}

function belongsToSubProject(file: FileNode, subProject: SubProjectProfile, allSubProjects: SubProjectProfile[]): boolean {
  if (subProject.rootRelativePath === '') {
    return !allSubProjects.some(
      (other) => other.rootRelativePath !== '' && file.path.startsWith(`${other.rootRelativePath}/`),
    );
  }

  return file.path.startsWith(`${subProject.rootRelativePath}/`);
}

export function detectEntryPoints(
  files: FileNode[],
  contentCache: Map<string, string>,
  subProjects: SubProjectProfile[],
): { global: Set<string>; bySubProject: Map<string, string[]> } {
  if (subProjects.length === 0) {
    return { global: new Set(scanForEntryPointSignatures(files, contentCache)), bySubProject: new Map() };
  }

  const bySubProject = new Map<string, string[]>();

  for (const subProject of subProjects) {
    const subProjectFiles = files.filter((file) => belongsToSubProject(file, subProject, subProjects));

    bySubProject.set(subProject.rootRelativePath, scanForEntryPointSignatures(subProjectFiles, contentCache));
  }

  const global = new Set<string>([...bySubProject.values()].flat());

  return { global, bySubProject };
}

export function scoreFile(file: FileNode, importGraph: ImportGraph, entryPoints: Set<string>): number {
  const pathScore = computePathScore(file.path);
  const importScore = Math.min((importGraph.inDegree.get(file.path) ?? 0) * IMPORT_SCORE_PER_IMPORTER, IMPORT_SCORE_CAP);
  const entryPointBonus = entryPoints.has(file.path) ? ENTRY_POINT_BONUS : 0;

  return pathScore + importScore + entryPointBonus;
}

export function prioritizeFiles(
  files: FileNode[],
  importGraph: ImportGraph,
  entryPoints: Set<string>,
  auditLog: AuditEntry[],
  maxFiles = 150,
): FileNode[] {
  const scored = files
    .map((file) => ({ ...file, score: scoreFile(file, importGraph, entryPoints) }))
    .sort((a, b) => b.score - a.score);

  const topFilesSummary = scored
    .slice(0, AUDIT_TOP_FILE_COUNT)
    .map((file) => `${file.path} (${file.score})`)
    .join(', ');

  auditLog.push({
    timestamp: Date.now(),
    stage: 'prioritization',
    action: 'complete',
    detail: `Top ${Math.min(AUDIT_TOP_FILE_COUNT, scored.length)} files by priority score: ${topFilesSummary}`,
  });

  return scored.slice(0, maxFiles);
}
