const { contextBridge, ipcRenderer, webFrame } = require('electron');
const { requests, events } = require('../shared/channels');
const { PAGE_SCRIPT, isYouTubeHost } = require('../features/shields/youtube');
// Pre-built at build time: a sandboxed preload cannot read resources.json,
// so resolving the scriptlets here would silently produce nothing.
const BRAVE_YOUTUBE = require('../features/shields/brave/youtube-bundle');

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
if (!isInternalPage && isYouTubeHost(location.hostname)) {
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
