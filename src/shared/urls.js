const INTERNAL_PAGES = new Set(['newtab', 'bookmarks', 'history', 'extensions', 'downloads', 'settings', 'ai']);
const ENGINES = { google: 'https://www.google.com/search?q=', brave: 'https://search.brave.com/search?q=' };
function internalPage(input) {
  try { const u = new URL(input); return u.protocol === 'browser:' && INTERNAL_PAGES.has(u.hostname) ? u.hostname : null; }
  catch { return null; }
}
function allowedURL(input) {
  try {
    const u = new URL(input);
    return ['http:', 'https:'].includes(u.protocol) ||
      (u.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(u.hostname)) ||
      (!!internalPage(input) && !u.username && !u.password) || input === 'about:blank';
  } catch { return false; }
}
function resolveInput(input, engine = 'google') {
  const value = String(input ?? '').trim().slice(0, 16384);
  if (!value) return 'browser://newtab';
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(localhost|[\w.-]+\.\w+):\d+(?:[/?#]|$)/i.test(value)) {
    if (!allowedURL(value)) throw new Error('This URL scheme is not allowed.');
    return new URL(value).href;
  }
  // Hostnames, localhost, IPv4, IPv6, ports and IDNs work without a scheme.
  if (!/\s/.test(value) && /^(localhost(?=[:/?#]|$)|\[[0-9a-f:]+\]|[^/?#]+\.[^/?#]+)(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    // Loopback stays on http. `127.` already consumes its dot, so it must not
    // share the lookahead that terminates the `localhost` / `[::1]` forms.
    const local = /^(?:localhost|\[::1\])(?=[:/?#]|$)/i.test(value) || /^127\.\d/.test(value);
    try { return new URL((local ? 'http://' : 'https://') + value).href; } catch {}
  }
  return (ENGINES[engine] || ENGINES.google) + encodeURIComponent(value);
}
function securityState(url, error) {
  if (error) return 'error';
  if (internalPage(url) || url === 'about:blank') return 'internal';
  if (url.startsWith('chrome-extension://')) return 'extension';
  return url.startsWith('https://') ? 'secure' : 'insecure';
}
module.exports = { ENGINES, INTERNAL_PAGES, internalPage, allowedURL, resolveInput, securityState };
