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
 *   Also supported: cosmetic filters (##selector and domain##selector), which
 *              hide the element an ad would have occupied.
 *   Not supported: scriptlet injection, $redirect, $csp, regex rules, and the
 *              procedural cosmetic syntax (#?# :has(), :matches-css()).
 *
 * Cosmetic filtering matters as much as network blocking for what a person
 * actually sees. Blocking the request stops the ad loading, but without
 * hiding the container the page is left with an empty reserved box, often
 * still labelled "Advertisement". Discarding these rules was why ads still
 * looked present on ordinary sites even with blocking on.
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

/**
 * Options that scope a rule to behaviour this engine does not implement.
 * A rule carrying one of these is marked inert rather than applied, because
 * applying it as a plain network rule would be wrong in both directions.
 */
const COSMETIC_ONLY_OPTIONS = new Set([
  'content', 'inline-script', 'inline-font',
]);

/**
 * Exception options that say what to switch OFF on a page rather than which
 * request to allow: `@@||site^$generichide` keeps site-specific hiding but
 * drops generic hiding there; `$elemhide` drops all hiding; `$document`
 * switches blocking off for the page entirely.
 */
const PAGE_FLAGS = {
  generichide: 'generichide', ghide: 'generichide',
  elemhide: 'elemhide', ehide: 'elemhide',
  specifichide: 'specifichide', shide: 'specifichide',
  document: 'document', doc: 'document',
  genericblock: 'genericblock',
};

/**
 * Options this engine does not implement, which make a rule UNSAFE to apply.
 *
 * These are not merely unsupported - ignoring them inverts what the rule
 * means. uBlock's list contains, for example:
 *
 *   *$xhr,redirect-rule=noop.txt,to=~pagead2.googlesyndication.com,from=tunein.com
 *
 * which redirects one site's requests to a stub. Dropping `from=`, `to=` and
 * `redirect-rule` leaves the bare pattern `*` with type xhr - "block every
 * XHR on the entire web". That one rule made the browser return
 * ERR_BLOCKED_BY_CLIENT for ordinary pages.
 *
 * A rule carrying any of these is marked inert, so it neither blocks nor
 * unblocks anything.
 */
const UNSUPPORTED_SCOPE_OPTIONS = new Set([
  // Redirect rules: the point of them is WHAT to serve instead, which this
  // engine cannot do.
  'redirect', 'redirect-rule', 'rewrite',
  // Request source and destination scoping.
  'from', 'to', 'denyallow', 'method', 'ipaddress',
  // Header-level matching and rewriting.
  'header', 'replace', 'csp', 'permissions', 'removeparam', 'uritransform',
  // Behavioural, not network.
  'empty', 'mp4', 'cname', 'strict1p', 'strict3p', 'all', 'popup', 'popunder',
  'webrtc', 'badfilter', 'match-case',
]);

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
    // Set when the rule only governs behaviour this engine does not implement.
    this.inert = false;
    // For @@ rules that switch features off on a page (see PAGE_FLAGS).
    this.pageFlags = null;
    this.list = '';

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
        continue;
      }

      // Options that scope a rule to something this engine does not implement.
      // These MUST disable the rule rather than being ignored: `$generichide`
      // and friends only lift COSMETIC hiding, so treating
      // `@@||facebook.com^$generichide` as a plain network exception silently
      // unblocks the Facebook pixel everywhere - which is exactly what it did
      // before this check existed.
      if (PAGE_FLAGS[name]) {
        if (this.isException) (this.pageFlags ||= new Set()).add(PAGE_FLAGS[name]);
        else this.inert = true;
        continue;
      }
      if (COSMETIC_ONLY_OPTIONS.has(name)) { this.inert = true; continue; }

      // Options that change WHAT a rule means, not just what it matches.
      // Dropping them turns a narrowly scoped rule into a broad one - see the
      // note on UNSUPPORTED_SCOPE_OPTIONS.
      if (UNSUPPORTED_SCOPE_OPTIONS.has(name)) { this.inert = true; continue; }
    }
  }

  #normalise(pattern) {
    let text = pattern;
    if (text.startsWith('||')) { this.domainAnchor = true; text = text.slice(2); }
    else if (text.startsWith('|')) { this.startAnchor = true; text = text.slice(1); }
    if (text.endsWith('|')) { this.endAnchor = true; text = text.slice(0, -1); }

    // A trailing `?` marks where the query string begins - it is a separator,
    // not a literal question mark. Treated literally, `||google.*/pagead/lvz?`
    // demanded a `?` actually be present and so never matched the real request
    // to /pagead/lvz. `^` already means "separator or end of URL", so reusing
    // it gets the right behaviour for free.
    if (text.endsWith('?')) text = text.slice(0, -1) + '^';

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
    // Scoped to something this engine does not implement - see `inert` above.
    if (this.inert) return false;
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

      // A `*` inside the domain itself, as in ||google.*/pagead/lvz - the
      // multi-TLD form EasyList uses heavily (google.*, amazon.*, ebay.*).
      // Splitting on the `*` leaves domainPart as "google", which no host ends
      // with, so every one of these rules silently failed to match. Verified
      // against a live YouTube page: /pagead/lvz and /pagead/1p-user-list
      // requests were allowed through despite EasyList carrying rules for both.
      if (pattern[separator] === '*') {
        const prefix = domainPart;                  // "google."
        // The host must start the prefix at a label boundary, so
        // notgoogle.com does not match ||google.*.
        const startsAtBoundary = host === prefix || host.startsWith(prefix) ||
          host.includes('.' + prefix);
        if (!startsAtBoundary) return false;
        return wildcardIndex(url, pattern) !== -1;
      }

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
  // Cosmetic rules are handled separately by parseCosmetic, not here.
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
/**
 * Parse a cosmetic rule.
 *
 * Handles the two plain forms:
 *   ##.ad-banner            generic - applies everywhere
 *   example.com##.sponsor   domain-scoped, comma-separated domain list
 *
 * Returns null for anything else, which deliberately includes:
 *   #@#  exception rules (unhiding), which need the generic set resolved first
 *   #?#  and #$# procedural/style rules, whose syntax is not plain CSS and
 *        would throw if handed to insertCSS
 *
 * A selector is rejected unless it looks like plain CSS. Anything from a
 * downloaded list ends up inside a stylesheet this app injects, so a
 * malformed or hostile selector must not be able to break out of it - hence
 * no braces, no at-rules, no comment sequences.
 */
function parseCosmetic(line) {
  const text = String(line).trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  if (text.includes('#@#') || text.includes('#?#') || text.includes('#$#')) return null;

  const at = text.indexOf('##');
  if (at === -1) return null;

  const selector = text.slice(at + 2).trim();
  if (!selector || selector.length > 400) return null;
  // Must be plain CSS: no rule-set punctuation, no at-rules, no comments.
  if (/[{}]/.test(selector)) return null;
  if (selector.includes('/*') || selector.includes('@') || selector.includes('\\')) return null;

  const scope = text.slice(0, at).trim();
  if (!scope) return { selector, domains: null };

  // A domain list may contain exclusions (~a.com). Those only make sense
  // alongside an included domain, and treating one as an inclusion would hide
  // the element on exactly the site the list meant to spare - so skip them.
  const domains = scope.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length || domains.some((d) => d.startsWith('~'))) return null;
  if (domains.some((d) => !/^[a-z0-9.*-]+$/.test(d))) return null;

  return { selector, domains };
}

const { CosmeticIndex } = require('./cosmetic');

class FilterEngine {
  constructor() {
    this.blockBuckets = new Map();
    this.blockGeneric = [];
    this.allowBuckets = new Map();
    this.allowGeneric = [];
    this.count = 0;
    /** CSS, procedural rules, scriptlets and their exceptions. */
    this.cosmetic = new CosmeticIndex();
    this.cosmeticCount = 0;
    /** @@ rules that switch features off on matching pages. */
    this.pageExceptions = [];
  }

  /**
   * @param {string} text
   * @param {{ id?: string, trusted?: boolean }} source - where the list came
   *   from, recorded on each rule for the logger, and whether it may use
   *   privileged (`trusted-*`) scriptlets.
   */
  addList(text, source = {}) {
    for (const line of String(text).split('\n')) {
      // Cosmetic rules outnumber network rules several times over in these
      // lists, so test for them first and skip the network parse entirely.
      if (line.includes('#@#') || line.includes('##') || line.includes('#?#') || line.includes('#$#')) {
        if (this.cosmetic.add(line, source)) this.cosmeticCount++;
        continue;
      }
      const rule = parseRule(line);
      if (!rule) continue;
      rule.list = source.id || '';
      if (rule.pageFlags) { this.pageExceptions.push(rule); continue; }
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
    return hit ? { blocked: true, rule: hit.raw, list: hit.list } : { blocked: false, rule: null };
  }

  /**
   * CSS hiding every ad container known for this host.
   *
   * Generic rules plus those scoped to the host or any parent domain, so a
   * rule written for `example.com` also applies on `news.example.com`.
   *
   * The result is cached per host: the generic set alone runs to tens of
   * thousands of selectors, and rebuilding that string on every navigation
   * would be pure waste.
   */
  cosmeticFor(host, url) {
    const flags = url ? this.pageFlagsFor(url) : new Set();
    if (flags.has('elemhide') || flags.has('document')) return '';
    return this.cosmetic.forHost(String(host || ''), { generic: !flags.has('generichide') }).css;
  }

  /** Everything a page needs beyond network blocking. */
  pageRules(host, url) {
    const flags = this.pageFlagsFor(url || ('https://' + host + '/'));
    if (flags.has('document')) return { css: '', procedural: [], scriptlets: [], flags: [...flags] };
    const all = this.cosmetic.forHost(String(host || ''), { generic: !flags.has('generichide') });
    const hide = !flags.has('elemhide');
    return {
      css: hide ? all.css : '',
      procedural: hide ? all.procedural : [],
      scriptlets: all.scriptlets,
      flags: [...flags],
    };
  }

  /** Which page-level switches the lists turn off for this page. */
  pageFlagsFor(url) {
    const flags = new Set();
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return flags; }
    const lower = String(url).toLowerCase();
    for (const rule of this.pageExceptions) {
      if (rule.matches(lower, host, host, 'document', false)) for (const f of rule.pageFlags) flags.add(f);
    }
    return flags;
  }
}

module.exports = { FilterEngine, parseRule, parseCosmetic, Rule, tokenOf, TYPE_MAP };
