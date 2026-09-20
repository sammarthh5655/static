/**
 * Scriptlets: code injected into a page's MAIN world before its own scripts.
 *
 * Network blocking cannot stop every ad. The clearest case is YouTube, which
 * serves video ads from `googlevideo.com/videoplayback` - the SAME endpoint as
 * the video itself. Blocking it blocks the content. The ad and the content are
 * indistinguishable at the network layer, so the only place to intervene is
 * inside the page, where the player knows which one it is showing.
 *
 * That is what uBlock Origin and Brave do, and it is what this does.
 *
 * HOW IT REACHES THE PAGE
 * `webContents.executeJavaScript` evaluates in the page's main world, and
 * running it on `did-start-navigation` lands before the document's own scripts.
 * That combination is verified, not assumed.
 *
 * SAFETY
 * Every scriptlet here is defensive: it wraps its body in try/catch, touches
 * only ad-related APIs, and is written so that failing does nothing rather
 * than breaking the page. A scriptlet that throws on a site it was not written
 * for is a broken site, which is worse than an unblocked ad.
 */

/**
 * Shared preamble. Defines helpers and guards against double-injection, which
 * would otherwise double-wrap patched APIs on a same-document navigation.
 */
const PREAMBLE = `
(function(){
  if (window.__staticScriptletsRan) return;
  window.__staticScriptletsRan = true;
  window.__staticBlocked = { count: 0, kinds: [] };
  var mark = function(kind){
    window.__staticBlocked.count++;
    if (window.__staticBlocked.kinds.indexOf(kind) === -1) {
      window.__staticBlocked.kinds.push(kind);
    }
  };
`;

const POSTAMBLE = `
})();
`;

/**
 * YouTube: last-resort ad skipping only.
 *
 * WHY THIS NO LONGER TOUCHES fetch OR XMLHttpRequest
 *
 * It used to. So does features/shields/youtube.js, which runs from the tab
 * preload at document-start. Both wrapped `window.fetch`, and because this
 * scriptlet is injected LATER (from main, after the document exists), its
 * wrapper replaced the preload's - silently, and only in real use.
 *
 * That was the bug behind "ads still appear in YouTube". Testing hid it: the
 * assertions checked that ad keys were absent from the player response, which
 * the document-start var-trap achieves on its own, so first load always looked
 * clean. The damage was to LATER videos, whose player response arrives over
 * fetch - and the surviving wrapper was the older one, which reassigns
 * `data.adPlacements = []` instead of emptying the array in place. The player
 * can already hold a reference to the original array, in which case the ads
 * it sees are untouched.
 *
 * One stripper now owns those two hooks: features/shields/youtube.js. What is
 * left here is the part that does not conflict with it.
 */
const YOUTUBE = `
  // If an ad starts anyway, click its skip button.
  //
  // This DELIBERATELY does not seek or change playback rate. An earlier
  // version did, and it fought the player on ad-free videos - one never
  // started at all and another took five seconds. Clicking a button that only
  // exists during an ad cannot affect normal playback, so this is the version
  // that is safe to leave running.
  try {
    var tidy = function(){
      var player = document.getElementById('movie_player');
      if (!player) return;
      if (!player.classList.contains('ad-showing') &&
          !player.classList.contains('ad-interrupting')) return;
      var skip = document.querySelector(
        '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button');
      if (skip) { try { skip.click(); mark('skip'); } catch (e) {} }
    };
    var timer = setInterval(tidy, 500);
    window.addEventListener('pagehide', function(){ clearInterval(timer); });
  } catch (e) {}
`;

/**
 * Generic video-ad defences for the common web players.
 *
 * Most sites that carry video ads use one of a handful of ad frameworks, and
 * all of them announce themselves on `window` before requesting anything.
 * Replacing them with inert stubs makes the page believe the ad library
 * loaded and returned no ads, which is the path every one of them handles
 * gracefully - it is the same path taken when an ad request goes unfilled.
 */
const GENERIC_VIDEO = `
  // Google IMA - the dominant video ad SDK (JW Player, Video.js, Brightcove).
  try {
    if (!window.google) window.google = {};
    if (!window.google.ima) {
      var noop = function(){};
      var ima = {
        AdDisplayContainer: function(){ this.initialize = noop; this.destroy = noop; },
        AdsLoader: function(){
          var self = this;
          this.listeners = {};
          this.addEventListener = function(type, fn){ (self.listeners[type] = self.listeners[type] || []).push(fn); };
          this.removeEventListener = noop;
          this.requestAds = function(){
            mark('ima-adsrequest');
            // Report "no ads available", which every integration handles.
            var error = { getError: function(){ return { getErrorCode: function(){ return 1009; },
              getMessage: function(){ return 'No ads'; }, toString: function(){ return 'No ads'; } }; } };
            setTimeout(function(){
              (self.listeners['adError'] || []).forEach(function(fn){ try { fn(error); } catch(e){} });
            }, 10);
          };
          this.getSettings = function(){ return { setPlayerType: noop, setPlayerVersion: noop,
            setAutoPlayAdBreaks: noop, setLocale: noop, setVpaidMode: noop, setNumRedirects: noop }; };
          this.contentComplete = noop;
          this.destroy = noop;
        },
        AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } },
        AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
        AdEvent: { Type: {} },
        AdsRequest: function(){},
        ImaSdkSettings: { VpaidMode: { DISABLED: 0, ENABLED: 1, INSECURE: 2 } },
        settings: { setDisableCustomPlaybackForIOS10Plus: noop },
      };
      window.google.ima = ima;
    }
  } catch (e) {}

  // Google Publisher Tag - display and in-stream slots.
  try {
    if (!window.googletag || !window.googletag.apiReady) {
      var cmdQueue = { push: function(fn){ try { if (typeof fn === 'function') fn(); } catch(e){} return 1; } };
      window.googletag = window.googletag || {};
      window.googletag.cmd = cmdQueue;
      window.googletag.apiReady = true;
      window.googletag.pubads = function(){
        return {
          addEventListener: function(){}, removeEventListener: function(){},
          enableSingleRequest: function(){}, disableInitialLoad: function(){},
          refresh: function(){ mark('gpt-refresh'); }, setTargeting: function(){},
          collapseEmptyDivs: function(){}, getSlots: function(){ return []; },
        };
      };
      window.googletag.defineSlot = function(){ return { addService: function(){ return this; },
        setTargeting: function(){ return this; }, setCollapseEmptyDiv: function(){ return this; } }; };
      window.googletag.enableServices = function(){};
      window.googletag.display = function(){ mark('gpt-display'); };
      window.googletag.sizeMapping = function(){ return { addSize: function(){ return this; },
        build: function(){ return []; } }; };
    }
  } catch (e) {}

  // Prebid header bidding - stub the auction so no bids are ever requested.
  try {
    if (!window.pbjs) {
      window.pbjs = {
        que: { push: function(fn){ try { if (typeof fn === 'function') fn(); } catch(e){} } },
        requestBids: function(cfg){ mark('prebid'); if (cfg && typeof cfg.bidsBackHandler === 'function') {
          try { cfg.bidsBackHandler({}, false); } catch(e){} } },
        addAdUnits: function(){}, setConfig: function(){}, getAdserverTargeting: function(){ return {}; },
        setTargetingForGPTAsync: function(){}, getHighestCpmBids: function(){ return []; },
        onEvent: function(){}, offEvent: function(){}, libLoaded: true,
      };
    }
  } catch (e) {}
`;

/**
 * Anti-adblock defusal, narrowly scoped.
 *
 * Some sites detect a blocker and replace the page with a wall. This makes the
 * most common detection flags read as "no blocker" WITHOUT disabling anything
 * real, so the content stays visible. It only touches well-known detector
 * globals rather than patching anything general.
 */
const ANTI_ADBLOCK = `
  try {
    var flags = ['adblockDetected', 'adBlockDetected', 'canRunAds', 'isAdBlockActive',
                 'adsBlocked', 'blockAdBlock', 'BlockAdBlock'];
    flags.forEach(function(name){
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get: function(){ return name === 'canRunAds' ? true : false; },
          set: function(){},
        });
      } catch (e) {}
    });
  } catch (e) {}
`;

/**
 * Which scriptlets apply to a host.
 *
 * Kept narrow on purpose: generic stubs run everywhere because they only
 * activate when a page reaches for an ad SDK, but the YouTube one is scoped
 * to YouTube because it patches YouTube-specific internals.
 */
function scriptsFor(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = [PREAMBLE];

  if (clean === 'youtube.com' || clean.endsWith('.youtube.com') ||
      clean === 'youtu.be' || clean === 'youtube-nocookie.com' ||
      clean.endsWith('.youtube-nocookie.com')) {
    parts.push(YOUTUBE);
  }

  parts.push(GENERIC_VIDEO, ANTI_ADBLOCK, POSTAMBLE);
  return parts.join('\n');
}

/** Cosmetic rules: hide the empty boxes an ad used to occupy. */
const COSMETIC_CSS = `
/* Generic ad containers used across the web. */
.adsbygoogle, ins.adsbygoogle,
[id^="google_ads_"], [id^="div-gpt-ad"], [id^="ad-slot"],
[class*="ad-slot"], [class*="ad-container"], [class*="ad-wrapper"],
[class*="advertisement"], [class*="sponsored-ad"],
[data-ad-slot], [data-ad-client], [data-google-query-id],
iframe[src*="doubleclick.net"], iframe[src*="googlesyndication"],
iframe[src*="amazon-adsystem"], iframe[id^="google_ads_iframe"],

/* YouTube. These are the custom elements YouTube renders ads into; hiding the
   element is what removes the leftover box once the network request is gone.
   Verified against a live page rather than guessed - ytd-ad-slot-renderer,
   ytd-in-feed-ad-layout-renderer, #player-ads and #masthead-ad were all still
   present and visible before these rules existed. */
ytd-ad-slot-renderer,
ytd-promoted-video-renderer,
ytd-display-ad-renderer,
ytd-in-feed-ad-layout-renderer,
ytd-banner-promo-renderer,
ytd-statement-banner-renderer,
ytd-companion-slot-renderer,
ytd-action-companion-ad-renderer,
ytd-promoted-sparkles-web-renderer,
ytd-promoted-sparkles-text-search-renderer,
ytd-carousel-ad-renderer,
ytd-search-pyv-renderer,
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
ytm-promoted-video-renderer,
ytm-companion-slot-renderer,
#player-ads,
#masthead-ad,
#offer-module,

/* The in-player overlay ads, including the Shorts overlay that survived the
   first pass. */
.ytp-ad-overlay-container,
.ytp-ad-message-container,
.ytp-ad-overlay-slot,
.ytp-featured-product,
.ytp-suggested-action,
.ytd-player-legacy-desktop-watch-ads-renderer,
#shorts-inline-ads,
ytd-reel-player-overlay-renderer ytd-ad-slot-renderer {
  display: none !important;
}
`;

module.exports = { scriptsFor, COSMETIC_CSS, YOUTUBE, GENERIC_VIDEO };
