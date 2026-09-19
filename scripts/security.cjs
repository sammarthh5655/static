const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Electron security check. Run with `npm run check:security`.
 *
 * A browser is the most attacked surface on a machine, and Electron ships the
 * Chromium that renders every page. Pinning a version and forgetting it means
 * running known-vulnerable Chromium for however long the pin has been stale -
 * which is the single most important gap between this project and a browser
 * maintained by a team.
 *
 * This compares the pinned version against the releases npm actually has and
 * reports what is behind, so the answer to "are we patched?" is a command
 * rather than a guess.
 *
 * It intentionally does NOT auto-update: an unattended Electron bump can break
 * the app in ways only a person can judge. It tells you, and gives you the
 * command.
 */

const ROOT = path.resolve(__dirname, '..');

function readPinned() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const raw = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  return raw.replace(/^[^0-9]*/, '');
}

function readInstalled() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'user-agent': 'static-browser-security-check' },
      timeout: 15000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('HTTP ' + response.statusCode + ' from ' + url));
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => { request.destroy(new Error('Timed out')); });
    request.on('error', reject);
  });
}

/** "44.4.2" -> [44, 4, 2], so versions compare numerically not as strings. */
function parts(version) {
  return String(version).split('.').map((n) => parseInt(n, 10) || 0);
}

function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

async function main() {
  const pinned = readPinned();
  const installed = readInstalled();

  console.log('Electron security check');
  console.log('  pinned in package.json : ' + (pinned || 'unknown'));
  console.log('  installed              : ' + (installed || 'not installed'));

  if (installed && pinned && compare(installed, pinned) !== 0) {
    console.log('\n  ! installed does not match the pin - run `npm install`');
  }

  let registry;
  try {
    registry = await fetchJson('https://registry.npmjs.org/electron');
  } catch (error) {
    console.error('\nCould not reach the npm registry: ' + error.message);
    console.error('Check again when you are online. Nothing was verified.');
    process.exit(2);
  }

  const versions = Object.keys(registry.versions || {})
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))          // stable only, no betas
    .sort(compare);

  const latest = versions[versions.length - 1];
  const major = parts(pinned)[0];

  // Patches within the pinned major are the ones that matter most: they are
  // where Chromium security fixes land without an API break.
  const sameMajor = versions.filter((v) => parts(v)[0] === major);
  const latestInMajor = sameMajor[sameMajor.length - 1];

  const behindInMajor = pinned && latestInMajor && compare(latestInMajor, pinned) > 0;
  const behindMajor = pinned && latest && parts(latest)[0] > major;

  console.log('  newest ' + major + '.x                : ' + (latestInMajor || 'unknown'));
  console.log('  newest overall         : ' + (latest || 'unknown'));

  if (behindInMajor) {
    const missed = sameMajor.filter((v) => compare(v, pinned) > 0);
    console.log('\n  SECURITY: ' + missed.length + ' release(s) behind within ' + major + '.x');
    console.log('  Chromium security fixes ship in these. Bump with:');
    console.log('\n    npm install --save-dev electron@' + latestInMajor);
    console.log('    npm run check && npm test && npm run test:smoke\n');
    console.log('  Release notes: https://github.com/electron/electron/releases');
  } else {
    console.log('\n  Up to date within ' + major + '.x.');
  }

  if (behindMajor) {
    console.log('\n  Note: Electron ' + parts(latest)[0] + ' is out. Major bumps can break APIs,');
    console.log('  so read the breaking-changes doc before moving:');
    console.log('  https://www.electronjs.org/docs/latest/breaking-changes');
  }

  // Non-zero exit when behind, so this can gate a release or run in CI.
  process.exit(behindInMajor ? 1 : 0);
}

main().catch((error) => {
  console.error('Security check failed:', error.message);
  process.exit(2);
});
