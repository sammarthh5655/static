const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch every list and report what we actually got. */
async function run(browser) {
  const { app } = require('electron');
  console.log('before:', browser.shields.engine.count, 'network,',
              browser.shields.engine.cosmeticCount, 'cosmetic');
  const started = Date.now();
  const result = await browser.shields.refresh({ force: true });
  console.log('fetched', result.fetched, 'of', result.total,
              'in', Math.round((Date.now() - started) / 1000) + 's');
  console.log('after :', browser.shields.engine.count, 'network,',
              browser.shields.engine.cosmeticCount, 'cosmetic');
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of fs.readdirSync(browser.shields.cacheDir).sort()) {
    const size = fs.statSync(path.join(browser.shields.cacheDir, f)).size;
    console.log('  ' + f.padEnd(24), Math.round(size / 1024) + ' KB');
  }
  app.exit(0);
}
module.exports = { run };
