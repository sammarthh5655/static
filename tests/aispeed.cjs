const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The assistant must ANSWER, and quickly - asking, asking about the page,
 * summarising and explaining - and when Gemini itself cannot answer, the
 * person must be told so in words, with a way to try again.
 *
 * Makes real Gemini calls: the failure worth catching is an answer that is
 * empty, an id Google has retired, or a request shape a model now refuses -
 * the "Request contains an invalid argument" that broke the sidebar was a
 * thinking setting the lite models reject, which no mock would have shown.
 * The one place the network is faked is the failure card, because Gemini
 * cannot be made to fail on demand.
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
    let img = null;
    for (let i = 0; i < 4 && (!img || img.isEmpty()); i++) {
      img = await wc.capturePage().catch(() => null);
      if (!img || img.isEmpty()) await wait(600);
    }
    if (img && !img.isEmpty()) {
      fs.writeFileSync(path.join(shotsDir, name), img.toPNG());
      console.log('  shot: shots/' + name);
    }
  };

  try {
    // Off-screen and unfocusable under a probe (see ensureWindow).
    browser.window.showInactive();
    await wait(1400);
    if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });

    // ---- every model in the chain still exists and takes a quick request --
    // A retired id or a refused setting here is exactly the rot that broke
    // the assistant last time. Busy or out of quota is weather, not a bug.
    for (const model of [gemini.DEFAULT_MODEL, ...gemini.FALLBACK_MODELS]) {
      const started = Date.now();
      const result = await gemini.generate({
        prompt: 'Reply with the single word: ready', model, thinking: 0,
        maxOutputTokens: 64, retries: 0, deadline: 20000,
      }).then((r) => ({ ok: true, text: r.text }), (e) => ({ ok: false, kind: e.kind, detail: e.detail || e.message }));
      const fine = result.ok || result.kind === 'busy' || result.kind === 'quota' || result.kind === 'timeout';
      check(`chain model ${model} answers a no-thinking request`, fine,
        (result.ok ? result.text : result.kind + ': ' + result.detail) + ` (${Date.now() - started}ms)`);
    }

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

    const lastAnswer = () => side.executeJavaScript(`(function(){
      var turns = document.querySelectorAll('.side-turn.is-ai');
      var last = turns[turns.length - 1];
      if (!last) return null;
      return {
        text: (last.querySelector('.side-text')||last).textContent || '',
        meta: (last.querySelector('.side-meta')||{}).textContent || '',
        working: last.classList.contains('is-working'),
        failed: last.classList.contains('is-failed'),
        retry: !!last.querySelector('.side-retry'),
        questions: document.querySelectorAll('.side-turn.is-you').length,
      };
    })()`).catch(() => null);
    const settle = async (limit = 60) => {
      let answer = null;
      for (let i = 0; i < limit; i++) {
        await wait(700);
        answer = await lastAnswer();
        if (answer && !answer.working) break;
      }
      return answer;
    };
    const askInSidebar = (question) => side.executeJavaScript(`(function(){
      var input = document.getElementById('input');
      input.value = ${JSON.stringify(question)};
      document.getElementById('compose')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);
    const click = async (selector) => {
      const at = await side.executeJavaScript(`(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: el.disabled };
      })()`);
      if (!at) return null;
      side.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      side.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      return at;
    };

    // The sidebar opens with the browser, on the welcome page, so the line
    // has followed a navigation to get here. It used to stay on "This is a
    // file on your computer" - the welcome page's file on disk.
    const strip = await side.executeJavaScript(`(async () => ({
      text: document.getElementById('perm-text').textContent,
      main: await window.browser.invoke('ai:page-permission'),
    }))()`);
    check('the permission line describes this page, not the one before',
      strip.main.level === 'ordinary' && !/file on your computer|browser page/i.test(strip.text),
      strip.text + ' / ' + strip.main.level);

    // ---- 1. ask about the page --------------------------------------------
    let started = Date.now();
    await askInSidebar('In one sentence, what is this page about?');
    let answer = await settle();
    let took = Date.now() - started;
    check('an answer came back', !!(answer && answer.text && !answer.failed), JSON.stringify(answer));
    if (answer) {
      check('the answer is not empty or undefined',
        answer.text.length > 20 && !/undefined/i.test(answer.text), answer.text.slice(0, 120));
      check('it is about the page, not a generic reply',
        /electron|framework|chromium|node|desktop/i.test(answer.text), answer.text.slice(0, 120));
      check('it says the page was used',
        !/answered without the page/.test(answer.meta), 'meta: ' + answer.meta);
    }
    check('it answered in reasonable time', took < 25000, Math.round(took / 1000) + 's');
    console.log('  ask-page took: ' + (took / 1000).toFixed(1) + 's');

    // ---- 2. a follow-up uses the conversation -------------------------------
    started = Date.now();
    await askInSidebar('Who originally developed it? Just the name.');
    answer = await settle();
    took = Date.now() - started;
    check('a follow-up is answered from the conversation',
      !!answer && !answer.failed && /github/i.test(answer.text), answer?.text.slice(0, 120));
    console.log('  follow-up took: ' + (took / 1000).toFixed(1) + 's');

    // ---- 3. summarise with a real click -------------------------------------
    started = Date.now();
    const pressed = await click('.side-action');
    check('the Summarise button is there to press', !!pressed && !pressed.disabled);
    answer = await settle(100);
    took = Date.now() - started;
    check('Summarise answers', !!answer && !answer.failed && answer.text.length > 40, answer?.text.slice(0, 120));
    check('the summary is of this page', /electron/i.test(answer?.text || ''), answer?.text.slice(0, 80));
    check('it summarised in reasonable time', took < 60000, Math.round(took / 1000) + 's');
    console.log('  summarise took: ' + (took / 1000).toFixed(1) + 's');

    // ---- 4. explain and translate a selection -------------------------------
    started = Date.now();
    const explained = await side.executeJavaScript(`window.browser.invoke('ai:explain-selection', {
      text: 'A race condition occurs when the behaviour of software depends on the relative timing of events.'
    }).then((r) => r, (e) => ({ error: e.message }))`);
    took = Date.now() - started;
    check('Explain answers', !!explained?.text && explained.text.length > 30, explained?.text?.slice(0, 120) || explained?.error);
    check('Explain is quick', took < 25000, (took / 1000).toFixed(1) + 's');
    console.log('  explain took: ' + (took / 1000).toFixed(1) + 's');

    const translated = await side.executeJavaScript(`window.browser.invoke('ai:explain-selection', {
      text: 'Good morning, how are you?', mode: 'translate', language: 'French'
    }).then((r) => r, (e) => ({ error: e.message }))`);
    check('Translate answers in French', /bonjour/i.test(translated?.text || ''), translated?.text || translated?.error);

    // ---- 5. a plain question with no page -----------------------------------
    started = Date.now();
    const plain = await side.executeJavaScript(`window.browser.invoke('ai:ask', {
      prompt: 'What is the capital of France? One word.'
    }).then((r) => r, (e) => ({ error: e.message }))`);
    took = Date.now() - started;
    check('a plain question is answered', /paris/i.test(plain?.text || ''), plain?.text || plain?.error);
    console.log('  ask took: ' + (took / 1000).toFixed(1) + 's');

    await shoot(side, 'ai-answers.png');

    // ---- 6. when Gemini cannot answer, the person is told so ----------------
    gemini._testing.useTransport(async () => ({
      status: 503, json: { error: { message: 'This model is currently experiencing high demand.' } },
    }));
    const questionsBefore = (await lastAnswer())?.questions || 0;
    started = Date.now();
    await askInSidebar('What year was it first released?');
    answer = await settle();
    took = Date.now() - started;
    check('a failure is shown as a failure, not as an answer', !!answer?.failed, JSON.stringify(answer));
    check('it is written for a person', !!answer && /busy/i.test(answer.text)
      && !/invoking remote method|invalid argument|Error:/i.test(answer.text), answer?.text);
    check('it offers to try again', !!answer?.retry);
    check('and says so promptly', took < 12000, (took / 1000).toFixed(1) + 's');
    await wait(500);
    await shoot(side, 'ai-failure.png');

    // The network recovers; "Try again" is pressed like a person would.
    gemini._testing.useTransport(null);
    gemini._testing.reset();
    started = Date.now();
    const retried = await click('.side-turn.is-failed .side-retry');
    check('Try again can be pressed', !!retried && !retried.disabled, JSON.stringify(retried));
    answer = await settle();
    took = Date.now() - started;
    check('the retry answers', !!answer && !answer.failed && /20\d\d/.test(answer.text), answer?.text.slice(0, 120));
    check('the failed attempt is replaced, not repeated',
      answer?.questions === questionsBefore + 1, `${questionsBefore} -> ${answer?.questions}`);
    console.log('  retry took: ' + (took / 1000).toFixed(1) + 's');

    check('no sidebar errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall AI checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
