const { SUGGEST_URLS, remoteAllowed, parseRemote } = require('../../shared/suggest');

/** How long a suggestion request may take before the list goes on without it. */
const TIMEOUT_MS = 1800;
/** Engines answer in a few kilobytes; anything far bigger is not an answer. */
const MAX_BODY = 64 * 1024;
const CACHE_SIZE = 80;
const CACHE_MS = 5 * 60 * 1000;

/**
 * Remote search suggestions, fetched here in main.
 *
 * Pages cannot fetch anything themselves (their CSP is connect-src 'none'), and
 * should not: main is where the privacy rules live, so a page asking is all
 * a page can do. Main refuses in incognito, when the person has turned
 * suggestions off, and for anything shared/suggest.js#remoteAllowed says
 * could be private - whatever the page asked for.
 *
 * One request per asker at a time. A newer keystroke aborts the older
 * request rather than racing it, so a slow answer for "ga" can never land on
 * top of the answer for "gal". Answers are cached briefly, which makes
 * Backspace instant and keeps a fast typist from sending the same prefix
 * twice.
 *
 * `fetcher` is electron's net.fetch in the app and a stub in probes, so no
 * test ever talks to a real search engine.
 */
class SearchSuggestions {
  constructor({ fetcher, enabled, engine, incognito } = {}) {
    this.fetcher = fetcher;
    this.enabled = enabled || (() => true);
    this.engine = engine || (() => 'google');
    this.incognito = !!incognito;
    this.cache = new Map();
    this.inflight = new Map();
  }

  /** Whether this exact text may be sent to the engine right now. */
  allowed(query) {
    return !this.incognito && this.enabled() !== false && !!SUGGEST_URLS[this.engine()] && remoteAllowed(query);
  }

  /**
   * The engine's suggestions for `query`, asked on behalf of `asker` (a
   * WebContents id). Resolves { query, engine, searches, remote } and never
   * rejects: a failed or refused lookup is simply an empty list, and the
   * local suggestions carry on regardless.
   */
  async lookup(query, asker) {
    const text = String(query ?? '').trim().slice(0, 200);
    const engine = this.engine();
    this.cancel(asker);
    if (!this.allowed(text)) return { query: text, engine, searches: [], remote: false };

    const key = engine + '\u0000' + text.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return { query: text, engine, searches: cached.searches, remote: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    this.inflight.set(asker, controller);
    try {
      const response = await this.fetcher(SUGGEST_URLS[engine] + encodeURIComponent(text), {
        signal: controller.signal,
        // No cookies either way: a suggestion request should not identify
        // the person, nor leave the engine's cookies behind.
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response || !response.ok) return { query: text, engine, searches: [], remote: true };
      const searches = parseRemote(await readBody(response), text);
      this.cache.set(key, { at: Date.now(), searches });
      // A Map keeps insertion order, so the oldest entry is the first one.
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
      return { query: text, engine, searches, remote: true };
    } catch {
      // Offline, too slow, or overtaken by a newer keystroke.
      return { query: text, engine, searches: [], remote: true, stale: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
      if (this.inflight.get(asker) === controller) this.inflight.delete(asker);
    }
  }

  /** Abort whatever `asker` is still waiting for. */
  cancel(asker) {
    const previous = this.inflight.get(asker);
    if (previous) { previous.abort(); this.inflight.delete(asker); }
  }

  /** Forget cached answers, e.g. when history is cleared. */
  clear() { this.cache.clear(); }
}

/**
 * The answer as text, decoded in the charset the engine says it used.
 *
 * Google's suggest service answers in ISO-8859-1 unless told otherwise, and
 * response.text() always reads UTF-8 - so "café" would come back as "caf�".
 * Reading the bytes and honouring the header gets both engines right.
 */
async function readBody(response) {
  if (typeof response.arrayBuffer !== 'function') return String(await response.text()).slice(0, MAX_BODY);
  const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_BODY);
  const type = typeof response.headers?.get === 'function' ? response.headers.get('content-type') || '' : '';
  const charset = (/charset\s*=\s*"?([\w.:-]+)/i.exec(type) || [])[1] || 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(bytes);
}

module.exports = { SearchSuggestions, readBody };
