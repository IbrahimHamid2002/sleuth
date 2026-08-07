import type { FileNode, Symbol as SymbolInfo } from '../types';

const FUNCTION_REGEX = /export (async )?function (\w+)/g;
const CLASS_REGEX = /export class (\w+)/g;
const CONST_REGEX = /export (default )?const (\w+)/g;
const EXPORT_BLOCK_REGEX = /export \{([^}]+)\}/g;

export function indexSymbols(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    FUNCTION_REGEX.lastIndex = 0;
    const functionName = FUNCTION_REGEX.exec(line)?.[2];

    if (functionName !== undefined) {
      symbols.push({ name: functionName, type: 'function', line: lineNumber });
    }

    CLASS_REGEX.lastIndex = 0;
    const className = CLASS_REGEX.exec(line)?.[1];

    if (className !== undefined) {
      symbols.push({ name: className, type: 'class', line: lineNumber });
    }

    CONST_REGEX.lastIndex = 0;
    const constName = CONST_REGEX.exec(line)?.[2];

    if (constName !== undefined) {
      symbols.push({ name: constName, type: 'const', line: lineNumber });
    }

    EXPORT_BLOCK_REGEX.lastIndex = 0;
    const exportGroup = EXPORT_BLOCK_REGEX.exec(line)?.[1];

    if (exportGroup !== undefined) {
      for (const rawName of exportGroup.split(',')) {
        const name = rawName.trim();

        if (name) {
          symbols.push({ name, type: 'export', line: lineNumber });
        }
      }
    }
  });

  return symbols;
}

export function buildSymbolIndex(
  files: FileNode[],
  contentCache: Map<string, string>,
): Map<string, Array<{ path: string; line: number }>> {
  const index = new Map<string, Array<{ path: string; line: number }>>();

  for (const file of files) {
    if (file.type !== 'file') {
      continue;
    }

    const content = contentCache.get(file.path);

    if (content === undefined) {
      continue;
    }

    for (const symbol of indexSymbols(file.path, content)) {
      const locations = index.get(symbol.name) ?? [];

      locations.push({ path: file.path, line: symbol.line });
      index.set(symbol.name, locations);
    }
  }

  return index;
}
