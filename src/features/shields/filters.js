/**
 * Filter-rule matching for the content blocker.
 *
 * Parses a useful subset of Adblock Plus syntax - the part that covers network
 * blocking - and matches requests against it. Deliberately NOT a full engine:
 *
 *   Supported: ||domain^ anchors, plain substrings, |prefix and suffix|
 *              anchors, * wildcards, $third-party, $script/$image/$xhr and the
 *              other common type options, $domain=a.com|~b.com, and @@
 *              exception rules.
 *   Not supported: cosmetic filters (##selector), scriptlet injection,
 *              $redirect, $csp, regex rules.
 *
 * That gap is real and worth stating plainly: without cosmetic filtering the
 * ad NETWORK is blocked but an empty box may remain where the ad was. uBlock
 * Origin and Brave Shields both do that part; this does not.
 *
 * Performance matters because this runs on every request. Rules are bucketed
 * by a token drawn from the pattern, so a request only tests the handful of
 * rules sharing a token with its URL rather than all 50,000.
 */

/** Request types we recognise, mapped from Electron's resourceType. */
const TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const TYPE_OPTIONS = new Set([
  'document', 'subdocument', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
]);

class Rule {
  constructor({ pattern, isException, options, raw }) {
    this.raw = raw;
    this.isException = isException;
    this.domainAnchor = false;
    this.startAnchor = false;
    this.endAnchor = false;
    this.thirdParty = null;      // true = only third-party, false = only first
    this.types = null;           // Set of allowed types, or null for any
    this.excludedTypes = null;
    this.domains = null;         // Set of domains the rule applies on
    this.excludedDomains = null;

    this.#applyOptions(options);
    this.pattern = this.#normalise(pattern);
    this.token = tokenOf(this.pattern);
  }

  #applyOptions(options) {
    if (!options) return;
    for (const option of options.split(',')) {
      const negated = option.startsWith('~');
      const body = negated ? option.slice(1) : option;
      const [name, value] = body.split('=');

      if (name === 'third-party') { this.thirdParty = !negated; continue; }
      if (name === 'first-party') { this.thirdParty = negated; continue; }
      if (name === 'domain' && value) {
        for (const entry of value.split('|')) {
          const exclude = entry.startsWith('~');
          const domain = (exclude ? entry.slice(1) : entry).toLowerCase();
          if (!domain) continue;
          if (exclude) (this.excludedDomains ||= new Set()).add(domain);
          else (this.domains ||= new Set()).add(domain);
        }
        continue;
      }
      if (TYPE_OPTIONS.has(name)) {
        if (negated) (this.excludedTypes ||= new Set()).add(name);
        else (this.types ||= new Set()).add(name);
      }
      // Anything else (redirect, csp, popup, ...) is ignored rather than
      // silently mis-applied.
    }
  }

  #normalise(pattern) {
    let text = pattern;
    if (text.startsWith('||')) { this.domainAnchor = true; text = text.slice(2); }
    else if (text.startsWith('|')) { this.startAnchor = true; text = text.slice(1); }
    if (text.endsWith('|')) { this.endAnchor = true; text = text.slice(0, -1); }
    return text.toLowerCase();
  }

  /**
   * Does this rule apply to the request?
   *
   * @param {string} url        lowercased request URL
   * @param {string} host       request hostname
   * @param {string} docHost    hostname of the page making the request
   * @param {string} type       normalised resource type
   * @param {boolean} isThird   third-party request
   */
  matches(url, host, docHost, type, isThird) {
    if (this.thirdParty !== null && this.thirdParty !== isThird) return false;
    if (this.types && !this.types.has(type)) return false;
    if (this.excludedTypes && this.excludedTypes.has(type)) return false;

    if (this.domains || this.excludedDomains) {
      const onDomain = (set) => set && [...set].some((domain) =>
        docHost === domain || docHost.endsWith('.' + domain));
      if (this.excludedDomains && onDomain(this.excludedDomains)) return false;
      if (this.domains && !onDomain(this.domains)) return false;
    }

    return this.#patternMatches(url, host);
  }

  #patternMatches(url, host) {
    const pattern = this.pattern;
    if (!pattern) return true;

    if (this.domainAnchor) {
      // ||example.com^ matches example.com and any subdomain, but NOT
      // notexample.com - which is why this compares labels rather than
      // doing a plain substring test.
      const separator = pattern.search(/[/^*?]/);
      const domainPart = separator === -1 ? pattern : pattern.slice(0, separator);
      if (!(host === domainPart || host.endsWith('.' + domainPart))) return false;
      if (separator === -1) return true;
      return wildcardIndex(url, pattern) !== -1;
    }

    if (this.startAnchor) return startsWithPattern(url, pattern);
    if (this.endAnchor && !pattern.includes('*')) return url.endsWith(pattern);
    return wildcardIndex(url, pattern) !== -1;
  }
}

/**
 * Substring search honouring `*` wildcards and `^` separators.
 * Written by hand rather than compiled to RegExp: building 50,000 regexes is
 * slow to construct and slower to run than this for the common case.
 */
function wildcardIndex(haystack, pattern) {
  if (!pattern.includes('*') && !pattern.includes('^')) {
    return haystack.indexOf(pattern);
  }
  const segments = pattern.split('*');
  let position = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const found = indexOfWithSeparator(haystack, segment, position);
    if (found === -1) return -1;
    position = found + segment.length;
    if (i === 0 && pattern.startsWith('*')) continue;
  }
  return position;
}

/** `^` in ABP means "any separator character or end of URL". */
function indexOfWithSeparator(haystack, needle, from) {
  if (!needle.includes('^')) return haystack.indexOf(needle, from);
  const pieces = needle.split('^');
  let position = from;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece) {
      const found = haystack.indexOf(piece, position);
      if (found === -1) return -1;
      position = found + piece.length;
    }
    if (i < pieces.length - 1) {
      const next = haystack[position];
      // End of string counts as a separator.
      if (next !== undefined && !/[/:?=&^]/.test(next)) return -1;
      if (next !== undefined) position += 1;
    }
  }
  return position - needle.replace(/\^/g, '').length;
}

function startsWithPattern(url, pattern) {
  if (!pattern.includes('*')) return url.startsWith(pattern);
  return wildcardIndex(url, pattern) === 0;
}

/**
 * Pick a stable token from a pattern for bucketing.
 *
 * Any request whose URL does not contain the token cannot match the rule, so
 * bucketing by it turns a 50,000-rule scan into a few dozen comparisons.
 */
function tokenOf(pattern) {
  // Three characters, not four. At four, ~1500 rules failed to produce a
  // token and fell into the generic bucket, which is scanned on EVERY request
  // - that alone was most of the matching cost.
  const candidates = pattern.match(/[a-z0-9%]{3,}/g);
  if (!candidates) return '';
  // The longest token is the most selective.
  return candidates.reduce((best, current) =>
    (current.length > best.length ? current : best), '');
}

/** Parse one filter-list line. Returns null for comments and cosmetic rules. */
function parseRule(line) {
  const text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  // Cosmetic filters are out of scope - see the note at the top of this file.
  if (text.includes('##') || text.includes('#@#') || text.includes('#?#')) return null;

  let body = text;
  const isException = body.startsWith('@@');
  if (isException) body = body.slice(2);

  // Regex rules are not supported. A regex rule is delimited by slashes at
  // BOTH ends (/pattern/); a plain path filter like /ads/banner.js starts with
  // a slash but does not end with one, and must not be mistaken for a regex.
  if (body.length > 2 && body.startsWith('/') && body.endsWith('/')) return null;

  let options = '';
  const dollar = body.lastIndexOf('$');
  if (dollar > 0) {
    const maybe = body.slice(dollar + 1);
    // Only treat it as options if it looks like them, not a URL fragment.
    if (/^[a-z~][a-z0-9~,=|._-]*$/i.test(maybe)) {
      options = maybe;
      body = body.slice(0, dollar);
    }
  }

  if (!body) return null;
  return new Rule({ pattern: body, isException, options, raw: text });
}

/**
 * A compiled list of rules, bucketed by token.
 */
class FilterEngine {
  constructor() {
    this.blockBuckets = new Map();
    this.blockGeneric = [];
    this.allowBuckets = new Map();
    this.allowGeneric = [];
    this.count = 0;
  }

  addList(text) {
    for (const line of String(text).split('\n')) {
      const rule = parseRule(line);
      if (!rule) continue;
      const buckets = rule.isException ? this.allowBuckets : this.blockBuckets;
      const generic = rule.isException ? this.allowGeneric : this.blockGeneric;
      if (rule.token) {
        if (!buckets.has(rule.token)) buckets.set(rule.token, []);
        buckets.get(rule.token).push(rule);
      } else {
        generic.push(rule);
      }
      this.count++;
    }
    return this.count;
  }

  /**
   * Test the rules that could possibly match, without building an
   * intermediate array. Spreading every bucket into a new array allocated on
   * every single request, which is the kind of cost that only shows up once a
   * page makes four hundred of them.
   *
   * @returns {object|null} the matching rule, or null
   */
  #findMatch(buckets, generic, tokens, url, host, page, type, isThird) {
    for (const token of tokens) {
      const bucket = buckets.get(token);
      if (!bucket) continue;
      for (const rule of bucket) {
        if (rule.matches(url, host, page, type, isThird)) return rule;
      }
    }
    for (const rule of generic) {
      if (rule.matches(url, host, page, type, isThird)) return rule;
    }
    return null;
  }

  /**
   * @returns {{blocked: boolean, rule: string|null}}
   */
  match({ url, docHost, resourceType }) {
    const lower = String(url).toLowerCase();
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return { blocked: false, rule: null }; }

    const type = TYPE_MAP[resourceType] || 'other';
    const page = String(docHost || '').toLowerCase();
    const isThird = !!page && host !== page && !host.endsWith('.' + page) && !page.endsWith('.' + host);

    // Tokenise once and reuse for both passes.
    const tokens = lower.match(/[a-z0-9%]{3,}/g) || [];

    // Exceptions win, so they are checked first.
    if (this.#findMatch(this.allowBuckets, this.allowGeneric,
                        tokens, lower, host, page, type, isThird)) {
      return { blocked: false, rule: null };
    }
    const hit = this.#findMatch(this.blockBuckets, this.blockGeneric,
                                tokens, lower, host, page, type, isThird);
    return hit ? { blocked: true, rule: hit.raw } : { blocked: false, rule: null };
  }
}

module.exports = { FilterEngine, parseRule, Rule, tokenOf, TYPE_MAP };
