import {
  PATH_SCORE_RULES,
  PRIORITIZER_AUDIT_TOP_FILE_COUNT,
  PRIORITIZER_ENTRY_POINT_BONUS,
  PRIORITIZER_ENTRY_POINT_SIGNATURES,
  PRIORITIZER_IMPORT_SCORE_CAP,
  PRIORITIZER_IMPORT_SCORE_PER_IMPORTER,
  PRIORITIZER_PATH_SCORE_BASELINE,
} from '../constants';
import type { AuditEntry, FileNode, ImportGraph, SubProjectProfile } from '../types';

export { PATH_SCORE_RULES } from '../constants';

export function computePathScore(path: string): number {
  for (const rule of PATH_SCORE_RULES) {
    if (rule.pattern.test(path)) {
      return rule.score;
    }
  }

  return PRIORITIZER_PATH_SCORE_BASELINE;
}

function scanForEntryPointSignatures(files: FileNode[], contentCache: Map<string, string>): string[] {
  const matched: string[] = [];

  for (const file of files) {
    const content = contentCache.get(file.path);

    if (content === undefined) {
      continue;
    }

    if (PRIORITIZER_ENTRY_POINT_SIGNATURES.some((signature) => content.includes(signature))) {
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
  const importScore = Math.min((importGraph.inDegree.get(file.path) ?? 0) * PRIORITIZER_IMPORT_SCORE_PER_IMPORTER, PRIORITIZER_IMPORT_SCORE_CAP);
  const entryPointBonus = entryPoints.has(file.path) ? PRIORITIZER_ENTRY_POINT_BONUS : 0;

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
    .slice(0, PRIORITIZER_AUDIT_TOP_FILE_COUNT)
    .map((file) => `${file.path} (${file.score})`)
    .join(', ');

  auditLog.push({
    timestamp: Date.now(),
    stage: 'prioritization',
    action: 'complete',
    detail: `Top ${Math.min(PRIORITIZER_AUDIT_TOP_FILE_COUNT, scored.length)} files by priority score: ${topFilesSummary}`,
  });

  return scored.slice(0, maxFiles);
}
