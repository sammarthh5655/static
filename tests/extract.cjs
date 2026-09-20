const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { EXTRACT_SCRIPT } = require('../src/features/ai/pagecontext');

/** Checks page extraction against a real page with heavy navigation chrome. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 160) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1000);
    browser.tabs.navigate(browser.tabs.activeId,
      'https://en.wikipedia.org/wiki/Electron_(software_framework)');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(300);
    await wait(1200);

    const out = await wc.executeJavaScript(EXTRACT_SCRIPT);
    const head = (out.text || '').slice(0, 220);
    console.log('--- first 220 chars ---\n' + head + '\n-----------------------');

    check('extraction returned text', (out.text || '').length > 500, out.chars + ' chars');
    check('the article title is near the start',
      /electron/i.test(head), head.slice(0, 60));
    // The reported bug: a language list appeared before the content.
    check('no language-count chrome leaks in',
      !/\d+\s+languages/i.test(out.text.slice(0, 2000)),
      (out.text.match(/\d+\s+languages/i) || [''])[0]);
    check('no jump-to-navigation link',
      !/jump to (navigation|content|search)/i.test(out.text.slice(0, 2000)));
    check('no run of blank lines', !/\n{3,}/.test(out.text));
    check('no tab characters', !/\t/.test(out.text));
    check('no line starts with spaces', !/^ +/m.test(out.text));
    check('body text is actually present',
      /framework|chromium|node/i.test(out.text), 'expected article words');
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall extraction checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
