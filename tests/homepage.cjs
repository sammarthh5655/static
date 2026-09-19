const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * New tab page checks. Run with `npm run test:homepage`.
 *
 * The assertions that matter are the ones about restraint: exactly five
 * actions, exactly three utility cards, and the advanced modes hidden behind
 * the tools panel. Those are easy to erode one addition at a time, which is
 * how a calm homepage turns back into a dashboard.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 130) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    // Seed history so the frequent row has something real to render.
    for (const [url, title] of [
      ['https://github.com/x', 'GitHub'],
      ['https://news.ycombinator.com/', 'Hacker News'],
      ['https://en.wikipedia.org/wiki/Electron', 'Wikipedia'],
      ['https://developer.mozilla.org/', 'MDN'],
      ['https://stackoverflow.com/', 'Stack Overflow'],
    ]) {
      for (let i = 0; i < 3; i++) browser.history.record(url, title);
    }
    browser.push();
    await wait(1500);

    browser.tabs.navigate(browser.tabs.activeId, 'browser://newtab');
    const wc = browser.tabs.active.view.webContents;
    const errors = [];
    wc.on('console-message', (event) => {
      if (event?.level === 'error' || event?.level === 3) errors.push(event.message.slice(0, 150));
    });
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(1400);

    const page = await wc.executeJavaScript(`({
      wordmark: document.querySelector('.wordmark')?.textContent || '',
      placeholder: document.getElementById('query').placeholder,
      actions: [...document.querySelectorAll('.action')].map(a => a.textContent.trim()),
      frequent: document.querySelectorAll('.frequent-item').length,
      utilCards: document.querySelectorAll('.util-card').length,
      hint: document.getElementById('keyhint').textContent,
      toolsAbsent: !document.getElementById('tools'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    })`);

    check('wordmark', page.wordmark === 'static', page.wordmark);
    check('placeholder names the Tab key', /press Tab for AI/.test(page.placeholder), page.placeholder);
    check('exactly five actions', page.actions.length === 5, page.actions.join(' | '));
    check('frequent row populated', page.frequent >= 5, page.frequent + ' items');
    check('exactly three utility cards', page.utilCards === 3, page.utilCards);
    check('hint explains both keys', /Enter/.test(page.hint) && /Tab/.test(page.hint), page.hint);
    check('no panel on the homepage', page.toolsAbsent === true);
    check('eclipse theme applied', page.accent === '#5ed3f0', page.accent);

    const ai = await wc.executeJavaScript(`(async () => {
      const q = document.getElementById('query');
      q.focus(); q.value = 'test';
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 250));
      const on = {
        mode: document.body.classList.contains('ai'),
        badge: !document.getElementById('search-badge').hidden,
        placeholder: q.placeholder,
      };
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 200));
      return { ...on, offAgain: !document.body.classList.contains('ai') };
    })()`, true);
    check('Tab enters AI mode', ai.mode && ai.badge, ai.placeholder);
    check('Escape leaves AI mode', ai.offAgain);

    // The AI tools panel and its floating button were both removed: a panel
    // overlaying the homepage is the opposite of what this page is for.
    const gone = await wc.executeJavaScript(`({
      trigger: !!document.getElementById('tools-trigger'),
      panel: !!document.getElementById('tools'),
      stray: document.querySelectorAll('[class*="tools"]').length,
    })`);
    check('no floating tools button', gone.trigger === false);
    check('no tools panel', gone.panel === false);
    check('no stray tools markup', gone.stray === 0, gone.stray + ' nodes');

    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll homepage checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Homepage test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
