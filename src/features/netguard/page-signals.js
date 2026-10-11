'use strict';

/**
 * What the tab preload does for network protection inside a page. Plain
 * JavaScript with no Node or Electron: the preload is sandboxed, and bundles
 * this (scripts/build.cjs).
 */

/**
 * The privacy signals a page's own scripts can read, set in its MAIN world
 * before any of them run (the preload is at document-start):
 *
 *   navigator.globalPrivacyControl === true   Global Privacy Control, which
 *     sites in California, Colorado and others must treat as an opt-out of
 *     selling or sharing personal data. Not in Chromium itself.
 *   navigator.doNotTrack === '1'              the older Do Not Track.
 *   document.referrer capped to an origin      when Strict referrers are on
 *     and the page was opened from another site, the page sees only that
 *     site's origin - the same as the Referer header it was sent.
 *
 * Getters on the prototypes, as the real properties are, so `in` and
 * property lookups behave like a browser that supports them natively.
 */
function signalsScript({ gpc = false, dnt = false, referrer = null } = {}) {
  const parts = [];
  if (gpc) parts.push(`define(Navigator.prototype, 'globalPrivacyControl', Object.getOwnPropertyDescriptor({ get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get);`);
  if (dnt) parts.push(`define(Navigator.prototype, 'doNotTrack', Object.getOwnPropertyDescriptor({ get doNotTrack() { return '1'; } }, 'doNotTrack').get);`);
  if (typeof referrer === 'string') {
    parts.push(`define(Document.prototype, 'referrer', Object.getOwnPropertyDescriptor({ get referrer() { return ${JSON.stringify(referrer)}; } }, 'referrer').get);`);
  }
  if (!parts.length) return '';
  return `(() => { const define = (target, name, get) => { try { Object.defineProperty(target, name, { get, configurable: true, enumerable: true }); } catch (e) {} }; ${parts.join(' ')} })();`;
}

/**
 * What document.referrer should read under Strict referrers: the origin of a
 * referrer from another site, or null to leave it as it is.
 */
function cappedReferrer(referrer, here, siteOf) {
  if (!referrer) return null;
  try {
    const from = new URL(referrer);
    const to = new URL(here);
    if (siteOf(from.hostname) === siteOf(to.hostname)) return null;
    const origin = from.origin + '/';
    return origin === referrer ? null : origin;
  } catch { return null; }
}

/**
 * An AMP document names its real page with <link rel=canonical>. Returns that
 * address, or '' for an ordinary page. Read at DOMContentLoaded.
 */
function ampCanonical(doc, here) {
  const root = doc.documentElement;
  if (!root || !(root.hasAttribute('amp') || root.hasAttribute('⚡'))) return '';
  const link = doc.querySelector('link[rel~="canonical"][href]');
  if (!link) return '';
  try {
    const target = new URL(link.getAttribute('href'), here);
    if (!/^https?:$/.test(target.protocol) || target.href === here) return '';
    return target.href;
  } catch { return ''; }
}

module.exports = { signalsScript, cappedReferrer, ampCanonical };
