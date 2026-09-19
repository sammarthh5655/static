const assert = require('node:assert');

/**
 * Headless-ish smoke test: boots the real application, drives it through the
 * feature surface, and exits non-zero on failure. Run with `npm run test:smoke`.
 *
 * This runs INSIDE Electron (main.js requires it when --smoke is passed), so it
 * can touch the live objects directly rather than automating the UI.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` returns truthy, or fail after `timeout` ms. */
async function until(label, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let value;
    try { value = await check(); } catch { value = false; }
    if (value) return value;
    await wait(100);
  }
  throw new Error('Timed out waiting for: ' + label);
}

async function run(browser) {
  const { app } = require('electron');
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push('  ok  ' + name); }
    catch (error) { results.push('FAIL  ' + name + ' :: ' + error.message); throw error; }
  };

  try {
    await step('window and chrome exist', async () => {
      assert.ok(browser.window, 'no window');
      assert.ok(browser.chrome, 'no chrome view');
      await until('chrome loaded', () => !browser.chrome.webContents.isLoading());
    });

    await step('starts with one tab', async () => {
      await until('first tab', () => browser.tabs.order.length >= 1);
      assert.strictEqual(browser.tabs.order.length, 1);
    });

    await step('new tab page loads', async () => {
      const tab = browser.tabs.active;
      assert.ok(tab, 'no active tab');
      await until('newtab committed', () => !tab.view.webContents.isLoading());
      assert.strictEqual(tab.state.displayUrl, 'browser://newtab');
    });

    await step('second launches restore the window without colliding with Focus Mode', async () => {
      const { spawn } = require('node:child_process');
      const window = browser.window;
      const focusMode = browser.focus;
      const tabCount = browser.tabs.order.length;
      assert.strictEqual(typeof focusMode.shouldBlock, 'function');

      for (const state of ['minimized', 'hidden']) {
        if (state === 'minimized') window.minimize();
        else window.hide();
        await until(state + ' window', () => state === 'minimized'
          ? window.isMinimized() : !window.isVisible());

        let received = false;
        let exited = false;
        let exitCode;
        let childError;
        const onSecondInstance = () => { received = true; };
        app.on('second-instance', onSecondInstance);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        // Use the same isolated smoke profile to exercise the real OS lock and
        // main.js event handler without touching the user's running browser.
        const child = spawn(process.execPath, [app.getAppPath(), '--smoke'], {
          env, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', error => { childError = error; exited = true; });
        child.once('exit', code => { exitCode = code; exited = true; });
        try {
          await until('second process exits', () => exited);
          assert.ifError(childError);
          assert.strictEqual(exitCode, 0);
          await until('existing window restored', () => received &&
            window.isVisible() && !window.isMinimized());
          assert.strictEqual(browser.window, window);
          assert.strictEqual(browser.tabs.order.length, tabCount);
          assert.strictEqual(browser.focus, focusMode);
          assert.strictEqual(typeof browser.focus.shouldBlock, 'function');
        } finally {
          app.removeListener('second-instance', onSecondInstance);
          if (!exited) child.kill();
        }
      }

      window.hide();
      app.emit('activate');
      await until('activation shows existing window', () => window.isVisible());
      assert.strictEqual(browser.window, window);
    });

    await step('opens and closes tabs', async () => {
      const id = browser.tabs.create({ url: 'browser://settings' });
      assert.strictEqual(browser.tabs.order.length, 2);
      assert.strictEqual(browser.tabs.activeId, id);
      browser.tabs.close(id);
      assert.strictEqual(browser.tabs.order.length, 1);
    });

    await step('never drops to zero tabs', async () => {
      browser.tabs.close(browser.tabs.activeId);
      assert.strictEqual(browser.tabs.order.length, 1, 'should have replaced the last tab');
    });

    await step('reorders tabs', async () => {
      const a = browser.tabs.activeId;
      const b = browser.tabs.create({ url: 'browser://history', background: true });
      browser.tabs.reorder(b, 0);
      assert.deepStrictEqual(browser.tabs.order, [b, a]);
      browser.tabs.close(b);
    });

    await step('omnibox resolves searches and URLs', async () => {
      const { resolveInput } = require('../src/shared/urls');
      assert.match(resolveInput('hello world', 'google'), /^https:\/\/www\.google\.com\/search/);
      assert.match(resolveInput('hello world', 'brave'), /^https:\/\/search\.brave\.com\/search/);
      assert.strictEqual(resolveInput('example.com'), 'https://example.com/');
      assert.strictEqual(resolveInput('localhost:3000'), 'http://localhost:3000/');
    });

    await step('bookmarks round-trip', async () => {
      browser.bookmarks.toggle('https://example.com/', 'Example');
      assert.strictEqual(browser.bookmarks.list().length, 1);
      browser.bookmarks.toggle('https://example.com/', 'Example');
      assert.strictEqual(browser.bookmarks.list().length, 0);
    });

    await step('history records and searches', async () => {
      browser.history.record('https://example.org/page', 'Example page');
      assert.strictEqual(browser.history.search('example').length, 1);
      browser.history.clear();
      assert.strictEqual(browser.history.search('').length, 0);
    });

    await step('settings validate input', async () => {
      browser.settings.update({ searchEngine: 'brave' });
      assert.strictEqual(browser.settings.value.searchEngine, 'brave');
      assert.throws(() => browser.settings.update({ searchEngine: 'evil' }));
      assert.throws(() => browser.settings.update({ nope: 1 }));
      browser.settings.update({ searchEngine: 'google' });
    });

    await step('state snapshot is complete', async () => {
      const state = browser.state();
      for (const key of ['tabs', 'active', 'bookmarks', 'downloads', 'settings', 'extensions', 'history']) {
        assert.ok(key in state, 'state missing ' + key);
      }
    });

    await step('extension subsystem started', async () => {
      assert.ok(browser.extensions, 'no extensions module');
      assert.ok(browser.extensions.api, 'extension API did not initialise');
      assert.ok(Array.isArray(browser.extensions.list()));
    });

    await step('loads a real web page', async () => {
      const id = browser.tabs.create({ url: 'https://example.com' });
      const tab = browser.tabs.tabs.get(id);
      await until('example.com loaded', () =>
        !tab.view.webContents.isLoading() && tab.state.url.startsWith('https://example.com'));
      assert.strictEqual(tab.state.security, 'secure');
      browser.tabs.close(id);
    });

    console.log('\nSmoke test results:');
    results.forEach((line) => console.log(line));
    console.log('\nAll smoke checks passed.\n');
    app.exit(0);
  } catch (error) {
    console.error('\nSmoke test results:');
    results.forEach((line) => console.error(line));
    console.error('\nSmoke test failed:', error.message, '\n');
    app.exit(1);
  }
}

module.exports = { run };
