'use strict';

/**
 * Bundles the two preload scripts into dist/ with esbuild.
 *
 * Why: preloads run with `sandbox: true`, where `require()` only resolves
 * 'electron'. Our preloads import the shared channel registry and the
 * <browser-action-list> element from electron-chrome-extensions, so they
 * have to be flattened into single files first. Runs automatically before
 * `npm start` and `npm run dist`.
 */
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [
    path.join(root, 'src/preload/ui-preload.js'),
    path.join(root, 'src/preload/tab-preload.js'),
  ],
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
}).catch(() => process.exit(1));
