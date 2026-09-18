'use strict';

// Wrapped in an IIFE: classic scripts share one global scope, so a top-level
// `const invoke` here would collide with the same name in each page script.
(function () {

/**
 * Helpers shared by every browser:// page.
 *
 * `window.browser` is injected by src/preload/tab.js, but only for pages
 * loaded from renderer/pages/. If it is missing we are running somewhere we
 * should not be, so every call fails loudly rather than silently doing nothing.
 */

const bridge = window.browser;
if (!bridge) throw new Error('Browser bridge unavailable on this page');

const invoke = (channel, payload) => bridge.invoke(channel, payload);

/** Subscribe to pushed app state; calls back immediately with current state. */
function onState(callback) {
  bridge.on('app:state', callback);
  invoke('app:state').then(callback).catch(() => {});
}

const $ = (selector) => document.querySelector(selector);

function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...[].concat(children).filter(Boolean));
  return node;
}

/** "3 minutes ago" / "Feb 4" for history and download rows. */
function timeAgo(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hr ago';
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(value < 10 && unit > 0 ? 1 : 0) + ' ' + units[unit];
}

/** Open a URL: plain click navigates this tab, middle/ctrl opens a new one. */
function openUrl(url, event) {
  if (event && (event.button === 1 || event.ctrlKey || event.metaKey)) {
    return invoke('tabs:new', { url, background: true });
  }
  return invoke('tabs:navigate', { input: url });
}

  window.page = { invoke, onState, $, element, timeAgo, formatBytes, openUrl };
})();
