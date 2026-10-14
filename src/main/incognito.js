'use strict';

const path = require('node:path');

/**
 * Delete incognito folders left behind by windows that have closed.
 *
 * A closing window cannot always delete its own folder on Windows (helper
 * processes can still hold files), so every start sweeps up after the last.
 * A folder whose owner is still running is never touched.
 */
function sweepIncognito() {
  const fs = require('node:fs');
  const os = require('node:os');
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('static-incognito-')); } catch { return; }
  for (const name of entries) {
    const dir = path.join(os.tmpdir(), name);
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8')); } catch { /* no owner recorded */ }
    if (pid === process.pid) continue;
    let alive = false;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; } }
    if (!alive) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next time */ } }
  }
}

/**
 * Whether an incognito window of static is open right now, in a process of
 * its own. Installing an update closes every static process, so it must wait
 * rather than throw away someone's private window without warning.
 */
function incognitoRunning() {
  const fs = require('node:fs');
  const os = require('node:os');
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('static-incognito-')); } catch { return false; }
  for (const name of entries) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(os.tmpdir(), name, 'owner.pid'), 'utf8')); } catch { continue; }
    if (!(pid > 0) || pid === process.pid) continue;
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'EPERM') return true; }
  }
  return false;
}

module.exports = { sweepIncognito, incognitoRunning };
