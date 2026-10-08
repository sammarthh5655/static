const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * browser://guide - the tour that follows setup. Off-screen.
 *
 * Walked the way a person walks it: real clicks on the arrows, the dots and
 * each card's button, a real mouse wheel on the track. Every button must open
 * the page it names, the tour must stay where it was while they look, and it
 * must be reachable again from Help, from the main menu and from Settings.
 * A screenshot of every card goes to shots/.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 180) : ''));
    if (!ok) fails++;
  };

  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const theme = browser.settings.value.theme;
  const animations = browser.settings.value.animations;

  try {
    await wait(1200);
    browser.onboarding.complete();

    const errors = [];
    const watched = new WeakSet();
    const watch = (wc) => {
      if (watched.has(wc)) return;
      watched.add(wc);
      wc.on('console-message', (event) => {
        if (event?.level === 'error' || event?.level === 3) errors.push(String(event.message).slice(0, 160));
      });
    };

    /** Load an address in the active tab and wait for it. */
    const load = async (url) => {
      const wc = browser.tabs.active.view.webContents;
      const done = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 8000); });
      browser.tabs.navigate(browser.tabs.activeId, url);
      await done;
      watch(wc);
      return wc;
    };

    /** A real click on whatever the selector finds. */
    const clickIn = async (wc, selector) => {
      const at = await wc.executeJavaScript(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const box = node.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: hit ? hit.tagName + '.' + String(hit.className && hit.className.baseVal !== undefined ? hit.className.baseVal : hit.className) : 'none', inside: !!hit && node.contains(hit), vw: innerWidth, vh: innerHeight, scroll: document.getElementById('track')?.scrollLeft };
      })()`);
      if (!at) throw new Error('nothing to click at ' + selector);
      if (!at.inside) console.log('  [diag] click on ' + selector + ' lands on ' + at.hit + ' ' + JSON.stringify(at));
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      await wait(30);
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await wait(40);
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      return at;
    };

    const shot = async (wc, name) => {
      const image = await wc.capturePage().catch(() => null);
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
    };

    /** Wait for the centred card to be the one wanted. */
    const settle = async (wc, id) => {
      for (let i = 0; i < 40; i++) {
        const now = await wc.executeJavaScript(`document.querySelector('.guide-card.is-active')?.dataset.card || ''`);
        if (now === id) break;
        await wait(80);
      }
      // Let the scroll finish, so the card is centred and not mid-slide: the
      // card is marked active as soon as the glide starts, and a glide across
      // several cards takes longer than a fixed pause would allow.
      let last = null;
      for (let i = 0; i < 40; i++) {
        const left = await wc.executeJavaScript(`(() => {
          const card = document.querySelector('.guide-card.is-active').getBoundingClientRect();
          return Math.round(card.left);
        })()`);
        if (left === last) break;
        last = left;
        await wait(120);
      }
      await wait(150);
      return wc.executeJavaScript(`(() => {
        const card = document.querySelector('.guide-card.is-active');
        const box = card.getBoundingClientRect();
        return { id: card.dataset.card, centred: Math.abs((box.left + box.width / 2) - innerWidth / 2) < 6,
                 hash: location.hash, count: document.getElementById('count').textContent };
      })()`);
    };

    // ---- arriving after setup -------------------------------------------
    let guide = await load('browser://guide?from=setup');
    await wait(900);
    const info = await guide.executeJavaScript(`({
      cards: [...document.querySelectorAll('.guide-card')].map(c => c.dataset.card),
      ready: document.body.classList.contains('is-ready'),
      skip: document.getElementById('skip').textContent,
      dots: document.querySelectorAll('.guide-dot').length,
      lines: [...document.querySelectorAll('.guide-line')].map(n => n.textContent),
      actions: [...document.querySelectorAll('.guide-card')].map(c => c.querySelectorAll('.guide-action').length),
    })`);
    const order = ['start', 'yours', 'shields', 'passwords', 'assistant', 'tabs', 'modes', 'end'];
    check('the guide has its cards, in order', JSON.stringify(info.cards) === JSON.stringify(order), JSON.stringify(info.cards));
    check('the guide has painted', info.ready);
    check('every card has one line of what it does', info.lines.every((line) => line.length > 20 && line.length < 140), info.lines.map((l) => l.length).join(','));
    check('every card has a button that goes somewhere', info.actions.every((n) => n >= 1), JSON.stringify(info.actions));
    check('one dot per card', info.dots === order.length, info.dots);
    check('arriving from setup, the exit says "Skip the tour"', info.skip === 'Skip the tour', info.skip);

    let at = await settle(guide, 'start');
    check('it opens on the first card, centred', at.id === 'start' && at.centred, JSON.stringify(at));
    await shot(guide, 'guide-1-start');

    // ---- the keyboard, and the opening card's own button --------------------
    const key = async (keyCode) => {
      guide.sendInputEvent({ type: 'keyDown', keyCode });
      await wait(20);
      guide.sendInputEvent({ type: 'keyUp', keyCode });
    };
    await key('Right');
    at = await settle(guide, 'yours');
    check('the right arrow key moves on a card', at.id === 'yours' && at.centred, JSON.stringify(at));
    await key('End');
    at = await settle(guide, 'end');
    check('End goes to the last card', at.id === 'end', JSON.stringify(at));
    await key('Home');
    at = await settle(guide, 'start');
    check('Home comes back to the first', at.id === 'start', JSON.stringify(at));
    await clickIn(guide, '.card-start .guide-action.is-primary');
    at = await settle(guide, 'yours');
    check('"Start the tour" moves on to the first feature', at.id === 'yours', JSON.stringify(at));
    await guide.executeJavaScript(`window.guide.goTo(0, { instant: true })`);
    await settle(guide, 'start');

    // ---- walking it with the arrow ----------------------------------------
    for (let i = 1; i < order.length; i++) {
      await clickIn(guide, '#next');
      at = await settle(guide, order[i]);
      check('the next arrow brings "' + order[i] + '" to the centre', at.id === order[i] && at.centred, JSON.stringify(at));
      // Long enough for the card's own animation to finish its first pass.
      await wait(order[i] === 'assistant' ? 2900 : 1400);
      await shot(guide, 'guide-' + (i + 1) + '-' + order[i]);
    }
    check('the place is kept in the address', at.hash === '#end', at.hash);
    check('the counter reads the last card', at.count === order.length + ' / ' + order.length, at.count);
    check('the next arrow stops at the end',
      await guide.executeJavaScript(`document.getElementById('next').disabled`) === true);

    // ---- the dots and the wheel -------------------------------------------
    await clickIn(guide, '.guide-dot:nth-child(3)');
    at = await settle(guide, 'shields');
    check('a dot goes straight to its card', at.id === 'shields', JSON.stringify(at));
    const track = await guide.executeJavaScript(`(() => { const b = document.getElementById('track').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    // Electron's wheel deltas are Chromium's: positive is towards the top, the
    // opposite of the DOM's, so this is a notch back.
    guide.sendInputEvent({ type: 'mouseWheel', x: track.x, y: track.y, deltaX: 0, deltaY: 120 });
    at = await settle(guide, 'yours');
    check('a mouse wheel turns the cards', at.id === 'yours', JSON.stringify(at));

    // ---- each card's button goes where it says -----------------------------
    /** Click a button on the centred card and read where the new tab went. */
    const opens = async (cardId, selector, expected, verify) => {
      await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf(${JSON.stringify(cardId)}))`);
      await settle(guide, cardId);
      const guideTab = browser.tabs.activeId;
      const before = new Set(browser.tabs.list().map((tab) => tab.id));
      await clickIn(guide, `.card-${cardId} ${selector}`);
      let fresh = null;
      for (let i = 0; i < 40 && !fresh; i++) {
        await wait(100);
        fresh = browser.tabs.list().find((tab) => !before.has(tab.id)) || null;
      }
      let url = '';
      for (let i = 0; i < 30 && fresh; i++) {
        url = browser.tabs.tabs.get(fresh.id)?.state?.displayUrl || '';
        if (url === expected) break;
        await wait(100);
      }
      check('"' + cardId + '" ' + selector + ' opens ' + expected, url === expected, url || 'no new tab');
      if (verify && fresh) {
        // Not only the address: the page itself shows the place named.
        const page = browser.tabs.tabs.get(fresh.id).view.webContents;
        let shown = false;
        for (let i = 0; i < 30 && !shown; i++) {
          await wait(100);
          shown = await page.executeJavaScript(verify.code).catch(() => false);
        }
        check('  and ' + verify.name, shown === true);
      }
      // Let the page finish starting before closing it, so its own requests
      // are not refused for coming from a tab that no longer exists.
      await wait(500);
      if (fresh) browser.tabs.close(fresh.id);
      browser.tabs.select(guideTab);
      await wait(250);
      check('  and the tour is still where it was', (browser.tabs.active?.state?.displayUrl || '').startsWith('browser://guide')
        && await guide.executeJavaScript(`document.querySelector('.guide-card.is-active').dataset.card`) === cardId);
    };

    await opens('yours', '.guide-action.is-primary', 'browser://settings#appearance', {
      name: 'Settings opens on Appearance, with the planets in view',
      code: `(() => { const s = document.querySelector('[data-section="appearance"]');
        return !!s && !s.hidden && !!s.querySelector('.planetarium-canvas'); })()`,
    });
    await opens('shields', '.guide-action.is-primary', 'browser://shields');
    await opens('passwords', '.guide-action.is-primary', 'browser://passwords');
    await opens('assistant', '.guide-action.is-primary', 'browser://ai');
    await opens('tabs', '.guide-action.is-primary', 'browser://organizer');
    await opens('tabs', '.guide-action:not(.is-primary)', 'browser://dashboard');
    await opens('modes', '.guide-action.is-primary', 'browser://dashboard');
    for (const mode of ['student', 'legal', 'shopping', 'focus']) {
      await opens('modes', `.mode-tile[data-mode="${mode}"]`, 'browser://' + mode);
    }
    await opens('end', '.guide-action:not(.is-primary)', 'browser://help');

    // The sidebar is a panel, not a page: the button opens it in place.
    if (browser.settings.value.sidebarMode === 'off') browser.settings.update({ sidebarMode: 'on' });
    browser.toggleSidebar(false);
    await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf('assistant'))`);
    await settle(guide, 'assistant');
    await clickIn(guide, '.card-assistant .guide-action:not(.is-primary)');
    for (let i = 0; i < 20 && !browser.sidebarOpen; i++) await wait(100);
    check('"Open the sidebar" opens the assistant sidebar', browser.sidebarOpen === true);
    browser.toggleSidebar(false);
    await wait(400);
    // With the sidebar switched off it cannot open, so the button goes to the
    // switch rather than doing nothing.
    const sidebarMode = browser.settings.value.sidebarMode;
    browser.settings.update({ sidebarMode: 'off' });
    await opens('assistant', '.guide-action:not(.is-primary)', 'browser://settings#workspaces');
    browser.settings.update({ sidebarMode });

    // ---- a planet tapped in the guide is worn -----------------------------
    await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf('yours'))`);
    await settle(guide, 'yours');
    const target = theme === 'saturn' ? 'jupiter' : 'saturn';
    await guide.executeJavaScript(`window.__hits = []; ['pointerdown','mousedown','mouseup','click'].forEach(t => addEventListener(t, e => window.__hits.push(t + ':' + (e.target.className || e.target.tagName)), true)); true`);
    await clickIn(guide, `.orrery-planet[data-planet="${target}"]`);
    await wait(300);
    console.log('  [diag] events', JSON.stringify(await guide.executeJavaScript('window.__hits')));
    for (let i = 0; i < 20 && browser.settings.value.theme !== target; i++) await wait(100);
    check('tapping a planet in the orrery wears it', browser.settings.value.theme === target, browser.settings.value.theme);
    await wait(600);
    check('  and the guide recolours with it',
      (await guide.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`))
        === require('../src/shared/theme').cssVariables({ ...browser.settings.value })['--bg']);
    check('  and marks it worn', await guide.executeJavaScript(`!!document.querySelector('.orrery-planet[data-planet="${target}"].is-worn')`));
    await wait(800);
    await shot(guide, 'guide-yours-' + target);
    // And on a light world, where glass and glow have to work the other way.
    browser.settings.update({ theme: 'venus' });
    await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf('shields'))`);
    await settle(guide, 'shields');
    await wait(1600);
    await shot(guide, 'guide-light-shields');
    browser.settings.update({ theme });
    await wait(400);

    // ---- motion respects the app's own switch -----------------------------
    browser.settings.update({ animations: false });
    browser.push();
    await wait(500);
    const stillState = await guide.executeJavaScript(`({
      still: document.body.classList.contains('is-still'),
      running: document.getAnimations().filter(a => a.playState === 'running').length,
    })`);
    check('with animations off, the guide is still', stillState.still && stillState.running === 0, JSON.stringify(stillState));
    browser.settings.update({ animations });
    browser.push();
    await wait(400);

    // ---- narrow window ------------------------------------------------------
    const [width, height] = browser.window.getSize();
    browser.window.setSize(760, 700);
    browser.layout();
    await wait(900);
    await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf('tabs'))`);
    at = await settle(guide, 'tabs');
    const narrow = await guide.executeJavaScript(`(() => {
      const card = document.querySelector('.guide-card.is-active').getBoundingClientRect();
      const button = document.querySelector('.guide-card.is-active .guide-action.is-primary').getBoundingClientRect();
      return { card: [Math.round(card.left), Math.round(card.right), innerWidth], fits: card.right <= innerWidth + 1 && card.left >= -1, button: button.bottom <= card.bottom && button.width > 0,
               overflowY: document.documentElement.scrollHeight > innerHeight + 1 };
    })()`);
    check('in a narrow window the card fits, with its button in view', narrow.fits && narrow.button && !narrow.overflowY, JSON.stringify(narrow));
    await shot(guide, 'guide-narrow-tabs');
    browser.window.setSize(width, height);
    browser.layout();
    await wait(600);

    // ---- leaving -----------------------------------------------------------
    await guide.executeJavaScript(`window.guide.goTo(window.guide.cards.indexOf('end'))`);
    await settle(guide, 'end');
    await clickIn(guide, '.card-end .guide-action.is-primary');
    let landed = '';
    for (let i = 0; i < 30 && !/newtab/.test(landed); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('"Start browsing" at the end of the tour goes to a new tab', landed === 'browser://newtab', landed);

    guide = await load('browser://guide?from=setup');
    await wait(900);
    await clickIn(guide, '#skip');
    landed = '';
    for (let i = 0; i < 30 && !/newtab/.test(landed); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('"Skip the tour" after setup goes to a new tab', landed === 'browser://newtab', landed);

    // Opened over a website, closing the guide goes back to the website - and
    // the address bar must say so, not keep the guide's browser:// name.
    const http = require('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Before the guide</title><p>A website.</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const site = 'http://127.0.0.1:' + server.address().port + '/';
    await load(site);
    guide = await load('browser://guide');
    await wait(900);
    await clickIn(guide, '#skip');
    landed = '';
    for (let i = 0; i < 40 && !landed.startsWith('http'); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('closing a guide opened over a website goes back to it, under its own address', landed === site, landed);
    check('  and not under an internal padlock', browser.tabs.active?.state?.security !== 'internal', browser.tabs.active?.state?.security);
    // And Forward onto the guide again names it properly.
    browser.tabs.active.view.webContents.navigationHistory.goForward();
    landed = '';
    for (let i = 0; i < 40 && !landed.startsWith('browser://'); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('  and Forward onto the guide again shows browser://guide', /^browser:\/\/guide/.test(landed), landed);
    server.close();

    // ---- finding it again ---------------------------------------------------
    const help = await load('browser://help');
    await wait(700);
    await clickIn(help, '.help-tour');
    landed = '';
    for (let i = 0; i < 30 && !/guide/.test(landed); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('Help\'s "Take the tour" opens the guide', /^browser:\/\/guide/.test(landed), landed);
    guide = browser.tabs.active.view.webContents;
    await wait(900);
    check('reached from Help, the exit says "Close the guide"',
      await guide.executeJavaScript(`document.getElementById('skip').textContent`) === 'Close the guide');
    await shot(help, 'guide-from-help');
    await clickIn(guide, '#skip');
    landed = '';
    for (let i = 0; i < 30 && !/help/.test(landed); i++) { await wait(100); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('closing it goes back to Help', /^browser:\/\/help/.test(landed), landed);

    // The main menu, opened and clicked like a person would.
    const before = new Set(browser.tabs.list().map((tab) => tab.id));
    await clickIn(browser.chrome.webContents, '#app-menu');
    let footer = null;
    for (let i = 0; i < 30 && !footer; i++) {
      await wait(100);
      footer = await browser.overlay.webContents.executeJavaScript(
        `[...document.querySelectorAll('.menu-footer button')].map(b => b.textContent)`).catch(() => null);
      if (footer && !footer.length) footer = null;
    }
    check('the main menu offers the guide beside Help', footer && footer.includes('Guide') && footer.indexOf('Guide') === footer.indexOf('Help') + 1, JSON.stringify(footer));
    await wait(300);
    await shot(browser.overlay.webContents, 'guide-menu');
    await clickIn(browser.overlay.webContents, '.menu-footer button:nth-child(2)');
    let opened = null;
    for (let i = 0; i < 30 && !opened; i++) {
      await wait(100);
      opened = browser.tabs.list().find((tab) => !before.has(tab.id)) || null;
    }
    landed = opened ? browser.tabs.tabs.get(opened.id)?.state?.displayUrl : '';
    check('"Guide" in the main menu opens the guide in a new tab', /^browser:\/\/guide/.test(landed || ''), landed || 'no new tab');
    if (opened) browser.tabs.close(opened.id);

    // And Settings, from its search.
    const settingsPage = await load('browser://settings#start');
    await wait(900);
    check('Settings offers the tour beside running setup again',
      await settingsPage.executeJavaScript(`!!document.querySelector('[data-open-page="browser://guide"]')`));
    check('Settings no longer describes the long setup',
      !/privacy level/.test(await settingsPage.executeJavaScript(`document.getElementById('setup-state').textContent`)));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    browser.settings.update({ theme, animations });
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall guide checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
