const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * browser://shields as an ad manager: real blocks on a real page land in the
 * statistics, the most-blocked lists, the open-tabs card and the live feed,
 * and the page shows them. Off-screen.
 */
const AD_PAGE = `<!doctype html><title>Ad-heavy page</title><h1>News</h1>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script src="https://c.amazon-adsystem.com/aax2/apstag.js"></script>
<script src="https://sb.scorecardresearch.com/beacon.js"></script>
<img src="https://ad.doubleclick.net/ddm/ad.gif" width="1" height="1">
<img src="https://www.facebook.com/tr?id=1&ev=PageView" width="1" height="1">
<img id="third" src="http://localhost:PORT/assets/avatar.png" width="1" height="1">
<p>Article text.</p>`;

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };

  let port = 0;
  const server = http.createServer((q, res) => {
    if (q.url.startsWith("/assets/avatar.png")) {
      // A third-party cookie the policy has to refuse.
      res.writeHead(200, { 'content-type': 'image/gif', 'set-cookie': 'track=1; Path=/' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AD_PAGE.replace('PORT', String(port)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  try {
    await wait(900);
    browser.shields.stats.reset();
    const before = browser.shields.stats.lifetime().blocked;

    // 1. A page full of ads and trackers.
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    browser.tabs.navigate(tab.id, base + '/news');
    await until(() => !wc.isLoading() && wc.getURL().startsWith(base));
    await wait(800);

    const s = browser.shields.stats.summary();
    const blocked = s.lifetime.blocked - before;
    check('the ads and trackers on the page are counted', blocked >= 5, blocked + ' blocked');
    check('split into ads and trackers', s.today.ads >= 3 && s.today.trackers >= 2, 'ads ' + s.today.ads + ', trackers ' + s.today.trackers);
    check('the refused third-party cookie is counted', s.today.cookies >= 1, 'cookies ' + s.today.cookies);
    const hosts = s.topHosts.map((h) => h.name);
    check('the most-blocked list names the networks', hosts.includes('doubleclick.net') && hosts.includes('google-analytics.com'), hosts.join(', '));
    check('doubleclick is ranked first, with its two requests', s.topHosts[0]?.name === 'doubleclick.net' && s.topHosts[0].count === 2, JSON.stringify(s.topHosts[0]));
    check('the site where it happened is recorded', s.topSites.some((site) => site.name === '127.0.0.1'), JSON.stringify(s.topSites));
    const hourNow = s.hourly[s.hourly.length - 1];
    check('the last-24-hours chart has this hour', hourNow.ads + hourNow.trackers >= blocked, JSON.stringify(hourNow));
    check('and the 30-day series has today', s.series30[29].ads + s.series30[29].trackers >= blocked, JSON.stringify(s.series30[29]));
    check('stats say when they started', s.firstDay === require('../src/features/shields/stats').dayKey(), s.firstDay);
    const feed = browser.shields.stats.recent(20);
    check('the live feed has each block, newest first', feed.length >= blocked && feed[0].at >= feed[feed.length - 1].at && feed.every((f) => f.site === '127.0.0.1'), feed.length + ' rows');
    check('feed rows carry type and list', feed.some((f) => f.type === 'script') && feed.some((f) => f.type === 'image') && feed.every((f) => f.list), JSON.stringify(feed[0]));

    // 2. The page, in a second tab so the ad page stays open.
    const pageId = browser.tabs.create({ url: 'browser://shields' });
    const page = browser.tabs.tabs.get(pageId).view.webContents;
    await until(() => page.getURL().includes('shields') && !page.isLoading());
    await until(() => page.executeJavaScript(`!!document.querySelector('.sh-hero') && document.querySelectorAll('.sh-feed-row').length > 0`));
    await wait(1400); // count-up animations finish

    const hero = await page.executeJavaScript(`document.querySelector('.sh-count').textContent`);
    check('the hero shows the lifetime figure', hero.replace(/\D/g, '') === String(browser.shields.stats.lifetime().blocked), hero);
    const tiles = await page.executeJavaScript(`[...document.querySelectorAll('.sh-tile')].map(t => t.querySelector('.sh-tile-label').firstChild.textContent + '=' + t.querySelector('.sh-tile-value').textContent)`);
    check('tiles show ads, trackers, cookies and the estimates', tiles.length === 9 && tiles.some((t) => /^Ads blocked=[1-9]/.test(t)) && tiles.some((t) => /^Third-party cookies=[1-9]/.test(t)), tiles.join(' | '));
    const bars = await page.executeJavaScript(`document.querySelectorAll('.sh-chart-svg .sh-bar.lane-ads, .sh-chart-svg .sh-bar.lane-trackers').length`);
    check('the chart draws this hour', bars >= 1, bars + ' bars');
    const ranked = await page.executeJavaScript(`[...document.querySelectorAll('.sh-rank-name')].map(n => n.textContent)`);
    check('most blocked is listed on the page', ranked[0] === 'doubleclick.net', ranked.join(', '));
    const tabsCard = await page.executeJavaScript(`[...document.querySelectorAll('.sh-tab')].map(t => t.querySelector('.sh-tab-host').textContent + ':' + t.querySelector('.sh-tab-count strong').textContent)`);
    check('open tabs shows the ad page and its count', tabsCard.some((t) => t.startsWith('127.0.0.1:') && Number(t.split(':')[1]) >= 5), tabsCard.join(' | '));
    const live = await page.executeJavaScript(`[...document.querySelectorAll('.sh-feed-row')].map(r => r.textContent).slice(0, 3)`);
    check('the live feed lists blocked requests', live.length >= 3 && live.every((r) => /Blocked|Neutralised/.test(r)), live[0]);
    const donut = await page.executeJavaScript(`document.querySelectorAll('.sh-donut-arc').length`);
    check('the ring splits today by kind', donut >= 3, donut + ' arcs');

    // 3. Switching range changes the figures' window.
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-range-tab')].find(b => b.textContent === 'All time').click()`);
    await wait(300);
    const active = await page.executeJavaScript(`document.querySelector('.sh-range-tab.is-active').textContent`);
    check('the range tabs switch', active === 'All time', active);

    // 4. Pausing Shields on a site from the page, then protecting it again.
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-site')].find(r => r.textContent.includes('127.0.0.1')).querySelector('.sh-switch').click()`);
    const paused = await until(() => (browser.shields.config.disabledSites || []).includes('127.0.0.1'));
    check('a site can be paused from "Where it happened"', !!paused, JSON.stringify(browser.shields.config.disabledSites));
    const listed = await until(() => page.executeJavaScript(`[...document.querySelectorAll('.sh-slot-paused .sh-site-name')].map(n => n.textContent).includes('127.0.0.1')`));
    check('and then shows under "Paused on these sites"', !!listed);
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-slot-paused .sh-seg-btn')].find(b => b.textContent === 'Protect again').click()`);
    const restored = await until(() => !(browser.shields.config.disabledSites || []).includes('127.0.0.1'));
    check('"Protect again" turns it back on', !!restored);

    // 5. A protection switch on the page changes the setting.
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-toggle')].find(t => t.textContent.startsWith('Upgrade to HTTPS')).click()`);
    const flipped = await until(() => browser.shields.config.upgradeHttps === false);
    check('protection switches work', !!flipped);
    browser.shields.update({ upgradeHttps: true });

    // Screenshots for a look, not assertions.
    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    // A normal desktop size, still off-screen.
    const bounds = browser.window.getBounds();
    browser.window.setBounds({ ...bounds, width: 1440, height: 940 });
    await wait(600);
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-range-tab')].find(b => b.textContent === 'Today').click(); window.scrollTo(0, 0)`);
    await wait(1300);
    for (const [name, selector] of [['shields-top', null], ['shields-lists', '.sh-slot-who'], ['shields-live', '.sh-slot-tabs'], ['shields-controls', '.sh-slot-controls']]) {
      if (selector) await page.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' })`);
      await wait(900);
      const image = await page.capturePage().catch(() => null);
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
    }

    // 6. Reset, from the page: two clicks, then everything reads zero.
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-seg-btn')].find(b => b.textContent === 'Reset statistics').click()`);
    await wait(150);
    check('reset asks for a second click first', browser.shields.stats.lifetime().blocked > 0);
    await page.executeJavaScript(`[...document.querySelectorAll('.sh-seg-btn')].find(b => b.textContent === 'Click again to reset').click()`);
    const cleared = await until(() => browser.shields.stats.lifetime().blocked === 0 && browser.shields.stats.top('hosts').length === 0);
    check('and then clears every statistic', !!cleared);
    browser.tabs.close(pageId);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall ad manager checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
