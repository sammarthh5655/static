const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shields checks. Run with `npm run test:shields`.
 *
 * The assertions split in two, and both matter:
 *   - it BLOCKS ad and tracker networks
 *   - it does NOT block ordinary CDNs, first-party requests, or localhost
 *
 * Over-blocking is the failure mode that makes people turn a blocker off, so
 * the negative assertions are as important as the positive ones.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 130) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1000);

    const inspect = (url, docHost, type = 'script') =>
      browser.shields.inspect({ url, docHost, resourceType: type, tabId: null });

    check('shields present', !!browser.shields && typeof browser.shields.inspect === 'function');
    check('rules loaded', browser.shields.engine.count > 30, browser.shields.engine.count + ' rules');

    // Blocks.
    check('blocks doubleclick', inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block === true);
    check('blocks google-analytics', inspect('https://www.google-analytics.com/analytics.js', 'news.com')?.block === true);
    check('blocks facebook pixel cross-site', inspect('https://www.facebook.com/tr?id=1', 'news.com')?.block === true);

    // Does not over-block.
    check('allows facebook on facebook', !inspect('https://www.facebook.com/tr?id=1', 'facebook.com')?.block);
    check('allows a normal CDN', !inspect('https://cdn.jsdelivr.net/npm/x.js', 'news.com')?.block);
    check('allows first-party scripts', !inspect('https://news.com/app.js', 'news.com')?.block);

    // Rewriting.
    const rewritten = browser.shields.rewrite('http://example.com/page?utm_source=x&id=7&fbclid=abc');
    check('upgrades http to https', rewritten.startsWith('https://'), rewritten);
    check('strips tracking parameters', !/utm_source|fbclid/.test(rewritten), rewritten);
    check('keeps real parameters', rewritten.includes('id=7'), rewritten);
    check('leaves localhost on http',
      browser.shields.rewrite('http://localhost:3000/app').startsWith('http://localhost'));

    // Per-site control.
    browser.shields.setSiteEnabled('news.com', false);
    check('per-site off stops blocking', !inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block);
    check('other sites stay protected', inspect('https://ad.doubleclick.net/x.js', 'other.com')?.block === true);
    browser.shields.setSiteEnabled('news.com', true);
    check('re-enabling restores blocking', inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block === true);

    // Matching must stay fast: this runs on every request a page makes.
    const urls = ['https://ad.doubleclick.net/x.js', 'https://cdn.jsdelivr.net/a.js',
      'https://news.com/app.js', 'https://analytics.example.com/t.gif'];
    const started = Date.now();
    for (let i = 0; i < 20000; i++) {
      browser.shields.engine.match({ url: urls[i % 4], docHost: 'news.com', resourceType: 'script' });
    }
    const perRequest = (Date.now() - started) * 1000 / 20000;
    check('matching is fast enough', perRequest < 200, perRequest.toFixed(1) + 'us per request');

    // A real page: blocks something, and still loads.
    const id = browser.tabs.create({ url: 'https://edition.cnn.com/' });
    const tab = browser.tabs.tabs.get(id);
    for (let i = 0; i < 80 && tab.view.webContents.isLoading(); i++) await wait(300);
    await wait(3000);
    const report = browser.shields.tabReport(id);
    check('blocks on a real site', report.count > 0,
      report.count + ' from ' + report.sources.length + ' hosts');
    check('real site still loads', (tab.state.title || '').length > 0, tab.state.title);
    browser.tabs.close(id);

    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll shields checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Shields test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
