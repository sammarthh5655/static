const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Organise must work in one click, from the tab strip, without a page. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 140) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1400);

    // Real, groupable tabs.
    for (const url of ['https://github.com/a', 'https://stackoverflow.com/q/1',
                       'https://amazon.in/dp/1', 'https://amazon.in/dp/2',
                       'https://en.wikipedia.org/wiki/Tab']) {
      browser.tabs.create({ url, background: true });
    }
    await wait(2500);

    const chrome = browser.chrome.webContents;
    const before = browser.tabs.list().filter((t) => t.groupId).length;
    const url = browser.tabs.active.state.displayUrl;

    await chrome.executeJavaScript(`document.getElementById('organise-tabs').click(), true`);
    await wait(3500);

    const label = await chrome.executeJavaScript(
      `document.getElementById('organise-tabs').textContent`);
    const grouped = browser.tabs.list().filter((t) => t.groupId).length;

    check('one click groups the tabs', grouped > before, before + ' -> ' + grouped + ' grouped');
    check('it did not navigate away from the page',
      browser.tabs.active.state.displayUrl === url,
      'was ' + url + ', now ' + browser.tabs.active.state.displayUrl);
    check('the button reports what it actually did',
      /group/.test(label) && /\d/.test(label), label);
    check('and offers an undo', /undo/i.test(label), label);

    // The button IS the undo while it is showing.
    await chrome.executeJavaScript(`document.getElementById('organise-tabs').click(), true`);
    await wait(2500);
    const after = browser.tabs.list().filter((t) => t.groupId).length;
    check('clicking it again undoes the grouping', after < grouped,
      grouped + ' -> ' + after + ' grouped');
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall organise checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
