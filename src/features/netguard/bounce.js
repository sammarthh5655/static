'use strict';

const { siteOf } = require('./site');

/**
 * Bounce-tracking protection and AMP skipping.
 *
 * A bounce tracker is a hop: a link that goes to a tracker first, which notes
 * the click (and often sets a cookie as a first party) and then redirects to
 * where the link really pointed. The destination is right there in the
 * address, so the hop can be skipped: the tracker never sees the click.
 *
 * AMP pages are Google-hosted or AMP-only copies of an article. Google's AMP
 * viewer (google.com/amp/s/...) and the AMP cache (*.cdn.ampproject.org) name
 * the real page in their own address, so they too are skipped straight to it.
 * AMP pages a site hosts itself name their real page in the document instead
 * (<link rel=canonical>); the tab preload reads that and asks main to go
 * there (see AMP_CHECK and NetGuard#leaveAmp).
 *
 * WHAT IS NEVER SKIPPED: a hop is only skipped when its destination is a real
 * http(s) address on a different site from the hop. Sign-in and payment
 * redirects (continue=, redirect_uri=, return_to=) are never read, and the
 * general click-tracker rule only fires on hosts that exist to track clicks,
 * so a bank's or a shop's own redirect is left alone.
 *
 * Brave's debounce rules (brave/adblock-lists, debounce.json, MPL-2.0) are
 * fetched alongside the threat lists and used too; the built-in rules below
 * cover the big platforms that list does not, and keep this working before
 * anything has been downloaded.
 */

/** Hops on the big platforms: host test, path test, the parameter holding the destination. */
const BUILT_IN = [
  // Google's outbound redirector (search results, Gmail, Docs links).
  { host: /^(www\.)?google\.[a-z.]+$/, path: /^\/url$/, params: ['q', 'url'] },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.messenger\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.instagram\.com$/, path: /^\/?$/, params: ['u'] },
  { host: /^l\.threads\.(net|com)$/, path: /^\/?$/, params: ['u'] },
  { host: /^out\.reddit\.com$/, path: /^\/[^/]*$/, params: ['url'] },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/(redir\/redirect|safety\/go)\/?$/, params: ['url'] },
  { host: /^(www\.)?vk\.com$/, path: /^\/away\.php$/, params: ['to'] },
  { host: /^(www\.)?ok\.ru$/, path: /^\/dk$/, params: ['st.link'] },
  { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ['z'] },
  { host: /^(www\.)?duckduckgo\.com$/, path: /^\/l\/?$/, params: ['uddg'] },
  { host: /^slack-redir\.net$/, path: /^\/link$/, params: ['url'] },
  { host: /^(www\.)?pinterest\.[a-z.]+$/, path: /^\/offsite\/?$/, params: ['url'] },
  { host: /^(away|redirect)\.vk\.com$/, path: /.*/, params: ['to'] },
  { host: /^disq\.us$/, path: /^\/url$/, params: ['url'], trim: /:[A-Za-z0-9_-]+$/ },
  { host: /^(www\.)?(steamcommunity|steampowered)\.com$/, path: /^\/linkfilter\/?$/, params: ['url', 'u'] },
  { host: /^click\.linksynergy\.com$/, path: /.*/, params: ['murl', 'RD_PARM1'] },
  { host: /^(www\.)?googleadservices\.com$/, path: /^\/pagead\/aclk$/, params: ['adurl'] },
];

/** Hosts whose whole job is counting clicks: click.example.com, track.example.net. */
const TRACKER_HOST = /^(click|clicks|clk|track|tracking|trk|redirect|redir|link|links|lnk|go|out|outbound|email|e|r)\d*\./;
/** Parameters such a host keeps the destination in. */
const TARGET_PARAMS = ['url', 'u', 'dest', 'destination', 'target', 'targeturl', 'redirect_url', 'redirecturl', 'to', 'goto', 'link', 'lnk', 'rurl', 'murl', 'out', 'href'];
/** Never touched, whatever the host: these are how sign-in and payment flows come back. */
const PROTECTED_PATH = /(login|logout|signin|sign-in|signout|oauth|openid|saml|sso|auth|consent|checkout|payment|pay\b|3ds|unsubscribe|verify|confirm|password|account)/i;

/** A destination worth going to: an absolute http(s) address. */
function destination(value) {
  if (!value) return '';
  let text = String(value).trim();
  // Some hops double-encode; one more decode is harmless when it is not needed.
  if (/^https?%3a/i.test(text)) { try { text = decodeURIComponent(text); } catch { return ''; } }
  if (/^\/\//.test(text)) text = 'https:' + text;
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

/** The hop and its destination are different sites, so skipping it changes who is visited. */
function crossSite(hop, target) {
  try { return siteOf(new URL(hop).hostname) !== siteOf(new URL(target).hostname); } catch { return false; }
}

/** Convert one of Brave's match patterns ("*://*.host/path*") to a test. */
function matchPattern(pattern) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const [, , hostPart, pathPart] = m;
  const esc = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = hostPart === '*' ? '[^/]+' : hostPart.startsWith('*.')
    ? '(?:[^/]+\\.)?' + esc(hostPart.slice(2)) : esc(hostPart);
  const pathRe = esc(pathPart).replace(/\*/g, '.*');
  try { return new RegExp('^https?://' + hostRe + '(?::\\d+)?' + pathRe + '$', 'i'); } catch { return null; }
}

class Bounce {
  constructor() {
    this.debounce = [];
  }

  /** Load Brave's debounce.json (already parsed). Unknown actions are skipped, not guessed at. */
  loadDebounce(rules) {
    const out = [];
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (!rule || !Array.isArray(rule.include) || typeof rule.action !== 'string') continue;
      const actions = rule.action.split(',');
      if (!actions.every((a) => ['redirect', 'base64', 'regex-path'].includes(a))) continue;
      const include = rule.include.map(matchPattern).filter(Boolean);
      const exclude = (rule.exclude || []).map(matchPattern).filter(Boolean);
      if (!include.length || typeof rule.param !== 'string') continue;
      let regex = null;
      if (actions.includes('regex-path')) { try { regex = new RegExp(rule.param); } catch { continue; } }
      out.push({
        include, exclude, base64: actions.includes('base64'), regex,
        param: rule.param, prepend: rule.prepend_scheme === 'https' || rule.prepend_scheme === 'http' ? rule.prepend_scheme : '',
        amp: rule.pref === 'brave.de_amp.enabled',
      });
    }
    this.debounce = out;
    return out.length;
  }

  /**
   * Where this hop really goes, or '' to leave it alone.
   * `kind` says which protection it was: 'bounce' or 'amp'.
   */
  unwrap(url, { bounce = true, amp = true } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();

    const found = (target, kind) => {
      const clean = destination(target);
      if (!clean || clean === url || !crossSite(url, clean) && kind === 'bounce') return null;
      // An AMP viewer address points at the same article on another site, so
      // cross-site is the norm there too; it only must not be itself.
      return { url: clean, kind };
    };

    if (amp) {
      // Google's AMP viewer: /amp/s/example.com/page is https://example.com/page.
      const viewer = /^\/amp\/(s\/)?(.+)$/.exec(parsed.pathname);
      if (viewer && /^(www\.)?google\.[a-z.]+$/.test(host)) {
        const hit = found((viewer[1] ? 'https://' : 'http://') + viewer[2] + parsed.search, 'amp');
        if (hit) return hit;
      }
      // The AMP cache: example-com.cdn.ampproject.org/c/s/example.com/page.
      const cache = /^\/[cv]\/(s\/)?(.+)$/.exec(parsed.pathname);
      if (cache && host.endsWith('.cdn.ampproject.org')) {
        const hit = found((cache[1] ? 'https://' : 'http://') + cache[2] + parsed.search, 'amp');
        if (hit) return hit;
      }
    }

    if (bounce) {
      for (const rule of BUILT_IN) {
        if (!rule.host.test(host) || !rule.path.test(parsed.pathname)) continue;
        for (const name of rule.params) {
          let value = parsed.searchParams.get(name);
          if (value && rule.trim) value = value.replace(rule.trim, '');
          const hit = value && found(value, 'bounce');
          if (hit) return hit;
        }
      }
    }

    for (const rule of this.debounce) {
      if (rule.amp ? !amp : !bounce) continue;
      if (!rule.include.some((re) => re.test(url)) || rule.exclude.some((re) => re.test(url))) continue;
      let value = '';
      if (rule.regex) {
        const m = rule.regex.exec(parsed.pathname);
        value = m?.[1] ? (rule.prepend ? rule.prepend + '://' + m[1] : m[1]) : '';
      } else value = parsed.searchParams.get(rule.param) || '';
      if (value && rule.base64) { try { value = Buffer.from(value, 'base64').toString('utf8'); } catch { value = ''; } }
      if (value && rule.regex) { try { value = decodeURIComponent(value); } catch { /* keep as is */ } }
      const hit = value && found(value, rule.amp ? 'amp' : 'bounce');
      if (hit) return hit;
    }

    // Any other host that exists to count clicks, with the destination in the
    // address. Only those hosts, and never on a sign-in or payment path.
    // The tracking label must be a subdomain: go.dev is a site, go.example.com a hop.
    if (bounce && TRACKER_HOST.test(host) && siteOf(host) !== host && !PROTECTED_PATH.test(parsed.pathname)) {
      for (const [name, value] of parsed.searchParams) {
        if (!TARGET_PARAMS.includes(name.toLowerCase())) continue;
        const hit = found(value, 'bounce');
        if (hit) return hit;
      }
    }
    return null;
  }
}

module.exports = { Bounce, BUILT_IN, destination, matchPattern, TRACKER_HOST, PROTECTED_PATH };
