const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const { THEMES } = require('../src/shared/theme');

/** Render the dashboard in every planet so the palettes can be compared. */
async function run(browser) {
  const { app } = require('electron');
  browser.window.show();
  await wait(1200);
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });

  browser.tabs.navigate(browser.tabs.activeId, 'browser://newtab');
  const wc = browser.tabs.active.view.webContents;
  for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(200);
  await wait(1200);

  const ordered = Object.values(THEMES).sort((a, b) => a.order - b.order);
  for (const planet of ordered) {
    browser.settings.update({ theme: planet.id });
    browser.push();
    // The compositor needs a moment after a theme swap; capturing too early
    // returns UnknownVizError.
    await wait(1800);
    let page = null;
    for (let attempt = 0; attempt < 4 && !page; attempt++) {
      page = await wc.capturePage().catch(() => null);
      if (!page) await wait(900);
    }
    if (!page) { console.log('could not capture', planet.name); continue; }
    fs.writeFileSync(path.join(dir, 'planet-' + planet.order + '-' + planet.id + '.png'), page.toPNG());
    console.log('rendered', planet.name);
  }
  app.exit(0);
}
module.exports = { run };
