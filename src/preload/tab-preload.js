'use strict';

/**
 * Preload attached to EVERY tab (all web content). It must stay minimal:
 * for ordinary pages it does nothing at all. Only when the page is one of
 * our own `static://` internal pages does it expose `window.staticPages`,
 * a whitelisted subset of IPC (see PAGE scope in src/shared/channels.js).
 *
 * The main process re-checks the sender frame's URL for every PAGE call, so
 * this check is a convenience, not the security boundary.
 *
 * Bundled by esbuild into dist/tab-preload.js (sandboxed preloads can't
 * require anything except 'electron').
 */
const { contextBridge, ipcRenderer } = require('electron');
const { INVOKE, EVENTS, PAGE, channelsForScope } = require('../shared/channels');

const INTERNAL_PROTOCOL = 'static:';

if (window.location.protocol === INTERNAL_PROTOCOL) {
  const invokeAllowed = new Set(channelsForScope(INVOKE, PAGE));
  const eventAllowed = new Set(channelsForScope(EVENTS, PAGE));

  contextBridge.exposeInMainWorld('staticPages', {
    invoke(channel, ...args) {
      if (!invokeAllowed.has(channel)) {
        return Promise.reject(new Error(`staticPages: channel "${channel}" is not whitelisted`));
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
      if (!eventAllowed.has(channel)) {
        throw new Error(`staticPages: event "${channel}" is not whitelisted`);
      }
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    platform: process.platform,
  });
}
