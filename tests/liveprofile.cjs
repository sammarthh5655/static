const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the blocker chain against the REAL profile, and report every link in it.
 *
 * Every previous probe used a fresh test profile. If something in the user's
 * own profile disables the chain, a test profile would never show it.
 */
async function run(browser) {
  const { app } = require('electron');
  console.log('userData     :', app.getPath('userData'));
  console.log('profile dir  :', browser.shields.cacheDir);
  console.log('cached lists :', browser.shields.cachedListCount());

  browser.window.show();
  await wait(1500);
  for (let i = 0; i < 40 && browser.shields.engine.count < 1000; i++) await wait(500);
  if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
  await wait(700);

  console.log('rules        :', browser.shields.engine.count, '/ cosmetic', browser.shields.engine.cosmeticCount);
  console.log('config       :', JSON.stringify({
    enabled: browser.shields.config.enabled,
    blockVideoAds: browser.shields.config.blockVideoAds,
    hideAdSlots: browser.shields.config.hideAdSlots,
    disabled: browser.shields.config.disabledSites,
  }));
  console.log('gate says    :', browser.shields.activeFor('www.youtube.com'));

  const wc = browser.tabs.active.view.webContents;
  console.log('tab preload  :', wc.getLastWebPreferences ?
    (wc.getLastWebPreferences().preload || 'NONE') : 'unknown');

  browser.tabs.navigate(browser.tabs.activeId, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
  await wait(8000);

  const page = await wc.executeJavaScript(`(function(){
    function d(n){ try { var x=Object.getOwnPropertyDescriptor(window,n);
      return !x ? 'absent' : (x.get||x.set ? 'accessor' : 'plain'); } catch(e){ return 'threw'; } }
    var r=null; try { r=window.ytInitialPlayerResponse; } catch(e){}
    var left=[]; if(r) ['adPlacements','adSlots','playerAds'].forEach(function(k){ if(k in r) left.push(k); });
    return {
      braveScriptletsRan: typeof window.__staticYt !== 'undefined',
      ourTrap: typeof window.__staticYtStats !== 'undefined',
      ytipr: d('ytInitialPlayerResponse'),
      leftover: left,
      cosmeticApplied: (function(){
        // Our cosmetic sheet hides ad slots; check one of its selectors took.
        var probe = document.createElement('ytd-ad-slot-renderer');
        document.body.appendChild(probe);
        var hidden = getComputedStyle(probe).display === 'none';
        probe.remove();
        return hidden;
      })(),
    };
  })()`).catch((e) => ({ error: e.message }));

  console.log('\n--- in the page ---');
  console.log(JSON.stringify(page, null, 1));
  app.exit(0);
}
module.exports = { run };
