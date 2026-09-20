const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does an ad actually play, on videos chosen at random?
 *
 * A fixed test video proves nothing: the 19-second clip this used to check is
 * not monetised, so "no ad detected" was meaningless. Video ids are now pulled
 * live from YouTube and a random sample is watched, and the ids are printed so
 * any pass can be re-checked by hand.
 */

/** Pull real video ids from a YouTube page. */
async function harvest(wc, url) {
  await wc.loadURL(url).catch(() => {});
  for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(250);
  await wait(2500);
  return wc.executeJavaScript(`(function(){
    var ids = {};
    // Anchors carry /watch?v=..., and the initial data blob carries far more.
    document.querySelectorAll('a[href*="/watch?v="]').forEach(function(a){
      var m = a.getAttribute('href').match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) ids[m[1]] = 1;
    });
    try {
      var html = document.documentElement.innerHTML;
      var re = /"videoId":"([A-Za-z0-9_-]{11})"/g, m;
      while ((m = re.exec(html))) ids[m[1]] = 1;
    } catch (e) {}
    return Object.keys(ids);
  })()`).catch(() => []);
}

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 180) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1500);
    // Lists load on a deferred timer; a 40-rule engine proves nothing either.
    for (let i = 0; i < 40 && browser.shields.engine.count < 1000; i++) await wait(500);
    if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
    await wait(600);

    console.log('rules:', browser.shields.engine.count,
                '| blockVideoAds:', browser.shields.config.blockVideoAds,
                '| cosmetic:', browser.shields.engine.cosmeticCount);

    const wc = browser.tabs.active.view.webContents;

    // Harvest from trending and from a broad search, so the pool is not one
    // channel's worth of videos.
    let pool = [];
    for (const source of [
      'https://www.youtube.com/feed/trending',
      'https://www.youtube.com/results?search_query=full+podcast+episode',
    ]) {
      pool = pool.concat(await harvest(wc, source));
    }
    pool = [...new Set(pool)];
    check('found real videos to test', pool.length >= 5, pool.length + ' ids harvested');
    if (pool.length < 3) { app.exit(1); return; }

    // A different random sample every run.
    const picked = [];
    while (picked.length < 4 && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    console.log('testing:', picked.join(', '));

    let withAd = 0;
    let stalled = 0;

    for (const id of picked) {
      const url = 'https://www.youtube.com/watch?v=' + id;
      browser.tabs.navigate(browser.tabs.activeId, url);
      for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
      // Long enough for a pre-roll to have started if one was coming.
      await wait(9000);

      const r = await wc.executeJavaScript(`(function(){
        var p = document.getElementById('movie_player');
        var v = document.querySelector('video');
        var data = null;
        try { data = p && p.getVideoData ? p.getVideoData() : null; } catch (e) {}
        var left = [];
        try {
          var resp = window.ytInitialPlayerResponse;
          if (resp) ['adPlacements','adSlots','playerAds','adBreakHeartbeatParams']
            .forEach(function(k){ if (k in resp) left.push(k); });
        } catch (e) {}
        return {
          title: (data && data.title ? data.title : '').slice(0, 44),
          isAd: data ? !!data.isAd : null,
          adUI: !!document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-badge, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'),
          slots: document.querySelectorAll('ytd-ad-slot-renderer, #player-ads iframe, #masthead-ad').length,
          leftover: left,
          trap: (function(){
            var d = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
            return !!(d && typeof d.set === 'function');
          })(),
          t: v ? +v.currentTime.toFixed(1) : -1,
          dur: v ? Math.round(v.duration || 0) : 0,
          ready: v ? v.readyState : -1,
          paused: v ? v.paused : null,
        };
      })()`).catch((e) => ({ error: e.message }));

      const playing = r.t > 0 || r.paused === true;
      const advert = !!(r.isAd || r.adUI);
      if (advert) withAd++;
      if (!playing && r.ready === 4 && r.paused === false) stalled++;

      console.log('  ' + id + '  ' + (advert ? 'AD' : 'clean') +
        '  t=' + r.t + '/' + r.dur + 's  ready=' + r.ready +
        '  trap=' + r.trap + '  leftover=' + JSON.stringify(r.leftover) +
        '  slots=' + r.slots + '  "' + (r.title || '') + '"');
    }

    check('no ad played on any sampled video', withAd === 0,
      withAd + ' of ' + picked.length + ' showed an ad');
    check('no video stalled at zero', stalled === 0,
      stalled + ' of ' + picked.length + ' stalled');
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall random-video checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
