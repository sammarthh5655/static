const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every surface that shows a blocked count must show the SAME count.
 * Four different numbers on screen at once is the bug this guards.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + d : ''));
    if (!ok) fails++;
  };

  browser.window.show();
  await wait(1200);

  // Seed real activity so the numbers are not all zero.
  const s = browser.shields.stats;
  s.record('ads', 40);
  s.record('trackers', 25);
  s.record('cosmetic', 12);
  s.record('videoAds', 3);
  browser.push();
  await wait(400);

  const life = s.lifetime();
  console.log('lifetime =', JSON.stringify(life));

  const state = browser.state();
  const shieldsFeature = state.features.shields;
  const modeCard = state.modes.shields;

  check('ads + trackers is the blocked figure', life.blocked === life.ads + life.trackers,
    life.blocked + ' = ' + life.ads + ' + ' + life.trackers);
  check('cosmetic is NOT counted as blocked', life.blocked !== life.total,
    'blocked=' + life.blocked + ' total=' + life.total);

  check('features.shields.totalBlocked matches lifetime',
    shieldsFeature.totalBlocked === life.blocked,
    shieldsFeature.totalBlocked + ' vs ' + life.blocked);

  // The mode card renders a compacted string; it must be built from the same
  // figure, so check it contains the compacted lifetime number.
  const compact = (v) => v >= 1000 ? (v / 1000).toFixed(v % 1000 >= 100 ? 1 : 0) + 'k' : String(v);
  check('the shields mode card matches lifetime',
    String(modeCard.summary).includes(compact(life.blocked)),
    modeCard.summary + ' should contain ' + compact(life.blocked));
  check('the shields badge matches lifetime',
    String(modeCard.badge) === compact(life.blocked),
    modeCard.badge + ' vs ' + compact(life.blocked));

  // And what the homepage widget will render.
  const summary = s.summary();
  check('the widget summary carries the same lifetime',
    summary.lifetime.ads === life.ads && summary.lifetime.trackers === life.trackers,
    JSON.stringify(summary.lifetime));

  console.log(fails ? '\nFAILURES: ' + fails : '\nevery surface agrees');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
