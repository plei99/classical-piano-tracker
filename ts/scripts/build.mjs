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

/**
 * The browser client for `tracker web`, built first and embedded in the CLI
 * bundle (and so in the compiled binary) as the `virtual:web-assets` module:
 * a map from URL path to file, which the local server serves from memory.
 */
async function buildWebAssets() {
  const result = await esbuild.build({
    entryPoints: { app: `${root}src/web/client/main.tsx`, theme: `${root}src/web/client/theme-boot.ts` },
    outdir: '/assets',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['chrome120', 'firefox120', 'safari17'],
    jsx: 'automatic',
    minify: process.env.TRACKER_MINIFY !== '0',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    logLevel: 'warning',
  });
  const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const assets = {
    '/': {
      contentType: 'text/html; charset=utf-8',
      body: await readFile(`${root}src/web/client/index.html`, 'utf8'),
    },
  };
  for (const file of result.outputFiles) {
    const extension = file.path.slice(file.path.lastIndexOf('.'));
    assets[file.path] = { contentType: types[extension], body: file.text };
  }
  return assets;
}

const webAssets = await buildWebAssets();

const webAssetsPlugin = {
  name: 'web-assets',
  setup(b) {
    b.onResolve({ filter: /^virtual:web-assets$/ }, () => ({ path: 'web-assets', namespace: 'web-assets' }));
    b.onLoad({ filter: /.*/, namespace: 'web-assets' }, () => ({
      contents: `export default ${JSON.stringify(webAssets)};`,
      loader: 'js',
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
  plugins: [rawPlugin, webAssetsPlugin],
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
