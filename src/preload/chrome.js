const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
const { requests, events } = require('../shared/channels');
// This bundle belongs only to our local chrome WebContentsView, never web tabs.
// Main validates sender identity AND its top-level URL on every application IPC.
// Both the chrome and the transparent menu overlay use this preload. Main
// validates the sender URL independently on every call, so listing them here
// is the first of two checks, not the only one.
const TRUSTED = ['/renderer/index.html', '/renderer/overlay.html'];
if (location.protocol === 'file:' && TRUSTED.some(p => location.pathname.endsWith(p))) {
  contextBridge.exposeInMainWorld('browser', Object.freeze({
    invoke(channel, payload) {
      if (!requests.includes(channel)) return Promise.reject(new Error('Unknown browser operation'));
      return ipcRenderer.invoke(channel, payload);
    },
    on(channel, callback) {
      if (!events.includes(channel) || typeof callback !== 'function') throw new Error('Unknown browser event');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    platform: process.platform,
    // Where a file dragged in from the computer lives, so it can open in a tab.
    // Empty for a file that exists only in memory (an image from a page).
    filePath(file) {
      try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
    },
  }));
  // The upstream helper exposes only its browser-action interface, not ipcRenderer.
  // Extension action buttons belong in the toolbar only, not the overlay.
  if (location.pathname.endsWith('/renderer/index.html')) injectBrowserAction();
}
