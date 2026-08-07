import { DIRECTORY_TREE_MAX_LINES } from '../constants';
import type { TreeNode } from '../types';

function createNode(): TreeNode {
  return { children: new Map(), isFile: false };
}

function insertPath(root: TreeNode, path: string): void {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let current = root;

  segments.forEach((segment, index) => {
    let child = current.children.get(segment);

    if (child === undefined) {
      child = createNode();
      current.children.set(segment, child);
    }

    if (index === segments.length - 1) {
      child.isFile = true;
    }

    current = child;
  });
}

function sortedEntries(node: TreeNode): Array<[string, TreeNode]> {
  return [...node.children.entries()].sort(([nameA, nodeA], [nameB, nodeB]) => {
    if (nodeA.isFile !== nodeB.isFile) {
      return nodeA.isFile ? 1 : -1;
    }

    return nameA.localeCompare(nameB);
  });
}

function renderNode(node: TreeNode, prefix: string, lines: string[]): void {
  const entries = sortedEntries(node);

  entries.forEach(([name, child], index) => {
    if (lines.length >= DIRECTORY_TREE_MAX_LINES) {
      return;
    }

    const isLast = index === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';

    lines.push(`${prefix}${connector}${child.isFile ? name : `${name}/`}`);

    if (!child.isFile) {
      renderNode(child, prefix + (isLast ? '    ' : '│   '), lines);
    }
  });
}

// Renders an exact, deterministic ASCII directory tree from real discovered
// file paths — never handed to the LLM to reproduce from memory, since an LLM
// asked to "recall" a tree from prose reliably invents or drops paths.
export function buildDirectoryTree(paths: string[]): string {
  if (paths.length === 0) {
    return '(no files discovered)';
  }

  const root = createNode();

  for (const path of paths) {
    insertPath(root, path);
  }

  const lines: string[] = [];

  renderNode(root, '', lines);

  if (lines.length >= DIRECTORY_TREE_MAX_LINES) {
    lines.push(`... (truncated — ${paths.length} total files, showing the first ${DIRECTORY_TREE_MAX_LINES} tree lines)`);
  }

  return lines.join('\n');
}
