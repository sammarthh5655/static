'use strict';

const { NEW_TAB_URL, INTERNAL_SCHEME } = require('./lib/url');

/**
 * Keyboard shortcuts.
 *
 * Shortcuts are handled in the main process from `before-input-event`, which
 * fires for both the UI chrome renderer and every tab's webContents. That way
 * Ctrl+T works no matter which part of the window has focus, and web pages
 * cannot swallow browser-level shortcuts.
 *
 * `handle(controller, input)` returns true when it consumed the event.
 * Add new shortcuts to the table below; the key is built by `describe()`.
 */

const isMac = process.platform === 'darwin';

/** Build a normalized "Ctrl+Shift+T" style key from an Electron Input. */
function describe(input) {
  const parts = [];
  // On macOS the primary modifier is Cmd; everywhere else it's Ctrl.
  const primary = isMac ? input.meta : input.control;
  if (primary) parts.push('Mod');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (isMac && input.control) parts.push('Ctrl');

  let key = input.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** @type {Record<string, (c: import('./window').BrowserWindowController) => void>} */
const BINDINGS = {
  'Mod+T': (c) => c.tabs.create({ url: c.ctx.settings.newTabUrl() }),
  'Mod+W': (c) => c.tabs.active && c.tabs.close(c.tabs.active.id),
  'Mod+F4': (c) => c.tabs.active && c.tabs.close(c.tabs.active.id),
  'Mod+Shift+T': (c) => c.tabs.reopenClosed(),
  'Mod+N': (c) => c.ctx.windows.createWindow(),
  'Mod+Shift+W': (c) => c.win.close(),
  'Mod+Tab': (c) => c.tabs.selectRelative(1),
  'Mod+Shift+Tab': (c) => c.tabs.selectRelative(-1),
  'Mod+PageDown': (c) => c.tabs.selectRelative(1),
  'Mod+PageUp': (c) => c.tabs.selectRelative(-1),
  'Mod+L': (c) => c.focusOmnibox(),
  'Mod+E': (c) => c.focusOmnibox(),
  'Alt+D': (c) => c.focusOmnibox(),
  'Mod+R': (c) => c.tabs.active?.reload(),
  'F5': (c) => c.tabs.active?.reload(),
  'Mod+Shift+R': (c) => c.tabs.active?.wc.reloadIgnoringCache(),
  'Escape': (c) => c.tabs.active?.wc.stop(),
  'Alt+ArrowLeft': (c) => c.tabs.active?.wc.navigationHistory.goBack(),
  'Alt+ArrowRight': (c) => c.tabs.active?.wc.navigationHistory.goForward(),
  'Alt+Home': (c) => c.tabs.active?.navigate(c.ctx.settings.homepageUrl()),
  'Mod+D': (c) => c.toggleBookmarkActive(),
  'Mod+Shift+B': (c) => c.ctx.settings.set({ showBookmarksBar: !c.ctx.settings.get('showBookmarksBar') }),
  'Mod+H': (c) => c.tabs.create({ url: `${INTERNAL_SCHEME}://history/` }),
  'Mod+J': (c) => c.tabs.create({ url: `${INTERNAL_SCHEME}://downloads/` }),
  'Mod+Shift+O': (c) => c.tabs.create({ url: `${INTERNAL_SCHEME}://bookmarks/` }),
  'Mod+Shift+Delete': (c) => c.tabs.create({ url: `${INTERNAL_SCHEME}://settings/#clear` }),
  'F12': (c) => c.tabs.active?.wc.toggleDevTools(),
  'Mod+Shift+I': (c) => c.tabs.active?.wc.toggleDevTools(),
  'Mod+=': (c) => zoom(c, +0.5),
  'Mod++': (c) => zoom(c, +0.5),
  'Mod+-': (c) => zoom(c, -0.5),
  'Mod+0': (c) => c.tabs.active?.wc.setZoomLevel(0),
  'F11': (c) => c.win.setFullScreen(!c.win.isFullScreen()),
  'Mod+P': (c) => c.tabs.active?.wc.print(),
  'Mod+U': (c) => { const t = c.tabs.active; if (t) c.tabs.create({ url: `view-source:${t.url}`, openerId: t.id }); },
};

// Ctrl+1..8 -> nth tab, Ctrl+9 -> last tab.
for (let i = 1; i <= 8; i++) BINDINGS[`Mod+${i}`] = (c) => c.tabs.selectIndex(i - 1);
BINDINGS['Mod+9'] = (c) => c.tabs.selectIndex('last');

function zoom(c, delta) {
  const wc = c.tabs.active?.wc;
  if (!wc) return;
  wc.setZoomLevel(Math.max(-5, Math.min(5, wc.getZoomLevel() + delta)));
}

class Shortcuts {
  /**
   * @param {import('./window').BrowserWindowController} controller
   * @param {Electron.Input} input
   * @returns {boolean} true if handled
   */
  handle(controller, input, source = 'tab') {
    if (input.type !== 'keyDown') return false;
    if (input.isAutoRepeat && input.key !== 'Tab') return false;
    const combo = describe(input);
    const fn = BINDINGS[combo];
    if (!fn) return false;
    // Escape: in the chrome it belongs to the omnibox (revert text); in a
    // page it stops loading, and only when something is actually loading.
    if (combo === 'Escape' && (source === 'ui' || !controller.tabs.active?.loading)) return false;
    fn(controller);
    return true;
  }
}

module.exports = { Shortcuts, describe, NEW_TAB_URL };
