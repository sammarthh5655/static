const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * New tab page checks. Run with `npm run test:homepage`.
 *
 * The assertions that matter are the ones about restraint: exactly five
 * actions, no panel overlaying the page, and a widget layout the user chose
 * rather than one the page hardcodes. Those are easy to erode one addition at
 * a time, which is how a calm homepage turns back into a dashboard.
 *
 * The privacy widget has its own rule: every number on it must come from the
 * real blocking counters, and with no data it must say so rather than show
 * zeros. A privacy screen with invented numbers is worse than none.
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
    // The fixed three-card utility row is gone: it was hardcoded markup that
    // made the widget registry inert. Widgets render from the user's chosen
    // layout instead, and are asserted further down.
    check('no hardcoded utility row remains', page.utilCards === 0, page.utilCards + ' left');
    check('hint explains both keys', /Enter/.test(page.hint) && /Tab/.test(page.hint), page.hint);
    check('no panel on the homepage', page.toolsAbsent === true);
    // Read the expected accent from the theme registry rather than repeating
    // the hex here. A hardcoded value went stale when the palette was retuned,
    // and the suite then reported a failure against correct behaviour.
    const eclipseAccent = require('../src/shared/theme').THEMES.eclipse.tokens.accent;
    check('eclipse theme applied', page.accent === eclipseAccent,
      page.accent + ' (expected ' + eclipseAccent + ')');

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

    // ---- widgets ---------------------------------------------------------
    // The widget registry and its renderers existed but nothing called them:
    // the page drew a fixed row of cards, so declaring a widget had no effect
    // and the layout stored in settings was inert. These cover the render path.
    const widgets = await wc.executeJavaScript(`(function(){
      return {
        count: document.querySelectorAll('.widget').length,
        hasClock: !!document.querySelector('.widget-clock'),
        hasPrivacy: !!document.querySelector('.widget-privacy'),
      };
    })()`);
    check('widgets render from the registry', widgets.count >= 2, widgets.count + ' widgets');
    check('clock widget present', widgets.hasClock === true);
    check('privacy widget present', widgets.hasPrivacy === true);

    // The privacy card must reflect the REAL counters. Seed a known value and
    // assert the card shows that number - not a placeholder, and not zeros.
    browser.shields.stats.record('ads', 7);
    browser.shields.stats.record('trackers', 5);
    await wait(5600);   // the widget re-reads on a 5s timer
    const live = await wc.executeJavaScript(`(function(){
      var count = document.querySelector('.privacy-count');
      var stats = {};
      document.querySelectorAll('.privacy-stat').forEach(function(row){
        stats[row.querySelector('.privacy-stat-label').textContent] =
          row.querySelector('.privacy-stat-value').textContent;
      });
      return {
        headline: count ? count.textContent : null,
        stats: stats,
        estimateLabelled: !!document.querySelector('.privacy-estimate'),
        bars: document.querySelectorAll('.spark-bar').length,
      };
    })()`);
    check('privacy widget shows the real blocked total',
      live.headline === '12', 'showed ' + live.headline + ', expected 12');
    check('privacy widget splits ads and trackers',
      live.stats.Ads === '7' && live.stats.Trackers === '5', JSON.stringify(live.stats));
    // Bandwidth and time cannot be measured - a blocked request is cancelled
    // before any body arrives - so they must be visibly marked as estimates.
    check('derived figures are labelled as estimates', live.estimateLabelled === true);
    check('sparkline covers seven days', live.bars === 7, live.bars + ' bars');

    // The empty state is the assertion that matters most on this card: with no
    // data it must SAY so, not show zeros that read as a broken blocker.
    browser.shields.store.data.days = {};
    await wait(5600);
    const empty = await wc.executeJavaScript(`(function(){
      var e = document.querySelector('.widget-privacy .widget-empty');
      return { text: e ? e.textContent : null,
               headline: !!document.querySelector('.privacy-count') };
    })()`);
    check('privacy widget shows an empty state, not zeros',
      /no blocking activity/i.test(empty.text || ''), empty.text);
    check('empty state shows no headline number', empty.headline === false);

    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll homepage checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Homepage test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
