// Bundles @sleuth/core's TypeScript source directly into dist/index.js so the
// published sleuth-cli package is self-contained — core is a workspace-only
// package, never published, so end users installing sleuth-cli from the
// registry have no other way to resolve it (see CLAUDE.md context on this task).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

console.log('[build] type-checking...');
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', join(packageRoot, 'tsconfig.json')],
  {
    cwd: packageRoot,
    stdio: 'inherit',
  },
);

console.log('[build] bundling with esbuild...');
await build({
  entryPoints: [join(packageRoot, 'src', 'index.ts')],
  outfile: join(packageRoot, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // better-sqlite3 ships a native binding — esbuild cannot bundle it, so it
  // is resolved from real node_modules at install time instead (see
  // packages/cli/package.json's "dependencies").
  external: ['better-sqlite3'],
  minify: true,
  sourcemap: false,
  // esbuild preserves src/index.ts's own leading shebang verbatim in ESM
  // output, so the banner must NOT repeat it (a second "#!" line mid-file is
  // invalid JS). It's still needed for one thing: several bundled CJS deps
  // (e.g. inquirer's transitive chain) call `require(...)` on Node builtins
  // with a non-literal argument, which esbuild can't statically externalize
  // in ESM format. Without a real `require` in scope, esbuild's fallback
  // shim throws "Dynamic require ... is not supported" at runtime — this
  // banner gives it Node's real `require` via `createRequire` so those calls
  // resolve normally.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('[build] done: dist/index.js');
