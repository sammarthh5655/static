const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Diagnostic: load every internal page, report console errors and confirm each
 * one actually rendered its state. Run with `npm run test:probe`.
 */
const PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'extensions'];

async function run(browser) {
  const { app } = require('electron');
  let failures = 0;
  try {
    browser.window.show();
    for (const page of PAGES) {
      const errors = [];
      const id = browser.tabs.create({ url: 'browser://' + page });
      const wc = browser.tabs.tabs.get(id).view.webContents;
      wc.on('console-message', (event) => {
        // Electron 44 passes an event object; level 3 is "error".
        const text = event?.message ?? '';
        if ((event?.level === 'error' || event?.level === 3) && text) errors.push(text);
      });
      await wait(1200);
      const rendered = await wc.executeJavaScript(
        'document.body.innerText.trim().length > 0 && !!window.page');
      if (errors.length || !rendered) {
        failures++;
        console.log('FAIL  ' + page + (rendered ? '' : ' (did not render)'));
        errors.forEach((error) => console.log('        ' + error));
      } else {
        console.log('  ok  ' + page);
      }
      browser.tabs.close(id);
    }
    console.log(failures ? '\n' + failures + ' page(s) failed.\n' : '\nAll internal pages render cleanly.\n');
    app.exit(failures ? 1 : 0);
  } catch (error) {
    console.error('Probe failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
