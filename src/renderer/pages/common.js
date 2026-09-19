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

/**
 * Subscribe to pushed app state; calls back immediately with current state.
 * Theme variables are applied before every callback, so a page never paints
 * one frame with the previous theme after the user changes it.
 */
function onState(callback) {
  const wrapped = (state) => {
    if (state?.settings) applyTheme(state.settings);
    callback(state);
  };
  bridge.on('app:state', wrapped);
  invoke('app:state').then(wrapped).catch((error) => console.error('app:state', error));
}

/**
 * Write the theme's CSS variables onto :root.
 *
 * Uses style.setProperty rather than injecting a <style> block, because the
 * CSP on these pages forbids inline stylesheets.
 */
let appliedTheme = '';
function applyTheme(settings) {
  if (!window.theme) return;
  const key = JSON.stringify(window.theme.cssVariables(settings));
  if (key === appliedTheme) return;
  appliedTheme = key;
  for (const [name, value] of Object.entries(window.theme.cssVariables(settings))) {
    document.documentElement.style.setProperty(name, value);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an icon from the shared icon set. Outline unless `filled`. */
function icon(name, { filled = false, size = 16 } = {}) {
  const spec = window.theme?.ICONS?.[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg');
  if (!spec) return svg;
  const path = document.createElementNS(SVG_NS, 'path');
  const useFill = filled && spec.fill;
  path.setAttribute('d', useFill ? spec.fill : spec.outline);
  path.setAttribute('fill', useFill ? 'currentColor' : 'none');
  path.setAttribute('stroke', useFill ? 'none' : 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * A site's real favicon, via Google's favicon service.
 *
 * Falls back to a letter avatar when the request fails, so a site with no
 * icon still renders something aligned with the others.
 */
function favicon(url, size = 20) {
  const wrap = document.createElement('span');
  wrap.className = 'favicon-slot';
  let host = '';
  try { host = new URL(url).hostname; } catch { /* leave blank */ }

  const img = document.createElement('img');
  img.className = 'favicon-img';
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  img.src = 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host);
  img.addEventListener('error', () => {
    const letter = document.createElement('span');
    letter.className = 'favicon-letter';
    letter.textContent = (host.replace(/^www\./, '').charAt(0) || '?').toUpperCase();
    img.replaceWith(letter);
  });
  wrap.append(img);
  return wrap;
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

  window.page = {
    invoke, onState, $, element, timeAgo, formatBytes, openUrl, icon, favicon, applyTheme,
    // Needed by the shell so Ctrl+K becomes Cmd+K on macOS.
    platform: bridge.platform,
  };
})();
