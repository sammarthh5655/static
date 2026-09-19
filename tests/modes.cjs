const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Feature-mode checks. Run with `npm run test:modes`.
 *
 * The assertions that matter most here are the negative ones: that Focus does
 * NOT block YouTube, and that Safety does NOT warn about real banks and search
 * engines. A blocker that catches too much gets turned off, and a warning that
 * cries wolf gets clicked through.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => { console.log((ok?'  ok  ':'FAIL  ')+n+(d?' :: '+String(d).slice(0,110):'')); if(!ok) fails++; };
  browser.window.show();
  await wait(1200);

  check('focus module', !!browser.focus && typeof browser.focus.shouldBlock === 'function');
  check('notes module', !!browser.notes && typeof browser.notes.add === 'function');
  check('safety module', !!browser.safety && typeof browser.safety.assess === 'function');
  check('resources module', !!browser.resources && typeof browser.resources.sample === 'function');

  // Real metrics from getAppMetrics.
  const snap = browser.resources.sample();
  check('resources measures memory', snap.totals.totalMemoryMb > 0,
        snap.totals.totalMemoryMb + ' MB across ' + snap.totals.tabCount + ' tabs');
  check('per-tab metrics present', snap.tabs.length > 0 && snap.tabs[0].pid > 0,
        JSON.stringify(snap.tabs[0] && {pid:snap.tabs[0].pid, mem:snap.tabs[0].memoryMb}));

  // Focus blocking.
  browser.focus.start({ preset: 'study', minutes: 30 });
  check('focus session active', browser.focus.active);
  check('blocks instagram', browser.focus.shouldBlock('https://www.instagram.com/x'));
  check('blocks reddit subdomain', browser.focus.shouldBlock('https://old.reddit.com/r/x'));
  check('ALLOWS youtube', !browser.focus.shouldBlock('https://www.youtube.com/watch?v=1'));
  check('allows ordinary sites', !browser.focus.shouldBlock('https://en.wikipedia.org/wiki/X'));
  browser.focus.finish('stopped');
  check('unblocks when session ends', !browser.focus.shouldBlock('https://instagram.com'));

  // Safety scoring: real sites must NOT trip it.
  const safe = ['https://www.google.com','https://github.com/x/y','https://en.wikipedia.org/wiki/A','https://amazon.in/dp/B0','https://www.hdfcbank.com/']
    .map(u => ({u, a: browser.safety.assess(u)}));
  const falsePositives = safe.filter(x => x.a.shouldWarn);
  check('no false positives on real sites', falsePositives.length === 0,
        falsePositives.map(x=>x.u+'='+x.a.score).join(', '));

  const bad = [
    ['brand in wrong domain','https://paypal-secure-login.tk/signin'],
    ['lookalike spelling','http://gooogle.com/login'],
    ['ip host + login','http://192.168.1.50/account/verify'],
    ['http login on odd tld','http://hdfc-bank-verify.xyz/login'],
  ].map(([label,u]) => ({label, a: browser.safety.assess(u)}));
  for (const b of bad) check('flags: '+b.label, b.a.shouldWarn, 'score '+b.a.score+' '+(b.a.reasons[0]?.title||''));

  // Notes round-trip.
  const note = browser.notes.add({ kind:'text', body:'Hello from the test', url:'https://example.com', tags:['test','demo'] });
  check('note stored', !!note.id && browser.notes.list({query:'Hello'}).length === 1, note.title);
  check('note tags normalised', note.tags.join(',') === 'test,demo', note.tags.join(','));
  browser.notes.remove(note.id);
  check('note removed', browser.notes.list({query:'Hello'}).length === 0);

  // ---- the mode PAGE, not just the module ------------------------------
  // Everything above this point talks to the main-process modules directly,
  // which is exactly why it all passed while every mode page was frozen: main
  // declared a `<mode>:changed` event for each feature but only ever SENT
  // `chat:changed`, so a page rendered once and never redrew. Clicking a Focus
  // toggle updated main and changed nothing on screen.
  //
  // These assertions drive the real DOM, so a page that stops re-rendering
  // fails here even when every module check still passes.
  browser.focus.finish('reset');
  browser.tabs.navigate(browser.tabs.activeId, 'browser://focus');
  const page = browser.tabs.active.view.webContents;
  for (let i = 0; i < 50 && page.isLoading(); i++) await wait(200);
  await wait(1200);

  // Re-query after each click: the page rebuilds its nodes on re-render, so a
  // node captured beforehand is detached and would report a stale value.
  const toggle = await page.executeJavaScript(`(async function(){
    var find = function(name){
      return [].slice.call(document.querySelectorAll('.site-toggle')).filter(function(t){
        return t.querySelector('.site-name').textContent === name; })[0]; };
    if (!find('Instagram')) return { error: 'no site toggles rendered' };
    var before = find('Instagram').classList.contains('on');
    find('Instagram').click();
    await new Promise(function(r){ setTimeout(r, 900); });
    var after = find('Instagram').classList.contains('on');
    find('Instagram').click();
    await new Promise(function(r){ setTimeout(r, 900); });
    return { before: before, after: after, restored: find('Instagram').classList.contains('on') };
  })()`, true).catch((error) => ({ error: error.message }));

  check('focus page redraws when a site is toggled off',
        toggle.before === true && toggle.after === false, toggle.error || JSON.stringify(toggle));
  check('focus page redraws when it is toggled back on',
        toggle.restored === true, toggle.error || JSON.stringify(toggle));

  const session = await page.executeJavaScript(`(async function(){
    var pill = function(re){
      return [].slice.call(document.querySelectorAll('.pill')).filter(function(p){
        return re.test(p.textContent); })[0]; };
    var start = pill(/^Study/);
    if (!start) return { error: 'no preset pills rendered' };
    start.click();
    await new Promise(function(r){ setTimeout(r, 1200); });
    var timer = (document.querySelector('.timer-value') || {}).textContent || '';
    var end = pill(/End session/);
    if (end) end.click();
    await new Promise(function(r){ setTimeout(r, 1000); });
    return { timer: timer, hadEnd: !!end, cleared: !document.querySelector('.timer-value') };
  })()`, true).catch((error) => ({ error: error.message }));

  check('starting a preset shows a running timer',
        /^\d+:\d\d$/.test(session.timer || ''), session.error || ('timer=' + session.timer));
  check('ending a session clears the timer',
        session.hadEnd === true && session.cleared === true, session.error || JSON.stringify(session));
  check('main agrees the session ended', browser.focus.active === false);

  // Mode summary powers the dashboard.
  const summary = browser.modeSummary();
  check('mode summary complete', ['focus','notes','resources','safety','ai'].every(k => summary[k]),
        Object.keys(summary).join(','));

  console.log(fails ? '\n'+fails+' failed\n' : '\nAll module checks passed.\n');
  app.exit(fails?1:0);
}
module.exports = { run };
