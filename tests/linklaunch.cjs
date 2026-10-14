/**
 * A link that LAUNCHES static must not cost the person their saved tabs.
 *
 * When static is the default browser and is not running, clicking a link in
 * another app starts it with that link. The link used to arrive before the
 * first window had restored the last session, which it only does into an
 * empty window - so the session was skipped, and overwritten with just the
 * link at the next save. Found in review, fixed in openFromSystem.
 *
 * This reproduces the launch timing: a fresh startup window (as at launch),
 * with a saved session and "continue where you left off", given a link
 * BEFORE its browser UI has loaded. Off-screen.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== undefined ? ' :: ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 180) : ''));
    if (!ok) fails++;
  };
  try {
    await wait(1200);
    // Past first run, set to restore, with two tabs saved.
    browser.onboarding?.complete?.();
    browser.settings.update({ onStartup: 'restore' });
    browser.sessionStore.data = {
      tabs: [
        { url: 'http://linklaunch.probe.test/saved-a', window: 0 },
        { url: 'http://linklaunch.probe.test/saved-b', window: 0, active: true },
      ],
      windows: [{ front: true }],
      savedAt: Date.now(),
    };

    // Launch timing: a new startup window, and the link right away - before
    // its chrome has loaded and opened the startup tabs.
    browser.startedUp = false;
    const w = browser.openWindow({ startup: true });
    browser.front = w;
    const opened = browser.openFromSystem(['http://linklaunch.probe.test/clicked'], process.cwd());

    // Give the chrome time to load (it would have opened startup tabs then).
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (w.tabs.order.length >= 3) break;
    }
    await wait(800);
    const urls = w.tabs.order.map((id) => {
      const t = w.tabs.tabs.get(id);
      return t.state.displayUrl || t.state.url || '';
    });
    check('the link opened', opened && urls.some((u) => /\/clicked$/.test(u)), urls);
    check('the saved session was restored as well', urls.some((u) => /\/saved-a$/.test(u)) && urls.some((u) => /\/saved-b$/.test(u)), urls);
    check('nothing opened twice', urls.length === new Set(urls).size && urls.length === 3, urls);
    const active = w.tabs.active?.state.displayUrl || w.tabs.active?.state.url || '';
    check('the clicked link is the tab in front', /\/clicked$/.test(active), active);
  } catch (error) {
    check('probe ran', false, error && error.stack ? error.stack : String(error));
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
