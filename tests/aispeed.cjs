const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Asking about the page must WORK, and must be quick.
 *
 * Makes real Gemini calls: the failure worth catching is an answer that is
 * empty, or an error the UI renders as a blank reply, and a mock would show
 * neither.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 160) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1400);
    if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });

    // A real article with real content to ask about.
    browser.tabs.navigate(browser.tabs.activeId,
      'https://en.wikipedia.org/wiki/Electron_(software_framework)');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
    await wait(2500);

    // Open the sidebar and ask through the real UI path.
    browser.toggleSidebar(true);
    await wait(2000);
    const side = browser.sidebar.webContents;
    for (let i = 0; i < 40 && side.isLoading(); i++) await wait(200);
    await wait(1200);

    const errors = [];
    side.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });

    const started = Date.now();
    await side.executeJavaScript(`(function(){
      var input = document.getElementById('input');
      input.value = 'In one sentence, what is this page about?';
      document.getElementById('compose')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);

    // Wait for a real answer to land.
    let answer = null;
    for (let i = 0; i < 60; i++) {
      await wait(700);
      answer = await side.executeJavaScript(`(function(){
        var turns = document.querySelectorAll('.side-turn.is-ai');
        var last = turns[turns.length - 1];
        if (!last) return null;
        return {
          text: (last.querySelector('.side-text')||last).textContent || '',
          meta: (last.querySelector('.side-meta')||{}).textContent || '',
          working: last.classList.contains('is-working') || /Thinking/.test(last.textContent),
        };
      })()`).catch(() => null);
      if (answer && !answer.working && answer.text && !/Thinking/.test(answer.text)) break;
    }
    const took = Date.now() - started;

    check('an answer came back', !!(answer && answer.text), JSON.stringify(answer));
    if (answer) {
      check('the answer is not empty or undefined',
        answer.text.length > 20 && !/undefined/i.test(answer.text), answer.text.slice(0, 120));
      check('it is about the page, not a generic reply',
        /electron|framework|chromium|node|desktop/i.test(answer.text), answer.text.slice(0, 120));
      check('it says the page was used',
        !/answered without the page/.test(answer.meta), 'meta: ' + answer.meta);
    }
    check('it answered in reasonable time', took < 25000, Math.round(took / 1000) + 's');
    console.log('  took: ' + Math.round(took / 1000) + 's');
    check('no sidebar errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall AI checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
