const fs = require('node:fs');
const path = require('node:path');

/**
 * Capture the real UI to PNGs so chrome/renderer changes can be eyeballed
 * without launching interactively. Run with `npm run test:shot`.
 *
 * Whole-window captures are used for anything involving menus, because menus
 * render in a separate transparent overlay view and capturing that view on its
 * own yields an empty image.
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(browser) {
  const { app, desktopCapturer, screen } = require('electron');
  const out = path.join(app.getAppPath(), '.test-output');
  fs.mkdirSync(out, { recursive: true });

  // A frameless window is not composited the instant show() returns, so the
  // first capture can fail with "display surface not available". Retry briefly
  // rather than making every caller sleep for a worst-case duration.
  const shotView = async (wc, name) => {
    let lastError;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const image = await wc.capturePage();
        if (!image.isEmpty()) {
          fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
          return;
        }
      } catch (error) { lastError = error; }
      await wait(400);
    }
    console.log('  (skipped "' + name + '": ' +
      (lastError ? lastError.message : 'capture kept coming back empty') + ')');
  };

  /** Whole-window capture: the only way to see the menu overlay composited. */
  const shotWindow = async (name) => {
    const { width, height } = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width, height },
    });
    const source = sources.find((s) => s.name && s.name.includes('static'));
    if (!source || source.thumbnail.isEmpty()) {
      console.log('  (skipped window shot "' + name + '": window not capturable here)');
      return;
    }
    fs.writeFileSync(path.join(out, name + '.png'), source.thumbnail.toPNG());
  };

  try {
    browser.window.show();
    browser.window.focus();
    // Nudge the window so the compositor produces a surface. Without this the
    // first capturePage on a frameless window can fail outright with
    // "display surface not available".
    browser.window.setBounds({ x: 40, y: 40, width: 1280, height: 820 });
    await wait(2500);

    await shotView(browser.chrome.webContents, 'chrome');

    // Menus render in the overlay view, so only a window capture shows them.
    await browser.chrome.webContents.executeJavaScript(
      "document.getElementById('app-menu').click()");
    await wait(1000);
    await shotWindow('menu');
    await browser.overlay.webContents.executeJavaScript('window.ui.closeMenu()');
    await wait(500);

    await shotView(browser.tabs.active.view.webContents, 'newtab');

    // New tab customiser panel.
    await browser.tabs.active.view.webContents.executeJavaScript(
      "document.getElementById('customize').click()");
    await wait(1200);
    // The panel uses backdrop-filter, which a single-view capturePage does not
    // composite, so it would come out invisible. Capture the window instead.
    await shotWindow('customize');

    // A newly created tab needs a moment to composite before it can be
    // captured; selecting it first makes that reliable.
    const id = browser.tabs.create({ url: 'browser://settings' });
    browser.tabs.select(id);
    await wait(2500);
    await shotView(browser.tabs.tabs.get(id).view.webContents, 'settings');

    // A light-theme pass, to confirm the theme reaches every surface rather
    // than only the variables.
    browser.settings.update({ theme: 'light', surfaceStyle: 'shadow', radius: 'sharp' });
    browser.push();
    await wait(1200);
    await shotView(browser.chrome.webContents, 'chrome-light');
    await browser.chrome.webContents.executeJavaScript(
      "document.getElementById('app-menu').click()");
    await wait(1200);
    await shotWindow('menu-light');
    browser.settings.update({ theme: 'dark', surfaceStyle: 'frosted', radius: 'rounded' });

    console.log('Wrote screenshots to ' + out);
    app.exit(0);
  } catch (error) {
    console.error('Screenshot failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
