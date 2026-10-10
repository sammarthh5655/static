const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Every way into split view, as a person finds them, and dragging a tab onto
 * either half of the page.
 *
 *   node scripts/start.cjs --splitdrag
 *   node scripts/start.cjs --splitdrag --incognito
 *
 * Covers the tab you are on (its menu offers "Split view with…" and a list of
 * the other tabs), any other tab, the main menu, a drag of the current tab or
 * another, the drag's two ends arriving in either order, replacing one side
 * of an open split, a cancelled drag, and a second window.
 */
async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const tag = browser.incognito ? 'incognito' : 'normal';
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== '' ? ' :: ' + detail : ''));
    if (!ok) failures.push(name);
  };
  const until = async (fn, tries = 50) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(100); }
    return null;
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const colour = { '/a': '#642', '/b': '#246', '/c': '#264', '/d': '#426' }[req.url] || '#444';
    res.end('<title>Page ' + req.url.slice(1) + '</title><body style="margin:0;font:40px sans-serif;color:#fff;background:' + colour + '">' + req.url + '</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const click = async (wc, x, y, button = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(30);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const menuLabels = (w) => w.overlay.webContents.executeJavaScript(`[...document.querySelectorAll('.menu-item')].map((n) => n.textContent.trim().replace(/\\s+/g, ' '))`);
  const menuShows = (w, text) => until(async () => (await menuLabels(w)).some((l) => l.includes(text)), 30);
  const choose = async (w, label) => {
    const at = await w.overlay.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.menu-item')];
      const n = items.find((x) => x.textContent.trim() === ${JSON.stringify(label)}) || items.find((x) => x.textContent.includes(${JSON.stringify(label)}));
      if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!at) return false;
    await click(w.overlay.webContents, at.x, at.y);
    return true;
  };
  const rightClickTab = async (w, id) => {
    const at = await centre(w.chrome.webContents, `.tab[data-id="${id}"]`);
    if (!at) return null;
    await click(w.chrome.webContents, at.x, at.y, 'right');
    await until(async () => w.overlayInteractive && (await menuLabels(w)).length > 0);
    await wait(250);
    return menuLabels(w);
  };
  const closeMenu = async (w) => { w.closeMenu(); await wait(300); };
  const shoot = async (wc, name) => {
    const img = await wc.capturePage().catch(() => null);
    if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
  };
  // HTML5 drag events, as the tab strip and the zones receive them. Two
  // processes take part in a real drag; each gets its own events here.
  const drag = (w, wc, selector, type) => wc.executeJavaScript(`(() => {
    const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false;
    window.__dt = window.__dt || new DataTransfer();
    n.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    if (${JSON.stringify(type)} === 'dragend') window.__dt = null;
    return true; })()`);
  const zonesUp = (w) => until(() => w.splitDrop && !w.splitDrop.webContents.isLoading() && w.splitDrop.getBounds().width > 0, 40);
  const zonesDown = (w) => until(() => !w.splitDrop || w.splitDrop.getBounds().width === 0, 30);
  const pairOf = (w) => w.tabs.pairOf(w.tabs.activeId);
  const reset = async (w) => { const p = pairOf(w); if (p) w.tabs.unsplit(p.left); w.layout(); await wait(200); };

  async function suite(w, label) {
    console.log('---- ' + label + ' (' + tag + ')');
    await until(() => !w.chrome.webContents.isLoading() && w.tabs.order.length, 80);
    await wait(800);
    browser.settings.update({ tabLayout: 'horizontal' });
    w.applyTabLayout();
    const a = w.tabs.activeId;
    w.tabs.navigate(a, base + '/a');
    const b = w.tabs.create({ url: base + '/b', background: true });
    const c = w.tabs.create({ url: base + '/c', background: true });
    const d = w.tabs.create({ url: base + '/d', background: true });
    // b was used most recently after a, so it is the partner a drag of a picks.
    w.tabs.select(b); await wait(150); w.tabs.select(a);
    await wait(1200);

    // ---- The tab you are on.
    let labels = await rightClickTab(w, a);
    check(label + ': the current tab\'s menu offers "Split view with…"', (labels || []).some((l) => l.startsWith('Split view with')), (labels || []).join(' | '));
    check(label + ': and does not offer to sleep the tab you are on', !(labels || []).some((l) => l.startsWith('Sleep tab')));
    await choose(w, 'Split view with');
    check(label + ': which opens the list of tabs to put beside it', !!(await menuShows(w, 'Page c')));
    const picker = await menuLabels(w);
    check(label + ': the list starts with a new tab, then the others', /New tab/.test(picker[0] || '') && picker.some((l) => l.includes('Page b')), picker.join(' | '));
    await choose(w, 'Page c');
    let pair = await until(() => pairOf(w));
    check(label + ': choosing one splits the current tab with it', !!pair && pair.left === a && pair.right === c, JSON.stringify(pair));
    check(label + ': the menu goes away', !!(await until(() => !w.overlayInteractive, 30)));
    await shoot(w.chrome.webContents, 'splitdrag-' + tag + '-' + label + '-strip');
    await reset(w);

    // ---- Split view with… > New tab.
    await rightClickTab(w, a);
    await choose(w, 'Split view with');
    await menuShows(w, 'Page c');
    const before = w.tabs.order.length;
    await choose(w, 'New tab');
    pair = await until(() => pairOf(w));
    check(label + ': "New tab" opens a new tab beside it', !!pair && pair.left === a && w.tabs.order.length === before + 1 && w.tabs.activeId === pair.right, JSON.stringify(pair));
    if (pair) w.tabs.close(pair.right);
    await reset(w);
    w.tabs.select(a); await wait(300);

    // ---- Another tab.
    labels = await rightClickTab(w, d);
    check(label + ': another tab\'s menu offers "Add tab to new split view"', (labels || []).includes('Add tab to new split view'), (labels || []).join(' | '));
    await choose(w, 'Add tab to new split view');
    pair = await until(() => pairOf(w));
    check(label + ': which puts it beside the current tab', !!pair && pair.left === a && pair.right === d, JSON.stringify(pair));
    await reset(w);

    // ---- The main menu.
    const menuAt = await centre(w.chrome.webContents, '#overflow');
    await click(w.chrome.webContents, menuAt.x, menuAt.y);
    check(label + ': the main menu has "Split view"', !!(await menuShows(w, 'Split view')));
    await choose(w, 'Split view');
    check(label + ': which opens the same list', !!(await menuShows(w, 'Page b')));
    await choose(w, 'Page b');
    pair = await until(() => pairOf(w));
    check(label + ': and splits with the tab chosen', !!pair && pair.left === a && pair.right === b, JSON.stringify(pair));
    await click(w.chrome.webContents, menuAt.x, menuAt.y);
    check(label + ': in split view the main menu offers the way out', !!(await menuShows(w, 'Exit split view')));
    await choose(w, 'Exit split view');
    check(label + ': and it works', !!(await until(() => !pairOf(w))));
    await closeMenu(w);
    w.tabs.select(b); await wait(150); w.tabs.select(a); await wait(300);

    // ---- Drag the tab you are on to the left half.
    const strip = w.chrome.webContents;
    await drag(w, strip, `.tab[data-id="${a}"]`, 'dragstart');
    check(label + ': dragging the current tab shows the zones', !!(await zonesUp(w)));
    const look = await w.splitDrop.webContents.executeJavaScript(`[...document.querySelectorAll('.zone')].map((z) => { const r = z.getBoundingClientRect(); return { side: z.dataset.side, left: r.left, right: r.right, text: z.textContent.trim() }; })`);
    const width = w.tabs.bounds.width;
    check(label + ': two halves cover the page, left and right', look.length === 2 && look[0].left < 20 && look[1].right > width - 20 && Math.abs((look[0].right - look[0].left) - (look[1].right - look[1].left)) < 4,
      JSON.stringify(look.map((z) => [z.side, Math.round(z.left), Math.round(z.right)])));
    check(label + ': each says where the tab will go', look[0].text === 'Open on the left' && look[1].text === 'Open on the right');
    const kids = w.window.contentView.children;
    check(label + ': the zones sit above the page', kids.indexOf(w.splitDrop) > kids.indexOf(w.tabs.active.view));
    await drag(w, w.splitDrop.webContents, '.zone[data-side="left"]', 'dragover');
    await wait(300);
    await shoot(w.splitDrop.webContents, 'splitdrag-' + tag + '-' + label + '-zones');
    await drag(w, w.splitDrop.webContents, '.zone[data-side="left"]', 'drop');
    await drag(w, strip, `.tab[data-id="${a}"]`, 'dragend');
    pair = await until(() => pairOf(w));
    check(label + ': let go on the left, it opens there beside the tab used before it', !!pair && pair.left === a && pair.right === b, JSON.stringify(pair));
    check(label + ': and the zones go away', !!(await zonesDown(w)));
    await reset(w);
    w.tabs.select(a); await wait(300);

    // ---- Drag another tab to the right half; the end reaches main first.
    await drag(w, strip, `.tab[data-id="${c}"]`, 'dragstart');
    await zonesUp(w);
    await drag(w, w.splitDrop.webContents, '.zone[data-side="right"]', 'dragover');
    await drag(w, strip, `.tab[data-id="${c}"]`, 'dragend');
    await wait(50);
    await drag(w, w.splitDrop.webContents, '.zone[data-side="right"]', 'drop');
    pair = await until(() => pairOf(w));
    check(label + ': let go on the right, it opens there - even when the drag\'s end arrives first', !!pair && pair.left === a && pair.right === c, JSON.stringify(pair));
    check(label + ': the dropped tab is the one in use', w.tabs.activeId === c);

    // ---- Already split: a third tab takes the left side, the right stays.
    await drag(w, strip, `.tab[data-id="${d}"]`, 'dragstart');
    await zonesUp(w);
    await drag(w, w.splitDrop.webContents, '.zone[data-side="left"]', 'drop');
    await drag(w, strip, `.tab[data-id="${d}"]`, 'dragend');
    pair = await until(() => { const p = pairOf(w); return p && p.left === d ? p : null; });
    check(label + ': in split view, a tab let go on the left replaces the left side', !!pair && pair.left === d && pair.right === c, JSON.stringify(pairOf(w)));
    await shoot(w.tabs.tabs.get(d).view.webContents, 'splitdrag-' + tag + '-' + label + '-left-pane');

    // ---- A cancelled drag changes nothing and leaves nothing behind.
    const was = JSON.stringify(pairOf(w));
    await drag(w, strip, `.tab[data-id="${b}"]`, 'dragstart');
    await zonesUp(w);
    await drag(w, strip, `.tab[data-id="${b}"]`, 'dragend');
    check(label + ': a drag let go elsewhere takes the zones away', !!(await zonesDown(w)));
    await wait(2200);
    check(label + ': and splits nothing', JSON.stringify(pairOf(w)) === was);
    await reset(w);
    for (const id of [b, c, d]) if (w.tabs.tabs.has(id)) w.tabs.close(id);
    await wait(300);
  }

  try {
    await wait(1200);
    const w1 = browser.front;
    await suite(w1, 'first window');

    // Down the side, too.
    browser.settings.update({ tabLayout: 'vertical' });
    w1.applyTabLayout();
    await until(() => w1.vtabs && !w1.vtabs.webContents.isLoading());
    const other = w1.tabs.create({ url: base + '/b', background: true });
    await wait(1200);
    await drag(w1, w1.vtabs.webContents, `.vt-tab[data-id="${other}"]`, 'dragstart');
    check('vertical tabs: dragging a row shows the zones', !!(await zonesUp(w1)));
    await drag(w1, w1.splitDrop.webContents, '.zone[data-side="right"]', 'drop');
    await drag(w1, w1.vtabs.webContents, `.vt-tab[data-id="${other}"]`, 'dragend');
    const vpair = await until(() => w1.tabs.pairOf(w1.tabs.activeId));
    check('vertical tabs: and dropping it on the right splits', !!vpair && vpair.right === other, JSON.stringify(vpair));
    if (vpair) w1.tabs.unsplit(vpair.left);
    w1.tabs.close(other);
    browser.settings.update({ tabLayout: 'horizontal' });
    w1.applyTabLayout();
    await wait(500);

    const w2 = browser.openWindow({ from: w1 });
    await suite(w2, 'second window');
    check('the first window was left alone', !w1.tabs.pairOf(w1.tabs.activeId) && (!w1.splitDrop || w1.splitDrop.getBounds().width === 0));
  } catch (error) {
    check('no errors', false, error.stack || error.message);
  }
  server.close();
  console.log(failures.length ? '\n' + failures.length + ' FAILURES' : '\nall split view checks passed');
  app.exit(failures.length ? 1 : 0);
}
module.exports = { run };
