const { domainToUnicode } = require('node:url');
const { JsonStore } = require('../../main/storage');
const { siteOf } = require('../netguard/site');

/**
 * Fake website and phishing warnings.
 *
 * This is a heuristic check, not a threat feed. It runs locally on the URL and
 * a few page signals - there is no blocklist service behind it, so it will
 * miss real phishing that does not look odd, and that limit is stated in the
 * UI rather than hidden.
 *
 * The design priority is a LOW FALSE-POSITIVE RATE. A browser that warns about
 * ordinary sites gets its warnings clicked through without reading, which is
 * worse than not warning at all. So a warning needs real weight behind it, and
 * anything the user explicitly trusts is never questioned again.
 */

/** Brands whose names are most often imitated in lookalike domains. */
const PROTECTED_BRANDS = [
  'google', 'gmail', 'youtube', 'facebook', 'instagram', 'whatsapp', 'apple',
  'icloud', 'microsoft', 'outlook', 'office365', 'paypal', 'amazon', 'netflix',
  'linkedin', 'twitter', 'dropbox', 'adobe', 'steam', 'discord', 'binance',
  'coinbase', 'metamask', 'chase', 'wellsfargo', 'hdfc', 'icici', 'sbi',
  'axisbank', 'paytm', 'phonepe', 'flipkart', 'irctc', 'aadhaar', 'uidai',
];

/** Legitimate domains for those brands, so the real site never trips a check. */
const LEGITIMATE = new Set([
  'google.com', 'google.co.in', 'gmail.com', 'youtube.com', 'youtu.be',
  'facebook.com', 'instagram.com', 'whatsapp.com', 'apple.com', 'icloud.com',
  'microsoft.com', 'live.com', 'outlook.com', 'office.com', 'paypal.com',
  'amazon.com', 'amazon.in', 'netflix.com', 'linkedin.com', 'twitter.com',
  'x.com', 'dropbox.com', 'adobe.com', 'steampowered.com', 'discord.com',
  'binance.com', 'coinbase.com', 'metamask.io', 'chase.com', 'wellsfargo.com',
  'hdfcbank.com', 'icicibank.com', 'onlinesbi.sbi', 'sbi.co.in', 'axisbank.com',
  'paytm.com', 'phonepe.com', 'flipkart.com', 'irctc.co.in', 'uidai.gov.in',
  // The same companies' other real addresses that carry the brand's name as
  // a word. Safe Browsing (features/netguard) stops a page this check flags,
  // so these must never trip it.
  'google-analytics.com', 'googlemail.com', 'youtube-nocookie.com', 'facebookmail.com',
  'icloud-content.com', 'apple-dns.net', 'microsoftonline.com', 'microsoft365.com',
  'paypal-community.com', 'amazon-adsystem.com', 'amazonpay.in', 'adobelogin.com',
  'discordapp.com', 'discordapp.net', 'office365.com',
]);

/**
 * Words a fake site glues onto a brand's name to look official:
 * paypal-login, applesupport, secure-chase. A brand inside another word
 * (purchase, pineapple, amazonaws) is not imitation.
 */
const BAIT_WORDS = new Set([
  'login', 'logon', 'signin', 'sign', 'secure', 'security', 'verify', 'verification', 'account', 'accounts',
  'support', 'help', 'helpdesk', 'update', 'billing', 'wallet', 'service', 'services', 'id', 'auth',
  'online', 'web', 'mail', 'pay', 'payment', 'team', 'official', 'alert',
  'alerts', 'confirm', 'recovery', 'unlock', 'gift', 'prize', 'promo', 'bonus', 'airdrop', 'claim',
  'reward', 'rewards', 'refund', 'app', 'apps', 'portal', 'access', 'safe',
]);

/**
 * Letters drawn alike in other alphabets (Cyrillic and Greek mostly), as the
 * Latin letter they pass for. An internationalised address spelled with
 * these to read as a brand is the classic homograph attack.
 */
const HOMOGLYPHS = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j',
  'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ӏ': 'l', 'ո': 'n', 'ս': 'u', 'ѕ': 's', 'ԛ': 'q', 'ԝ': 'w', 'ᴠ': 'v',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'ρ': 'p', 'ε': 'e', 'υ': 'u',
  'ı': 'i', 'ł': 'l', 'ö': 'o', 'ó': 'o', 'ò': 'o', 'ô': 'o', 'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a',
  'é': 'e', 'è': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i', 'ï': 'i', 'ú': 'u', 'ù': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n',
};

/** Letters a quick reader takes for one another: paypai, rnicrosoft. */
const SIMILAR = new Set(['il', 'li', 'ij', 'ji', 'lj', 'jl', 'uv', 'vu', 'nm', 'mn', 'oq', 'qo', 'gq', 'qg']);

/** TLDs disproportionately used for throwaway phishing hosts. */
const RISKY_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'xyz', 'click', 'link', 'work',
  'zip', 'mov', 'rest', 'country', 'kim', 'loan', 'download',
]);

/** Characters commonly substituted to fake a brand name. */
const CONFUSABLES = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
  rn: 'm', vv: 'w', ii: 'u',
};

/** Score at or above which the interstitial is shown. */
const WARN_THRESHOLD = 60;

class Safety {
  constructor(dir, { onChange } = {}) {
    this.store = new JsonStore(dir, 'safety', {
      enabled: true,
      trusted: [],
      warnings: [],
      blockedCount: 0,
    });
    this.onChange = onChange || (() => {});
  }

  get config() { return this.store.data; }

  isTrusted(host) {
    const clean = String(host || '').toLowerCase().replace(/^www\./, '');
    return (this.config.trusted || []).includes(clean);
  }

  trust(host) {
    const clean = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!clean) return { ok: false };
    if (!this.config.trusted.includes(clean)) {
      this.store.data.trusted = [...this.config.trusted, clean].slice(-500);
      this.store.save();
      this.onChange();
    }
    return { ok: true };
  }

  untrust(host) {
    this.store.data.trusted = (this.config.trusted || [])
      .filter((entry) => entry !== String(host || '').toLowerCase());
    this.store.save();
    this.onChange();
    return { ok: true };
  }

  /**
   * Assess a URL.
   *
   * @returns {{score:number, risk:string, reasons:Array, host:string}}
   */
  assess(url) {
    const result = { score: 0, risk: 'safe', reasons: [], host: '', url };
    if (!this.config.enabled) return result;

    let parsed;
    try { parsed = new URL(url); } catch { return result; }
    if (!/^https?:$/.test(parsed.protocol)) return result;

    const host = parsed.hostname.toLowerCase();
    const bare = host.replace(/^www\./, '');
    result.host = bare;

    // Anything the user has trusted, or a known-good domain, stops here.
    if (this.isTrusted(bare)) return result;
    if (LEGITIMATE.has(bare)) return result;
    if ([...LEGITIMATE].some((good) => bare.endsWith('.' + good))) return result;

    // `imitates` marks the signals that on their own say "imitation": a
    // brand's name or spelling, or an address built to disguise itself. The
    // rest (an odd ending, a long name) only ever add weight, so Safe
    // Browsing never stops a page for its shape alone.
    const add = (points, title, detail, primary = false) => {
      result.score += points;
      result.reasons.push({ title, detail, points });
      if (primary) result.imitates = true;
    };

    // --- punycode / homograph -------------------------------------------
    const idn = host.startsWith('xn--') || host.includes('.xn--');
    if (idn) {
      add(45, 'Internationalised domain name',
        'This address uses non-Latin characters that can be drawn to look like ordinary letters.');
    }

    // --- brand imitation --------------------------------------------------
    // The site is the registrable domain (amazon.co.uk, not co.uk). An
    // internationalised address is read as the Latin letters it passes for,
    // so apple.com spelled with a Cyrillic "a" is seen for what it imitates.
    const shown = idn ? skeleton(domainToUnicode(bare) || bare) : bare;
    const homograph = idn && shown !== bare;
    const registrable = siteOf(shown);
    const labels = bare.split('.');
    const brandHit = this.#brandImitation(shown, registrable, homograph);
    if (brandHit) {
      add(brandHit.points, 'Looks like ' + brandHit.brand, homograph
        ? `This address is spelled with letters from another alphabet so that it reads as "${registrable}".`
        : brandHit.detail, true);
    }

    // --- structural signals ------------------------------------------------
    const tld = labels[labels.length - 1];
    if (RISKY_TLDS.has(tld)) {
      add(20, 'Unusual domain ending',
        `.${tld} addresses are cheap and disposable, so they are used for scams far more often than most.`);
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      add(35, 'Numeric address instead of a name',
        'Real services use a domain name. A raw IP address usually means someone is avoiding one.');
    }

    if (labels.length >= 5) {
      add(20, 'Unusually deep subdomains',
        'Long chains like login.secure.account.example.com are used to push the real domain out of view.');
    }

    if (shown.length > 40) {
      add(12, 'Very long address',
        'Long addresses make it hard to see which part is the real domain.');
    }

    // Counted on the address as it reads: punycode's own xn-- is not one.
    const hyphens = (shown.match(/-/g) || []).length;
    if (hyphens >= 3) {
      add(15, 'Many hyphens in the address',
        'Repeated hyphens are typical of generated scam domains.');
    }

    // --- credential harvesting ---------------------------------------------
    const pathAndQuery = (parsed.pathname + parsed.search).toLowerCase();
    if (/(login|signin|verify|account|secure|update|confirm|wallet|billing)/.test(pathAndQuery)) {
      if (parsed.protocol === 'http:') {
        add(40, 'Sign-in page without encryption',
          'This page asks for account details over an unencrypted connection, so anything typed can be read in transit.');
      } else if (result.score >= 45) {
        // Only counts as a signal when the address is already suspicious;
        // on its own, a /login path is completely ordinary.
        add(15, 'Sign-in page on a suspicious address',
          'The address already looks irregular and this page is asking for credentials.');
      }
    }

    if (parsed.username || parsed.password) {
      add(40, 'Credentials embedded in the address',
        'An address of the form user@host is a classic way to disguise where a link really goes.', true);
    }

    result.score = Math.min(100, result.score);
    result.risk = result.score >= 80 ? 'high'
      : result.score >= WARN_THRESHOLD ? 'medium'
      : result.score >= 30 ? 'low' : 'safe';
    result.shouldWarn = result.score >= WARN_THRESHOLD;
    return result;
  }

  /**
   * Does this domain imitate a protected brand without being it?
   *
   * Two patterns matter: the brand's name as a word of an address that is
   * not the brand's (paypal-login.com, secure.applesupport.net), and a
   * near-miss spelling of the brand as the site's own name (paypa1.com).
   * A brand inside an ordinary word - purchase, pineapple, amazonaws - is
   * not imitation, and neither is a real word one letter from a brand
   * (finance, stream, email): Safe Browsing stops pages this check flags,
   * so a false alarm on an ordinary site costs more than a miss.
   *
   * `homograph`: the address was read from look-alike letters, so even the
   * brand's own name is an imitation - the real site is never spelled so.
   */
  #brandImitation(bare, registrable, homograph = false) {
    const registrableName = registrable.split('.')[0];
    const suffix = registrable.slice(registrableName.length);
    const words = bare.slice(0, bare.length - suffix.length).split(/[.-]/).filter(Boolean);

    for (const brand of PROTECTED_BRANDS) {
      if (registrableName === brand) {
        if (!homograph) continue; // amazon.de, amazon.co.uk: the brand's own
        return { brand, points: 55, detail: '' };
      }
      // The brand glued to a bait word (paypallogin, secure-chase), or beside
      // one or its own ending (paypal.com.account-check.ru): built to deceive.
      // The brand alone as part of another site's address (as in
      // apple.stackexchange.com) is only a hint.
      const glued = words.some((word) => word !== brand &&
        ((word.startsWith(brand) && BAIT_WORDS.has(word.slice(brand.length))) ||
         (word.endsWith(brand) && BAIT_WORDS.has(word.slice(0, -brand.length)))));
      const alone = words.indexOf(brand);
      const baited = alone !== -1 && words.some((word, i) => i !== alone && (BAIT_WORDS.has(word) || (i === alone + 1 && ['com', 'net', 'org', 'co'].includes(word))));
      if (glued || alone !== -1) {
        return {
          brand,
          points: glued || baited ? 60 : 35,
          detail: `The name "${brand}" appears in this address, but the actual site is "${registrable}", which does not belong to them.`,
        };
      }

      // Near-miss spelling of the brand in the registrable label.
      if (registrableName.length >= 4 && isLookalike(registrableName, brand)) {
        return {
          brand,
          points: 55,
          detail: `"${registrableName}" is one or two characters away from "${brand}" - a common way to imitate a well-known site.`,
        };
      }
    }
    return null;
  }

  /** Record a warning that was actually shown, for the safety log. */
  recordWarning(assessment, action) {
    this.store.data.warnings = [
      {
        host: assessment.host,
        url: assessment.url,
        score: assessment.score,
        risk: assessment.risk,
        reasons: assessment.reasons.map((r) => r.title),
        action,
        at: Date.now(),
      },
      ...(this.config.warnings || []),
    ].slice(0, 200);
    if (action === 'blocked') {
      this.store.data.blockedCount = (this.config.blockedCount || 0) + 1;
    }
    this.store.save();
    this.onChange();
  }

  setEnabled(enabled) {
    this.store.data.enabled = !!enabled;
    this.store.save();
    this.onChange();
    return this.config;
  }

  state() {
    return {
      enabled: !!this.config.enabled,
      trusted: this.config.trusted || [],
      warnings: (this.config.warnings || []).slice(0, 50),
      blockedCount: this.config.blockedCount || 0,
    };
  }

  flush() { this.store.save(); }
}

/**
 * Is `candidate` a deliberate near-miss of `brand`?
 *
 * Only the slips a fake is made of: confusable characters (paypa1,
 * arnazon), two neighbouring letters swapped (gogole), a doubled letter
 * added or dropped (gooogle, facebok), or one letter traded for one drawn
 * alike (paypai). Any other one-letter difference is how ordinary words
 * differ (finance and binance, stream and steam), so it is not counted -
 * except on long names, where one slip is rarely a real word.
 */
function isLookalike(candidate, brand) {
  if (candidate === brand) return false;
  let a = candidate;
  for (const [from, to] of Object.entries(CONFUSABLES)) a = a.split(from).join(to);
  const b = brand;
  if (a === b) return true;
  if (a.length === b.length) {
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
    if (diff.length === 1 && SIMILAR.has(a[diff[0]] + b[diff[0]])) return true;
  }
  // One letter more or fewer, where that letter doubles its neighbour.
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  if (long.length === short.length + 1) {
    for (let i = 0; i < long.length; i++) {
      if ((long[i] === long[i - 1] || long[i] === long[i + 1]) && long.slice(0, i) + long.slice(i + 1) === short) return true;
    }
  }
  return b.length >= 8 && editDistance(a, b) === 1;
}

/** An internationalised address as the Latin letters it passes for. */
function skeleton(text) {
  let out = '';
  for (const ch of String(text).toLowerCase()) out += HOMOGLYPHS[ch] || ch;
  return out;
}

/** Levenshtein distance, iterative and allocation-light. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      current[j + 1] = Math.min(
        previous[j + 1] + 1,
        current[j] + 1,
        previous[j] + (a[i] === b[j] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

module.exports = { Safety, WARN_THRESHOLD, isLookalike, editDistance, skeleton };
