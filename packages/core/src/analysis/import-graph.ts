import { posix } from 'node:path';

import { IMPORT_GRAPH_RESOLUTION_EXTENSIONS, IMPORT_GRAPH_SPECIFIER_REGEXES } from '../constants';
import type { FileNode, ImportGraph } from '../types';

export type { ImportGraph } from '../types';

function extractSpecifiers(content: string): string[] {
  const specifiers: string[] = [];

  for (const regex of IMPORT_GRAPH_SPECIFIER_REGEXES) {
    regex.lastIndex = 0;

    let match: RegExpExecArray | null = regex.exec(content);

    while (match !== null) {
      const specifier = match[1];

      if (specifier !== undefined) {
        specifiers.push(specifier);
      }

      match = regex.exec(content);
    }
  }

  return specifiers;
}

function resolveRelativeImport(
  importerPath: string,
  specifier: string,
  knownFiles: Set<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));

  const candidates = [
    base,
    ...IMPORT_GRAPH_RESOLUTION_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...IMPORT_GRAPH_RESOLUTION_EXTENSIONS.map((ext) => posix.join(base, `index${ext}`)),
  ];

  return candidates.find((candidate) => knownFiles.has(candidate));
}

export function buildImportGraph(files: FileNode[], contentCache: Map<string, string>): ImportGraph {
  const inDegree = new Map<string, number>();
  const edges: Array<{ from: string; to: string }> = [];
  const knownFiles = new Set(files.filter((file) => file.type === 'file').map((file) => file.path));

  for (const file of files) {
    if (file.type !== 'file') {
      continue;
    }

    const content = contentCache.get(file.path);

    if (content === undefined) {
      continue;
    }

    for (const specifier of extractSpecifiers(content)) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        continue;
      }

      const resolved = resolveRelativeImport(file.path, specifier, knownFiles);

      if (resolved !== undefined) {
        inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
        edges.push({ from: file.path, to: resolved });
      }
    }
  }

  return { inDegree, edges };
}
