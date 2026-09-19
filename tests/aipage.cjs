const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * browser://ai checks. Run with `npm run test:aipage`.
 *
 * Makes REAL Gemini calls: the failures worth catching here are a broken
 * transcript, history that does not persist, and a conversation that forgets
 * its own earlier turns - none of which a mock would surface.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 110) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1200);
    // Navigate the existing tab rather than creating one: a freshly created
    // view is often not composited yet.
    browser.tabs.navigate(browser.tabs.activeId, 'browser://ai');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(900);

    const errors = [];
    wc.on('console-message', (event) => {
      if (event?.level === 'error' || event?.level === 3) errors.push(event.message.slice(0, 140));
    });

    const boot = await wc.executeJavaScript(`({
      sidebar: !!document.querySelector('.chat-sidebar'),
      composer: !!document.getElementById('input'),
      empty: !document.getElementById('empty').hidden,
      suggestions: document.querySelectorAll('.chat-suggestion').length,
      bridge: !!window.page,
    })`);
    check('page renders', boot.sidebar && boot.composer && boot.bridge && boot.suggestions > 0,
      JSON.stringify(boot));
    check('empty state on a fresh profile', boot.empty);

    // The question and a pending row must appear immediately on a NEW chat -
    // the empty state lingering here was a real bug.
    const pending = await wc.executeJavaScript(`(async () => {
      const input = document.getElementById('input');
      input.value = 'Reply with exactly: BANANA';
      document.getElementById('composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await new Promise(r => setTimeout(r, 250));
      return {
        question: !!document.querySelector('.turn.user'),
        pendingRow: !!document.querySelector('.turn.pending'),
        emptyHidden: document.getElementById('empty').hidden,
        titled: document.getElementById('chat-title').textContent !== 'New chat',
      };
    })()`, true);
    check('question shows immediately on a new chat', pending.question, JSON.stringify(pending));
    check('pending row shows while waiting', pending.pendingRow);
    check('empty state hides once asking', pending.emptyHidden);
    check('chat titles itself from the question', pending.titled);

    const answer = await wc.executeJavaScript(`(async () => {
      for (let n = 0; n < 80; n++) {
        await new Promise(r => setTimeout(r, 500));
        const done = [...document.querySelectorAll('.turn.model:not(.pending)')];
        if (done.length) return done[done.length - 1].querySelector('.turn-text').textContent;
        const error = document.querySelector('.turn.error');
        if (error) return 'ERR: ' + error.querySelector('.turn-text').textContent;
      }
      return 'TIMEOUT';
    })()`, true);
    check('Gemini answers', /banana/i.test(answer), answer);

    // Continuing the conversation must carry prior turns.
    const followup = await wc.executeJavaScript(`(async () => {
      const input = document.getElementById('input');
      input.value = 'What word did you just reply with?';
      document.getElementById('composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      for (let n = 0; n < 80; n++) {
        await new Promise(r => setTimeout(r, 500));
        const done = [...document.querySelectorAll('.turn.model:not(.pending)')];
        if (done.length >= 2) return done[done.length - 1].querySelector('.turn-text').textContent;
        const error = document.querySelector('.turn.error');
        if (error) return 'ERR: ' + error.querySelector('.turn-text').textContent;
      }
      return 'TIMEOUT';
    })()`, true);
    check('remembers earlier turns', /banana/i.test(followup), followup);

    const stored = browser.chats.list();
    check('conversation persisted in main', stored.length >= 1 && stored[0].turns >= 4,
      stored[0] ? stored[0].turns + ' turns' : 'none');
    check('sidebar lists the chat',
      await wc.executeJavaScript('document.querySelectorAll(".chat-item").length >= 1'));

    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll AI page checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('AI page test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
