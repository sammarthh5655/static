const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does an ad play on a video that CARRIES ads?
 *
 * Previous checks used a 19-second clip from 2005 that Google does not
 * monetise, so "no ad" proved nothing. These are long, monetised videos.
 */
async function run(browser) {
  const { app } = require('electron');

  const VIDEOS = [
    ['music video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['long talk',   'https://www.youtube.com/watch?v=8aGhZQkoFbQ'],
  ];

  browser.window.show();
  await wait(1500);
  // Lists load on a deferred timer; measuring a 40-rule engine proves nothing.
  for (let i = 0; i < 40 && browser.shields.engine.count < 1000; i++) await wait(500);
  if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
  await wait(800);

  console.log('rules:', browser.shields.engine.count,
              '| blockVideoAds:', browser.shields.config.blockVideoAds);

  for (const [label, url] of VIDEOS) {
    browser.tabs.navigate(browser.tabs.activeId, url);
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
    await wait(9000);

    const probe = await wc.executeJavaScript(`(function(){
      var p = document.getElementById('movie_player');
      var v = document.querySelector('video');
      var data = null;
      try { data = p && p.getVideoData ? p.getVideoData() : null; } catch (e) {}
      return {
        // The player's OWN opinion of whether it is showing an ad.
        isAd: data ? !!data.isAd : null,
        adClass: !!document.querySelector('.ad-showing, .ad-interrupting'),
        adBadge: (document.querySelector('.ytp-ad-badge, .ytp-ad-simple-ad-badge, .ytp-ad-text')||{}).textContent || '',
        skip: !!document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'),
        overlay: document.querySelectorAll('.ytp-ad-overlay-container .ytp-ad-overlay-slot, #player-ads iframe').length,
        time: v ? +v.currentTime.toFixed(1) : -1,
        dur: v ? Math.round(v.duration) : -1,
        // Did Brave's scriptlets install?
        braveSet: (function(){
          try {
            var d = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
            return !!(d && typeof d.set === 'function');
          } catch (e) { return 'err'; }
        })(),
        ourHook: typeof window.__staticYtStats !== 'undefined',
        stats: window.__staticAdStats ? window.__staticAdStats() : null,
        // What the player response still carries.
        leftover: (function(){
          try {
            var r = window.ytInitialPlayerResponse;
            if (!r) return 'none';
            return ['adPlacements','adSlots','playerAds','adBreakHeartbeatParams']
              .filter(function(k){ return k in r; });
          } catch (e) { return 'err'; }
        })(),
      };
    })()`);

    console.log('\n--- ' + label + ' ---');
    console.log(JSON.stringify(probe, null, 1));
    console.log(probe.isAd || probe.adClass || probe.skip
      ? '*** AN AD IS PLAYING ***' : 'no ad detected');
  }
  app.exit(0);
}
module.exports = { run };
