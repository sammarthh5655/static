const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
const { requests, events } = require('../shared/channels');
const { PAGE_SCRIPT, isYouTubeHost } = require('../features/shields/youtube');
// Pre-built at build time: a sandboxed preload cannot read resources.json,
// so resolving the scriptlets here would silently produce nothing.
const BRAVE_YOUTUBE = require('../features/shields/brave/youtube-bundle');
// Plain JavaScript with no Node or Electron, bundled in (scripts/build.cjs).
const { signalsScript, cappedReferrer, ampCanonical } = require('../features/netguard/page-signals');
const { siteOf } = require('../features/netguard/site');

/**
 * Preload for TAB content. This runs inside every tab, including untrusted
 * web pages, so it must expose nothing by default.
 *
 * Internal pages (browser://newtab, browser://settings, ...) are loaded from
 * disk via loadFile, so they arrive here as file:// URLs under
 * `renderer/pages/`. Only those get the bridge. Main independently validates
 * the sender on every call, so a page that spoofs its location still fails.
 */
/**
 * This preload runs in every frame of a tab, not just the top one, so that
 * the privacy signals below reach iframes too. Every other part of it is for
 * the top frame only, as it always was: `top` is what keeps them there.
 */
const top = process.isMainFrame === true;

const isInternalPage = top && location.protocol === 'file:' &&
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
    // Where a dropped file lives (the vertical tab strip opens it in a tab).
    filePath(file) {
      try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
    },
  }));
}

/**
 * Network protection's privacy signals, in the PAGE's own world of every
 * frame, before any of the page's scripts run: navigator.globalPrivacyControl
 * and navigator.doNotTrack as Settings has them, and document.referrer capped
 * to an origin when Strict referrers are on (the Referer header itself is
 * rewritten in main). Main answers which apply; it decides nothing else here.
 */
if (!isInternalPage && /^https?:$/.test(location.protocol)) {
  let signals = null;
  try { signals = ipcRenderer.sendSync('netguard:signals'); } catch { /* no answer, no signals */ }
  if (signals) {
    const script = signalsScript({
      gpc: signals.gpc === true,
      dnt: signals.dnt === true,
      referrer: signals.strictReferrer === true ? cappedReferrer(document.referrer, location.href, siteOf) : null,
    });
    if (script) {
      try { webFrame.executeJavaScript(script); } catch { /* the headers are still sent */ }
    }
  }
  // An AMP page a site hosts itself names its real page; main decides
  // whether to go there (AMP skipping on, a real tab, not a loop).
  if (top) {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        const canonical = ampCanonical(document, location.href);
        if (canonical) ipcRenderer.send('netguard:amp', canonical);
      } catch { /* an odd page stays as it is */ }
    }, { once: true });
  }
}

/**
 * YouTube video-ad removal, injected into the PAGE's own world.
 *
 * Timing is the whole point. This preload runs at document-start, before any
 * of the page's own scripts, which is the only moment at which the accessor on
 * `ytInitialPlayerResponse` can be installed ahead of the `var` that assigns
 * it. Injecting later - from did-start-navigation in main, as an earlier
 * version did - races the parser and loses.
 *
 * `webFrame.executeJavaScript` is used rather than the preload's own scope
 * because the preload is an ISOLATED world: it cannot see or define the page
 * globals the player reads.
 *
 * Main decides whether this should run at all (shields on, video-ad blocking
 * on, site not excepted) and sets the flag below before the page loads.
 */
if (top && !isInternalPage && isYouTubeHost(location.hostname)) {
  let enabled = false;
  try {
    // Synchronous on purpose. The accessor this installs must be in place
    // before the page's own `var ytInitialPlayerResponse = ...` executes, and
    // an async round-trip would resolve after the parser has already run.
    // The call is one cheap boolean on YouTube navigations only.
    enabled = ipcRenderer.sendSync('shields:video-ads-for-host', location.hostname) === true;
  } catch {
    // Main is the authority. If it cannot answer, do nothing: an ad that
    // plays is far better than a broken YouTube.
  }
  if (enabled) {
    try {
      // Brave's own YouTube scriptlets first: set-constant installs accessors
      // on ytInitialPlayerResponse.adPlacements and friends, which must be in
      // place before the page's own `var` assigns them. Proven in a real page
      // (tests/bravejs.cjs) rather than assumed.
      if (BRAVE_YOUTUBE) webFrame.executeJavaScript(BRAVE_YOUTUBE);
    } catch {
      // A scriptlet that refuses to run must not stop ours from running.
    }
    try {
      webFrame.executeJavaScript(PAGE_SCRIPT);
    } catch {
      // Injection refused (CSP, frame torn down mid-navigation). The network
      // rules and cosmetic CSS still apply.
    }
  }
}

// Autofill and password saving, on web pages only.
if (top && !isInternalPage && /^https?:$/.test(location.protocol)) {
  try { require('./autofill'); } catch { /* a page that breaks the helper must not break the page */ }
  // Passkeys and the Credential Management API, before the page's own scripts.
  try { require('./credentials').start(); } catch { /* the browser's own handling still works */ }
}

/**
 * Scriptlets and procedural hiding from the filter lists, for every web page.
 *
 * Asked for synchronously for the same reason as the YouTube hooks above: a
 * scriptlet that stubs an ad library must be in place before the page's own
 * first script. Main decides what applies (Shields on, site not excepted).
 */
if (top && !isInternalPage && /^https?:$/.test(location.protocol)) {
  let rules = null;
  try { rules = ipcRenderer.sendSync('shields:page-rules', location.hostname); } catch { /* main decides; no answer, no rules */ }
  if (rules && rules.scriptlets) {
    try { webFrame.executeJavaScript(rules.scriptlets); } catch { /* refused by the page's CSP; cosmetic and network rules still apply */ }
  }
  if (rules && Array.isArray(rules.procedural) && rules.procedural.length) {
    try { require('./procedural').start(rules.procedural); } catch { /* a bad rule must not break the page */ }
  }
}
