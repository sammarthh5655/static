'use strict';

const { ipcMain, webContents: electronWebContents } = require('electron');
const { INVOKE, EVENTS, UI, PAGE } = require('../shared/channels');
const { INTERNAL_SCHEME } = require('./lib/url');

/**
 * Thin wrapper around ipcMain that enforces the channel registry in
 * `src/shared/channels.js`.
 *
 * Every channel declares which scopes may call it. Before a handler runs we
 * check that the *sender* actually belongs to one of those scopes:
 *   - UI:   the sender must be a webContents we registered as trusted chrome
 *           (the window's own webContents or the omnibox dropdown overlay).
 *   - PAGE: the sender frame must be a top-level `static://` page.
 * A web page (https://...) can never reach these handlers even if it somehow
 * obtained an ipcRenderer, because the sender check fails.
 */

/** WebContents instances that are allowed to use UI-scoped channels. */
const trustedUI = new Set();

function registerUIContents(wc) {
  trustedUI.add(wc);
  wc.once('destroyed', () => trustedUI.delete(wc));
}

function isInternalPageFrame(frame) {
  if (!frame) return false;
  // Only top frames: an <iframe> inside an internal page is not trusted.
  if (frame.parent) return false;
  return frame.url.startsWith(`${INTERNAL_SCHEME}://`);
}

function senderScopes(event) {
  const scopes = [];
  if (trustedUI.has(event.sender)) scopes.push(UI);
  if (isInternalPageFrame(event.senderFrame)) scopes.push(PAGE);
  return scopes;
}

function authorize(event, allowed) {
  return senderScopes(event).some((s) => allowed.includes(s));
}

/**
 * Register an invoke handler. `fn(event, ...args)` receives the raw event so
 * handlers can find the calling window through `event.sender`.
 */
function handle(channel, fn) {
  const allowed = INVOKE[channel];
  if (!allowed) {
    throw new Error(`ipc: channel "${channel}" is not declared in shared/channels.js`);
  }
  ipcMain.handle(channel, (event, ...args) => {
    if (!authorize(event, allowed)) {
      console.warn(`ipc: rejected "${channel}" from unauthorized sender ${event.sender.id}`);
      throw new Error(`Unauthorized IPC channel: ${channel}`);
    }
    return fn(event, ...args);
  });
}

/** Send an event to a specific webContents (validated against EVENTS). */
function send(wc, channel, payload) {
  if (!EVENTS[channel]) {
    throw new Error(`ipc: event "${channel}" is not declared in shared/channels.js`);
  }
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

/** Broadcast an event to every trusted UI renderer. */
function broadcastUI(channel, payload) {
  for (const wc of trustedUI) send(wc, channel, payload);
}

/** Broadcast an event to every top-level internal page currently loaded. */
function broadcastPages(channel, payload) {
  for (const wc of electronWebContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (wc.getURL().startsWith(`${INTERNAL_SCHEME}://`)) send(wc, channel, payload);
  }
}

/** Broadcast to whichever scopes the event channel is declared for. */
function broadcast(channel, payload) {
  const scopes = EVENTS[channel] || [];
  if (scopes.includes(UI)) broadcastUI(channel, payload);
  if (scopes.includes(PAGE)) broadcastPages(channel, payload);
}

module.exports = { handle, send, broadcast, broadcastUI, broadcastPages, registerUIContents };
