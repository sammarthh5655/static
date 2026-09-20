const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const brave = require('../src/features/shields/brave');

/**
 * Brave's scriptlets, run in a REAL page.
 *
 * A Node sandbox is not a browser: these scriptlets reach for globals a
 * sandbox does not have, so the only honest test is a real renderer.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 170) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1200);
    console.log('scriptlets in library:', brave.count());

    // A real page, on the real origin these rules target.
    browser.tabs.navigate(browser.tabs.activeId, 'https://www.youtube.com/');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 80 && wc.isLoading(); i++) await wait(250);
    await wait(3000);

    // Brave's own YouTube rule, verbatim from their main list.
    const script = brave.scriptFor(
      'json-prune, playerResponse.adPlacements playerResponse.playerAds ' +
      'playerResponse.adSlots adPlacements playerAds adSlots');
    check('the rule builds a script', script.length > 1000, script.length + ' bytes');

    const result = await wc.executeJavaScript(`(function(){
      try {
        ${script}
        // Feed it a player response the way YouTube would.
        var payload = JSON.stringify({
          adPlacements: [{a:1},{b:2}],
          adSlots: [{c:3}],
          playerAds: [{d:4}],
          videoDetails: { title: 'keep me' }
        });
        var parsed = JSON.parse(payload);
        return {
          ok: true,
          keys: Object.keys(parsed),
          kept: !!(parsed.videoDetails && parsed.videoDetails.title === 'keep me')
        };
      } catch (e) { return { ok: false, error: String(e && e.message) }; }
    })()`, true);

    check('it runs in a real page', result.ok === true, result.error);
    if (result.ok) {
      const gone = !result.keys.includes('adPlacements') &&
                   !result.keys.includes('adSlots') &&
                   !result.keys.includes('playerAds');
      check('ads are pruned out of the player response', gone, result.keys.join(','));
      check('real content is untouched', result.kept === true);
    }

    // set-constant, the other technique Brave uses on YouTube.
    const setter = brave.scriptFor('set, ytInitialPlayerResponse.playerAds, undefined');
    const setResult = await wc.executeJavaScript(`(function(){
      try {
        ${setter}
        window.ytInitialPlayerResponse = { playerAds: [1,2,3], videoDetails: { title: 'x' } };
        return { ok: true, ads: window.ytInitialPlayerResponse.playerAds,
                 kept: !!window.ytInitialPlayerResponse.videoDetails };
      } catch (e) { return { ok: false, error: String(e && e.message) }; }
    })()`, true);
    check('set-constant runs', setResult.ok === true, setResult.error);
    if (setResult.ok) {
      check('it neutralises the ad property', setResult.ads === undefined || setResult.ads === null,
        JSON.stringify(setResult.ads));
      check('and leaves the rest of the response alone', setResult.kept === true);
    }
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall Brave scriptlet checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
