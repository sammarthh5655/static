/**
 * YouTube video-ad removal.
 *
 * WHY THIS IS SHAPED THE WAY IT IS
 *
 * Three earlier attempts failed, each for a reason worth recording so the
 * mistakes are not repeated:
 *
 *  1. Rewriting the HTML response. Worked, but routed every https request in
 *     the browser through net.fetch. Anything net.fetch did not reproduce
 *     byte-for-byte (ranges, streaming, auth) broke - YouTube showed "no
 *     internet". Removed.
 *
 *  2. Polling for `window.ytInitialPlayerResponse` and emptying its ad arrays.
 *     `ytInitialPlayerResponse` is a top-level `var`, so a plain property
 *     setter never fires, and a 50ms poll cannot reliably win against the
 *     parser. Ads still played.
 *
 *  3. Hooking XMLHttpRequest only. YouTube fetches `/youtubei/v1/player` with
 *     `fetch()`, not XHR, so every subsequent video in a session was served
 *     its ads untouched. This was the main reason ads kept appearing.
 *
 * WHAT ACTUALLY WORKS (the approach uBlock Origin uses)
 *
 * The `var` problem is sidestepped rather than fought. A `var` declaration
 * does NOT redefine a property that already exists on `window`; it assigns to
 * it, which runs the existing setter. So we install a configurable accessor on
 * `window.ytInitialPlayerResponse` FIRST, and when the page's `var` assigns
 * the player response, our setter receives the object and strips the ad keys
 * out of it before returning. The player then reads an object that never had
 * ads in it. No polling, no race.
 *
 * Navigations after the first one fetch a fresh player response over the
 * network, so `fetch` and `XMLHttpRequest` are both wrapped and the same keys
 * are pruned from the JSON body.
 *
 * Everything is wrapped in try/catch and only ever DELETES known ad keys. If
 * any part fails, the page still works - it just shows an ad, which is far
 * better than a broken YouTube.
 */

/** Player-response keys that carry ads. Matches uBlock's YouTube rules. */
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

/** Hosts this runs on. */
function isYouTubeHost(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '');
  return clean === 'youtube.com' || clean.endsWith('.youtube.com') ||
         clean === 'youtube-nocookie.com' || clean === 'youtu.be' ||
         clean === 'youtubekids.com';
}

/**
 * The code injected into the page's own world at document-start.
 *
 * Built as a string because it must run in the page's main world, where the
 * player's globals live - an isolated-world preload cannot see them.
 */
const PAGE_SCRIPT = `
(function(){
  // Re-entrant BY DESIGN. This script is injected at document-start by the
  // preload, and again on every SPA navigation. YouTube is a single-page app:
  // clicking video after video never loads a new document, so the preload
  // never runs again and the hooks below would have to survive untouched for
  // the whole session. They do not have to - the page's own code, or an
  // extension's content script, can reassign window.fetch at any point and
  // silently unhook everything for the rest of the session.
  //
  // So instead of returning early when already present, re-assert anything
  // that is missing. State lives on the window object so it survives
  // re-injection.
  var first = !window.__staticYt;
  window.__staticYt = true;
  var KEYS = ${JSON.stringify(AD_KEYS)};

  // Counters split by source, and reset per video.
  //
  // A single cumulative counter was actively misleading: it was non-zero from
  // the first video's var trap, so an assertion of "the fetch hook stripped
  // something" was true even when the fetch hook was absent entirely. Keep
  // them separate so each path can be observed on its own.
  if (!window.__staticYtStats) {
    window.__staticYtStats = { varTrap: 0, fetch: 0, xhr: 0, total: 0 };
  }
  var stats = window.__staticYtStats;

  // Delete ad keys from a player-response-shaped object, in place.
  //
  // In place, not by reassignment: the player may already hold a reference to
  // the same array, and replacing the property would leave that reference
  // pointing at the original ads.
  function prune(obj, source) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      for (var i = 0; i < KEYS.length; i++) {
        if (KEYS[i] in obj) {
          delete obj[KEYS[i]];
          stats.total++;
          if (source) stats[source]++;
        }
      }
      // Some responses nest the real payload one level down.
      if (obj.playerResponse && typeof obj.playerResponse === 'object') prune(obj.playerResponse, source);
    } catch (e) {}
    return obj;
  }
  window.__staticAdsRemoved = function(){ return stats.total; };
  window.__staticAdStats = function(){
    return { varTrap: stats.varTrap, fetch: stats.fetch, xhr: stats.xhr, total: stats.total };
  };
  // Called on each SPA navigation so per-video counts mean something.
  window.__staticAdReset = function(){
    stats.varTrap = 0; stats.fetch = 0; stats.xhr = 0; stats.total = 0;
  };

  // --- the var trap -----------------------------------------------------
  // A top-level \`var x = ...\` does not redefine an existing own property of
  // window; it assigns through the setter below. That is what lets us get in
  // front of a declaration we cannot otherwise intercept.
  function trap(name) {
    try {
      var current;
      var existing = Object.getOwnPropertyDescriptor(window, name);
      if (existing && !existing.configurable) return;
      if (existing && 'value' in existing) current = prune(existing.value, 'varTrap');
      Object.defineProperty(window, name, {
        configurable: true,
        get: function(){ return current; },
        set: function(v){ current = prune(v, 'varTrap'); }
      });
    } catch (e) {}
  }
  // Only on a fresh document: after document-start the var has already run,
  // and re-trapping would replace a live value with an accessor for nothing.
  if (first) {
    trap('ytInitialPlayerResponse');
    trap('playerResponse');
  }

  // --- fetch ------------------------------------------------------------
  // This is the path that actually serves ads for the 2nd and later videos in
  // a session. Missing it was why ads kept playing.
  // Re-assert only when ours is not the wrapper currently installed. Chain
  // whatever is there now rather than restoring a captured native fetch -
  // that would undo an extension's own legitimate wrapper.
  try {
    if (!window.fetch || window.fetch.__static !== true) {
    var nativeFetch = window.fetch;
    var wrapped = function(input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var promise = nativeFetch.apply(this, arguments);
      if (url.indexOf('/youtubei/v1/player') === -1) return promise;
      return promise.then(function(response){
        try {
          // Clone so the page still gets a readable, unconsumed body if
          // anything below throws.
          return response.clone().json().then(function(data){
            prune(data, 'fetch');
            return new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }).catch(function(){ return response; });
        } catch (e) { return response; }
      });
    };
    wrapped.__static = true;
    window.fetch = wrapped;
    }
  } catch (e) {}

  // --- XMLHttpRequest ---------------------------------------------------
  // Older code paths and some clients still use XHR.
  try {
    if (XMLHttpRequest.prototype.send.__static !== true) {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      try { this.__staticUrl = String(url || ''); } catch (e) {}
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(){
      var xhr = this;
      try {
        if (xhr.__staticUrl && xhr.__staticUrl.indexOf('/youtubei/v1/player') !== -1) {
          xhr.addEventListener('readystatechange', function(){
            if (xhr.readyState !== 4) return;
            try {
              var data = JSON.parse(xhr.responseText);
              prune(data, 'xhr');
              var text = JSON.stringify(data);
              Object.defineProperty(xhr, 'responseText', { configurable: true, get: function(){ return text; } });
              Object.defineProperty(xhr, 'response', { configurable: true, get: function(){ return text; } });
            } catch (e) {}
          });
        }
      } catch (e) {}
      return send.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send.__static = true;
    }
  } catch (e) {}
})();
`;

module.exports = { PAGE_SCRIPT, isYouTubeHost, AD_KEYS };
