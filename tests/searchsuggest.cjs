const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Search suggestions, worked the way a person works them: real keystrokes
 * into the new tab's search box and the address bar, the arrows, Tab, Escape
 * and a real click on a row. The search engine is a stub installed on main's
 * fetcher, so nothing here ever reaches Google - and every request the stub
 * sees is recorded, which is how the privacy rules are checked: by what was
 * actually sent, not by what the page shows.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && d !== '' ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const until = async (predicate, tries = 60, every = 50) => {
    for (let i = 0; i < tries; i++) {
      if (await predicate().catch(() => false)) return true;
      await wait(every);
    }
    return false;
  };

  // ---- the real fetcher, against a local engine ----
  // net.fetch itself, with the options main passes, talking to a server on
  // this computer that answers the way Google's does: in ISO-8859-1. Proves
  // the cookies option, the charset handling and the abort all work in
  // Electron, not just in a stub.
  {
    const http = require('node:http');
    const { SUGGEST_URLS } = require('../src/shared/suggest');
    const seen = [];
    const server = http.createServer((req, res) => {
      const q = new URL(req.url, 'http://x').searchParams.get('q');
      seen.push({ q, cookie: req.headers.cookie || '' });
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=ISO-8859-1' });
        res.end(Buffer.from(JSON.stringify([q, [q + ' café', q + ' crème']]), 'latin1'));
      };
      if (q === 'slow') setTimeout(send, 3000); else send();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const realUrl = SUGGEST_URLS.google;
    SUGGEST_URLS.google = 'http://127.0.0.1:' + server.address().port + '/complete/search?client=chrome&q=';
    try {
      // A cookie the engine could recognise the person by, ready to be sent.
      const { session } = require('electron');
      await session.defaultSession.cookies.set({ url: 'http://127.0.0.1:' + server.address().port, name: 'NID', value: 'person' });
      const answer = await browser.searchSuggest.lookup('menu', 'probe-net');
      check('the real fetcher reads an ISO-8859-1 answer correctly',
        JSON.stringify(answer.searches) === JSON.stringify(['menu café', 'menu crème']), JSON.stringify(answer));
      // The control: the same request with cookies allowed does carry it, so
      // the check above means something.
      await require('electron').net.fetch(SUGGEST_URLS.google + 'control', { credentials: 'include' }).then((r) => r.text()).catch(() => '');
      check('and sends no cookies (while one sent with them would)',
        seen.length === 2 && !seen[0].cookie && /NID=person/.test(seen[1].cookie), JSON.stringify(seen));
      const started = Date.now();
      const slow = await browser.searchSuggest.lookup('slow', 'probe-net');
      check('a slow engine is given up on, and the list goes on without it',
        slow.searches.length === 0 && Date.now() - started < 2600, (Date.now() - started) + 'ms');
    } catch (error) {
      check('the real fetcher works', false, error.message);
    } finally {
      SUGGEST_URLS.google = realUrl;
      browser.searchSuggest.clear();
      await require('electron').session.defaultSession.cookies
        .remove('http://127.0.0.1:' + server.address().port, 'NID').catch(() => {});
      server.closeAllConnections?.();
      server.close();
    }
  }

  // ---- the stub engine ----
  const ANSWERS = {
    gal: ['galaxy s24 review', 'gal gadot', 'galway', 'galaxy watch'],
    gala: ['galaxy s24 review', 'galaxy watch', 'gala dinner ideas'],
    galax: ['galaxy s24 review', 'galaxy watch', 'galaxy buds'],
    weather: ['weather tomorrow', 'weather radar'],
    q: ['quiet places'], qu: ['quantum computing', 'queen songs'],
  };
  const sent = [];
  const aborted = [];
  let delay = 30;
  browser.searchSuggest.fetcher = (url, options) => new Promise((resolve, reject) => {
    const q = decodeURIComponent(url.split('q=')[1] || '');
    sent.push({ url, q, credentials: options?.credentials });
    const timer = setTimeout(() => resolve({
      ok: true,
      text: async () => JSON.stringify([q, ANSWERS[q] || [q + ' meaning'], [], [],
        { 'google:suggesttype': (ANSWERS[q] || [1]).map(() => 'QUERY') }]),
    }), delay);
    options?.signal?.addEventListener('abort', () => { clearTimeout(timer); aborted.push(q); reject(new Error('aborted')); });
  });
  const sentSince = (n) => sent.slice(n).map((s) => s.q);

  // Navigation is recorded rather than performed: a click on a suggestion
  // would otherwise load a real results page.
  const navigations = [];
  const realNavigate = browser.tabs.navigate.bind(browser.tabs);

  try {
    browser.window.setSize(1300, 900);
    browser.settings.update({ theme: 'neptune', animations: true, searchEngine: 'google', searchSuggestions: true,
      newTab: { background: 'plain' } });
    browser.history.record('https://github.com/explore', 'Explore GitHub');
    browser.history.record('https://www.google.com/search?q=galaxy+s23+battery', 'galaxy s23 battery - Google Search');
    browser.history.record('https://www.galwaytourism.ie/', 'Galway Tourism - things to do');
    // The probe profile persists between runs and toggle() flips, so only add.
    if (!browser.bookmarks.list().some((b) => b.url === 'https://galaxy.example.org/')) {
      browser.bookmarks.toggle('https://galaxy.example.org/', 'Galaxy Zoo');
    }
    browser.push();

    check('the setting exists and is on by default', browser.settings.value.searchSuggestions === true);

    const id = browser.tabs.create({ url: 'browser://newtab' });
    const wc = browser.tabs.tabs.get(id).view.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });
    await until(() => js(`!!window.suggest && !!document.querySelector('#query') && !!window.page`), 80, 100);
    await wait(900);
    // The probe window can never hold system focus; this makes the page act
    // as if its window were the focused one, which a person's is.
    try {
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) { console.log('  (focus emulation unavailable: ' + error.message + ')'); }

    const key = (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const type = async (text, gap = 45) => { for (const ch of text) { key(ch); await wait(gap); } };
    const clear = () => js(`(() => { const q = document.querySelector('#query'); q.focus(); q.value = '';
      q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const list = () => js(`(() => {
      const box = document.querySelector('#suggest');
      const rows = [...box.querySelectorAll('.suggest-row')];
      const glide = box.querySelector('.suggest-glide');
      return {
        open: !box.hidden,
        rows: rows.map((r) => r.querySelector('.suggest-title')?.textContent || ''),
        kinds: rows.map((r) => [...r.classList].filter((c) => c.startsWith('is-') && c !== 'is-new').join(' ')),
        marks: rows.map((r) => r.querySelector('.suggest-match')?.textContent || ''),
        tags: rows.map((r) => r.querySelector('.suggest-tag')?.textContent || ''),
        selected: rows.findIndex((r) => r.classList.contains('is-selected')),
        value: document.querySelector('#query').value,
        foot: box.querySelector('.suggest-source')?.textContent || '',
        keys: box.querySelector('.suggest-keys')?.textContent || '',
        expanded: document.querySelector('#query').getAttribute('aria-expanded'),
        active: document.querySelector('#query').getAttribute('aria-activedescendant'),
        glideOn: !!glide?.classList.contains('is-on'),
        glideY: glide ? new DOMMatrix(getComputedStyle(glide).transform).m42 : -1,
        rowY: rows.map((r) => r.offsetTop),
        overflow: (() => { const l = box.querySelector('.suggest-list'); return l ? l.scrollHeight - l.clientHeight : 0; })(),
      };
    })()`);
    const shot = async (name) => {
      await wait(380);
      const img = await wc.capturePage().catch(() => null);
      if (img) fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    };

    await clear();

    // ---- typing brings local rows at once and the engine's after a pause ----
    let before = sent.length;
    await type('gal');
    const early = await list();
    check('history and bookmarks show while typing, before the engine is asked',
      early.open && early.rows.some((r) => /Galway Tourism|Galaxy Zoo/.test(r)), JSON.stringify(early.rows));
    const arrived = await until(async () => (await list()).rows.includes('galaxy s24 review'));
    let view = await list();
    console.log('  [diag] rows', JSON.stringify(view.rows), JSON.stringify(view.kinds));
    check('the engine\'s suggestions arrive in the list', arrived, JSON.stringify(view.rows));
    check('only one request for three quick keystrokes (debounced)', sentSince(before).length === 1, JSON.stringify(sentSince(before)));
    check('it asked Google\'s suggest service for exactly what was typed',
      /^https:\/\/suggestqueries\.google\.com\/complete\/search\?client=chrome&q=gal$/.test(sent.at(-1)?.url || ''), sent.at(-1)?.url);
    check('without cookies', sent.at(-1)?.credentials === 'omit', sent.at(-1)?.credentials);
    check('the first row searches for what was typed', view.rows[0] === 'gal' && /Search Google/.test(view.tags[0]), view.tags[0]);
    check('the typed part is highlighted in every row', view.marks.every((m) => m.toLowerCase() === 'gal'), JSON.stringify(view.marks));
    check('a past search from history is offered as a search',
      view.rows.includes('galaxy s23 battery') && view.kinds[view.rows.indexOf('galaxy s23 battery')].includes('is-past'));
    check('a site starting with what was typed comes straight after it', view.kinds[1]?.includes('is-page'), view.kinds[1]);
    check('at most eight rows', view.rows.length <= 8, view.rows.length);
    check('the box says it is expanded, for screen readers', view.expanded === 'true');
    check('the footer names the engine', /Suggestions from Google/.test(view.foot), view.foot);
    await shot('suggest-newtab');

    // ---- one more letter narrows the list instead of emptying it ----
    key('a');
    await wait(25);
    view = await list();
    check('the last answer stays up, narrowed, while the next is on its way',
      view.open && view.rows.includes('galaxy s24 review') && !view.rows.includes('gal gadot') && !view.rows.includes('galway'),
      JSON.stringify(view.rows));
    await until(async () => (await list()).rows.includes('gala dinner ideas'));
    check('then the new answer replaces it', (await list()).rows.includes('gala dinner ideas'));

    // ---- the arrows choose, and preview the choice in the box ----
    key('Down');
    await wait(40);
    key('Down');
    await wait(260);
    view = await list();
    check('two Downs choose the second row', view.selected === 1, view.selected);
    check('the box shows the chosen row', view.value === (view.kinds[1].includes('is-page') ? view.value : view.rows[1]), view.value + ' vs ' + view.rows[1]);
    check('the highlight slides to the chosen row', view.glideOn && Math.abs(view.glideY - view.rowY[1]) < 1.5, view.glideY + ' vs ' + view.rowY[1]);
    check('the active row is announced', view.active === 'suggest-1', view.active);
    check('the footer explains Tab now', /Tab to fill in/.test(view.keys), view.keys);
    await shot('suggest-newtab-chosen');
    key('Up');
    key('Up');
    await wait(80);
    view = await list();
    check('Up past the first row brings back exactly what was typed', view.selected === -1 && view.value === 'gala', view.value);

    // ---- Tab fills a suggestion in to keep typing from ----
    const target = view.rows.indexOf('galaxy watch');
    for (let i = 0; i <= target; i++) { key('Down'); await wait(30); }
    key('Tab');
    await wait(60);
    view = await list();
    check('Tab writes the chosen search into the box', view.value === 'galaxy watch ', JSON.stringify(view.value));
    check('and does not switch to AI mode', !(await js(`document.body.classList.contains('ai')`)));
    await until(async () => (await list()).open);

    // ---- Escape closes and puts back what was typed ----
    key('Down');
    await wait(40);
    key('Escape');
    await wait(80);
    view = await list();
    check('Escape closes the list', !view.open && view.expanded === 'false');
    check('and puts back what was typed', view.value === 'galaxy watch ', JSON.stringify(view.value));

    // ---- an email typed slowly never leaves, not even half of it ----
    // Each pause is a request, so typed a letter at a time, past the debounce,
    // "jo@gmail" must not slip out on the way to "jo@gmail.com".
    await clear();
    let emailFrom = sent.length;
    await type('jo@gmail.com', 170);
    await wait(250);
    const leaked = sentSince(emailFrom).filter((q) => q.includes('@'));
    check('an email typed slowly is never sent, not even its start', leaked.length === 0 && sentSince(emailFrom).includes('jo'),
      JSON.stringify(sentSince(emailFrom)));

    // ---- a newer keystroke cancels the older request ----
    await clear();
    delay = 400;
    let n = sent.length;
    key('q');
    await wait(220);           // past the pause: "q" is now in flight
    key('u');
    await until(async () => (await list()).rows.includes('quantum computing'), 40, 50);
    check('the slow answer for "q" was abandoned when "u" was typed', aborted.includes('q'), JSON.stringify(aborted));
    view = await list();
    check('and the list is for "qu"', view.rows[0] === 'qu' && !view.rows.includes('quiet places'), JSON.stringify(view.rows));
    check('two requests, one per pause', sentSince(n).join(',') === 'q,qu', JSON.stringify(sentSince(n)));
    delay = 30;

    // ---- a real click on a row searches for it ----
    await clear();
    await type('galax');
    await until(async () => (await list()).rows.includes('galaxy buds'));
    browser.tabs.navigate = (tabId, input) => { navigations.push(input); };
    const at = await js(`(() => {
      const row = [...document.querySelectorAll('.suggest-row')].find((r) => r.querySelector('.suggest-title')?.textContent === 'galaxy buds');
      const b = row.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 3), y: Math.round(b.top + b.height / 2) };
    })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await wait(200);
    view = await list();
    check('hovering slides the highlight under the pointer', view.glideOn && view.rowY.some((y) => Math.abs(y - view.glideY) < 1.5), view.glideY + ' in ' + JSON.stringify(view.rowY));
    await shot('suggest-newtab-hover');
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await until(async () => navigations.length > 0);
    browser.tabs.navigate = realNavigate;
    check('clicking a suggestion searches for it', navigations[0] === 'galaxy buds', JSON.stringify(navigations));
    check('and the list closes', !(await list()).open);

    // ---- what never leaves the computer ----
    const privateCase = async (text, label) => {
      await clear();
      const n = sent.length;
      wc.insertText(text);
      await wait(450);
      const v = await list();
      check(label + ' is not sent', sentSince(n).length === 0, JSON.stringify(sentSince(n)));
      return v;
    };
    view = await privateCase('jo@example.com', 'an email address');
    check('the footer says it stays on this computer', /stays on this computer/.test(view.foot) || !view.open, view.foot);
    view = await privateCase('Hunter2!x', 'something that looks like a password');
    await privateCase('browser://settings', 'an internal address');
    await privateCase('github.com/explore', 'a web address');
    await privateCase('4111 1111 1111 1111', 'a card number');
    // The control: an ordinary word IS sent, so the checks above mean something.
    await clear();
    const controlFrom = sent.length;
    wc.insertText('git');
    await wait(450);
    check('an ordinary word is sent, so the checks above mean something', sentSince(controlFrom).join() === 'git', JSON.stringify(sentSince(controlFrom)));
    await until(async () => (await list()).open);
    await shot('suggest-newtab-local-first');

    // ---- AI mode is not a search ----
    // (Text goes in by insertText from here on: after the real click above,
    // an off-screen window cannot take keyboard focus back for raw keys.)
    await clear();
    wc.insertText('gal');
    await until(async () => (await list()).open);
    const aiAvailable = await js(`!!document.querySelector('#keyhint').textContent`);
    if (aiAvailable) {
      await js(`document.querySelector('.action')?.click()`);
      await wait(150);
      check('switching to AI closes the suggestions', !(await list()).open);
      await js(`(() => { const q = document.querySelector('#query'); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
    }
    // ---- the switch: off means history and bookmarks only ----
    browser.settings.update({ searchSuggestions: false });
    browser.push();
    await wait(300);
    view = await privateCase('weather', 'with the switch off, anything');
    view = await list();
    check('the footer says where suggestions come from', !view.open || /history and bookmarks/.test(view.foot), view.foot);

    // Local rows still come, and the footer says they are all there is.
    await clear();
    wc.insertText('gal');
    await until(async () => (await list()).open);
    view = await list();
    check('with the switch off, history and bookmarks still suggest', view.open && view.rows.includes('Galaxy Zoo') && !view.rows.includes('galaxy s24 review'), JSON.stringify(view.rows));
    check('and the footer says where they come from', /history and bookmarks/.test(view.foot), view.foot);
    check('a list that fits has no scrollbar', view.overflow <= 0, view.overflow + 'px over');
    await shot('suggest-newtab-local');

    // ...and main refuses even if a page asks directly.
    const direct = await js(`window.browser.invoke('search:suggest', { query: 'weather' })`);
    check('main refuses when the switch is off, whatever the page asks', direct.remote === false && direct.searches.length === 0, JSON.stringify(direct));

    // ---- Settings > Search has the switch, and it works with a real click ----
    const sid = browser.tabs.create({ url: 'browser://settings' });
    const swc = browser.tabs.tabs.get(sid).view.webContents;
    const sjs = (code) => swc.executeJavaScript(code);
    await until(() => sjs(`!!document.querySelector('[data-category=search]') && !!document.querySelector('#searchSuggestions')`), 80, 100);
    await wait(500);
    await sjs(`document.querySelector('[data-category=search]').click()`);
    await wait(300);
    const sw = await sjs(`(() => {
      const n = document.querySelector('#searchSuggestions');
      const label = document.querySelector('label[for=searchSuggestions]');
      const b = n.getBoundingClientRect();
      return { role: n.getAttribute('role'), toggle: n.classList.contains('toggle'), checked: n.checked,
        label: label?.textContent, w: Math.round(b.width), h: Math.round(b.height),
        x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    check('Settings > Search has a "Search suggestions" switch', sw.role === 'switch' && sw.toggle && sw.label === 'Search suggestions', JSON.stringify(sw));
    check('drawn like the other switches', sw.w === 40 && sw.h === 22, sw.w + 'x' + sw.h);
    check('it shows the current choice (off)', sw.checked === false);
    swc.sendInputEvent({ type: 'mouseMove', x: sw.x, y: sw.y });
    swc.sendInputEvent({ type: 'mouseDown', x: sw.x, y: sw.y, button: 'left', clickCount: 1 });
    swc.sendInputEvent({ type: 'mouseUp', x: sw.x, y: sw.y, button: 'left', clickCount: 1 });
    check('clicking it turns suggestions back on in main', await until(async () => browser.settings.value.searchSuggestions === true));
    await wait(400);
    const simg = await swc.capturePage().catch(() => null);
    if (simg) fs.writeFileSync(path.join(dir, 'suggest-settings.png'), simg.toPNG());
    browser.tabs.close(sid);
    browser.tabs.select(id);
    await wait(400);

    // ---- incognito never asks ----
    browser.searchSuggest.incognito = true;
    await privateCase('weather', 'in incognito, anything');
    browser.searchSuggest.incognito = false;

    // ---- a light world, to see the glass on a pale page ----
    browser.settings.update({ theme: 'venus' });
    browser.push();
    await wait(500);
    await clear();
    wc.insertText('gal');
    await until(async () => (await list()).rows.includes('galaxy s24 review'));
    await js(`(() => { const r = document.querySelectorAll('.suggest-row')[3]; r?.dispatchEvent(new MouseEvent('mouseenter')); })()`);
    await shot('suggest-newtab-light');
    browser.settings.update({ theme: 'neptune' });
    browser.push();
    await wait(300);

    check('no errors on the new tab page', errors.length === 0, errors.join(' | '));

    // ---- the address bar offers the same list ----
    const chrome = browser.chrome.webContents;
    const cjs = (code) => chrome.executeJavaScript(code);
    const cerrors = [];
    chrome.on('console-message', (e) => { if (e?.level === 'error' || e?.level === 3) cerrors.push(String(e.message).slice(0, 160)); });
    try {
      chrome.debugger.attach('1.3');
      await chrome.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) { console.log('  (chrome focus emulation unavailable: ' + error.message + ')'); }
    const ckey = (keyCode) => {
      chrome.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode.length === 1) chrome.sendInputEvent({ type: 'char', keyCode });
      chrome.sendInputEvent({ type: 'keyUp', keyCode });
    };
    await cjs(`(() => { const a = document.getElementById('address'); a.focus(); a.value = ''; return true; })()`);
    n = sent.length;
    for (const ch of 'gal') { ckey(ch); await wait(45); }
    const omni = () => cjs(`(() => {
      const rows = [...document.querySelectorAll('#suggestions .suggestion')];
      return {
        open: !document.getElementById('suggestions').hidden,
        rows: rows.map((r) => r.querySelector('.label')?.textContent || ''),
        marks: rows.map((r) => r.querySelector('.match')?.textContent || ''),
        tag: rows[0]?.querySelector('.tag')?.textContent || '',
        selected: rows.findIndex((r) => r.classList.contains('selected')),
        value: document.getElementById('address').value,
        bottom: Math.round(document.getElementById('suggestions').getBoundingClientRect().bottom),
        viewport: innerHeight,
      };
    })()`);
    await until(async () => (await omni()).rows.includes('galaxy s24 review'));
    const bar = await omni();
    console.log('  [diag] address bar', JSON.stringify(bar.rows));
    check('the address bar shows the engine\'s suggestions too', bar.rows.includes('galaxy s24 review'), JSON.stringify(bar.rows));
    const ntRows = (await (async () => { await clear(); wc.insertText('gal'); await until(async () => (await list()).rows.includes('galaxy s24 review')); return (await list()).rows; })());
    check('in the same order as the new tab page', JSON.stringify(bar.rows) === JSON.stringify(ntRows), JSON.stringify(ntRows));
    check('the address bar highlights the typed part', bar.marks.filter(Boolean).length >= bar.rows.length - 1, JSON.stringify(bar.marks));
    check('its first row says what Enter does', /Search Google/.test(bar.tag), bar.tag);
    check('the list fits in the toolbar view', bar.bottom <= bar.viewport + 1, bar.bottom + ' / ' + bar.viewport);
    check('one request from the address bar for "gal" (or the cache)', sentSince(n).length <= 1, JSON.stringify(sentSince(n)));
    const cimg = await chrome.capturePage().catch(() => null);
    if (cimg) fs.writeFileSync(path.join(dir, 'suggest-addressbar.png'), cimg.toPNG());

    await cjs(`document.getElementById('address').focus()`);
    ckey('Down'); await wait(40); ckey('Down'); await wait(60);
    let b2 = await omni();
    check('Down chooses rows in the address bar', b2.selected === 1 && b2.value.length > 0, b2.selected + ' ' + b2.value);
    const chosen = b2.value;
    ckey('Tab'); await wait(120);
    b2 = await omni();
    check('Tab fills the chosen row in, in the address bar too', b2.value.trim() === chosen.trim(), JSON.stringify(b2.value));
    await cjs(`document.getElementById('address').focus()`);
    await until(async () => (await omni()).open);
    const filled = (await omni()).value;
    ckey('Up'); await wait(60);
    b2 = await omni();
    const rowsNow = b2.rows.length;
    check('Up from the box chooses the last row', b2.selected === rowsNow - 1, b2.selected + ' of ' + rowsNow);
    ckey('Down'); await wait(60);
    b2 = await omni();
    check('and Down past it brings back exactly what was typed', b2.selected === -1 && b2.value === filled, JSON.stringify(b2.value) + ' vs ' + JSON.stringify(filled));
    ckey('Escape'); await wait(300);
    check('Escape closes the address bar list', !(await omni()).open);
    check('and gives the space back to the page', browser.suggestionsOpen === false);
    check('no errors in the toolbar', cerrors.length === 0, cerrors.join(' | '));
    try { wc.debugger.detach(); chrome.debugger.detach(); } catch { /* done anyway */ }
  } catch (error) {
    browser.tabs.navigate = realNavigate;
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall search suggestion checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
