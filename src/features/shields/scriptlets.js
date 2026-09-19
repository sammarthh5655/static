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
 * YouTube video ads.
 *
 * The player fetches a JSON blob describing the video. Ad placements live in
 * `adPlacements`, `playerAds` and `adSlots`. Emptying those before the player
 * reads them means it has no ads to play - no skipping, no waiting, because
 * the player never learns an ad exists.
 *
 * Two interception points are needed because YouTube uses both paths:
 *   - `ytInitialPlayerResponse`, written into the HTML on first load
 *   - `/youtubei/v1/player` fetch responses, used for later navigations
 */
const YOUTUBE = `
  var stripAds = function(data){
    if (!data || typeof data !== 'object') return data;
    try {
      // Covers pre-roll, mid-roll AND post-roll: every entry here is an ad
      // slot, whatever its AD_PLACEMENT_KIND.
      if (data.adPlacements && data.adPlacements.length) {
        data.adPlacements = [];
        mark('youtube-placements');
      }
      if (data.playerAds && data.playerAds.length) { data.playerAds = []; mark('youtube-playerads'); }
      if (data.adSlots && data.adSlots.length) { data.adSlots = []; mark('youtube-adslots'); }
      // Removes the "ads will begin shortly" interstitial.
      if (data.playerConfig && data.playerConfig.audioConfig) {
        delete data.playerConfig.audioConfig.enablePerFormatLoudness;
      }
      if (data.streamingData) {
        // Server-stitched ad segments; dropping them leaves the real video.
        delete data.streamingData.serverAbrStreamingUrl;
      }
    } catch (e) {}
    return data;
  };

  // 1. The player response baked into the initial HTML.
  //
  // YouTube reassigns this property with a plain value later in its own
  // startup, which REPLACES an accessor defined here. Testing showed exactly
  // that: the accessor was gone by the time the page settled. So the getter
  // strips on every read as well as on write, which keeps working however
  // many times the property is redefined.
  try {
    var stored;
    var define = function(){
      try {
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
          configurable: true,
          get: function(){ return stripAds(stored); },
          set: function(value){ stored = stripAds(value); },
        });
      } catch (e) {}
    };
    define();
    // Re-assert periodically during page startup, in case the property was
    // redefined out from under us. Stops once the page is settled, so this is
    // not a permanent timer.
    var reasserts = 0;
    var guard = setInterval(function(){
      var descriptor = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
      if (descriptor && !descriptor.get) {
        // It was overwritten with a plain value - clean that value and
        // reinstate the accessor.
        stored = stripAds(descriptor.value);
        define();
      }
      if (++reasserts > 40) clearInterval(guard);
    }, 250);
    window.addEventListener('pagehide', function(){ clearInterval(guard); });
  } catch (e) {}

  // 2. Player responses fetched for subsequent videos.
  try {
    var origFetch = window.fetch;
    window.fetch = function(input, init){
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var promise = origFetch.apply(this, arguments);
      if (url.indexOf('/youtubei/v1/player') === -1) return promise;
      return promise.then(function(response){
        return response.clone().json().then(function(data){
          var cleaned = stripAds(data);
          return new Response(JSON.stringify(cleaned), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }).catch(function(){ return response; });
      });
    };
  } catch (e) {}

  // 3. Belt and braces: if an ad does start, skip it.
  // Only touches the ad player, never the normal one.
  try {
    var skip = function(){
      var button = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
      if (button) { button.click(); mark('youtube-skip'); return; }
      var showing = document.querySelector('.ad-showing');
      if (showing) {
        var video = document.querySelector('video');
        // Seeking an ad to its end ends it without touching the real video.
        if (video && video.duration && isFinite(video.duration)) {
          video.currentTime = video.duration;
          mark('youtube-seek');
        }
      }
    };
    var timer = setInterval(skip, 500);
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
.adsbygoogle, ins.adsbygoogle,
[id^="google_ads_"], [id^="div-gpt-ad"], [id^="ad-slot"],
[class*="ad-slot"], [class*="ad-container"], [class*="ad-wrapper"],
[class*="advertisement"], [class*="sponsored-ad"],
[data-ad-slot], [data-ad-client], [data-google-query-id],
iframe[src*="doubleclick.net"], iframe[src*="googlesyndication"],
iframe[src*="amazon-adsystem"], iframe[id^="google_ads_iframe"],
.ytp-ad-overlay-container, .ytp-ad-message-container,
#player-ads, #masthead-ad, ytd-promoted-video-renderer,
ytd-display-ad-renderer, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer {
  display: none !important;
}
`;

module.exports = { scriptsFor, COSMETIC_CSS, YOUTUBE, GENERIC_VIDEO };
