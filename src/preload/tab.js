const { contextBridge, ipcRenderer } = require('electron');
const { requests, events } = require('../shared/channels');

/**
 * Preload for TAB content. This runs inside every tab, including untrusted
 * web pages, so it must expose nothing by default.
 *
 * Internal pages (browser://newtab, browser://settings, ...) are loaded from
 * disk via loadFile, so they arrive here as file:// URLs under
 * `renderer/pages/`. Only those get the bridge. Main independently validates
 * the sender on every call, so a page that spoofs its location still fails.
 */
const isInternalPage = location.protocol === 'file:' &&
  /[\\/]renderer[\\/]pages[\\/][a-z]+\.html$/.test(location.pathname);

if (isInternalPage) {
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
}
