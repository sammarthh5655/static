const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');

/**
 * Network rules that modify rather than block, on real pages, off-screen:
 * $redirect serves a harmless stand-in, $removeparam cleans the address,
 * $csp stops what the page may run.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((q, res) => {
    if (q.url.startsWith('/ads.js')) { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('window.realAd = 1;'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (q.url.startsWith('/csp')) { res.end('<title>csp</title><script>document.title = "inline ran"</script>'); return; }
    res.end(`<title>t</title><script>window.events = [];</script>
      <script src="/ads.js" onload="events.push('load')" onerror="events.push('error')"></script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await wait(800);
    browser.shields.engine.addList([
      '||127.0.0.1^*/ads.js$script,redirect=noop.js',
      '$removeparam=utm_source',
      "||127.0.0.1^*/csp$csp=script-src 'none'",
    ].join('\n'), { id: 'probe' });
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(url.split('?')[0])); i++) await wait(120);
      await wait(700);
    };
    await go(base + '/page');
    const result = await wc.executeJavaScript('({ events: window.events, realAd: window.realAd })');
    check('a $redirect rule serves the stand-in: the script "loads" but the ad code never runs',
      JSON.stringify(result.events) === '["load"]' && result.realAd === undefined, JSON.stringify(result));
    await go(base + '/page?utm_source=newsletter&id=7');
    check('$removeparam takes the tracking parameter out of the address', wc.getURL() === base + '/page?id=7', wc.getURL());
    await go(base + '/csp');
    check('$csp stops what the rule forbids (inline script here)', (await wc.executeJavaScript('document.title')) === 'csp');
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall network rule checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
