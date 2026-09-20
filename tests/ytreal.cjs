const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does an ad ACTUALLY play on YouTube?
 *
 * Every previous probe asserted internal state - a counter incremented, a rule
 * matched, a hook installed - and every one passed while the real experience
 * was broken. This one only looks at what the user sees: is the player showing
 * an ad right now, and did our interception ever actually fire?
 */
async function run(browser) {
  const { app } = require('electron');
  const log = (...a) => console.log(...a);

  try {
    browser.window.show();
    await wait(1500);

    log('shields.enabled      =', browser.shields.config.enabled);
    log('blockVideoAds        =', browser.shields.config.blockVideoAds);
    log('network rules        =', browser.shields.engine.count);
    log('cosmetic rules       =', browser.shields.engine.cosmeticCount);

    // A video known to carry ads.
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    browser.tabs.navigate(browser.tabs.activeId, url);
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 80 && wc.isLoading(); i++) await wait(250);
    await wait(6000);

    const probe = await wc.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      const player = document.getElementById('movie_player');
      return {
        // What the PAGE says about ads - this is ground truth.
        adShowing: !!document.querySelector('.ad-showing, .ad-interrupting'),
        adModule: !!document.querySelector('.video-ads, #player-ads'),
        adBadge: (document.querySelector('.ytp-ad-badge, .ytp-ad-simple-ad-badge')||{}).textContent || '',
        skipButton: !!document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button'),
        playerClasses: player ? player.className : 'NO PLAYER',
        videoTime: v ? v.currentTime : null,
        videoDuration: v ? v.duration : null,
        paused: v ? v.paused : null,
        readyState: v ? v.readyState : null,
        // Did OUR code ever run in this page?
        hookInstalled: typeof window.__staticYtStats !== 'undefined',
        stats: window.__staticYtStats || null,
        fetchPatched: !!(window.fetch && window.fetch.__static),
        // Is the accessor actually on window?
        accessorPresent: !!Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse')?.set,
        // Does the player response still contain ad slots?
        adPlacements: (() => {
          try {
            const r = window.ytInitialPlayerResponse;
            if (!r) return 'no player response';
            return {
              adPlacements: Array.isArray(r.adPlacements) ? r.adPlacements.length : 'absent',
              adSlots: Array.isArray(r.adSlots) ? r.adSlots.length : 'absent',
              playerAds: Array.isArray(r.playerAds) ? r.playerAds.length : 'absent',
            };
          } catch (e) { return 'threw: ' + e.message; }
        })(),
      };
    })()`);

    log('\n--- WHAT THE PAGE ACTUALLY SHOWS ---');
    log(JSON.stringify(probe, null, 2));

    log('\n--- VERDICT ---');
    if (!probe.hookInstalled) log('*** OUR SCRIPT NEVER RAN IN THE PAGE ***');
    else if (!probe.accessorPresent) log('*** accessor missing - var won, or script ran too late ***');
    else log('hook present; stats =', JSON.stringify(probe.stats));
    log(probe.adShowing ? '*** AN AD IS PLAYING RIGHT NOW ***' : 'no ad class on the player');
  } catch (error) {
    log('PROBE THREW:', error.stack || error.message);
  }
  app.exit(0);
}
module.exports = { run };
