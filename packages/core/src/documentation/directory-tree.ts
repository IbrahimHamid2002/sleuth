interface TreeNode {
  children: Map<string, TreeNode>;
  isFile: boolean;
}

const MAX_TREE_LINES = 400;

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
    if (lines.length >= MAX_TREE_LINES) {
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
// file paths — this is never handed to the LLM to reproduce from memory. An
// LLM asked to "recall" a file tree from prose summaries reliably invents or
// drops paths, the same failure class documented for agent/prompts.ts's
// real-path-grounding fix; a tree is 100% derivable from data we already
// have, so it should never be LLM-generated in the first place.
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

  if (lines.length >= MAX_TREE_LINES) {
    lines.push(`... (truncated — ${paths.length} total files, showing the first ${MAX_TREE_LINES} tree lines)`);
  }

  return lines.join('\n');
}
