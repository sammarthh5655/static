const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(browser) {
  const { app } = require('electron');
  browser.window.show();
  await wait(1500);
  console.log('rules =', browser.shields.engine.count);
  console.log('videoAds BEFORE =', browser.shields.stats.summary().today.videoAds ?? 'n/a');
  browser.tabs.navigate(browser.tabs.activeId, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  const wc = browser.tabs.active.view.webContents;
  for (let i = 0; i < 80 && wc.isLoading(); i++) await wait(250);
  await wait(9000);
  // Feed the trap a synthetic player response containing ad keys. This proves
  // the strip path AND the counter wiring without depending on whether this
  // particular video happens to be carrying an ad right now.
  await wc.executeJavaScript(`
    window.ytInitialPlayerResponse = {
      adPlacements: [{ a: 1 }, { b: 2 }],
      adSlots: [{ c: 3 }],
      playerAds: [{ d: 4 }],
      videoDetails: { title: 'synthetic' }
    }; true`, true);
  await wait(4000);
  const after = await wc.executeJavaScript(
    'JSON.stringify(Object.keys(window.ytInitialPlayerResponse || {}))');
  console.log('keys after trap =', after);
  const inPage = await wc.executeJavaScript('window.__staticAdStats ? window.__staticAdStats() : null');
  console.log('in-page stats   =', JSON.stringify(inPage));
  const today = browser.shields.stats.summary().today;
  console.log('videoAds AFTER  =', today.videoAds);
  console.log(today.videoAds > 0 ? 'COUNTER WIRED: video ad strips are now recorded'
                                 : '*** still 0 - counter not reaching the store ***');
  app.exit(0);
}
module.exports = { run };
