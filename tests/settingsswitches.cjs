const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Every on/off control in Settings is a switch: drawn as one, announced as
 * one, and worked the way a person works it - a real click on the switch, a
 * click on its words, Space from the keyboard. Each flip is checked where it
 * matters, in main's settings, not just in the page.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const until = async (predicate, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await predicate().catch(() => false)) return true;
      await wait(100);
    }
    return false;
  };

  try {
    browser.window.setSize(1300, 900);
    browser.settings.update({
      theme: 'neptune', animations: true, bookmarksBar: true,
      newTab: { showMostVisited: true, showStatusStrip: true },
    });
    browser.push();
    const id = browser.tabs.create({ url: 'browser://settings' });
    const wc = browser.tabs.tabs.get(id).view.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });
    const shot = async (name, rect) => {
      await wait(350);
      const img = await wc.capturePage(rect).catch(() => null);
      if (img) fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    };
    const section = async (name) => {
      await js(`document.querySelector('[data-category=${name}]').click()`);
      await wait(250);
    };
    // A real mouse click at the centre of an element (or of its label text).
    const clickAt = async (selector) => {
      const at = await js(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)});
        n.scrollIntoView({ block: 'center' });
        const b = n.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      })()`);
      await wait(60);
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    };
    const knobX = (selector) => js(`(() => {
      const t = getComputedStyle(document.querySelector(${JSON.stringify(selector)}), '::before').transform;
      return t === 'none' ? 0 : new DOMMatrix(t).m41;
    })()`);

    await until(() => js(`!!document.querySelector('[data-category=appearance]') && document.querySelector('#bookmarksBar').checked`));

    // ---- every one of them is a switch ----
    const audit = await js(`(() => {
      const boxes = [...document.querySelectorAll('input[type=checkbox]')];
      const named = (n) => !!(n.getAttribute('aria-label') || (n.id && document.querySelector('label[for="' + n.id + '"]')) || n.closest('label'));
      return {
        total: boxes.length,
        notSwitch: boxes.filter((n) => n.getAttribute('role') !== 'switch' || !n.classList.contains('toggle')).map((n) => n.id),
        unnamed: boxes.filter((n) => !named(n)).map((n) => n.id),
      };
    })()`);
    check('every checkbox on the page is a role=switch toggle (' + audit.total + ')', audit.total >= 18 && audit.notSwitch.length === 0, JSON.stringify(audit));
    check('every switch has a name a screen reader can read', audit.unnamed.length === 0, audit.unnamed.join(', '));

    await section('appearance');
    check('the forge\'s Cancel button stays hidden until a planet is being edited', await js(`document.querySelector('#forge-cancel')?.hidden !== false`));
    const look = await js(`(() => {
      const n = document.querySelector('#bookmarksBar');
      const s = getComputedStyle(n), k = getComputedStyle(n, '::before'), m = getComputedStyle(n, '::after');
      return { w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height, radius: parseFloat(s.borderTopLeftRadius),
        bg: s.backgroundImage, knob: k.width + ' ' + k.borderTopLeftRadius + ' ' + k.backgroundColor, mark: m.backgroundImage.slice(0, 60) };
    })()`);
    check('drawn as a pill with a round knob', look.w === 40 && look.h === 22 && look.radius >= 11 && /^16px/.test(look.knob), JSON.stringify(look));
    check('the on state is the accent gradient', /gradient/.test(look.bg), look.bg.slice(0, 120));
    check('the knob sits at the far end when on', Math.abs(await knobX('#bookmarksBar') - 18) < 0.5, await knobX('#bookmarksBar'));
    await shot('switches-appearance-dark');

    // ---- a real click, animated ----
    await clickAt('#bookmarksBar');
    const mid = [];
    for (let i = 0; i < 6; i++) { mid.push(await knobX('#bookmarksBar')); await wait(25); }
    const flipped = await until(async () => browser.settings.value.bookmarksBar === false);
    check('clicking the switch turns the bookmarks bar off in main', flipped, browser.settings.value.bookmarksBar);
    check('the knob glides rather than jumps', mid.some((x) => x > 0.5 && x < 17.5), mid.map((x) => x.toFixed(1)).join(' '));
    await wait(400);
    check('and comes to rest at the start', Math.abs(await knobX('#bookmarksBar')) < 0.5, await knobX('#bookmarksBar'));
    check('aria state follows (checked=false)', await js(`!document.querySelector('#bookmarksBar').checked`));

    // ---- clicking the words flips it too ----
    await clickAt('label[for=bookmarksBar]');
    check('clicking the label turns it back on', await until(async () => browser.settings.value.bookmarksBar === true), browser.settings.value.bookmarksBar);

    // ---- keyboard: Tab to it, Space flips it, the focus ring shows ----
    await section('content');
    // The probe window is off-screen and can never hold system focus, so
    // Chromium would never match :focus at all. Focus emulation makes the page
    // behave as if its window were the focused one, which a person's is.
    try {
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) { console.log('  (focus emulation unavailable: ' + error.message + ')'); }
    wc.focus();
    await js(`document.querySelector('#open-newtab').focus()`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    const tabbed = await until(() => js(`document.activeElement?.id === 'showMostVisited'`), 20);
    check('Tab reaches the switch', tabbed, await js(`document.activeElement?.id`));
    if (!tabbed) await js(`document.querySelector('#showMostVisited').focus()`);
    const ring = await js(`(() => { const n = document.querySelector('#showMostVisited'), s = getComputedStyle(n);
      return { visible: n.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth, glow: s.boxShadow.slice(0, 80) }; })()`);
    check('a visible focus ring around the switch', ring.visible && ring.outline === 'solid 2px', JSON.stringify(ring));
    await shot('switches-focus-ring');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    wc.sendInputEvent({ type: 'char', keyCode: ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    check('Space turns "most visited" off', await until(async () => browser.settings.value.newTab?.showMostVisited === false), JSON.stringify(browser.settings.value.newTab?.showMostVisited));
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    wc.sendInputEvent({ type: 'char', keyCode: ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    check('and Space again turns it back on', await until(async () => browser.settings.value.newTab?.showMostVisited === true));

    // ---- the Shields master switch greys out the rest ----
    await section('privacy');
    await shot('switches-privacy-dark');
    await clickAt('#sh-enabled');
    const off = await until(async () => browser.shields?.config?.enabled === false || await js(`document.querySelector('#sh-trackers').disabled`));
    const dim = await js(`({ disabled: document.querySelector('#sh-trackers').disabled, opacity: getComputedStyle(document.querySelector('#sh-trackers')).opacity, cursor: getComputedStyle(document.querySelector('#sh-trackers')).cursor })`);
    check('turning Shields off disables the switches under it', off && dim.disabled && Number(dim.opacity) < 0.6 && dim.cursor === 'not-allowed', JSON.stringify(dim));
    await shot('switches-shields-off');
    await clickAt('#sh-trackers');
    await wait(200);
    check('a disabled switch ignores clicks', await js(`document.querySelector('#sh-trackers').checked`) === true);
    await clickAt('#sh-enabled');
    check('turning Shields back on enables them again', await until(() => js(`!document.querySelector('#sh-trackers').disabled && document.querySelector('#sh-enabled').checked`)));

    // ---- clear-data tiles: the whole tile is the switch ----
    await clickAt('.check-tile:has(#clear-cookies) strong');
    const tile = await js(`(() => { const t = document.querySelector('.check-tile:has(#clear-cookies)');
      return { on: document.querySelector('#clear-cookies').checked, lit: getComputedStyle(t).backgroundImage }; })()`);
    check('clicking a clear-data tile turns its switch on and lights the tile', tile.on && /gradient/.test(tile.lit), JSON.stringify(tile).slice(0, 160));
    await shot('switches-clear-tiles');
    // Nothing chosen means nothing is cleared - and nothing real is cleared here.
    await js(`for (const n of document.querySelectorAll('.checks input')) if (n.checked) n.click()`);
    await clickAt('#clear');
    check('with every tile off, Clear asks for a choice instead', await until(() => js(`document.querySelector('#clear-status').textContent === 'Select at least one thing to clear.'`), 20));
    await js(`document.querySelector('#clear-history').click()`);

    // ---- the Animations setting stills the switches ----
    await section('accessibility');
    await clickAt('label[for=reduce-motion]');
    check('"Reduce motion" (by its label) turns animations off', await until(async () => browser.settings.value.animations === false));
    await until(() => js(`getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim() === '0ms'`));
    await clickAt('#reduce-motion');
    const instant = await knobX('#reduce-motion');
    check('with animations off the knob moves at once', Math.abs(instant) < 0.5, instant);
    check('and animations are back on', await until(async () => browser.settings.value.animations === true));

    // ---- the import panel's switches on Get started match the rest ----
    // They only exist when another browser is installed to import from.
    await section('start');
    if (await until(() => js(`!!document.querySelector('.import-switch')`), 30)) {
      const sel = `[...document.querySelectorAll('.import-switch')].find((b) => /Homepage/.test(b.textContent))`;
      const knobOf = (q) => `(() => { const k = (${q}).querySelector('.import-knob'), t = getComputedStyle(k, '::after').transform;
        return { w: k.getBoundingClientRect().width, h: k.getBoundingClientRect().height, x: t === 'none' ? 0 : new DOMMatrix(t).m41,
          bg: getComputedStyle(k).backgroundImage, on: (${q}).getAttribute('aria-checked') }; })()`;
      const before = await js(knobOf(sel));
      // Coming back to a section must not unhide what is hidden on purpose.
      const stray = await js(`({ picked: !!document.querySelector('.import-browser[aria-checked=true]'), list: !document.querySelector('.import-profile')?.hidden })`);
      check('no empty profile list before a browser is picked', stray.picked || !stray.list, JSON.stringify(stray));
      check('import switches are drawn like the settings switches', before.w === 40 && before.h === 22 && before.on === 'false' && Math.abs(before.x) < 0.5, JSON.stringify(before));
      await js(`(${sel}).scrollIntoView({ block: 'center' })`);
      await wait(60);
      const at = await js(`(() => { const b = (${sel}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await wait(450);
      const after = await js(knobOf(sel));
      check('clicking one turns it on: gradient track, knob across', after.on === 'true' && /gradient/.test(after.bg) && Math.abs(after.x - 18) < 0.5, JSON.stringify(after));
      await shot('switches-import');
      await js(`(${sel}).click()`);
    } else {
      console.log('  --  no other browser installed here, so no import switches to check');
    }

    // ---- close-up, light theme and a narrow tab ----
    await section('privacy');
    await js(`document.querySelector('#sh-enabled').scrollIntoView({ block: 'start' })`);
    wc.setZoomFactor(2);
    await shot('switches-closeup-dark', { x: 0, y: 0, width: 1000, height: 520 });
    wc.setZoomFactor(1);
    browser.settings.update({ theme: 'sun' }); browser.push();
    await until(() => js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '${require('../src/shared/theme').THEMES.sun.tokens.bg}'`));
    await shot('switches-privacy-light');
    await js(`document.querySelector('.checks').scrollIntoView({ block: 'center' })`);
    await shot('switches-clear-light');
    browser.window.setSize(720, 640);
    await wait(500);
    // Narrowing the window turns the category column into a row; the chosen
    // category (Privacy, part-way along) must not be left off the end of it.
    const kept = await js(`(() => { const nav = document.querySelector('#settings-nav').getBoundingClientRect(), a = document.querySelector('.settings-nav-item.active').getBoundingClientRect();
      return { id: document.querySelector('.settings-nav-item.active').dataset.category, inView: a.left >= nav.left - 1 && a.right <= nav.right + 1, left: Math.round(a.left) }; })()`);
    check('narrowing the window keeps the chosen category in sight', kept.id === 'privacy' && kept.inView, JSON.stringify(kept));
    const narrow = await js(`({ doc: document.documentElement.scrollWidth <= innerWidth, main: document.querySelector('.settings-main').scrollWidth <= document.querySelector('.settings-main').clientWidth })`);
    check('no sideways scrolling in a narrow tab', narrow.doc && narrow.main, JSON.stringify(narrow));
    const row = await js(`(() => { const s = document.querySelector('#sh-enabled').closest('.field'), n = document.querySelector('#sh-enabled');
      return { wraps: n.getBoundingClientRect().top >= s.firstElementChild.getBoundingClientRect().bottom, right: s.getBoundingClientRect().right - n.getBoundingClientRect().right }; })()`);
    check('switches stay beside their words when narrow', !row.wraps && row.right < 40, JSON.stringify(row));
    await section('about');
    const seen = await js(`(() => { const nav = document.querySelector('#settings-nav').getBoundingClientRect(), a = document.querySelector('.settings-nav-item.active').getBoundingClientRect();
      return { inView: a.left >= nav.left - 1 && a.right <= nav.right + 1, scrolled: document.querySelector('#settings-nav').scrollLeft }; })()`);
    check('the chosen category is scrolled into the sideways row', seen.inView && seen.scrolled > 0, JSON.stringify(seen));
    await js(`document.querySelector('#settings-nav').scrollLeft = 0`);
    const navAt = await js(`(() => { const b = document.querySelector('#settings-nav').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseWheel', x: navAt.x, y: navAt.y, deltaX: 0, deltaY: -240 });
    check('the mouse wheel scrolls the row along', await until(() => js(`document.querySelector('#settings-nav').scrollLeft > 0`), 20));
    await section('privacy');
    await shot('switches-narrow-light');

    check('no page errors', errors.length === 0, errors.join(' | '));
    browser.settings.update({ theme: 'neptune', animations: true, bookmarksBar: true }); browser.push();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall switch checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
