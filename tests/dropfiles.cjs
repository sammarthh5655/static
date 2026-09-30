const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Dragging images and files into Static, off-screen:
 *   - onto the tab strip: a file from the computer opens in a new tab
 *   - an image that exists only in memory (a data: picture from a page) too
 *   - onto a tab: it replaces that tab
 *   - a link still opens as before
 *   - dropped onto a page: it opens in a new tab beside it, not as file://
 *   - static-file:// serves ONLY dropped files, by token
 */

async function run(browser) {
  const { app, nativeImage } = require('electron');
  // An 8x6 picture.
  const PNG = nativeImage.createFromBitmap(Buffer.alloc(8 * 6 * 4, 200), { width: 8, height: 6 }).toPNG();
  const { allowedURL } = require('../src/shared/urls');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 60, ms = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(ms); } return null; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-drop-'));
  const photo = path.join(dir, 'holiday photo.png');
  fs.writeFileSync(photo, PNG);
  const secret = path.join(dir, 'not dropped.txt');
  fs.writeFileSync(secret, 'private');

  try {
    await until(() => browser.tabs?.active, 80);
    await wait(600);
    const chrome = browser.chrome.webContents;
    const tabUrls = () => browser.tabs.list().map((t) => t.url);
    let known = new Set(browser.tabs.tabs.keys());
    /** The tab that appeared since the last call. */
    const newest = () => {
      const fresh = [...browser.tabs.tabs.keys()].find((id) => !known.has(id));
      known = new Set(browser.tabs.tabs.keys());
      return fresh ? browser.tabs.tabs.get(fresh) : null;
    };
    const loaded = (tab) => until(() => tab && !tab.view.webContents.isLoading() && tab.view.webContents.getURL());
    const imageIn = (tab) => until(() => tab.view.webContents.executeJavaScript(`document.images[0] && document.images[0].naturalWidth ? [document.images[0].naturalWidth, document.images[0].naturalHeight, document.contentType] : null`).catch(() => null));

    // 1. A file from the computer, dropped on the tab strip (by path).
    let before = browser.tabs.list().length;
    await chrome.executeJavaScript(`window.browser.invoke('tabs:open-files', { files: [{ path: ${JSON.stringify(photo)} }] })`);
    await until(() => browser.tabs.list().length === before + 1);
    let tab = newest();
    await loaded(tab);
    check('a dropped image file opens in a new tab', /^static-file:\/\/[a-f0-9]{32}\/holiday%20photo\.png$/.test(tab?.view.webContents.getURL() || ''), tab?.view.webContents.getURL());
    let image = await imageIn(tab);
    check('and shows the image', image && image[0] === 8 && image[1] === 6 && image[2] === 'image/png', JSON.stringify(image));
    check('the address bar calls it a file on this computer', browser.tabs.activeState().security === 'file', browser.tabs.activeState().security);

    // 2. The same drop through the real tab strip, with an in-memory image
    //    (what dragging a data: picture out of a page gives).
    before = browser.tabs.list().length;
    await chrome.executeJavaScript(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'from a page.png', { type: 'image/png' }));
      const strip = document.getElementById('tabs');
      const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
      strip.dispatchEvent(over);
      window.__accepted = over.defaultPrevented;
      strip.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: strip.getBoundingClientRect().right - 2, clientY: 10 }));
    })()`);
    check('the tab strip accepts a dragged image', await chrome.executeJavaScript('window.__accepted'));
    await until(() => browser.tabs.list().length === before + 1);
    tab = newest();
    await loaded(tab);
    image = await imageIn(tab);
    check('an image dragged from a page (no address) opens in a new tab', /^static-file:\/\/[a-f0-9]{32}\/from%20a%20page\.png$/.test(tab?.view.webContents.getURL() || '') && image?.[0] === 8, tab?.view.webContents.getURL());

    // 3. Onto a tab: it replaces that tab.
    const target = browser.tabs.active;
    before = browser.tabs.list().length;
    await chrome.executeJavaScript(`window.browser.invoke('tabs:open-files', { files: [{ path: ${JSON.stringify(photo)} }], intoTab: ${JSON.stringify(target.id)} })`);
    await until(() => /^static-file:/.test(target.view.webContents.getURL()));
    check('dropped onto a tab, it opens in that tab', browser.tabs.list().length === before && /^static-file:/.test(target.view.webContents.getURL()));

    newest();
    // 4. Links still open as before.
    before = browser.tabs.list().length;
    await chrome.executeJavaScript(`(() => {
      const data = new DataTransfer();
      data.setData('text/uri-list', 'https://example.com/dropped');
      const plus = document.getElementById('newtab');
      plus.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      plus.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await until(() => browser.tabs.list().length === before + 1);
    check('a dropped link still opens in a new tab, once', browser.tabs.list().length === before + 1 && tabUrls().some((u) => u.startsWith('https://example.com/dropped')), tabUrls().join(' '));

    newest();
    // 5. A file dropped onto a page: never file://, a new tab beside it instead.
    const page = browser.tabs.active;
    before = browser.tabs.list().length;
    let prevented = false;
    const event = { url: pathToFileURL(photo).href, preventDefault: () => { prevented = true; } };
    page.view.webContents.emit('will-navigate', event, event.url);
    await until(() => browser.tabs.list().length === before + 1);
    const beside = newest();
    await loaded(beside);
    check('a file dropped on a page opens in a new tab, not as file://', prevented && /^static-file:/.test(beside?.view.webContents.getURL() || ''), beside?.view.webContents.getURL());
    let ours = false;
    const internal = { url: pathToFileURL(path.join(app.getAppPath(), 'src', 'renderer', 'pages', 'settings.html')).href, preventDefault: () => { ours = true; } };
    page.view.webContents.emit('will-navigate', internal, internal.url);
    check("Static's own pages are not mistaken for dropped files", !ours);

    // 6. The scheme serves dropped files and nothing else.
    const probe = beside.view.webContents;
    const other = await probe.executeJavaScript(`fetch('static-file://${'0'.repeat(32)}/x').then(r => r.status).catch(e => 'error')`);
    check('an unknown token gets nothing', other === 404 || other === 'error', other);
    check('a path can never be an address', !allowedURL('static-file://C:/Users/x.txt') && !allowedURL('static-file://../etc/passwd') && !allowedURL(pathToFileURL(secret).href));
    check('a token address is allowed', allowedURL('static-file://' + 'ab'.repeat(16) + '/a.png'));

    // 7. Kept across restarts: the list is on disk.
    const saved = JSON.parse(fs.readFileSync(path.join(browser.dir, 'dropped-files.json'), 'utf8'));
    check('dropped files are remembered for restored tabs', saved.some((e) => e.path === photo));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall drop checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
