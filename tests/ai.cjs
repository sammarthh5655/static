const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * AI checks. Run with `npm run test:ai`.
 *
 * This makes a REAL Gemini call rather than mocking it - the failure worth
 * catching is a broken key, a retired model id, or an overload path that
 * surfaces an error to the user instead of retrying.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => { console.log((ok?'  ok  ':'FAIL  ')+n+(d?' :: '+d:'')); if(!ok) fails++; };
  browser.window.show();
  await wait(1800);
  const wc = browser.tabs.active.view.webContents;
  const errs = [];
  wc.on('console-message', (e) => { if (e?.level==='error'||e?.level===3) errs.push(e.message.slice(0,120)); });

  const st = await wc.executeJavaScript('(async()=>{const r=await window.browser.invoke("ai:status");return r})()');
  check('AI reports available', st?.available === true, JSON.stringify(st));

  // Tab must switch modes, not move focus.
  const mode = await wc.executeJavaScript(`(async () => {
    const q = document.getElementById('query');
    q.focus(); q.value = 'test';
    q.dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true, cancelable:true }));
    await new Promise(r=>setTimeout(r,200));
    return {
      aiMode: document.body.classList.contains('ai-mode'),
      badge: !document.getElementById('ai-badge').hidden,
      hint: document.getElementById('search-hint').textContent,
      stillFocused: document.activeElement === q,
    };
  })()`);
  check('Tab enters AI mode', mode.aiMode && mode.badge, JSON.stringify(mode.hint));
  check('Tab keeps focus in the field', mode.stillFocused);

  // Escape must return to search mode.
  const back = await wc.executeJavaScript(`(async () => {
    const q = document.getElementById('query');
    q.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,200));
    return document.body.classList.contains('ai-mode');
  })()`);
  check('Escape leaves AI mode', back === false);

  // A real Gemini answer must land in the panel.
  const answer = await wc.executeJavaScript(`(async () => {
    const q = document.getElementById('query');
    q.focus();
    q.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    q.value = 'What is the capital of France? One word.';
    // requestSubmit fires the real submit path; dispatching a bare Event can
    // bypass the form's own handling.
    document.getElementById('search').requestSubmit();
    for (let i=0;i<60;i++){
      await new Promise(r=>setTimeout(r,500));
      const t = document.getElementById('ai-answer').textContent;
      if (t && t !== 'Thinking\u2026') return { text: t.slice(0,160), panel: !document.getElementById('ai-panel').hidden };
    }
    return { text: 'TIMEOUT', panel:false };
  })()`, true);
  check('Gemini answer renders in panel', answer.panel && /paris/i.test(answer.text), JSON.stringify(answer.text));

  check('no console errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? '\n'+fails+' failed\n' : '\nAll AI checks passed.\n');
  app.exit(fails?1:0);
}
module.exports = { run };
