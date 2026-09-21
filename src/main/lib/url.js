'use strict';

const { buildSearchUrl } = require('./search-engines');

/** Scheme used for built-in pages: static://newtab, static://settings, ... */
const INTERNAL_SCHEME = 'static';

/** URL for the built-in new tab page. */
const NEW_TAB_URL = `${INTERNAL_SCHEME}://newtab/`;

/** Schemes we navigate to directly when typed with an explicit scheme. */
const NAVIGABLE_SCHEMES = new Set([
  'http', 'https', 'file', 'about', 'data', 'blob', 'view-source',
  'chrome-extension', INTERNAL_SCHEME,
]);

/** chrome://foo aliases -> our internal pages, so muscle memory works. */
const CHROME_ALIASES = new Set(['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'extensions']);

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+(?::\d{1,5})?(?:[/?#].*)?$/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#].*)?$/;
const LOCALHOST_RE = /^localhost(?::\d{1,5})?(?:[/?#].*)?$/i;
const HOST_PORT_RE = /^[a-z0-9-]+:\d{1,5}(?:[/?#].*)?$/i;

/**
 * Decide what the omnibox input means.
 *
 * @returns {{type: 'url'|'search', url: string, fallbackUrl?: string}|null}
 *   `fallbackUrl` is set when we guessed https:// for a bare host; the tab
 *   retries with http:// if the https attempt fails at the network level.
 */
function parseOmniboxInput(rawText, searchEngineId) {
  const text = (rawText || '').trim();
  if (!text) return null;

  const hasSpace = /\s/.test(text);
  const schemeMatch = text.match(/^([a-z][a-z0-9+.-]*):/i);

  if (schemeMatch && !hasSpace) {
    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === 'chrome') {
      const page = text.replace(/^chrome:\/*/i, '').replace(/[/?#].*$/, '');
      if (CHROME_ALIASES.has(page)) {
        return { type: 'url', url: `${INTERNAL_SCHEME}://${page}/` };
      }
    }

    if (NAVIGABLE_SCHEMES.has(scheme)) {
      return { type: 'url', url: text };
    }

    // "localhost:3000" / "myhost:8080" looks like a scheme but is host:port.
    if (HOST_PORT_RE.test(text)) {
      return { type: 'url', url: `http://${text}` };
    }
  }

  if (!hasSpace) {
    if (LOCALHOST_RE.test(text) || IPV4_RE.test(text)) {
      return { type: 'url', url: `http://${text}` };
    }
    if (HOST_RE.test(text)) {
      return { type: 'url', url: `https://${text}`, fallbackUrl: `http://${text}` };
    }
  }

  return { type: 'search', url: buildSearchUrl(searchEngineId, text) };
}

function isInternalUrl(url) {
  return typeof url === 'string' && url.startsWith(`${INTERNAL_SCHEME}://`);
}

/** Human-friendly host for a URL (used in suggestions/history UI). */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

module.exports = { parseOmniboxInput, isInternalUrl, hostOf, NEW_TAB_URL, INTERNAL_SCHEME };
