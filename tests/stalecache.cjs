const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * A profile cached when the browser shipped two lists must not keep exactly
 * those two after twenty were added. The timestamp said "fresh", so nothing
 * refetched - and the browser blocked far less than it claimed.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 140) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1200);

    // Recreate the broken state exactly: two lists, a recent lastFetch.
    const dir = browser.shields.cacheDir;
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file), { force: true });
    for (const id of ['easylist', 'easyprivacy']) {
      fs.writeFileSync(path.join(dir, id + '.txt'), '||ads.example^\n##.ad\n'.repeat(80));
    }
    browser.shields.store.data.lastFetch = Date.now();
    browser.shields.loadLists();

    check('the stale state is set up', browser.shields.cachedListCount() === 2,
      browser.shields.cachedListCount() + ' cached');
    check('and it knows the cache is incomplete',
      browser.shields.cachedListCount() < 20);

    // This must NOT skip, even though lastFetch is seconds old.
    const result = await browser.shields.refresh();
    check('a recent timestamp does not excuse a short cache',
      result.skipped !== true, JSON.stringify(result));
    check('every list was fetched', result.fetched === result.total,
      result.fetched + '/' + result.total);
    check('the engine has the full rule set', browser.shields.engine.count > 120000,
      browser.shields.engine.count + ' rules');
    check('and the full cosmetic set', browser.shields.engine.cosmeticCount > 40000,
      browser.shields.engine.cosmeticCount + ' cosmetic');

    // A COMPLETE, recent cache should still skip - we have not broken caching.
    const second = await browser.shields.refresh();
    check('a complete recent cache is left alone', second.skipped === true,
      JSON.stringify(second));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall stale-cache checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
