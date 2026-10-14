/**
 * Package static: electron-builder with electron-builder.config.cjs.
 *
 *   node scripts/dist.cjs --win [--x64|--arm64] [--publish never]
 *   node scripts/dist.cjs --mac            (on a Mac)
 *   node scripts/dist.cjs --dir            (unpacked app only, fast)
 *
 * Any electron-builder command-line flag passes straight through. The
 * npm run dist / dist:win / dist:mac / pack scripts all come here.
 *
 * Why not call electron-builder directly: on Windows it builds the
 * uninstaller by RUNNING a freshly compiled, unsigned helper program.
 * Windows 11's Smart App Control (on by default on new installs) refuses to
 * run unsigned programs it does not know, so the build fails with
 * "spawn UNKNOWN" - it did on the machine this was written on. On macOS
 * electron-builder instead READS the uninstaller out of that helper with a
 * small parser (UninstallerReader) and never runs it. This makes Windows use
 * the same parser: nothing unsigned is executed during the build, and the
 * uninstaller is still signed afterwards when signing is configured.
 *
 * electron-builder is pinned to an exact version in package.json; if this
 * internal ever moves, the build fails loudly here rather than silently
 * running the helper.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

if (process.platform === 'win32') {
  const macosVersion = require('app-builder-lib/out/util/macosVersion');
  if (typeof macosVersion.isMacOsCatalina !== 'function') {
    throw new Error('scripts/dist.cjs: electron-builder internals changed (isMacOsCatalina missing). Review the Smart App Control workaround.');
  }
  // Only the NSIS uninstaller step asks this on Windows (NsisTarget.js).
  macosVersion.isMacOsCatalina = () => true;
}

// Run electron-builder's own command line in this process, so the line
// above applies to it.
process.argv = [
  process.argv[0],
  path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
  '--config', path.join(ROOT, 'electron-builder.config.cjs'),
  ...process.argv.slice(2),
];
require('electron-builder/out/cli/cli');
