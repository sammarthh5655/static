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
 * Install the filter on a session.
 *
 * @param {Electron.Session} session
 * @param {() => boolean} isEnabled  checked per request, so the toggle is live
 * @param {(count:number) => void} onStrip
 */
function install(session, isEnabled, onStrip) {
  session.protocol.handle('https', async (request) => {
    // Everything that is not a YouTube document goes straight through. Using
    // net.fetch here keeps cookies, cache and proxy behaviour identical to a
    // normal load.
    const passthrough = () => net.fetch(request, { bypassCustomProtocolHandlers: true });

    if (!isEnabled() || request.method !== 'GET' || !shouldFilter(request.url)) {
      return passthrough();
    }
    // Only documents: a fetch for JSON from the same path must not be rewritten.
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('text/html')) return passthrough();

    try {
      const response = await passthrough();
      const type = response.headers.get('content-type') || '';
      if (!type.includes('text/html')) return response;

      const html = await response.text();
      const { html: cleaned, changed } = stripAdArrays(html);
      if (changed) onStrip(changed);
      // Nothing to rewrite: hand back the original response untouched rather
      // than paying the reconstruction cost for no benefit.
      if (!changed) return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
      });

      return new Response(cleaned, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
      });
    } catch {
      // Any failure falls back to an unmodified load. An ad getting through is
      // a far better outcome than a page that will not open.
      return passthrough();
    }
  });
}

/**
 * Headers for a rebuilt response.
 *
 * `content-encoding` MUST go: net.fetch has already decompressed the body, so
 * leaving `br` or `gzip` in place tells the renderer to decompress plain text,
 * which stalls the load. `content-length` must go with it because the body's
 * size changed. Both were behind a multi-second delay to first frame, and one
 * video that never started at all.
 */
function cleanHeaders(source) {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return headers;
}

function uninstall(session) {
  try { session.protocol.unhandle('https'); } catch { /* not installed */ }
}

module.exports = { install, uninstall, stripAdArrays, shouldFilter, matchBracket };
