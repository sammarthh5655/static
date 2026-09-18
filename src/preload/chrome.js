const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
const { requests, events } = require('../shared/channels');
// This bundle belongs only to our local chrome WebContentsView, never web tabs.
// Main validates sender identity AND its top-level URL on every application IPC.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/index.html')) {
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
  }));
  // The upstream helper exposes only its browser-action interface, not ipcRenderer.
  injectBrowserAction();
}
