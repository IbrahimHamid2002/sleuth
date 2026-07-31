import { describe, expect, it } from 'vitest';

import type { ImportGraph } from '../analysis/import-graph';
import { computePathScore, detectEntryPoints, prioritizeFiles, scoreFile } from '../analysis/prioritizer';
import type { AuditEntry, FileNode, SubProjectProfile } from '../types';

describe('computePathScore', () => {
  it('scores package.json exactly 100', () => {
    expect(computePathScore('package.json')).toBe(100);
  });

  it('scores a test file at baseline, not elevated', () => {
    expect(computePathScore('src/foo.test.ts')).toBe(20);
  });
});

describe('detectEntryPoints', () => {
  it('attributes entry points to the root sub-project ("") in the single-project case (regression)', () => {
    const files: FileNode[] = [
      { path: 'src/server.ts', type: 'file', size: 10 },
      { path: 'src/util.ts', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      ['src/server.ts', "const app = express();\napp.listen(3000);"],
      ['src/util.ts', 'export const noop = () => undefined;'],
    ]);

    const subProjects: SubProjectProfile[] = [
      { rootRelativePath: '', frameworks: ['express'], packageManager: 'npm', entryPoints: [] },
    ];

    const { global, bySubProject } = detectEntryPoints(files, contentCache, subProjects);

    expect(global.has('src/server.ts')).toBe(true);
    expect(global.has('src/util.ts')).toBe(false);
    expect(bySubProject.get('')).toEqual(['src/server.ts']);
  });

  it('attributes entry points independently per sub-project for generically-named folders (client/server)', () => {
    const files: FileNode[] = [
      { path: 'server/index.ts', type: 'file', size: 10 },
      { path: 'server/utils.ts', type: 'file', size: 10 },
      { path: 'client/src/main.tsx', type: 'file', size: 10 },
      { path: 'client/src/App.tsx', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      ['server/index.ts', 'const app = express();\napp.listen(3000);'],
      ['server/utils.ts', 'export const helper = () => 1;'],
      ['client/src/main.tsx', "ReactDOM.createRoot(document.getElementById('root')).render(<App />);"],
      ['client/src/App.tsx', 'export const App = () => null;'],
    ]);

    const subProjects: SubProjectProfile[] = [
      { rootRelativePath: 'server', frameworks: ['express'], packageManager: 'npm', entryPoints: [] },
      { rootRelativePath: 'client', frameworks: ['react'], packageManager: 'npm', entryPoints: [] },
    ];

    const { global, bySubProject } = detectEntryPoints(files, contentCache, subProjects);

    expect(bySubProject.get('server')).toEqual(['server/index.ts']);
    expect(bySubProject.get('client')).toEqual(['client/src/main.tsx']);
    expect(bySubProject.get('server')).not.toContain('client/src/main.tsx');

    expect(global.has('server/index.ts')).toBe(true);
    expect(global.has('client/src/main.tsx')).toBe(true);
    expect(global.size).toBe(2);
  });

  it('falls back to a single implicit whole-repo scan when there are zero sub-projects', () => {
    const files: FileNode[] = [
      { path: 'server.ts', type: 'file', size: 10 },
      { path: 'util.ts', type: 'file', size: 10 },
    ];

    const contentCache = new Map<string, string>([
      ['server.ts', 'const server = createServer(app);'],
      ['util.ts', 'export const noop = () => undefined;'],
    ]);

    const { global, bySubProject } = detectEntryPoints(files, contentCache, []);

    expect(global.has('server.ts')).toBe(true);
    expect(global.has('util.ts')).toBe(false);
    expect(bySubProject.size).toBe(0);
  });
});

describe('scoreFile', () => {
  it('applies the +30 entry-point bonus when a bootstrap signature is present', () => {
    const file: FileNode = { path: 'src/bootstrap.ts', type: 'file', size: 10 };
    const importGraph: ImportGraph = { inDegree: new Map() };
    const entryPoints = new Set(['src/bootstrap.ts']);

    const withBonus = scoreFile(file, importGraph, entryPoints);
    const withoutBonus = scoreFile(file, importGraph, new Set());

    expect(withBonus - withoutBonus).toBe(30);
  });

  it('caps importScore at 40 even when inDegree implies 60', () => {
    const file: FileNode = { path: 'src/shared-util.ts', type: 'file', size: 10 };
    const importGraph: ImportGraph = { inDegree: new Map([['src/shared-util.ts', 15]]) };

    const score = scoreFile(file, importGraph, new Set());

    // Baseline pathScore (20) + capped importScore (40) + no entry bonus (0).
    expect(score).toBe(60);
  });
});

describe('prioritizeFiles', () => {
  it('sorts descending by score, truncates to maxFiles, and audits the top 20', () => {
    const files: FileNode[] = [
      { path: 'package.json', type: 'file', size: 10 },
      { path: 'src/low.ts', type: 'file', size: 10 },
      { path: 'src/routes/high.ts', type: 'file', size: 10 },
    ];

    const importGraph: ImportGraph = { inDegree: new Map() };
    const entryPoints = new Set<string>();
    const auditLog: AuditEntry[] = [];

    const result = prioritizeFiles(files, importGraph, entryPoints, auditLog, 2);

    expect(result).toHaveLength(2);
    expect(result[0]?.path).toBe('package.json');
    expect(result[1]?.path).toBe('src/routes/high.ts');
    expect(result[0]?.score).toBe(100);

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]?.stage).toBe('prioritization');
    expect(auditLog[0]?.detail).toContain('package.json (100)');
  });
});
