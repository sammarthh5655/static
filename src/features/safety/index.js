const { JsonStore } = require('../../main/storage');

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
]);

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

    const add = (points, title, detail) => {
      result.score += points;
      result.reasons.push({ title, detail, points });
    };

    // --- punycode / homograph -------------------------------------------
    if (host.startsWith('xn--') || host.includes('.xn--')) {
      add(45, 'Internationalised domain name',
        'This address uses non-Latin characters that can be drawn to look like ordinary letters.');
    }

    // --- brand imitation --------------------------------------------------
    const labels = bare.split('.');
    const registrable = labels.slice(-2).join('.');
    const brandHit = this.#brandImitation(bare, registrable);
    if (brandHit) {
      add(brandHit.points, 'Looks like ' + brandHit.brand,
        brandHit.detail);
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

    if (bare.length > 40) {
      add(12, 'Very long address',
        'Long addresses make it hard to see which part is the real domain.');
    }

    const hyphens = (bare.match(/-/g) || []).length;
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
      } else if (result.score > 0) {
        // Only counts as a signal when something else is already suspicious;
        // on its own, a /login path is completely ordinary.
        add(15, 'Sign-in page on a suspicious address',
          'The address already looks irregular and this page is asking for credentials.');
      }
    }

    if (parsed.username || parsed.password) {
      add(40, 'Credentials embedded in the address',
        'An address of the form user@host is a classic way to disguise where a link really goes.');
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
   * Two patterns matter: the brand appearing as a label in a domain that is
   * not the brand's own, and a near-miss spelling of the brand.
   */
  #brandImitation(bare, registrable) {
    const labels = bare.split('.');
    const registrableName = registrable.split('.')[0];

    for (const brand of PROTECTED_BRANDS) {
      // The brand name appears somewhere, but this is not the brand's domain.
      if (bare.includes(brand)) {
        if (registrableName === brand) continue; // e.g. amazon.de - fine
        return {
          brand,
          points: 50,
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
 * Confusable substitutions are normalised first (paypa1 -> paypal), then edit
 * distance catches single insertions, deletions and transpositions. A distance
 * of 1 on a short word is too loose, so the threshold scales with length.
 */
function isLookalike(candidate, brand) {
  let normalised = candidate;
  for (const [from, to] of Object.entries(CONFUSABLES)) {
    normalised = normalised.split(from).join(to);
  }
  if (normalised === brand) return true;

  const allowed = brand.length >= 8 ? 2 : 1;
  return editDistance(normalised, brand) <= allowed &&
         Math.abs(normalised.length - brand.length) <= allowed;
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

module.exports = { Safety, WARN_THRESHOLD, isLookalike, editDistance };
