'use strict';

/**
 * Preload for the browser chrome (src/renderer/index.html) and the omnibox
 * dropdown overlay. Bundled by esbuild into dist/ui-preload.js because
 * sandboxed preloads can only `require('electron')` — everything else
 * (the channel registry, electron-chrome-extensions' browser-action element)
 * has to be inlined.
 *
 * Exposes exactly one object, `window.staticUI`, with:
 *   invoke(channel, ...args) -> Promise   (only UI-scoped INVOKE channels)
 *   on(channel, listener)    -> unsubscribe (only UI-scoped EVENTS channels)
 *   platform                 -> 'win32' | 'darwin' | 'linux'
 */
const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
const { INVOKE, EVENTS, UI, channelsForScope } = require('../shared/channels');

const invokeAllowed = new Set(channelsForScope(INVOKE, UI));
const eventAllowed = new Set(channelsForScope(EVENTS, UI));

contextBridge.exposeInMainWorld('staticUI', {
  invoke(channel, ...args) {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`staticUI: channel "${channel}" is not whitelisted`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!eventAllowed.has(channel)) {
      throw new Error(`staticUI: event "${channel}" is not whitelisted`);
    }
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
});

// Defines the <browser-action-list> custom element (extension toolbar icons
// + popups). It talks to electron-chrome-extensions over its own IPC channel
// ("crx-msg-remote"), which the library validates on the main side.
injectBrowserAction();
