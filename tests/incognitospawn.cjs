const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * "New incognito window" starts a separate Static process with its own
 * throwaway folder, beside this one; once it is gone, the next sweep deletes
 * what it left. The child inherits the off-screen test setting, so nothing
 * appears on screen.
 */
async function run(browser) {
  const { app } = require('electron');
  const { sweepIncognito } = require('../src/main/incognito');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const folderOf = (pid) => fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('static-incognito-'))
    .map((n) => path.join(os.tmpdir(), n))
    .find((dir) => { try { return fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8') === String(pid); } catch { return false; } });

  let pid = 0;
  try {
    await wait(800);
    pid = browser.openIncognito('https://example.com/');
    check('a separate process starts', pid > 0 && pid !== process.pid, 'pid ' + pid);
    let dir = null;
    for (let i = 0; i < 60 && !dir; i++) { await wait(250); dir = folderOf(pid); }
    check('with its own throwaway folder', !!dir, dir);
    await wait(2500);
    check('and it keeps running beside this one', alive(pid));
    check('this browser is still a normal window', browser.incognito === false && browser.session.isPersistent());

    sweepIncognito();
    check('a sweep never touches a running window\'s folder', !!dir && fs.existsSync(dir));

    process.kill(pid);
    for (let i = 0; i < 40 && alive(pid); i++) await wait(250);
    check('closing it ends the process', !alive(pid));
    await wait(1500);
    for (let i = 0; i < 10 && dir && fs.existsSync(dir); i++) { sweepIncognito(); await wait(500); }
    check('and what it left is swept away', !dir || !fs.existsSync(dir), dir);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
    if (pid && alive(pid)) process.kill(pid);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall incognito launch checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
