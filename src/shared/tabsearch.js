'use strict';

/**
 * Tab search: which open tabs match what has been typed, best first, and
 * which letters matched, so the list can light them up.
 *
 * Forgiving on purpose. People half-remember a tab: "gmal" should still find
 * Gmail, "news bbc" the BBC News tab, "docs.goo" the document on Google Docs.
 * So every word typed has to turn up somewhere - in the title, the site or
 * the address - in any order; inside a word, the letters only need to be in
 * order. A run of letters together, or a match at the start of a word,
 * counts for more than letters scattered across a long title.
 *
 * Used by the menu overlay; no Electron here, so `npm test` runs it in Node.
 */
(function () {

/** A letter or digit, in any script. Word starts are where these begin. */
const WORDISH = /[\p{L}\p{N}]/u;

const startsWord = (text, at) => at === 0 || !WORDISH.test(text[at - 1]);

/**
 * How well one word matches one piece of text, or null if it does not.
 * `loose` allows the letters to be scattered (in order); without it the
 * word must appear whole, which is what an address needs - in a long URL
 * almost any handful of letters appear in order somewhere.
 */
function matchWord(text, word, { loose = true } = {}) {
  const value = String(text || '');
  const lower = value.toLowerCase();
  // Lower-casing can change a string's length (a dotted capital I, for
  // one); then the positions would not line up, so nothing is marked.
  const markable = lower.length === value.length;
  if (!word) return null;

  const at = lower.indexOf(word);
  if (at >= 0) {
    // Whole, at the start of a word, near the front: the best kind of match.
    const score = 100 + (startsWord(lower, at) ? 40 : 0) + (at === 0 ? 20 : 0) - Math.min(at, 30) + word.length * 2;
    return { score, hits: markable ? Array.from({ length: word.length }, (_, i) => at + i) : [] };
  }
  if (!loose || word.length < 2) return null;

  // In order, but not together. A letter right after the last one, or at
  // the start of a word, is worth more; a long gap costs a little.
  let score = 0;
  let from = 0;
  let previous = -1;
  const hits = [];
  for (const letter of word) {
    const index = lower.indexOf(letter, from);
    if (index < 0) return null;
    if (index === previous + 1) score += 8;
    else if (startsWord(lower, index)) score += 6;
    else score += 2;
    if (previous >= 0 && index !== previous + 1) score -= Math.min(4, (index - previous - 1) / 3);
    hits.push(index);
    previous = index;
    from = index + 1;
  }
  // Letters spread across the whole title are a guess, not a match.
  if (hits[hits.length - 1] - hits[0] > word.length * 5) return null;
  return { score, hits: markable ? hits : [] };
}

/** The site a tab is on, as people say it: "bbc.co.uk", not "https://www.bbc.co.uk/". */
function siteOf(url) {
  const value = String(url || '');
  if (/^browser:\/\//i.test(value)) return value.replace(/^browser:\/\/([^/?#]*).*$/i, 'Static · $1');
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:' || parsed.protocol === 'static-file:') return 'File on this computer';
    return parsed.hostname.replace(/^www\./, '') || value;
  } catch { return value; }
}

/**
 * Rank `tabs` ({ title, url, site? }) against `query`. Returns entries
 * { tab, score, titleHits, siteHits } best first; ties keep the order the
 * tabs came in (most recently used first, as main sends them). An empty
 * query returns every tab, in that order, with nothing marked.
 */
function searchTabs(tabs, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const list = Array.isArray(tabs) ? tabs : [];
  if (!words.length) return list.map((tab) => ({ tab, score: 0, titleHits: [], siteHits: [] }));

  const results = [];
  list.forEach((tab, order) => {
    const title = String(tab?.title || '');
    const site = String(tab?.site || siteOf(tab?.url));
    const url = String(tab?.url || '');
    let total = 0;
    const titleHits = new Set();
    const siteHits = new Set();
    for (const word of words) {
      const inTitle = matchWord(title, word);
      const inSite = matchWord(site, word);
      const inUrl = matchWord(url, word, { loose: false });
      // The title is what people remember; the site nearly as well; the
      // rest of the address is a fallback.
      const best = [
        inTitle && { score: inTitle.score, where: 'title', hits: inTitle.hits },
        inSite && { score: inSite.score * 0.9, where: 'site', hits: inSite.hits },
        inUrl && { score: inUrl.score * 0.7, where: 'url', hits: [] },
      ].filter(Boolean).sort((a, b) => b.score - a.score)[0];
      if (!best) return;
      total += best.score;
      // Marked wherever it was found, so the eye sees why the tab is here.
      inTitle?.hits.forEach((hit) => titleHits.add(hit));
      inSite?.hits.forEach((hit) => siteHits.add(hit));
    }
    results.push({ tab, score: total, order, titleHits: [...titleHits].sort((a, b) => a - b), siteHits: [...siteHits].sort((a, b) => a - b) });
  });
  return results
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order, ...rest }) => rest);
}

/**
 * Split text into runs, each marked or not, for drawing the matched
 * letters: [['Gm', true], ['a', false], ['il', true]].
 */
function runs(text, hits) {
  const value = String(text || '');
  const marked = new Set(hits || []);
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const on = marked.has(i);
    if (out.length && out[out.length - 1][1] === on) out[out.length - 1][0] += value[i];
    else out.push([value[i], on]);
  }
  return out;
}

const shared = { searchTabs, matchWord, runs, siteOf };

// Usable from both `require` (tests) and a plain <script> tag (the overlay).
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.tabSearch = shared;

})();
