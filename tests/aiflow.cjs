const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The sidebar assistant used the way a person uses it: click into the box,
 * type a question, press Enter, watch it think, read the answer - and, when
 * Gemini cannot answer, read WHY in words that mean something to them.
 *
 * Complements aispeed (which times every path against the real API). This
 * one is about what the person sees: the permission line while a page is
 * still loading, the waiting state, each kind of failure as its own plain
 * message, a question on one of our own pages, and markdown never arriving
 * as stray asterisks. Real Gemini for the answers; the failures are faked,
 * because Google cannot be made to refuse on demand.
 */
async function run(browser) {
  const { app } = require('electron');
  const gemini = require('../src/features/ai/gemini');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 160) : ''));
    if (!ok) fails++;
  };
  const shotsDir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const shoot = async (wc, name) => {
    const img = await wc.capturePage().catch(() => null);
    if (img && !img.isEmpty()) {
      fs.writeFileSync(path.join(shotsDir, name), img.toPNG());
      console.log('  shot: shots/' + name);
    }
  };

  try {
    // Off-screen and unfocusable under a probe (see ensureWindow).
    browser.window.showInactive();
    await wait(1400);
    if (!browser.tabs.order.length) browser.tabs.create({ url: 'browser://newtab' });
    browser.tabs.navigate(browser.tabs.activeId, 'browser://newtab');
    const page = () => browser.tabs.active.view.webContents;
    for (let i = 0; i < 40 && page().isLoading(); i++) await wait(150);
    await wait(600);

    browser.toggleSidebar(true);
    await wait(1500);
    const side = browser.sidebar.webContents;
    for (let i = 0; i < 40 && side.isLoading(); i++) await wait(200);
    await wait(800);

    const errors = [];
    side.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });
    const permission = () => side.executeJavaScript(`window.browser.invoke('ai:page-permission')`);
    const strip = () => side.executeJavaScript(`document.getElementById('perm-text').textContent`);

    // ---- our own page: blocked, and a question is answered without it -----
    let verdict = await permission();
    check('on one of Static’s own pages the line says so', verdict.level === 'blocked' && /browser page/i.test(verdict.reason), verdict.reason);

    // ---- leaving our own page for the web: never "a file on your computer" -
    browser.tabs.navigate(browser.tabs.activeId, 'https://en.wikipedia.org/wiki/Lighthouse');
    const midLoad = [];
    for (let i = 0; i < 12 && (page().isLoading() || i < 2); i++) {
      midLoad.push((await permission()).reason || 'ordinary');
      await wait(120);
    }
    check('while the article loads, the line never calls the page left behind a file of yours',
      !midLoad.some((reason) => /file on your computer/i.test(reason)), midLoad.join(' | '));
    for (let i = 0; i < 90 && page().isLoading(); i++) await wait(250);
    await wait(1500);
    check('once loaded, the line says it can read this article',
      /Can read this page · en\.wikipedia\.org/.test(await strip()), await strip());

    // ---- a question typed and sent like a person would ----------------------
    const box = async (selector) => side.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: !!el.disabled };
    })()`);
    const click = async (selector) => {
      const at = await box(selector);
      if (!at) return null;
      side.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      side.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      return at;
    };
    const type = async (text) => {
      await click('#input');
      side.focus();
      await wait(150);
      for (const ch of text) {
        side.sendInputEvent({ type: 'char', keyCode: ch });
        await wait(8);
      }
      await wait(120);
      side.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      side.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    };
    const last = () => side.executeJavaScript(`(function(){
      var turns = document.querySelectorAll('.side-turn.is-ai');
      var t = turns[turns.length - 1];
      if (!t) return null;
      return {
        text: (t.querySelector('.side-text')||t).textContent || '',
        meta: (t.querySelector('.side-meta')||{}).textContent || '',
        working: t.classList.contains('is-working'),
        failed: t.classList.contains('is-failed'),
        retry: !!t.querySelector('.side-retry'),
        inputValue: document.getElementById('input').value,
        inputDisabled: document.getElementById('input').disabled,
      };
    })()`);
    const settle = async (limit = 60) => {
      let answer = null;
      for (let i = 0; i < limit; i++) {
        await wait(500);
        answer = await last();
        if (answer && !answer.working) break;
      }
      return answer;
    };

    let started = Date.now();
    await type('List three facts about lighthouses from this page.');
    await wait(450);
    const waiting = await last();
    check('pressing Enter sends it and shows the assistant thinking',
      !!waiting?.working && waiting.inputValue === '' && waiting.inputDisabled, JSON.stringify(waiting));
    await shoot(side, 'aiflow-thinking.png');
    let answer = await settle();
    let took = Date.now() - started;
    check('a typed question is answered', !!answer && !answer.failed && answer.text.length > 40, answer?.text.slice(0, 120));
    check('from the page', /light|lamp|lens|ship|coast|tower/i.test(answer?.text || ''), answer?.text.slice(0, 80));
    check('as plain text, with no markdown asterisks or hashes',
      !/\*\*|^#+\s/m.test(answer?.text || ''), (answer?.text || '').slice(0, 160));
    check('in reasonable time', took < 25000, (took / 1000).toFixed(1) + 's');
    console.log('  typed ask took: ' + (took / 1000).toFixed(1) + 's');
    await shoot(side, 'aiflow-answer.png');

    const explained = await side.executeJavaScript(`window.browser.invoke('ai:explain-selection', {
      text: 'The Fresnel lens allowed lighthouse beams to be seen far further out to sea.'
    }).then((r) => r, (e) => ({ error: e.message }))`);
    check('Explain answers in plain text', !!explained?.text && !/\*\*/.test(explained.text),
      explained?.text?.slice(0, 140) || explained?.error);

    // ---- each kind of failure, in words a person can act on -----------------
    const failWith = async (label, reply, pattern) => {
      gemini._testing.reset();
      gemini._testing.useTransport(async () => (typeof reply === 'function' ? reply() : reply));
      const before = Date.now();
      await type('How tall is the tallest one?');
      const result = await settle(40);
      check(`${label}: shown as a failure card`, !!result?.failed && result.retry, JSON.stringify(result));
      check(`${label}: says what happened`, pattern.test(result?.text || '')
        && !/invoking remote|Error:|invalid argument|status|429|503|400/i.test(result?.text || ''), result?.text);
      check(`${label}: promptly`, Date.now() - before < 12000, ((Date.now() - before) / 1000).toFixed(1) + 's');
      // Clear it away so the next one starts clean.
      await side.executeJavaScript(`document.getElementById('new-chat').click()`);
      await wait(150);
    };
    await failWith('key refused', { status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.',
      details: [{ reason: 'API_KEY_INVALID' }] } } }, /key/i);
    await failWith('allowance used up', { status: 429, json: { error: { message: 'You exceeded your current quota, please check your plan and billing details.',
      details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } }, /allowance/i);
    await failWith('no connection', () => Promise.reject(Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { kind: 'network' })), /internet connection/i);
    await failWith('wrong region', { status: 400, json: { error: { message: 'User location is not supported for the API use.' } } }, /country or region/i);
    await failWith('a request every model refuses', { status: 400, json: { error: { message: 'Request contains an invalid argument.' } } }, /couldn.t take that request/i);

    // The failure card, looked at once more for the record.
    gemini._testing.useTransport(async () => ({ status: 503, json: { error: { message: 'high demand' } } }));
    await type('And the oldest?');
    await settle(40);
    await wait(400);
    await shoot(side, 'aiflow-failure.png');
    gemini._testing.useTransport(null);
    gemini._testing.reset();

    // The network is back; Try again is clicked.
    started = Date.now();
    const retry = await click('.side-turn.is-failed .side-retry');
    check('Try again is there and can be pressed', !!retry && !retry.disabled, JSON.stringify(retry));
    answer = await settle();
    check('trying again answers', !!answer && !answer.failed && answer.text.length > 10, answer?.text?.slice(0, 120));
    console.log('  retry took: ' + ((Date.now() - started) / 1000).toFixed(1) + 's');

    // ---- a question on one of our own pages is answered without it --------
    browser.tabs.navigate(browser.tabs.activeId, 'browser://settings');
    for (let i = 0; i < 40 && page().isLoading(); i++) await wait(150);
    await wait(800);
    await side.executeJavaScript(`document.getElementById('new-chat').click()`);
    await type('What is 12 times 12? Just the number.');
    answer = await settle();
    check('on a browser page, a plain question is still answered', /144/.test(answer?.text || ''), answer?.text);
    check('and says it was answered without the page', /without the page/.test(answer?.meta || ''), answer?.meta);

    check('no sidebar errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall AI flow checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
