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

  // Mode summary powers the dashboard.
  const summary = browser.modeSummary();
  check('mode summary complete', ['focus','notes','resources','safety','ai'].every(k => summary[k]),
        Object.keys(summary).join(','));

  console.log(fails ? '\n'+fails+' failed\n' : '\nAll module checks passed.\n');
  app.exit(fails?1:0);
}
module.exports = { run };
