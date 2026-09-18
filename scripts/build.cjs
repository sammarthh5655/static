const { build } = require('esbuild');

// Preloads must be bundled: sandboxed preloads cannot `require` from
// node_modules at runtime, and chrome.js pulls in electron-chrome-extensions'
// browser-action element. Output is CommonJS because preloads are not ESM.
const targets = [
  { entryPoints: ['src/preload/chrome.js'], outfile: 'build/chrome.preload.cjs' },
  { entryPoints: ['src/preload/tab.js'], outfile: 'build/tab.preload.cjs' },
];

Promise.all(targets.map(target => build({
  ...target,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  target: 'node22', sourcemap: false,
}))).catch(error => { console.error(error); process.exit(1); });
