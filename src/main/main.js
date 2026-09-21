'use strict';

/**
 * Main-process entry point. Deliberately thin: it wires the shared context,
 * boots each feature module in dependency order, and opens the first window.
 * Feature logic lives in `src/features/<name>/index.js`; window/view plumbing
 * in `src/main/window.js`; IPC policy in `src/main/ipc.js`.
 */

const { app, session } = require('electron');

// electron-chrome-extensions registers the `crx` privileged scheme the moment
// it's required. Electron only keeps the LAST registerSchemesAsPrivileged
// call, so require it first and let protocol.js register the union.
require('electron-chrome-extensions');
const { registerPrivilegedSchemes, handleInternalProtocol } = require('./protocol');
const { createTabSession } = require('./session');
const { flushAll } = require('./lib/json-store');
const { WindowManager, attachSearchHelpers } = require('./window-manager');
const { Shortcuts } = require('./shortcuts');
const { installApplicationMenu } = require('./app-menu');

const { Settings } = require('../features/settings');
const { History } = require('../features/history');
const { Bookmarks } = require('../features/bookmarks');
const { Downloads } = require('../features/downloads');
const { Omnibox } = require('../features/omnibox');
const { Extensions } = require('../features/extensions');

app.setName('Static');
registerPrivilegedSchemes();

/**
 * Shared context handed to every feature and window. Features reach each
 * other through it (e.g. tabs -> history.add) instead of requiring each
 * other, which keeps the dependency graph flat.
 */
const ctx = {
  tabSession: null,     // persist:static — all web content + extensions
  uiSession: null,      // default session — the browser chrome itself
  windows: null,        // WindowManager
  shortcuts: new Shortcuts(),
  settings: null,
  history: null,
  bookmarks: null,
  downloads: null,
  omnibox: null,
  extensionsFeature: null, // our wrapper (enable/disable/list)
  extensions: null,        // ElectronChromeExtensions instance (set once ready)
};

// One instance only: a second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const c = ctx.windows?.focused();
    if (c) {
      if (c.win.isMinimized()) c.win.restore();
      c.win.focus();
    }
  });
}

async function boot() {
  ctx.tabSession = createTabSession();
  ctx.uiSession = session.defaultSession;
  handleInternalProtocol(ctx.tabSession);

  ctx.settings = new Settings(ctx);
  ctx.history = new History(ctx);
  ctx.bookmarks = new Bookmarks(ctx);
  ctx.downloads = new Downloads(ctx);
  ctx.omnibox = new Omnibox(ctx);
  ctx.windows = new WindowManager(ctx);
  attachSearchHelpers(ctx);

  ctx.downloads.attach(ctx.tabSession);

  // IPC handlers. Every channel must be declared in src/shared/channels.js.
  ctx.settings.registerIpc();
  ctx.history.registerIpc();
  ctx.bookmarks.registerIpc();
  ctx.downloads.registerIpc();
  ctx.omnibox.registerIpc();
  ctx.windows.registerIpc();

  // Extensions come up before the first window so the toolbar shows their
  // actions immediately and chrome.tabs sees every tab from the start.
  ctx.extensionsFeature = new Extensions(ctx);
  ctx.extensionsFeature.registerIpc();
  try {
    await ctx.extensionsFeature.init();
  } catch (err) {
    console.error('extensions: failed to initialise', err);
  }

  installApplicationMenu(ctx.windows);
  ctx.windows.createWindow();
}

app.whenReady().then(boot).catch((err) => {
  console.error('Fatal error during startup', err);
  app.quit();
});

app.on('activate', () => {
  // macOS: clicking the dock icon with no windows open.
  if (ctx.windows && ctx.windows.controllers.length === 0) ctx.windows.createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => flushAll());

// Surface renderer crashes in the terminal rather than failing silently.
app.on('render-process-gone', (_e, wc, details) => {
  console.error(`renderer gone (${details.reason}) for ${wc.getURL()}`);
});
