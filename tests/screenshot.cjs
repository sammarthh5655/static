const fs = require('node:fs');
const path = require('node:path');

/**
 * Capture the real UI to a PNG so chrome/renderer changes can be eyeballed
 * without launching interactively. Run with `npm run test:shot`.
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(browser) {
  const { app } = require('electron');
  const out = path.join(app.getAppPath(), '.test-output');
  fs.mkdirSync(out, { recursive: true });

  try {
    // capturePage needs a visible, composited window; an offscreen or hidden
    // window fails with UnknownVizError.
    browser.window.show();
    browser.window.focus();
    await wait(1500); // let the chrome paint and the new tab page settle

    // The chrome view and the tab view are separate WebContents, so capture
    // each: together they show the whole window top to bottom.
    const chrome = await browser.chrome.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'chrome.png'), chrome.toPNG());

    browser.tabs.create({ url: 'browser://settings' });
    await wait(1200);
    const settings = await browser.tabs.active.view.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'settings.png'), settings.toPNG());

    browser.tabs.navigate(browser.tabs.activeId, 'browser://newtab');
    await wait(1200);
    const newtab = await browser.tabs.active.view.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'newtab.png'), newtab.toPNG());

    console.log('Wrote screenshots to ' + out);
    app.exit(0);
  } catch (error) {
    console.error('Screenshot failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
