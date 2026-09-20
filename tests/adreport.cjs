const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * A DIAGNOSTIC the user can run themselves, on their own profile, at the
 * moment they are actually seeing an ad.
 *
 * Every probe so far ran in a test profile on a video I chose. This one runs
 * against whatever is on screen right now and writes a report, so the thing
 * being measured is the thing the user is looking at.
 *
 *   npm run report:ads
 */
async function run(browser) {
  const { app } = require('electron');

  console.log('');
  console.log('  Static ad-blocking report');
  console.log('  =========================');
  console.log('');
  console.log('  1. The browser is open. Go to the video where you see an ad.');
  console.log('  2. WHILE the ad is on screen, come back here.');
  console.log('  3. This will sample the page every 5 seconds for 3 minutes');
  console.log('     and write shots/ad-report.txt plus a screenshot.');
  console.log('');

  browser.window.show();
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const say = (text) => { console.log('  ' + text); lines.push(text); };

  say('userData     : ' + app.getPath('userData'));
  say('cached lists : ' + browser.shields.cachedListCount());
  say('rules        : ' + browser.shields.engine.count + ' network, ' +
      browser.shields.engine.cosmeticCount + ' cosmetic');
  say('config       : ' + JSON.stringify({
    enabled: browser.shields.config.enabled,
    blockVideoAds: browser.shields.config.blockVideoAds,
    hideAdSlots: browser.shields.config.hideAdSlots,
    disabledSites: browser.shields.config.disabledSites,
  }));
  say('');

  let shot = 0;
  for (let tick = 0; tick < 36; tick++) {
    const tab = browser.tabs.active;
    if (!tab) { await wait(5000); continue; }
    const wc = tab.view.webContents;
    const url = tab.state.displayUrl || '';

    const s = await wc.executeJavaScript(`(function(){
      var p = document.getElementById('movie_player');
      var v = document.querySelector('video');
      var data = null;
      try { data = p && p.getVideoData ? p.getVideoData() : null; } catch(e){}
      function d(n){ try { var x = Object.getOwnPropertyDescriptor(window, n);
        return !x ? 'absent' : (x.get || x.set ? 'accessor' : 'plain'); } catch(e){ return 'threw'; } }
      var left = [];
      try { var r = window.ytInitialPlayerResponse;
        if (r) ['adPlacements','adSlots','playerAds'].forEach(function(k){ if (k in r) left.push(k); });
      } catch(e){}
      return {
        isAd: data ? !!data.isAd : null,
        cls: !!document.querySelector('.ad-showing, .ad-interrupting'),
        skip: !!document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button'),
        badge: (document.querySelector('.ytp-ad-badge, .ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining')||{}).textContent || '',
        slots: document.querySelectorAll('ytd-ad-slot-renderer, #player-ads, #masthead-ad').length,
        brave: typeof window.__staticYt !== 'undefined',
        ours: typeof window.__staticYtStats !== 'undefined',
        trap: d('ytInitialPlayerResponse'),
        leftover: left,
        t: v ? +v.currentTime.toFixed(1) : -1,
      };
    })()`).catch((e) => ({ error: String(e.message).slice(0, 80) }));

    const ad = !!(s.isAd || s.cls || s.skip || s.badge);
    say('t+' + (tick * 5) + 's ' + (ad ? 'AD   ' : 'clean') +
        ' video=' + s.t +
        ' brave=' + s.brave + ' ours=' + s.ours + ' trap=' + s.trap +
        ' leftover=' + JSON.stringify(s.leftover) +
        ' slots=' + s.slots +
        (s.badge ? ' badge="' + s.badge + '"' : '') +
        (s.error ? ' ERROR=' + s.error : '') +
        '  ' + url.slice(0, 60));

    // Capture whenever an ad is visible - that is the evidence that matters.
    if (ad && shot < 4) {
      const img = await wc.capturePage().catch(() => null);
      if (img) {
        const name = 'ad-' + (tick * 5) + 's.png';
        fs.writeFileSync(path.join(dir, name), img.toPNG());
        say('   -> screenshot: shots/' + name);
        shot++;
      }
    }
    await wait(5000);
  }

  fs.writeFileSync(path.join(dir, 'ad-report.txt'), lines.join('\n'));
  console.log('');
  console.log('  Written: shots/ad-report.txt');
  console.log('  Send me that file and any shots/ad-*.png.');
  app.exit(0);
}
module.exports = { run };
