'use strict';

/**
 * Search suggestions: what may be sent away, how an engine's answer is read,
 * and how remote searches and local pages become one list.
 *
 * Shared by main (which decides and fetches) and by the two places a person
 * types - the address bar and the new tab's search box - so both offer the
 * same list in the same order. No Electron here: `npm test` runs it in Node.
 */
(function () {

/** Where each engine answers "what might I be typing?". */
const SUGGEST_URLS = {
  google: 'https://suggestqueries.google.com/complete/search?client=chrome&q=',
  brave: 'https://search.brave.com/api/suggest?q=',
};

/** Results pages, so a past search in history can be offered as a search. */
const RESULTS_PAGES = [
  { host: /^(www\.)?google\.[a-z.]+$/, path: '/search' },
  { host: /^search\.brave\.com$/, path: '/search' },
];

const MAX_ROWS = 8;
const MAX_REMOTE = 5;

/**
 * Whether what has been typed may leave this computer as a suggestion
 * request.
 *
 * A suggestion request goes out on every pause in typing, before the person
 * has decided to send anything, so it is held to a stricter standard than a
 * search. Anything that might be an address, a browser:// page, an email, a
 * password, a key or a card number stays here. Erring towards local-only is
 * cheap: the list still shows history and bookmarks.
 */
function remoteAllowed(input) {
  const q = String(input ?? '').trim();
  if (!q || q.length > 120) return false;
  if (/[\u0000-\u001f\u007f]/.test(q)) return false;
  // Any scheme at all (browser://, about:, file:, javascript:, data:,
  // mailto:), or something that would be opened as an address.
  if (/^[a-z][a-z\d+.-]*:/i.test(q) || looksLikeAddress(q)) return false;
  if (/^(www\.|\/|\\|~)/i.test(q)) return false;
  // An email address, anywhere in the text - and the start of one. Each
  // pause in typing is a request, so "jo@gmail" would go out on the way to
  // "jo@gmail.com" if only the finished address were caught. A bare
  // "@handle" is fine.
  if (/[^\s@]@/.test(q)) return false;
  // Long runs of digits: card, phone, account and ID numbers.
  if (/\d(?:[ -]?\d){8,}/.test(q)) return false;
  for (const word of q.split(/\s+/)) if (secretLike(word)) return false;
  return true;
}

/**
 * Whether Enter would open this as an address rather than search for it -
 * the same test shared/urls.js#resolveInput uses, so what navigates is
 * labelled as going there, and is never announced to a search engine.
 */
function looksLikeAddress(input) {
  const q = String(input ?? '').trim();
  if (!q || /\s/.test(q)) return false;
  if (/^(https?|browser|file|about|chrome-extension|view-source):/i.test(q)) return true;
  return /^(localhost(?=[:/?#]|$)|\[[0-9a-f:]+\]|[^/?#]+\.[^/?#]+)(?::\d+)?(?:[/?#].*)?$/i.test(q);
}

/**
 * A single word that reads like a password or a key rather than a word:
 * letters and digits together with a symbol or mixed case ("Hunter2!",
 * "P@ssw0rd", "aB3dE5fG"), or a long run of letters and digits ("sk_live_…").
 * "covid-19" and "mp3" are fine; "iPhone15" is caught, which costs only its
 * remote suggestions.
 */
function secretLike(word) {
  if (word.length < 8) return false;
  const letter = /[a-z]/i.test(word);
  const digit = /\d/.test(word);
  if (word.length >= 20 && /^[\w+/=-]+$/.test(word) && letter && digit) return true;
  if (!letter || !digit) return false;
  const symbol = /[^\w\s.'-]/.test(word);
  const mixedCase = /[a-z]/.test(word) && /[A-Z]/.test(word);
  return symbol || mixedCase;
}

/**
 * Read an engine's answer. Both speak the OpenSearch shape,
 * ["typed", ["suggestion", ...], ...]; Google's Chrome client also says what
 * each one is, and only plain queries are kept - its "navigation" entries are
 * addresses, and the list already has the person's own pages for those.
 *
 * The body is untrusted text from the network: everything is checked, cut to
 * size and stripped of control characters, and it is only ever rendered as
 * text.
 */
function parseRemote(body, query) {
  let data;
  try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  const types = data[4] && typeof data[4] === 'object' && Array.isArray(data[4]['google:suggesttype'])
    ? data[4]['google:suggesttype'] : null;
  const typed = String(query ?? '').trim().toLowerCase();
  const seen = new Set([typed]);
  const out = [];
  data[1].forEach((entry, index) => {
    if (typeof entry !== 'string' || out.length >= MAX_REMOTE * 2) return;
    if (types && types[index] && types[index] !== 'QUERY') return;
    const text = entry.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  return out;
}

/** The search a results-page address stands for, or ''. */
function searchFromUrl(url) {
  try {
    const u = new URL(url);
    const page = RESULTS_PAGES.find((p) => p.host.test(u.hostname) && u.pathname === p.path);
    return page ? (u.searchParams.get('q') || '').trim().slice(0, 160) : '';
  } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * One list from what was typed, the engine's guesses and the person's own
 * pages, in the order a person scans it:
 *
 *   1. a search for exactly what was typed (Enter's default, always first);
 *   2. a page whose site starts with it - typing "git" means GitHub sooner
 *      than a search for "git hub";
 *   3. the engine's suggestions, and past searches from history;
 *   4. the rest of the history and bookmark matches.
 *
 * `searches` are strings; `pages` are history/bookmark entries
 * ({ title, url, source }). Rows are { kind: 'search'|'page', ... }.
 */
function mergeSuggestions(query, { searches = [], pages = [], engine = 'google' } = {}) {
  const typed = String(query ?? '').trim();
  if (!typed) return [];
  const lower = typed.toLowerCase();
  // What Enter does with the text as typed: go there, or search for it.
  const rows = [looksLikeAddress(typed)
    ? { kind: 'go', url: typed, typed: true }
    : { kind: 'search', query: typed, typed: true, engine }];
  const searched = new Set([lower]);

  const pastSearches = [];
  const ownPages = [];
  for (const page of pages) {
    if (!page || typeof page.url !== 'string') continue;
    const past = searchFromUrl(page.url);
    if (past) {
      if (past.toLowerCase().includes(lower)) pastSearches.push(past);
    } else ownPages.push(page);
  }

  const leading = ownPages.filter((p) => hostOf(p.url).startsWith(lower)).slice(0, 2);
  for (const page of leading) rows.push(pageRow(page));

  const addSearch = (text, past) => {
    const key = text.toLowerCase();
    if (searched.has(key) || rows.length >= MAX_ROWS) return;
    searched.add(key);
    // An engine may suggest an address ("youtube.com"). Enter would open
    // it, not search for it, so it is labelled as going there.
    rows.push(looksLikeAddress(text)
      ? { kind: 'go', url: text }
      : { kind: 'search', query: text, past: !!past, engine });
  };
  let remote = 0;
  for (const text of searches) {
    if (remote >= MAX_REMOTE) break;
    if (typeof text === 'string' && text) { addSearch(text, false); remote++; }
  }
  for (const text of pastSearches.slice(0, 2)) addSearch(text, true);

  const seenUrls = new Set(leading.map((p) => p.url));
  for (const page of ownPages) {
    if (rows.length >= MAX_ROWS) break;
    if (seenUrls.has(page.url)) continue;
    seenUrls.add(page.url);
    rows.push(pageRow(page));
  }
  return rows;
}

function pageRow(page) {
  return {
    kind: 'page',
    url: page.url,
    title: String(page.title || '').trim() || page.url,
    source: page.source === 'bookmark' ? 'bookmark' : 'history',
  };
}

/**
 * The previous answer's searches that still fit what is now typed. Shown
 * while the next answer is on its way, so typing one more letter narrows the
 * list instead of collapsing it and growing it back.
 */
function stillMatching(searches, query) {
  const lower = String(query ?? '').trim().toLowerCase();
  if (!lower) return [];
  return (searches || []).filter((text) => text.toLowerCase().startsWith(lower) && text.toLowerCase() !== lower);
}

/**
 * Split text around the first place the typed text appears, for drawing the
 * typed part highlighted: [before, match, after]. Plain strings - the caller
 * renders them as text nodes, never as markup.
 */
function highlightParts(text, query) {
  const value = String(text ?? '');
  const q = String(query ?? '').trim();
  if (!q) return [value, '', ''];
  const at = value.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [value, '', ''];
  return [value.slice(0, at), value.slice(at, at + q.length), value.slice(at + q.length)];
}

const shared = {
  SUGGEST_URLS, MAX_ROWS, MAX_REMOTE,
  remoteAllowed, looksLikeAddress, secretLike, parseRemote, searchFromUrl, mergeSuggestions, stillMatching, highlightParts,
};

// Usable from both `require` (main) and a plain <script> tag (renderers).
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.suggest = shared;

})();
