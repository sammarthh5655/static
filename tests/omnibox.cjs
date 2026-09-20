const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Typing in the address bar must offer suggestions. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 160) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1500);

    // Real history and bookmarks to suggest from.
    // record(url, title) - positional, not an object.
    browser.history.record('https://github.com/explore', 'Explore GitHub');
    browser.history.record('https://news.ycombinator.com/', 'Hacker News');
    try { browser.bookmarks.toggle({ url: 'https://example.com/docs', title: 'Example docs' }); }
    catch { /* bookmarks are not the subject here */ }
    await wait(500);

    // The engine itself.
    const direct = browser.history.suggest('git', browser.bookmarks.list());
    check('the suggestion engine returns matches', direct.length > 0,
      direct.length + ' for "git"');

    const chrome = browser.chrome.webContents;
    const errors = [];
    chrome.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });

    // Type the way a person does: focus, set value, fire input.
    const typed = await chrome.executeJavaScript(`(function(){
      var a = document.getElementById('address');
      if (!a) return { ok: false, why: 'no address bar' };
      a.focus();
      a.value = 'git';
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    })()`);
    check('the address bar exists', typed.ok === true, typed.why);
    await wait(1200);

    const shown = await chrome.executeJavaScript(`(function(){
      var box = document.getElementById('suggestions');
      return {
        exists: !!box,
        hidden: box ? box.hidden : null,
        display: box ? getComputedStyle(box).display : null,
        items: document.querySelectorAll('#suggestions .suggestion').length,
        text: [...document.querySelectorAll('#suggestions .suggestion')]
          .map(function(n){ return n.textContent.slice(0, 40); }),
      };
    })()`);
    console.log('  [diag]', JSON.stringify(shown));

    check('the suggestion list exists', shown.exists === true);
    check('it is visible while typing', shown.hidden === false && shown.display !== 'none',
      'hidden=' + shown.hidden + ' display=' + shown.display);
    check('suggestions are shown', shown.items > 0, shown.items + ' items');
    check('the first is a web search for what was typed',
      shown.items > 0 && /git/.test(shown.text[0] || ''), shown.text[0]);
    check('history is offered too', shown.items > 1, JSON.stringify(shown.text));

    // The list lives INSIDE the chrome view, so the view must be tall enough
    // to show it. At the resting height it was clipped to a few pixels, which
    // is what "suggestions don't come" actually looked like.
    const geometry = await chrome.executeJavaScript(`(function(){
      var box = document.getElementById('suggestions');
      var r = box.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom),
               height: Math.round(r.height), viewport: window.innerHeight };
    })()`);
    console.log('  [diag] geometry', JSON.stringify(geometry));
    check('the dropdown has real height', geometry.height > 40,
      geometry.height + 'px tall');
    check('and is not clipped by the chrome view',
      geometry.bottom <= geometry.viewport + 1,
      'list ends at ' + geometry.bottom + ', view is ' + geometry.viewport);

    // Closing it must give the space back to the page.
    await chrome.executeJavaScript(`(function(){
      var a = document.getElementById('address');
      a.value = '';
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await wait(800);
    check('the chrome shrinks again when the list closes',
      browser.suggestionsOpen === false);

    check('no chrome errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall omnibox checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
