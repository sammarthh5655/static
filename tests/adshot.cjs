const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Watch a video for a while and SCREENSHOT it, plus record everything the
 * player reports over time.
 *
 * Every probe so far sampled one moment a few seconds in. A mid-roll ad, or an
 * ad that starts after the player settles, would be invisible to that.
 */
async function run(browser) {
  const { app } = require('electron');
  browser.window.show();
  await wait(1500);
  for (let i = 0; i < 40 && browser.shields.engine.count < 1000; i++) await wait(500);
  if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
  await wait(700);
  console.log('rules:', browser.shields.engine.count, 'cosmetic:', browser.shields.engine.cosmeticCount);

  const wc = browser.tabs.active.view.webContents;

  // Find a LONG video that actually plays. A hardcoded id can be dead ("We're
  // processing this video"), and a video at currentTime 0 proves nothing
  // about ads - which is exactly how a previous run reported 45 clean seconds
  // of a stream that never started.
  await wc.loadURL('https://www.youtube.com/results?search_query=podcast+full+episode').catch(() => {});
  for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(250);
  await wait(2500);
  const pool = await wc.executeJavaScript(`(function(){
    var ids = {};
    document.querySelectorAll('a[href*="/watch?v="]').forEach(function(a){
      var m = a.getAttribute('href').match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) ids[m[1]] = 1;
    });
    return Object.keys(ids);
  })()`).catch(() => []);

  let url = null;
  for (const id of pool.sort(() => Math.random() - 0.5).slice(0, 6)) {
    browser.tabs.navigate(browser.tabs.activeId, 'https://www.youtube.com/watch?v=' + id);
    for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
    await wait(6000);
    const ok = await wc.executeJavaScript(`(function(){
      var v = document.querySelector('video');
      return v ? { t: v.currentTime, dur: v.duration || 0 } : { t: 0, dur: 0 };
    })()`).catch(() => ({ t: 0, dur: 0 }));
    // Playing, and long enough to carry a mid-roll.
    if (ok.t > 0.5 && ok.dur > 600) { url = id; break; }
    console.log('  skipped ' + id + ' (t=' + ok.t + ' dur=' + Math.round(ok.dur) + ')');
  }
  if (!url) { console.log('could not find a long video that plays'); app.exit(1); return; }
  console.log('watching:', url);

  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });

  // Sample every 3 seconds for 45 seconds, so a late ad cannot hide.
  let sawAd = false;
  for (let tick = 0; tick < 15; tick++) {
    await wait(3000);
    const s = await wc.executeJavaScript(`(function(){
      var p = document.getElementById('movie_player');
      var v = document.querySelector('video');
      var data = null;
      try { data = p && p.getVideoData ? p.getVideoData() : null; } catch(e){}
      return {
        isAd: data ? !!data.isAd : null,
        cls: !!document.querySelector('.ad-showing, .ad-interrupting'),
        skip: !!document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button'),
        badge: (document.querySelector('.ytp-ad-badge, .ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining')||{}).textContent || '',
        t: v ? +v.currentTime.toFixed(1) : -1,
        title: (data && data.title || '').slice(0, 30)
      };
    })()`).catch(() => ({ error: true }));

    const ad = !!(s.isAd || s.cls || s.skip || s.badge);
    if (ad) sawAd = true;
    console.log('  t+' + (tick * 3 + 3) + 's  ' + (ad ? 'AD  ' : 'clean') +
      '  video=' + s.t + '  badge="' + (s.badge || '') + '"  "' + (s.title || '') + '"');

    if (tick === 2 || ad) {
      const img = await wc.capturePage().catch(() => null);
      if (img) {
        const name = 'watch-' + (ad ? 'AD-' : '') + (tick * 3 + 3) + 's.png';
        fs.writeFileSync(path.join(dir, name), img.toPNG());
        console.log('    shot: ' + name);
      }
      if (ad) break;
    }
  }
  console.log(sawAd ? '\n*** AN AD APPEARED ***' : '\nno ad in 45 seconds of watching');
  app.exit(0);
}
module.exports = { run };
