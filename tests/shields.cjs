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
    // NOT the Facebook pixel: EasyPrivacy blocks ||facebook.com/tr? with no
    // $third-party option, so it is blocked on facebook.com too - that is the
    // list's deliberate intent, not over-blocking. Test a real first-party
    // asset instead.
    check('allows first-party assets', !inspect('https://www.facebook.com/images/logo.png', 'facebook.com', 'image')?.block);
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

    // ---- scriptlets: video ads --------------------------------------------
    // Network rules CANNOT block YouTube video ads: they come from the same
    // googlevideo.com endpoint as the video itself, so blocking them blocks
    // the content. These assertions cover the part only scriptlet injection
    // into the page's main world can do.
    const ytTab = browser.tabs.create({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    const yt = browser.tabs.tabs.get(ytTab);
    for (let i = 0; i < 90 && yt.view.webContents.isLoading(); i++) await wait(300);
    await wait(7000);

    const player = await yt.view.webContents.executeJavaScript(`({
      ran: !!window.__staticScriptletsRan,
      adPlacements: (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.adPlacements)
        ? window.ytInitialPlayerResponse.adPlacements.length : 0,
      playerAds: (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.playerAds)
        ? window.ytInitialPlayerResponse.playerAds.length : 0,
      adShowing: !!document.querySelector('.ad-showing'),
      hasVideo: !!document.querySelector('video'),
      title: document.title,
    })`).catch((error) => ({ error: error.message }));

    check('scriptlets run on YouTube', player.ran === true, player.error || '');
    check('ad placements stripped', player.adPlacements === 0, 'adPlacements=' + player.adPlacements);
    check('player ads stripped', player.playerAds === 0, 'playerAds=' + player.playerAds);
    check('no ad is showing', player.adShowing === false);
    check('the real video still loads', player.hasVideo === true, player.title);
    browser.tabs.close(ytTab);

    // Scriptlets must not break ordinary sites. This is the failure that
    // matters most here: a broken page is worse than an unblocked ad.
    for (const [label, url] of [
      ['wikipedia', 'https://en.wikipedia.org/wiki/Advertising'],
      ['github', 'https://github.com/electron/electron'],
    ]) {
      const siteTab = browser.tabs.create({ url });
      const site = browser.tabs.tabs.get(siteTab);
      for (let i = 0; i < 80 && site.view.webContents.isLoading(); i++) await wait(300);
      await wait(2500);
      const page = await site.view.webContents.executeJavaScript(`({
        ran: !!window.__staticScriptletsRan,
        text: document.body ? document.body.innerText.trim().length : 0,
        title: document.title,
      })`).catch((error) => ({ error: error.message }));
      check(label + ' still renders with scriptlets active',
        page.ran === true && page.text > 2000, page.title || page.error);
      browser.tabs.close(siteTab);
    }

    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll shields checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Shields test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
