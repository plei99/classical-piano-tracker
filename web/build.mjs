// Bundles the browser client for `tracker web` into <outdir>/app.js and
// app.css (the stylesheet the client imports):
//   node build.mjs [outdir]
// tracker-web's build script runs this and embeds the result in the binary.
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const outdir = process.argv[2] ?? 'dist';
await esbuild.build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: { app: 'src/client/main.tsx' },
  outdir,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['chrome120', 'firefox120', 'safari17'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: process.env.TRACKER_MINIFY !== '0',
  legalComments: 'none',
  logLevel: 'warning',
});
