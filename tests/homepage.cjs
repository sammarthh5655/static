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
    const { THEMES, DEFAULT_THEME } = require('../src/shared/theme');
    const expectedAccent = THEMES[browser.settings.value.theme || DEFAULT_THEME].tokens.accent;
    check('the chosen planet is applied', page.accent === expectedAccent,
      page.accent + ' (expected ' + expectedAccent + ')');

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
    // Start the counters from nothing first: the probe profile persists, and
    // lifetime figures left by an earlier run made a correct card read 14.
    browser.shields.stats.reset();
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
        // Both lifetime figures, in order: ads then trackers.
        figures: [...document.querySelectorAll('.privacy-figure')].map(function(f){
          return {
            value: f.querySelector('.privacy-count').textContent,
            label: f.querySelector('.privacy-count-label').textContent,
          };
        }),
        stats: stats,
        estimateLabelled: !!document.querySelector('.privacy-estimate'),
        bars: document.querySelectorAll('.spark-bar').length,
      };
    })()`);
    // Lifetime ads and trackers as two separate figures, each labelled. One
    // combined number with no period stated is what made the homepage, the
    // shield card and the dashboard look like they disagreed.
    check('privacy widget shows lifetime ads and trackers separately',
      live.figures.length === 2 &&
      live.figures[0].value === '7' && /ads/i.test(live.figures[0].label) &&
      live.figures[1].value === '5' && /trackers/i.test(live.figures[1].label),
      JSON.stringify(live.figures));
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

    // ---- scratchpad and reading queue -------------------------------------
    // Both are backed by the REAL Notes feature and Organizer sessions, so a
    // note added anywhere shows up here and one added here is a real note.
    // Start from a clean store: leftovers from an earlier run otherwise look
    // exactly like duplicates.
    for (const note of browser.notes.list({ limit: 500 })) browser.notes.remove(note.id);
    browser.settings.update({ newTab: {
      widgets: ['clock', 'privacy', 'notes', 'reading', 'shortcuts'] } });
    wc.reload();
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(1800);

    const blank = await wc.executeJavaScript(`({
      scratch: (document.querySelector('.widget-scratch .widget-empty')||{}).textContent || '',
      reading: (document.querySelector('.widget-reading .widget-empty')||{}).textContent || '',
    })`);
    check('scratchpad shows an empty state', /nothing saved/i.test(blank.scratch), blank.scratch);
    check('reading queue shows an empty state', /no saved pages/i.test(blank.reading), blank.reading);

    // Adding through the FEATURE must reach the widget, which is what the
    // notes:changed subscription is for.
    browser.notes.add({ kind: 'text', body: 'A real text note' });
    browser.notes.add({ kind: 'link', url: 'https://example.com/a', title: 'A saved article' });
    await wait(1600);
    const filled = await wc.executeJavaScript(`({
      scratch: [...document.querySelectorAll('.scratch-text')].map(n => n.textContent),
      reading: [...document.querySelectorAll('.reading-title')].map(n => n.textContent),
      host: (document.querySelector('.reading-sub')||{}).textContent || '',
    })`);
    check('scratchpad follows notes:changed',
      filled.scratch.includes('A real text note'), JSON.stringify(filled.scratch));
    check('reading queue shows saved links',
      filled.reading.includes('A saved article'), JSON.stringify(filled.reading));
    check('reading queue shows the source host', filled.host === 'example.com', filled.host);
    // A saved LINK belongs in the reading queue only. Showing it in both made
    // one saved article appear twice on the same page.
    check('a link is not also listed in the scratchpad',
      !filled.scratch.includes('A saved article'), JSON.stringify(filled.scratch));

    // Typing in the widget must create a real note, not widget-local state.
    await wc.executeJavaScript(`(async () => {
      const input = document.querySelector('.scratch-input');
      input.value = 'typed into the widget';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 900));
      return true;
    })()`, true);
    await wait(900);
    const bodies = browser.notes.list({ limit: 50 }).map((n) => n.title || n.body);
    check('typing in the scratchpad creates a real note',
      bodies.includes('typed into the widget'), bodies.slice(0, 4).join(' | '));

    // ---- customise mode ---------------------------------------------------
    // The Customise studio edits which widgets are on and where they sit.
    // Where is stored as fractions of the free space (see widgets/float.js),
    // never pixels, so a layout survives a resize or another display. Free
    // resizing is deliberately not offered for the same reason. The studio's
    // wallpaper half and dragging by the grip are covered by tests/studio.cjs;
    // this covers the layout half.
    browser.settings.update({ newTab: { widgets: ['clock', 'privacy', 'reading'], positions: {} } });
    wc.reload();
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(1600);

    // Drag a card by its body - not its grip, and nothing clickable on it -
    // a little way towards the middle of the page. Synthetic pointer events,
    // so nothing depends on the probe window having focus.
    const dragBody = (id) => wc.executeJavaScript(`(async () => {
      const card = document.querySelector('[data-widget="${id}"]');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      let at = null;
      for (let y = r.top + 6; y < r.bottom - 4 && !at; y += 6) {
        for (let x = r.left + 6; x < r.right - 4 && !at; x += 6) {
          const hit = document.elementFromPoint(x, y);
          if (hit && hit.closest('[data-widget]') === card &&
              !hit.closest('input, textarea, select, a, button, [contenteditable="true"], .widget-grip')) at = { x, y, hit };
        }
      }
      if (!at) return null;
      const before = { left: card.offsetLeft, top: card.offsetTop };
      const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true });
      const dx = Math.sign(innerWidth / 2 - (r.left + r.width / 2)) * 120, dy = 60;
      at.hit.dispatchEvent(new PointerEvent('pointerdown', opts(at.x, at.y)));
      for (let i = 1; i <= 8; i++) {
        card.dispatchEvent(new PointerEvent('pointermove', opts(at.x + dx * i / 8, at.y + dy * i / 8)));
        await new Promise((r) => setTimeout(r, 16));
      }
      card.dispatchEvent(new PointerEvent('pointerup', opts(at.x + dx, at.y + dy)));
      return { before, after: { left: card.offsetLeft, top: card.offsetTop } };
    })()`);

    const off = await wc.executeJavaScript(`({
      hidden: document.getElementById('customise-bar').hidden,
      mode: document.body.classList.contains('customising'),
    })`);
    check('customise controls are hidden until asked for',
      off.hidden === true && off.mode === false, JSON.stringify(off));
    // Outside customise mode only the grip moves a card, so selecting text or
    // typing in a widget can never drag it about by accident.
    const still = await dragBody('privacy');
    await wait(600);
    check('outside customise mode a card does not move by its body',
      !!still && still.after.left === still.before.left && still.after.top === still.before.top &&
      !browser.settings.value.newTab.positions?.privacy,
      JSON.stringify({ still, saved: browser.settings.value.newTab.positions }));

    await wc.executeJavaScript("document.getElementById('customise-open').click()");
    await wait(800);
    await wc.executeJavaScript("document.querySelector('.studio-tab[data-pane=\"widgets\"]')?.click()");
    await wait(300);
    const on = await wc.executeJavaScript(`({
      hidden: document.getElementById('customise-bar').hidden,
      mode: document.body.classList.contains('customising'),
      switches: document.querySelectorAll('.studio-widget[role=switch]').length,
      switchesOn: [...document.querySelectorAll('.studio-widget[aria-checked=true]')]
        .map(n => n.querySelector('strong').textContent),
    })`);
    check('customise mode opens', on.hidden === false && on.mode === true, JSON.stringify(on));
    // One switch per registered widget. Zero here meant shared/widgets.js was
    // never loaded on the page - the registry was empty and Reset silently
    // fell back to a stub layout - or that the list waited on something else.
    check('a switch per registered widget',
      on.switches === Object.keys(require('../src/shared/widgets').WIDGETS).length,
      on.switches + ' switches');
    check('the switches show which widgets are on',
      on.switchesOn.length === 3, on.switchesOn.join(', '));

    // While customising, the whole card is the handle, and where it is put
    // is saved through settings rather than just moving the DOM.
    const dragged = await dragBody('privacy');
    await wait(900);
    const spot = browser.settings.value.newTab.positions?.privacy;
    check('while customising, dragging a card saves where it was put',
      !!spot && spot.x >= 0 && spot.x <= 1 && spot.y >= 0 && spot.y <= 1,
      JSON.stringify({ dragged, spot }));

    await wc.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.studio-widget')]
        .find((n) => n.querySelector('strong')?.textContent === 'Recently closed');
      if (row) row.click();
    })()`);
    await wait(1100);
    check('a switch adds a widget to the saved layout',
      browser.settings.value.newTab.widgets.includes('recent'),
      JSON.stringify(browser.settings.value.newTab.widgets));

    await wc.executeJavaScript("document.querySelector('.studio-tab[data-pane=\"layouts\"]')?.click()");
    await wait(300);
    await wc.executeJavaScript("document.querySelector('.studio-preset[data-preset=\"minimal\"]')?.click()");
    await wait(1100);
    check('a preset replaces the layout',
      JSON.stringify(browser.settings.value.newTab.widgets) === '["clock"]',
      JSON.stringify(browser.settings.value.newTab.widgets));
    // A preset is a fresh arrangement, so it puts every widget back too.
    check('and clears where cards had been dragged',
      Object.keys(browser.settings.value.newTab.positions || {}).length === 0,
      JSON.stringify(browser.settings.value.newTab.positions));

    await wc.executeJavaScript(`(() => {
      const reset = [...document.querySelectorAll('.studio-action')]
        .find((n) => /default layout/i.test(n.textContent));
      if (reset) reset.click();
    })()`);
    await wait(1100);
    const defaults = require('../src/shared/widgets').DEFAULT_LAYOUT;
    check('reset restores the real default layout',
      JSON.stringify(browser.settings.value.newTab.widgets) === JSON.stringify(defaults),
      JSON.stringify(browser.settings.value.newTab.widgets));

    await wc.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await wait(700);
    const closed = await wc.executeJavaScript(`({
      hidden: document.getElementById('customise-bar').hidden,
      mode: document.body.classList.contains('customising'),
    })`);
    check('Escape leaves customise mode',
      closed.hidden === true && closed.mode === false, JSON.stringify(closed));



    // ---- clock format, engine selector, status strip ---------------------

    const clock = await wc.executeJavaScript(`({
      toggle: !!document.querySelector('.clock-toggle'),
      time: document.querySelector('.clock-time')?.textContent || '',
      size: parseFloat(getComputedStyle(document.querySelector('.clock-time')).fontSize),
    })`);
    check('the time is the 12/24 hour control', clock.toggle === true);
    check('the clock is large enough to read at a glance', clock.size >= 40, clock.size + 'px');

    // Cycle the format and confirm it is SAVED, not just redrawn.
    await wc.executeJavaScript(`document.querySelector('.clock-toggle').click(), true`);
    await wait(500);
    const after12 = browser.settings.value.newTab.clockFormat;
    check('clicking the time saves a clock format', ['12', '24', 'system'].includes(after12), after12);

    const shown = await wc.executeJavaScript(
      `document.querySelector('.clock-time').textContent`);
    if (after12 === '12') {
      check('12 hour format really shows an am/pm marker', /[ap]\.?m/i.test(shown), shown);
    } else if (after12 === '24') {
      check('24 hour format shows no am/pm marker', !/[ap]\.?m/i.test(shown), shown);
    } else {
      check('clock still renders a time', /\d/.test(shown), shown);
    }

    const engine = await wc.executeJavaScript(`({
      present: !!document.getElementById('search-engine'),
      value: document.getElementById('search-engine')?.value || '',
      options: [...(document.getElementById('search-engine')?.options || [])].map(o => o.value),
    })`);
    check('the search box carries an engine selector', engine.present === true);
    check('the selector shows the engine actually in use',
      engine.value === browser.settings.value.searchEngine,
      JSON.stringify({ shown: engine.value, saved: browser.settings.value.searchEngine }));
    check('every configured engine is offered',
      engine.options.includes('google') && engine.options.includes('brave'),
      JSON.stringify(engine.options));

    // Change it and confirm it reaches settings.
    await wc.executeJavaScript(
      `const s = document.getElementById('search-engine'); s.value = 'brave';` +
      ` s.dispatchEvent(new Event('change')), true`);
    await wait(500);
    check('changing the engine is saved', browser.settings.value.searchEngine === 'brave',
      browser.settings.value.searchEngine);

    const strip = await wc.executeJavaScript(`({
      hidden: document.getElementById('status-strip').hidden,
      items: [...document.querySelectorAll('.status-item')].map(n => n.textContent),
    })`);
    // The strip is allowed to be empty on a bare profile; what it must never
    // do is show a zero as though it were a measurement.
    check('the status strip states only measured figures, never zeros',
      strip.items.every(text => !/^0/.test(text)), JSON.stringify(strip.items));
    check('a hidden strip is genuinely empty',
      strip.hidden === false || strip.items.length === 0, JSON.stringify(strip));

    // Nothing in the strip may overlap the search text.
    const overlap = await wc.executeJavaScript(`(() => {
      const input = document.getElementById('query');
      const select = document.getElementById('search-engine');
      if (!input || !select) return { ok: false, reason: 'missing' };
      const i = input.getBoundingClientRect(), s = select.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(input).paddingRight);
      return { ok: (i.right - padding) <= s.left + 1, padding, inputRight: i.right, selectLeft: s.left };
    })()`);
    check('search text cannot run under the engine selector', overlap.ok === true,
      JSON.stringify(overlap));

    // The strip is position:fixed, so it legitimately floats over content that
    // scrolls beneath it. What must hold is that it is pinned to the viewport
    // bottom, and that the page reserves enough room to scroll the last
    // element clear of it rather than leaving it permanently covered.
    const cover = await wc.executeJavaScript(`(() => {
      const strip = document.getElementById('status-strip');
      if (!strip || strip.hidden) return { ok: true, reason: 'strip hidden' };
      const s = strip.getBoundingClientRect();
      const pinned = Math.abs(s.bottom - window.innerHeight) <= 1;
      const stage = document.querySelector('.stage');
      const reserved = parseFloat(getComputedStyle(stage).paddingBottom);
      return { ok: pinned && reserved >= s.height, pinned, reserved, stripHeight: s.height };
    })()`);
    check('the status strip is pinned to the viewport and leaves room to scroll past',
      cover.ok === true, JSON.stringify(cover));

    // The homepage must FIT. It used to overflow as soon as more than three
    // widgets were on, which meant scrolling to reach your own widgets.
    browser.settings.update({ newTab: {
      widgets: ['clock', 'privacy', 'shortcuts', 'reading', 'notes', 'recent'],
      widgetSize: 'compact',
    } });
    browser.push();
    await wait(1200);

    const fit = await wc.executeJavaScript(`({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      widgets: document.querySelectorAll('.widget').length,
      customise: (function(){
        var b = document.getElementById('customise-open');
        if (!b) return null;
        var r = b.getBoundingClientRect();
        return { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom,
                 fixed: getComputedStyle(b).position };
      })(),
    })`);
    check('six widgets still fit without scrolling',
      fit.scrollH <= fit.clientH + 4,
      fit.widgets + ' widgets, ' + fit.scrollH + 'px content in ' + fit.clientH + 'px');
    check('the customise button is pinned bottom-right',
      fit.customise && fit.customise.fixed === 'fixed' &&
      fit.customise.right < 40 && fit.customise.bottom < 40,
      JSON.stringify(fit.customise));

    // And widget size really changes the layout.
    browser.settings.update({ newTab: { widgetSize: 'large' } });
    browser.push();
    await wait(900);
    const large = await wc.executeJavaScript(
      `getComputedStyle(document.body).getPropertyValue('--widget-min').trim()`);
    check('widget size is adjustable', large === '300px', '--widget-min = ' + large);

    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll homepage checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Homepage test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
