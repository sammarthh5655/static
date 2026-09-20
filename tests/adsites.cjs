const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ad-heavy sites, not just YouTube.
 *
 * Counts the ad iframes and slots still visible after the page settles. A
 * blocker that only handles YouTube is not an ad blocker.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 150) : ''));
    if (!ok) fails++;
  };

  browser.window.show();
  await wait(1200);
  // Fetch the full set before measuring anything.
  const r = await browser.shields.refresh({ force: true });
  console.log('lists:', r.fetched + '/' + r.total,
              '| network:', browser.shields.engine.count,
              '| cosmetic:', browser.shields.engine.cosmeticCount);
  if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
  await wait(600);

  const SITES = [
    'https://www.speedtest.net/',
    'https://www.indiatimes.com/',
    'https://timesofindia.indiatimes.com/',
  ];

  const wc = browser.tabs.active.view.webContents;
  let totalVisible = 0;

  for (const url of SITES) {
    const before = browser.shields.stats.lifetime().blocked;
    browser.tabs.navigate(browser.tabs.activeId, url);
    for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
    await wait(6000);

    const seen = await wc.executeJavaScript(`(function(){
      // Anything that is an ad frame or slot AND still takes up space.
      var sel = 'iframe[src*="doubleclick"], iframe[src*="googlesyndication"],' +
                'iframe[id^="google_ads"], ins.adsbygoogle, [id^="div-gpt-ad"],' +
                '[class*="advertisement"], [id*="banner-ad"]';
      var visible = 0, total = 0;
      document.querySelectorAll(sel).forEach(function(n){
        total++;
        var r = n.getBoundingClientRect();
        var s = getComputedStyle(n);
        if (r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden') visible++;
      });
      return { total: total, visible: visible, host: location.hostname };
    })()`).catch(() => ({ total: -1, visible: -1, host: 'failed' }));

    const blocked = browser.shields.stats.lifetime().blocked - before;
    totalVisible += Math.max(0, seen.visible);
    console.log('  ' + seen.host.padEnd(30) + ' blocked ' + String(blocked).padStart(4) +
                ' requests | ad elements: ' + seen.total + ' found, ' + seen.visible + ' still visible');
  }

  check('no ad element is left visible on any site', totalVisible === 0,
    totalVisible + ' visible across ' + SITES.length + ' sites');
  console.log(fails ? '\nFAILURES: ' + fails : '\nall ad-site checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
