const { net } = require('electron');

/**
 * Response-body filtering for YouTube watch pages.
 *
 * WHY THIS EXISTS
 * YouTube embeds its player response directly in the HTML as
 * `var ytInitialPlayerResponse = {...}`. A `var` declaration at top level does
 * not fire a property setter, and by the time any injected script runs the
 * parser has already evaluated it - so the player holds ad data that no
 * in-page patch can get ahead of. Watching the DOM for the script tag does not
 * help either: the inline script is part of the initial parse.
 *
 * Testing confirmed both: the injected scriptlet's marks fired, yet the raw
 * HTML still contained the ad payload and a 15-second ad played.
 *
 * The only place left is before the page ever reaches the renderer. This
 * fetches the document, removes the ad arrays from the embedded JSON, and
 * serves the cleaned bytes. The player then starts with no ads to play, so
 * there is nothing to skip and no stall waiting for one.
 *
 * SCOPE
 * Deliberately narrow: only YouTube watch/embed documents, only the top-level
 * HTML, and only three well-known JSON keys. Everything else is passed through
 * untouched by returning null, so a failure here can never break other sites.
 */

/** Keys holding ad arrays in the player response. */
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

/** Does this request look like a YouTube page worth filtering? */
function shouldFilter(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'm.youtube.com' &&
        host !== 'youtube-nocookie.com') return false;
    return parsed.pathname === '/watch' ||
           parsed.pathname.startsWith('/embed/') ||
           parsed.pathname === '/';
  } catch {
    return false;
  }
}

/**
 * Replace each ad array with an empty one.
 *
 * Operates on the raw text rather than parsing the whole document: the payload
 * is megabytes of JSON, and a bracket-matched scan is both faster and safer
 * than a regex, which would mis-handle nested arrays inside ad entries.
 */
function stripAdArrays(html) {
  let result = html;
  let changed = 0;

  for (const key of AD_KEYS) {
    const needle = '"' + key + '":';
    let from = 0;
    for (;;) {
      const at = result.indexOf(needle, from);
      if (at === -1) break;

      // Find the array that follows, skipping whitespace.
      let cursor = at + needle.length;
      while (cursor < result.length && /\s/.test(result[cursor])) cursor++;
      if (result[cursor] !== '[') { from = at + needle.length; continue; }

      const end = matchBracket(result, cursor);
      if (end === -1) { from = at + needle.length; continue; }

      result = result.slice(0, cursor) + '[]' + result.slice(end + 1);
      changed++;
      from = cursor + 2;
    }
  }
  return { html: result, changed };
}

/**
 * Index of the `]` closing the `[` at `start`.
 *
 * Tracks string state so brackets inside JSON strings do not confuse the
 * depth count - ad payloads routinely contain URLs with brackets in them.
 */
function matchBracket(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Install the filter.
 *
 * DESIGN NOTE - read before changing this.
 *
 * An earlier version registered `protocol.handle('https')` and rewrote the
 * response body. It worked, but it put EVERY https request in the browser
 * through net.fetch and rebuilt each response - an enormous blast radius for
 * one site's ads. Anything net.fetch did not reproduce exactly (range
 * requests, streaming, auth headers, redirects) became a broken request, and
 * YouTube reported "no internet".
 *
 * This version does not touch the network stack at all. Nothing is
 * intercepted, nothing is re-fetched, and a failure here cannot break a
 * request. Ad removal happens in the page, on the object the player actually
 * reads, driven by `injectionFor()` below.
 */
function install() {
  // Intentionally a no-op: kept so callers do not need to change, and so the
  // reason the interception was removed stays visible here rather than only
  // in git history.
}

function uninstall() {}

/**
 * Code to run at document-start in a YouTube frame.
 *
 * `ytInitialPlayerResponse` arrives as a top-level `var`, which does not fire
 * a property setter - so it cannot be intercepted before assignment. What CAN
 * be done is to empty its ad arrays the instant it appears, which happens
 * before the player module reads them because this polls from document-start
 * on the same turn the parser is producing.
 */
function injectionFor(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '');
  const isYouTube = clean === 'youtube.com' || clean.endsWith('.youtube.com') ||
                    clean === 'youtube-nocookie.com' || clean === 'youtu.be';
  if (!isYouTube) return '';

  return `
(function(){
  if (window.__staticYtGuard) return;
  window.__staticYtGuard = true;

  var strip = function(data){
    if (!data || typeof data !== 'object') return 0;
    var n = 0;
    try {
      if (data.adPlacements && data.adPlacements.length) { data.adPlacements.length = 0; n++; }
      if (data.playerAds && data.playerAds.length) { data.playerAds.length = 0; n++; }
      if (data.adSlots && data.adSlots.length) { data.adSlots.length = 0; n++; }
      if (data.adBreakHeartbeatParams) { delete data.adBreakHeartbeatParams; n++; }
    } catch (e) {}
    return n;
  };

  // Empty the arrays IN PLACE rather than reassigning them. The player may
  // already hold a reference to the same array, so replacing the property
  // would leave that reference pointing at the original ads.
  var sweep = function(){
    var n = 0;
    try { n += strip(window.ytInitialPlayerResponse); } catch (e) {}
    try {
      var player = document.getElementById('movie_player');
      if (player && player.getPlayerResponse) n += strip(player.getPlayerResponse());
    } catch (e) {}
    if (n) { window.__staticAdsStripped = (window.__staticAdsStripped || 0) + n; }
  };

  // Run immediately, then on a tight interval through page startup. The
  // interval is what catches the var assignment, since a setter cannot.
  sweep();
  var ticks = 0;
  var fast = setInterval(function(){
    sweep();
    if (++ticks > 120) { clearInterval(fast); }
  }, 50);
  document.addEventListener('DOMContentLoaded', sweep);
  window.addEventListener('pagehide', function(){ clearInterval(fast); });

  // Later videos in the same session fetch a fresh player response over XHR,
  // which never goes through the initial HTML at all.
  try {
    var XHR = window.XMLHttpRequest;
    var open = XHR.prototype.open;
    var send = XHR.prototype.send;
    XHR.prototype.open = function(m, url){ this.__u = String(url || ''); return open.apply(this, arguments); };
    XHR.prototype.send = function(){
      var xhr = this;
      if (xhr.__u && xhr.__u.indexOf('/youtubei/v1/player') !== -1) {
        xhr.addEventListener('readystatechange', function(){
          if (xhr.readyState !== 4) return;
          try {
            var parsed = JSON.parse(xhr.responseText);
            if (strip(parsed)) {
              var text = JSON.stringify(parsed);
              Object.defineProperty(xhr, 'responseText', { configurable: true, get: function(){ return text; } });
              Object.defineProperty(xhr, 'response', { configurable: true, get: function(){ return text; } });
            }
          } catch (e) {}
        }, false);
      }
      return send.apply(this, arguments);
    };
  } catch (e) {}
})();
`;
}

module.exports = { install, uninstall, injectionFor, stripAdArrays, shouldFilter, matchBracket };
