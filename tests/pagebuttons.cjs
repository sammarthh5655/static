const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * No button on Static's own pages wraps its words onto a second line or is
 * squashed narrower than its label - "Clear all" on History was folded into
 * "Clear / all". Every visible button with a short, one-piece label is
 * measured at a normal window width and a narrow one.
 *
 *   node scripts/start.cjs --pagebuttons
 */
const PAGES = ['history', 'bookmarks', 'downloads', 'extensions', 'settings', 'passwords', 'autofill', 'shields',
  'notes', 'organizer', 'screentime', 'resources', 'safety', 'health', 'dashboard', 'focus', 'student', 'legal',
  'shopping', 'help', 'licences', 'profiles', 'ai', 'newtab', 'guide'];

async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== '' ? ' :: ' + detail : ''));
    if (!ok) failures.push(name);
  };
  const w = browser.front;
  await wait(1500);
  // A label in one line box per text node: more boxes means it wrapped.
  const measure = () => w.tabs.active.view.webContents.executeJavaScript(`(() => {
    const bad = [];
    for (const b of document.querySelectorAll('button, a.button')) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(b).visibility === 'hidden') continue;
      const text = b.textContent.trim().replace(/\\s+/g, ' ');
      if (!text || text.length > 28 || b.children.length > 2) continue;
      const nodes = [...b.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (nodes.length !== 1) continue;
      const range = document.createRange();
      range.selectNodeContents(nodes[0]);
      const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
      if (lines > 1 || b.scrollWidth > b.clientWidth + 2) bad.push(text + ' (' + lines + ' lines, ' + Math.round(r.width) + 'px)');
    }
    return bad;
  })()`);

  try {
    for (const width of [1280, 900]) {
      w.window.setContentSize(width, 820);
      w.layout();
      await wait(400);
      for (const page of PAGES) {
        w.tabs.navigate(w.tabs.activeId, 'browser://' + page);
        await wait(1100);
        const bad = await measure().catch((e) => ['(could not measure: ' + e.message + ')']);
        check(page + ' at ' + width + 'px: no button wraps or squashes', !bad.length, bad.join(', '));
        // The page's content keeps its width: hiding a side column once
        // dropped it into that column's zero width.
        const main = await w.tabs.active.view.webContents.executeJavaScript(`(() => {
          const m = document.querySelector('.shell-main, .chat-main, main, .wrap') || document.body;
          return { width: Math.round(m.getBoundingClientRect().width), inner: innerWidth }; })()`);
        check(page + ' at ' + width + 'px: the content keeps its width', main.width >= main.inner * 0.5, JSON.stringify(main));
        if (page === 'history') {
          const img = await w.tabs.active.view.webContents.capturePage().catch(() => null);
          if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, 'pagebuttons-history-' + width + '.png'), img.toPNG());
        }
      }
    }
    // The chat list switched off, at full width.
    w.window.setContentSize(1280, 820); w.layout();
    w.tabs.navigate(w.tabs.activeId, 'browser://ai');
    await wait(1200);
    const ai = await w.tabs.active.view.webContents.executeJavaScript(`(() => {
      document.getElementById('toggle-sidebar')?.click();
      return new Promise((r) => setTimeout(() => r({ hidden: document.body.classList.contains('sidebar-hidden'),
        width: Math.round(document.querySelector('.chat-main').getBoundingClientRect().width), inner: innerWidth }), 300)); })()`);
    check('AI chat with its list hidden still fills the page', ai.hidden && ai.width >= ai.inner * 0.9, JSON.stringify(ai));
  } catch (error) {
    check('no errors', false, error.stack || error.message);
  }
  console.log(failures.length ? '\n' + failures.length + ' FAILURES' : '\nall page button checks passed');
  app.exit(failures.length ? 1 : 0);
}
module.exports = { run };
