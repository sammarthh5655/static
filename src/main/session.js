'use strict';

const { session, dialog } = require('electron');

/**
 * Partition for everything that is "web content": tabs, extensions, cookies,
 * cache. Must be `persist:` so extensions can be loaded (Electron refuses to
 * load extensions into in-memory sessions).
 */
const TAB_PARTITION = 'persist:static';

/** Permissions we grant silently, like Chrome does without a prompt. */
const AUTO_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'window-management',
  'idle-detection',
  'background-sync',
]);

/** Permissions that get a yes/no prompt naming the requesting origin. */
const PROMPT = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'clipboard-read']);

function createTabSession() {
  const tabSession = session.fromPartition(TAB_PARTITION);

  // Strip the "Electron/x.y" and app-name tokens so sites (and the Chrome Web
  // Store in particular) treat us like a regular Chrome build.
  const ua = tabSession.getUserAgent()
    .replace(/ Electron\/\S+/i, '')
    .replace(/ static\/\S+/i, '');
  tabSession.setUserAgent(ua);

  // Remembered per-origin decisions for prompted permissions, session-scoped.
  const decisions = new Map(); // key: `${origin}|${permission}` -> boolean

  tabSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    if (!PROMPT.has(permission)) return callback(false);

    const origin = safeOrigin(details.requestingUrl || wc.getURL());
    const key = `${origin}|${permission}`;
    if (decisions.has(key)) return callback(decisions.get(key));

    const win = require('electron').BrowserWindow.fromWebContents(wc) || undefined;
    dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permission request',
      message: `${origin} wants to use ${describePermission(permission, details)}`,
    }).then(({ response }) => {
      const allowed = response === 0;
      decisions.set(key, allowed);
      callback(allowed);
    });
  });

  tabSession.setPermissionCheckHandler((wc, permission) => {
    if (AUTO_ALLOW.has(permission)) return true;
    // Synchronous checks (e.g. Notification.permission) can only report what
    // has already been decided; unknown => false.
    return false;
  });

  return tabSession;
}

function describePermission(permission, details) {
  switch (permission) {
    case 'media': {
      const types = details.mediaTypes || [];
      if (types.includes('video') && types.includes('audio')) return 'your camera and microphone';
      if (types.includes('video')) return 'your camera';
      if (types.includes('audio')) return 'your microphone';
      return 'media devices';
    }
    case 'geolocation': return 'your location';
    case 'notifications': return 'notifications';
    case 'midi':
    case 'midiSysex': return 'MIDI devices';
    case 'clipboard-read': return 'your clipboard';
    case 'openExternal': return 'an external application';
    default: return permission;
  }
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

module.exports = { createTabSession, TAB_PARTITION };
