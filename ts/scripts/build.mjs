// Bundles the CLI into a single ESM file. Bundling matters for startup:
// resolving and compiling hundreds of node_modules files costs far more than
// parsing one file.
import { execSync } from 'node:child_process';
import { readFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

function git(args, fallback) {
  try {
    return (
      execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || fallback
    );
  } catch {
    return fallback;
  }
}

const build = {
  version: process.env.TRACKER_VERSION || git('describe --tags --always --dirty', 'dev'),
  commit: process.env.TRACKER_COMMIT || git('rev-parse --short HEAD', 'unknown'),
  date: process.env.TRACKER_BUILD_DATE || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
};

/** Loads `*?raw` imports as text, matching Vite's behavior in tests. */
const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: new URL(args.path.replace(/\?raw$/, ''), `file://${args.resolveDir}/`).pathname,
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await esbuild.build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/tracker.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // TRACKER_MINIFY=0 keeps names readable for CPU profiles.
  minify: process.env.TRACKER_MINIFY !== '0',
  legalComments: 'none',
  plugins: [rawPlugin],
  // Ink only loads React DevTools when DEV=true; keep it out of the bundle.
  alias: { 'react-devtools-core': `${root}scripts/empty-module.mjs` },
  define: {
    'process.env.NODE_ENV': '"production"',
    __TRACKER_BUILD__: JSON.stringify(build),
  },
  // Some dependencies are CommonJS and call require() at runtime.
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'warning',
});
await chmod(`${root}dist/tracker.js`, 0o755);
