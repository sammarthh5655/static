'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const tls = require('node:tls');
const { app, ipcMain, net, webContents: allContents } = require('electron');
const { JsonStore } = require('../../main/storage');
const { ThreatLists, LISTS: THREAT_LISTS, KINDS } = require('./threats');
const { Bounce } = require('./bounce');
const { resolverConfig, PROVIDERS } = require('./dns');
const { LEVELS, levelOf } = require('./presets');
const { siteOf, sameSite, isLocalHost, isIpAddress } = require('./site');

/**
 * Network protection: Safe Browsing, HTTPS-only mode, certificates, Secure
 * DNS, WebRTC, bounce tracking and AMP, Global Privacy Control, Do Not Track
 * and referrers. One service, because all of it hangs off the same few hooks
 * of the session - the request filter, the request headers, the certificate
 * check and a tab's failed loads - and those hooks are each allowed only one
 * listener (see BrowserApplication#installRequestFilter).
 *
 * The browser (BrowserApplication) owns the hooks and calls in here; this
 * owns the decisions and the interstitial pages' state.
 *
 * Everything here applies in incognito too: that window is its own process
 * with its own session, and constructs one of these like any other.
 */

/** Brave's debounce rules, fetched with the threat lists. */
const DEBOUNCE_URL = 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/debounce.json';

/** What WebRTC may use, per setting. Chromium's own policy names. */
const WEBRTC = {
  standard: 'default_public_interface_only',
  strict: 'disable_non_proxied_udp',
  off: 'default',
};

/**
 * Files that run as programs when opened. From a site you have not been to
 * before, these are what a drive-by download looks like.
 */
const DANGEROUS_TYPES = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'iso', 'img', 'vhd', 'vhdx', 'dll', 'sys',
  'dmg', 'pkg', 'app', 'command', 'scpt', 'workflow', 'sh', 'apk', 'appimage', 'deb', 'rpm',
]);

/**
 * Failures of an upgraded https:// load that mean "this site has no working
 * https", so http is the answer (or, in HTTPS-only mode, the question).
 * Not every failure: no network at all, or a name that does not exist, would
 * fail over http too.
 */
const NOT_A_SECURE_SITE = (code) => code !== -3 && code !== -20 && code !== -105 && code !== -106 &&
  code !== -137 && code !== -21 && code !== -27 && code <= -100 && code > -400;

/** Certificate errors: Chromium's ERR_CERT_* range. */
const isCertError = (code) => code <= -200 && code > -300;

/** What each certificate error means, said plainly. */
function certProblem(code, error) {
  const name = String(error || '').replace(/^net::/, '');
  const known = {
    '-200': ['Wrong site', 'The certificate is for a different address, so this may not be the site you meant to reach.'],
    '-201': ['Expired or not yet valid', 'The certificate is outside its valid dates. Check that this computer\'s date and time are right.'],
    '-202': ['Not from a trusted authority', 'No authority your computer trusts vouches for this site. It may have made its own certificate.'],
    '-203': ['Damaged certificate', 'The certificate has errors and cannot be checked.'],
    '-206': ['Revoked', 'The authority that issued the certificate has withdrawn it.'],
    '-207': ['Not valid', 'The certificate could not be verified.'],
    '-208': ['Weak signature', 'The certificate is signed in a way that can be forged.'],
    '-211': ['Weak key', 'The certificate uses a key short enough to be broken.'],
    '-213': ['Valid for too long', 'The certificate is valid for longer than browsers allow.'],
    '-214': ['Not publicly logged', 'The certificate was not published to Certificate Transparency logs, as browsers require.'],
    '-217': ['Known interception', 'This certificate is known to be used to intercept traffic.'],
  }[String(code)];
  return { title: known?.[0] || 'Certificate problem', detail: known?.[1] || 'The connection to this site cannot be verified.', code: name || String(code) };
}

/** Plain-language threat kinds, for the warning page and the site card. */
const THREAT_WORDS = {
  ...KINDS,
  suspicious: { label: 'Looks fake', title: 'This site looks like a fake' },
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function bareHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

class NetGuard {
  /**
   * @param browser the BrowserApplication: settings, shields, safety, history,
   *                session, and the tabs of every window
   */
  constructor(browser) {
    this.browser = browser;
    this.store = new JsonStore(browser.dir, 'netguard', {
      // Sites you chose to open despite a Safe Browsing warning: host -> { kind, list, at }.
      allowedSites: {},
      // Sites you allowed over http in HTTPS-only mode.
      httpAllowed: [],
      threatsFetched: 0,
      debounceFetched: 0,
    });
    this.threats = new ThreatLists(browser.dir, {
      store: this.store,
      fetcher: (url) => this.#download(url),
    });
    this.bounce = new Bounce();
    this.#loadDebounce();
    /** token -> what an interstitial is about. Memory only. */
    this.pending = new Map();
    /** webContents id -> { http, https, at }: an http address tried over https. */
    this.upgrades = new Map();
    /** Hosts whose https failed this run, so plain http is used without asking. */
    this.httpThisSession = new Set();
    /** host -> Set of certificate fingerprints you chose to trust anyway, this run only. */
    this.certAllowed = new Map();
    /** host -> the certificate it last showed. Memory only, newest last. */
    this.certs = new Map();
    /** webContents id -> { url, error, certificate }: the last certificate error. */
    this.certErrors = new Map();
    /** webContents id -> { blocked, upgraded, shown }: this page's insecure content. */
    this.mixed = new Map();
    /** webContents id -> predicate: history entries to drop when the next page commits. */
    this.dropOnCommit = new Map();
    /** webContents id -> { url, at }: the AMP page last left, so a site that sends us back is not looped. */
    this.ampLeft = new Map();
    /** Addresses you chose to download anyway: the next download of each is let through. */
    this.downloadAllowed = new Set();
  }

  get settings() { return this.browser.settings.value; }

  /* ---- start ---------------------------------------------------------------- */

  /** Hooks that do not go through the browser's request filter. Called once, at start. */
  start() {
    const session = this.browser.session;

    // Certificates: Chromium's own verdict always stands (-3 means "use it");
    // this only keeps a copy of what each site showed, for the site card.
    session.setCertificateVerifyProc((request, callback) => {
      try { this.#keepCertificate(request); } catch { /* the card loses a row, nothing more */ }
      callback(-3);
    });

    // A certificate error: refused, unless you chose to go ahead with this
    // exact certificate this run. Kept for the warning page either way.
    app.on('certificate-error', (event, contents, url, error, certificate, callback, isMainFrame) => {
      if (contents?.session !== session) return;
      const host = hostOf(url);
      if (this.certAllowed.get(host)?.has(certificate?.fingerprint)) {
        event.preventDefault();
        callback(true);
        return;
      }
      if (isMainFrame !== false) this.certErrors.set(contents.id, { url, error, certificate: summariseCertificate(certificate, error), at: Date.now() });
      callback(false);
    });

    // WebRTC on everything this session makes: tabs, panels, the overlay.
    app.on('web-contents-created', (_event, contents) => {
      if (contents.session === session) this.#webrtc(contents);
    });
    for (const contents of allContents.getAllWebContents()) if (contents.session === session) this.#webrtc(contents);

    // Enhanced Safe Browsing: a look at each download before it is kept.
    // First in line, so a download it stops never reaches the Downloads list.
    session.prependListener('will-download', (event, item, contents) => this.#checkDownload(event, item, contents));

    // The tab preload asks, in every frame, which signals to send.
    ipcMain.on('netguard:signals', (event) => {
      const s = this.settings;
      event.returnValue = { gpc: s.gpc !== false, dnt: s.doNotTrack === true, strictReferrer: s.referrerPolicy === 'strict' };
    });
    // A page that turned out to be AMP names its real page.
    ipcMain.on('netguard:amp', (event, canonical) => this.#leaveAmp(event, canonical));

    this.applyDns();

    // Lists: now if there are none or they are old, then twice a day. They
    // are also refreshed whenever the Shields lists are (see refreshLists).
    setTimeout(() => this.refreshLists().catch(() => {}), this.threats.total() ? 5000 : 0);
    this.timer = setInterval(() => this.refreshLists().catch(() => {}), 3 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  /** Download the threat lists and the debounce rules, when they are due (or `force`). */
  async refreshLists({ force = false } = {}) {
    const result = await this.threats.refresh({ force });
    const age = Date.now() - (this.store.data.debounceFetched || 0);
    if (force || age > 24 * 60 * 60 * 1000 || !this.bounce.debounce.length) {
      try {
        const text = await this.#download(DEBOUNCE_URL);
        const rules = JSON.parse(text);
        if (Array.isArray(rules) && rules.length && this.bounce.loadDebounce(rules)) {
          fs.mkdirSync(this.threats.cacheDir, { recursive: true });
          fs.writeFileSync(path.join(this.threats.cacheDir, 'debounce.json'), text);
          this.store.data.debounceFetched = Date.now();
          this.store.save();
        }
      } catch (error) {
        console.error('bounce tracking: could not fetch Brave\'s debounce rules:', error.message);
      }
    }
    this.browser.push?.();
    return result;
  }

  #loadDebounce() {
    try {
      this.bounce.loadDebounce(JSON.parse(fs.readFileSync(path.join(this.threats.cacheDir, 'debounce.json'), 'utf8')));
    } catch { /* not fetched yet: the built-in rules still apply */ }
  }

  #download(url) {
    return net.fetch(url, { cache: 'no-cache' }).then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    });
  }

  /* ---- settings that live outside the request filter ------------------------ */

  /** Point Chromium's resolver where Settings says. It is process-wide; incognito, a process of its own, applies its own copy. */
  applyDns() {
    const config = resolverConfig(this.settings);
    try {
      app.configureHostResolver(config);
      this.dnsApplied = config;
    } catch (error) {
      console.error('secure dns: could not configure the resolver:', error.message);
      this.dnsApplied = null;
    }
    return config;
  }

  #webrtc(contents) {
    try {
      if (!contents.isDestroyed()) contents.setWebRTCIPHandlingPolicy(WEBRTC[this.settings.webrtcPolicy] || WEBRTC.standard);
    } catch { /* a view that is closing */ }
  }

  /** Settings changed (from the page, a level, a reset): apply what lives outside the request path. */
  settingsChanged(patch) {
    const keys = patch && typeof patch === 'object' ? Object.keys(patch) : null;
    if (!keys || keys.some((key) => ['secureDns', 'secureDnsProvider', 'secureDnsCustom'].includes(key))) this.applyDns();
    if (!keys || keys.includes('webrtcPolicy')) {
      for (const contents of allContents.getAllWebContents()) if (contents.session === this.browser.session) this.#webrtc(contents);
    }
  }

  /** Apply a tracking protection level: every switch it names, in Shields and Settings. */
  applyLevel(id) {
    const level = LEVELS[id];
    if (!level) throw new Error('Unknown protection level.');
    this.browser.shields.update(level.shields);
    this.browser.settings.update(level.settings);
    this.settingsChanged(level.settings);
    return this.state();
  }

  level() {
    return levelOf(this.browser.shields.config, this.settings);
  }

  /* ---- the request filter ---------------------------------------------------- */

  /**
   * Decide what to do with a request before Shields sees it.
   *
   * @param details  the webRequest details
   * @param tab      the tab making it, when it is one
   * @returns {{cancel?: true, redirect?: string, skipUpgrade?: true, allowSite?: true}|null}
   */
  inspect(details, tab) {
    const { url, resourceType } = details;
    if (!/^https?:/i.test(url)) return null;
    const s = this.settings;
    const top = resourceType === 'mainFrame';
    const host = hostOf(url);
    const allowed = this.#siteAllowed(host);

    // ---- Safe Browsing --------------------------------------------------
    if (s.safeBrowsing !== 'off' && !allowed && !isLocalHost(host)) {
      const threat = this.threats.match(url);
      if (threat) {
        if (top) {
          this.browser.shields.stats.record('phishing');
          this.#interstitial(tab, details, { kind: 'threat', threat });
        } else {
          // A script, frame or download from a listed address. Counted, never shown.
          this.browser.shields.stats.record('dangerous');
        }
        return { cancel: true };
      }
      if (top && this.browser.safety?.config.enabled !== false) {
        const assessment = this.browser.safety.assess(url);
        const threshold = s.safeBrowsing === 'enhanced' ? 45 : 60;
        // Only an address that imitates something (a brand, a disguise) is
        // stopped; an odd shape alone only adds weight (features/safety).
        if (assessment.score >= threshold && assessment.imitates) {
          this.browser.shields.stats.record('phishing');
          this.browser.safety.recordWarning(assessment, 'blocked');
          this.#interstitial(tab, details, { kind: 'suspicious', assessment });
          return { cancel: true };
        }
      }
    }
    if (!top) return null;

    // ---- bounce trackers and AMP ----------------------------------------
    // A link followed, never a form sent: a POST cannot be redirected as a GET.
    if ((s.bounceTracking !== false || s.ampSkip !== false) && (details.method || 'GET') === 'GET') {
      const hop = this.bounce.unwrap(url, { bounce: s.bounceTracking !== false, amp: s.ampSkip !== false });
      if (hop) {
        this.browser.shields.stats.record(hop.kind === 'amp' ? 'amp' : 'bounce');
        return { redirect: hop.url };
      }
    }

    // ---- http -----------------------------------------------------------
    if (/^http:/i.test(url) && !isLocalHost(host) && !isIpAddress(host)) {
      const bare = bareHost(host);
      // A site you allowed over http. One that only fell back quietly (with
      // HTTPS-only off) is asked about again once HTTPS-only is on.
      if (this.store.data.httpAllowed.includes(bare) || (!s.httpsOnly && this.httpThisSession.has(bare))) return { skipUpgrade: true, allowSite: allowed || undefined };
      const id = details.webContentsId;
      const last = this.upgrades.get(id);
      // The https address sent us straight back to http: there is no secure
      // version, whatever the server's redirect claims.
      const looped = last && last.http === url && Date.now() - last.at < 15000;
      if (looped) {
        this.upgrades.delete(id);
        if (s.httpsOnly) {
          this.#interstitial(tab, details, { kind: 'nohttps', url });
          return { cancel: true };
        }
        this.httpThisSession.add(bare);
        return { skipUpgrade: true };
      }
      if (s.httpsOnly) {
        const secure = 'https:' + url.slice(5);
        this.noteUpgrade(id, url, secure);
        this.browser.shields.stats.record('https');
        return { redirect: secure };
      }
    }
    return allowed ? { allowSite: true } : null;
  }

  /** An http address is being tried over https, by HTTPS-only mode or Shields. */
  noteUpgrade(contentsId, http, https) {
    if (contentsId === undefined || contentsId === null) return;
    this.upgrades.set(contentsId, { http, https, at: Date.now() });
  }

  /** Did you choose to open this host despite a warning? Its parent domains count too. */
  #siteAllowed(host) {
    const sites = this.store.data.allowedSites || {};
    let at = bareHost(host);
    while (at) {
      if (sites[at]) return true;
      const dot = at.indexOf('.');
      if (dot === -1) break;
      at = at.slice(dot + 1);
      if (!at.includes('.')) break;
    }
    return false;
  }

  /** For the request filter: Shields' own badware rules stand down for a site you chose to open. */
  userAllowed(url) {
    return this.#siteAllowed(hostOf(url));
  }

  /* ---- request headers ------------------------------------------------------ */

  /**
   * Global Privacy Control, Do Not Track and Strict referrers, on every
   * request this session sends. Edits `headers` in place.
   */
  requestHeaders(details, headers) {
    const s = this.settings;
    if (s.gpc !== false) headers['Sec-GPC'] = '1';
    else { delete headers['Sec-GPC']; delete headers['sec-gpc']; }
    if (s.doNotTrack === true) headers.DNT = '1';
    if (s.referrerPolicy === 'strict') {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'referer');
      const value = key ? headers[key] : '';
      // Across sites only the origin goes, whatever the page asked for
      // (referrerpolicy="unsafe-url" included). Within a site, as normal.
      if (value && !sameSite(value, details.url)) {
        try { headers[key] = new URL(value).origin + '/'; } catch { delete headers[key]; }
      }
    }
    return headers;
  }

  /* ---- interstitials ----------------------------------------------------------- */

  /**
   * Show a warning page in `tab` instead of what it was opening. The request
   * has been cancelled already; the page is loaded the way every internal
   * page is (as Screen Time's block page is). The warning names a token, and
   * main keeps what it is about, so the page can never be talked into
   * vouching for an address it was not shown for.
   */
  #interstitial(tab, details, info) {
    if (!tab) return null;
    const url = info.url || details.url;
    // A page asking for the same thing twice in a moment (a redirect retried,
    // a double click) gets one warning, not two: the one already on its way.
    for (const [token, entry] of this.pending) {
      if (entry.tabId !== tab.id || entry.url !== url || entry.proceeded || Date.now() - entry.at > 3000) continue;
      if (!String(tab.state?.internalUrl || '').includes(token)) this.#show(tab, entry, info.failedUrl || url);
      return token;
    }
    const token = randomUUID();
    const host = hostOf(url);
    const entry = { token, tabId: tab.id, kind: info.kind, url, host, at: Date.now() };
    if (info.threat) Object.assign(entry, { threat: info.threat });
    if (info.assessment) entry.assessment = { score: info.assessment.score, risk: info.assessment.risk, reasons: info.assessment.reasons };
    if (info.cert) entry.cert = info.cert;
    this.pending.set(token, entry);
    this.#prunePending();
    this.#show(tab, entry, info.failedUrl || url);
    return token;
  }

  /** Load the warning page for `entry` in its tab. */
  #show(tab, entry, failed) {
    // The cancelled or failed load leaves an entry behind; Back would land on
    // it and run straight into this warning again.
    this.#dropBehind(tab.view.webContents.id, (u) => sameEntry(u, failed));
    setImmediate(() => {
      if (!tab.manager?.tabs.has(tab.id)) return;
      const query = new URLSearchParams({ kind: entry.kind, url: entry.url, id: entry.token });
      tab.manager.navigate(tab.id, 'browser://warning?' + query.toString());
    });
  }

  #prunePending() {
    const hour = Date.now() - 60 * 60 * 1000;
    for (const [token, entry] of this.pending) if (entry.at < hour) this.pending.delete(token);
    while (this.pending.size > 200) this.pending.delete(this.pending.keys().next().value);
  }

  /** A main-frame load failed in a tab: an upgrade that did not work, or a certificate error. */
  loadFailed(tab, code, url) {
    const contents = tab?.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const up = this.upgrades.get(contents.id);
    if (up && sameEntry(up.https, url) && NOT_A_SECURE_SITE(code)) {
      this.upgrades.delete(contents.id);
      if (this.settings.httpsOnly) {
        this.#interstitial(tab, { url: up.http }, { kind: 'nohttps', url: up.http, failedUrl: url });
        return;
      }
      // Shields' quiet upgrade: the site has no https, so it opens as it is,
      // marked Not secure, and is not tried over https again this run.
      this.httpThisSession.add(bareHost(hostOf(up.http)));
      this.#dropBehind(contents.id, (u) => sameEntry(u, url));
      setImmediate(() => { if (tab.manager?.tabs.has(tab.id)) tab.manager.navigate(tab.id, up.http); });
      return;
    }
    if (isCertError(code)) {
      const seen = this.certErrors.get(contents.id);
      const cert = seen && sameEntry(seen.url, url) ? seen : { url, error: '', certificate: null };
      const problem = certProblem(code, cert.error);
      this.#interstitial(tab, { url }, {
        kind: 'cert', url, failedUrl: url,
        cert: { ...problem, certificate: cert.certificate, fingerprint: cert.certificate?.fingerprint || '', canProceed: code !== -206 && code !== -217 && !!cert.certificate },
      });
    }
  }

  /** A page committed in a tab: tidy history after a warning, and start counting its insecure content afresh. */
  committed(contents) {
    if (!contents || contents.isDestroyed()) return;
    this.mixed.delete(contents.id);
    // Waiting for the right page: the cancelled load's own error page
    // commits first, and must not use the tidy-up meant for the page after.
    const drops = (this.dropOnCommit.get(contents.id) || []).filter((drop) => Date.now() <= drop.until);
    if (!drops.length) { this.dropOnCommit.delete(contents.id); return; }
    try {
      const history = contents.navigationHistory;
      // Several can be due at once: a warning answered, then the failed
      // https try on the way to the site's http page.
      for (let guard = 0; guard < 4; guard++) {
        const active = history.getActiveIndex();
        const behind = active > 0 ? history.getAllEntries()[active - 1] : null;
        const at = behind ? drops.findIndex((drop) => drop.test(behind.url)) : -1;
        if (at === -1) break;
        drops.splice(at, 1);
        history.removeEntryAtIndex(active - 1);
      }
    } catch { /* history is a convenience here; the warning still worked */ }
    if (drops.length) this.dropOnCommit.set(contents.id, drops);
    else this.dropOnCommit.delete(contents.id);
  }

  /**
   * When a later page commits in `id`, remove the history entry just behind
   * it if `test` says it is the one to go: a blocked load, a warning answered,
   * an AMP page left. Expires on its own, so it can never take a page later.
   */
  #dropBehind(id, test) {
    if (id === undefined || id === null) return;
    const drops = (this.dropOnCommit.get(id) || []).filter((drop) => Date.now() <= drop.until);
    drops.push({ test, until: Date.now() + 15000 });
    this.dropOnCommit.set(id, drops.slice(-4));
  }

  /** What a warning page is about, for that page only. */
  #entryFor(sender, w, token) {
    const tab = w?.tabOf?.(sender);
    const entry = this.pending.get(String(token || ''));
    if (!tab || !entry || entry.tabId !== tab.id) return null;
    return { tab, entry };
  }

  #describe(entry) {
    const lists = this.threats.state();
    const base = {
      kind: entry.kind, url: entry.url, host: entry.host, at: entry.at,
      lists: { fetchedAt: lists.fetchedAt, entries: lists.entries },
      level: this.settings.safeBrowsing,
    };
    if (entry.kind === 'threat') {
      const words = THREAT_WORDS[entry.threat.kind] || THREAT_WORDS.malware;
      return { ...base, threat: { kind: entry.threat.kind, label: words.label, title: words.title, list: entry.threat.name, source: entry.threat.source, matched: entry.threat.matched } };
    }
    if (entry.kind === 'suspicious') return { ...base, assessment: entry.assessment };
    if (entry.kind === 'cert') {
      const { title, detail, code, certificate, canProceed } = entry.cert;
      return { ...base, cert: { title, detail, code, certificate, canProceed } };
    }
    return base;
  }

  /** Leave a warning page for the last page before the danger, or a new tab. */
  #backToSafety(tab, entry) {
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    const entries = history.getAllEntries();
    const dangerous = (u) => /[\\/]pages[\\/]warning\.html/.test(u || '') || (entry && hostOf(u) === entry.host) || /^about:blank/.test(u || '');
    for (let i = history.getActiveIndex() - 1; i >= 0; i--) {
      if (!dangerous(entries[i]?.url)) { history.goToIndex(i); return true; }
    }
    tab.manager.navigate(tab.id, 'browser://newtab');
    return true;
  }

  #proceed(tab, entry) {
    const host = bareHost(entry.host);
    if (entry.kind === 'threat' || entry.kind === 'suspicious') {
      this.store.data.allowedSites = { ...this.store.data.allowedSites, [host]: { kind: entry.kind === 'threat' ? entry.threat.kind : 'suspicious', list: entry.threat?.name || 'Static\'s fake-site check', at: Date.now() } };
      // Keep at most the last 500 choices.
      const keys = Object.keys(this.store.data.allowedSites);
      for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete this.store.data.allowedSites[key];
      this.store.save();
      if (entry.kind === 'suspicious') this.browser.safety.recordWarning({ host, url: entry.url, score: entry.assessment?.score || 0, risk: 'proceeded', reasons: [] }, 'proceeded');
    } else if (entry.kind === 'nohttps') {
      if (!this.store.data.httpAllowed.includes(host)) this.store.data.httpAllowed = [...this.store.data.httpAllowed, host].slice(-500);
      this.store.save();
    } else if (entry.kind === 'cert') {
      if (!entry.cert.canProceed || !entry.cert.fingerprint) return false;
      if (!this.certAllowed.has(entry.host)) this.certAllowed.set(entry.host, new Set());
      this.certAllowed.get(entry.host).add(entry.cert.fingerprint);
    }
    entry.proceeded = true;
    const contents = tab.view.webContents;
    // Once the site is open, the warning page behind it goes from history:
    // Back should lead to where you were, not to a warning about a choice made.
    this.#dropBehind(contents.id, (u) => String(u || '').includes(entry.token));
    tab.manager.navigate(tab.id, entry.url);
    this.browser.push?.();
    return true;
  }

  /** Stop trusting a site you opened despite a warning (or all of them). */
  forget({ host, all } = {}) {
    if (all) {
      this.store.data.allowedSites = {};
      this.store.data.httpAllowed = [];
      this.certAllowed.clear();
    } else {
      const bare = bareHost(host);
      const sites = { ...this.store.data.allowedSites };
      delete sites[bare];
      this.store.data.allowedSites = sites;
      this.store.data.httpAllowed = this.store.data.httpAllowed.filter((entry) => entry !== bare);
    }
    this.store.save();
    this.browser.push?.();
    return this.state();
  }

  /* ---- AMP pages that name their real page -------------------------------------- */

  #leaveAmp(event, canonical) {
    if (this.settings.ampSkip === false) return;
    const contents = event.sender;
    if (!event.senderFrame || event.senderFrame !== contents.mainFrame) return;
    const tab = this.browser.tabOf?.(contents);
    if (!tab || tab.state.internalUrl) return;
    const here = contents.getURL();
    let target;
    try { target = new URL(String(canonical || '')); } catch { return; }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.href === here) return;
    // A site that sends its canonical page back to AMP (for phones, say)
    // would bounce us between the two: it gets one go, then is left alone.
    const last = this.ampLeft.get(contents.id);
    if (last && (last.url === here || last.target === target.href) && Date.now() - last.at < 30000) return;
    this.ampLeft.set(contents.id, { url: here, target: target.href, at: Date.now() });
    this.browser.shields.stats.record('amp');
    this.#dropBehind(contents.id, (u) => sameEntry(u, here));
    tab.manager.navigate(tab.id, target.href);
  }

  /* ---- certificates and insecure content ------------------------------------------ */

  #keepCertificate(request) {
    const host = String(request.hostname || '').toLowerCase();
    if (!host || !request.certificate) return;
    this.certs.delete(host);
    this.certs.set(host, {
      ...summariseCertificate(request.certificate),
      verified: request.verificationResult === 'OK' || request.errorCode === 0,
      knownRoot: !!request.isIssuedByKnownRoot,
      at: Date.now(),
    });
    while (this.certs.size > 400) this.certs.delete(this.certs.keys().next().value);
  }

  certificateFor(host) {
    return this.certs.get(String(host || '').toLowerCase()) || null;
  }

  /**
   * Did you go past a certificate warning for this address's host? Such a
   * page is https in name only, so the tab shows it as not secure.
   */
  securityOf(url) {
    const host = hostOf(url);
    return host && this.certAllowed.get(host)?.size ? 'insecure' : null;
  }

  /**
   * The certificate of a secure page whose connection this run never saw:
   * one served entirely from the cache, or verified once already and
   * remembered by Chromium's own verifier, which then does not ask again.
   * Asked of the site directly, only when the site card is opened, and never
   * around a proxy: a direct connection would step outside it.
   */
  async ensureCertificate(tab, host) {
    if (tab?.state?.security !== 'secure' || !host || this.certificateFor(host)) return;
    let url;
    try { url = new URL(tab.state.url); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host.toLowerCase()) return;
    const proxy = await this.browser.session.resolveProxy(url.href).catch(() => '');
    if (proxy !== 'DIRECT') return;
    // The address is looked up by Chromium's own resolver, so Secure DNS
    // (and anything else configured there) applies to this lookup as well:
    // the operating system's resolver is never asked behind its back.
    const resolved = await this.browser.session.resolveHost(url.hostname).catch(() => null);
    const address = resolved?.endpoints?.find((endpoint) => endpoint.family === 'ipv4')?.address || resolved?.endpoints?.[0]?.address;
    if (!address) return;
    const cert = await peerCertificate(url.hostname, Number(url.port) || 443, address).catch(() => null);
    if (cert && !this.certificateFor(host)) this.certs.set(host.toLowerCase(), { ...cert, verified: false, fetched: true, at: Date.now() });
  }

  /**
   * Chromium reports insecure content on a secure page in the console, and
   * that is the only place it says so: active content (scripts, frames) is
   * blocked, passive content (images, audio, video) is upgraded to https.
   */
  consoleMessage(contents, message) {
    const text = String(message || '');
    if (!text.startsWith('Mixed Content:')) return;
    const entry = this.mixed.get(contents.id) || { blocked: 0, upgraded: 0, shown: 0, seen: new Set() };
    // Chromium can say it more than once for one address (the preload
    // scanner, then the real load): each address is counted once.
    const what = /requested an insecure [^']*'([^']+)'/.exec(text)?.[1] || text;
    const kind = /has been blocked/.test(text) ? 'blocked' : /automatically upgraded/.test(text) ? 'upgraded' : 'shown';
    if (entry.seen.has(kind + ' ' + what)) return;
    entry.seen.add(kind + ' ' + what);
    entry[kind]++;
    this.mixed.set(contents.id, entry);
  }

  /**
   * Rows and items for the site card (BrowserApplication#siteInfo): the
   * certificate, the page's insecure content, a warning you went past.
   */
  siteCard(tab, host) {
    const facts = [];
    const items = [];
    const contents = tab?.view?.webContents;
    const security = tab?.state?.security;
    const cert = security === 'secure' ? this.certificateFor(host) : null;
    if (this.certAllowed.get(String(host || '').toLowerCase())?.size) {
      facts.push({ label: 'Certificate', value: 'Not trusted · you went ahead' });
    } else if (cert) {
      const until = new Date(cert.validExpiry * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      facts.push({ label: 'Certificate', value: (cert.issuerOrg || cert.issuerName || 'Unknown issuer') + ' · until ' + until });
      items.push({ label: 'Certificate details', icon: 'lock', more: true, hint: 'Who it was issued to and by, and its fingerprint', action: { channel: 'site:certificate', payload: {} } });
    }
    const mixed = contents ? this.mixed.get(contents.id) : null;
    if (mixed && (mixed.blocked || mixed.upgraded || mixed.shown)) {
      const parts = [];
      if (mixed.blocked) parts.push(mixed.blocked + ' blocked');
      if (mixed.upgraded) parts.push(mixed.upgraded + ' made secure');
      if (mixed.shown) parts.push(mixed.shown + ' shown');
      facts.push({ label: 'Insecure content', value: parts.join(' · ') });
    }
    const allowed = this.store.data.allowedSites?.[bareHost(host)];
    if (allowed) {
      facts.push({ label: 'Safe Browsing', value: 'Warned · you went ahead' });
      items.push({ label: 'Warn me about this site again', icon: 'warn', hint: 'Safe Browsing will stop it opening', action: { channel: 'netguard:forget', payload: { host: bareHost(host) } } });
    } else if (security === 'insecure' && this.store.data.httpAllowed.includes(bareHost(host))) {
      facts.push({ label: 'HTTPS-only', value: 'You allowed http here' });
      items.push({ label: 'Ask about http here again', icon: 'lock', hint: 'HTTPS-only mode will warn first', action: { channel: 'netguard:forget', payload: { host: bareHost(host) } } });
    }
    return { facts, items };
  }

  /** The compact certificate card, from the site card's "Certificate details". */
  certificateCard(w) {
    const tab = w.tabs?.active;
    const host = hostOf(tab?.state?.url || '');
    const cert = this.certificateFor(host);
    if (!cert) return false;
    const date = (s) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const facts = [
      { label: 'Issued to', value: cert.subjectName || host, wide: String(cert.subjectName || host).length > 26 },
      cert.subjectOrg ? { label: 'Organisation', value: cert.subjectOrg, wide: cert.subjectOrg.length > 26 } : null,
      { label: 'Issued by', value: [cert.issuerName, cert.issuerOrg].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || 'Unknown', wide: true },
      { label: 'Valid from', value: date(cert.validStart) },
      { label: 'Valid until', value: date(cert.validExpiry) },
      { label: 'SHA-256', value: cert.sha256 || cert.fingerprint.replace(/^sha256\//, ''), mono: true },
      cert.serialNumber ? { label: 'Serial', value: cert.serialNumber.toUpperCase(), mono: true } : null,
    ].filter(Boolean);
    w.showMenu([
      { site: { title: 'Certificate', subtitle: host + (cert.fetched ? ' · as the site shows it now' : cert.verified ? ' · trusted by this computer' : ''), icon: 'lock', tone: 'secure', facts } },
      { label: 'Back to site information', icon: 'back', more: true, action: { channel: 'site:info', payload: { again: true } } },
    ], w.lastMenu?.anchor || w.promptAnchor(), w.lastMenu?.align || 'left');
    return true;
  }

  /* ---- downloads (Enhanced) ------------------------------------------------------ */

  /**
   * Why this download deserves a second look, or [] when it does not. Only
   * in Enhanced: a file from a listed address or page, an address the
   * fake-site check finds odd, or a program from a site never visited before.
   */
  downloadReasons(url, page, name) {
    if (this.settings.safeBrowsing !== 'enhanced') return [];
    const ext = (String(name || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const reasons = [];
    const listed = this.threats.match(url) || (page ? this.threats.match(page) : null);
    if (listed) reasons.push((THREAT_WORDS[listed.kind]?.label || 'Listed') + ' on ' + listed.name);
    const odd = this.browser.safety?.assess(url);
    if (!listed && odd && odd.score >= 30) reasons.push('The address looks odd: ' + String(odd.reasons[0]?.title || 'irregular').toLowerCase());
    if (DANGEROUS_TYPES.has(ext) && !this.#visitedBefore(url, page)) reasons.push('A program from a site you had not visited before today');
    return reasons;
  }

  /**
   * Enhanced Safe Browsing's look at a download. A file worth a warning is
   * stopped before anything is written (preventDefault: no save dialog, no
   * half-downloaded file), and fetched again only if you say so.
   */
  #checkDownload(event, item, contents) {
    const url = item.getURL();
    if (this.downloadAllowed.delete(url)) return;
    const page = contents && !contents.isDestroyed() ? contents.getURL() : '';
    const name = item.getFilename() || '';
    const reasons = this.downloadReasons(url, page, name);
    if (!reasons.length) return;
    event.preventDefault();
    this.downloadsStopped = (this.downloadsStopped || 0) + 1;
    const w = this.browser.windowOf?.(contents) || this.browser.front;
    this.browser.ask([
      { site: { title: 'This file could harm your computer', subtitle: name, icon: 'warn', tone: 'danger', facts: [
        { label: 'From', value: bareHost(hostOf(url)) || 'Unknown' },
        { label: 'Why', value: reasons[0], wide: true },
      ] } },
      { label: 'Don’t download', icon: 'close', hint: 'Nothing was saved', choice: 'cancel' },
      { label: 'Download anyway', icon: 'download', hint: 'Only if you trust where it came from', choice: 'keep' },
    ], { w }).then((answer) => {
      this.lastDownloadDecision = { name, answer: answer || 'dismissed', reasons };
      if (answer !== 'keep') return;
      this.downloadAllowed.add(url);
      const from = contents && !contents.isDestroyed() ? contents : null;
      if (from) from.downloadURL(url);
      else this.browser.session.downloadURL(url);
    }).catch(() => {});
  }

  /** Has this site been visited before today? In incognito nothing is remembered, so no. */
  #visitedBefore(...urls) {
    const sites = new Set(urls.map((u) => siteOf(hostOf(u))).filter(Boolean));
    if (!sites.size) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const visit of this.browser.history?.store?.data || []) {
      if (visit.visitedAt >= today.getTime()) continue;
      if (sites.has(siteOf(hostOf(visit.url)))) return true;
    }
    return false;
  }

  /* ---- state and IPC ---------------------------------------------------------------- */

  state() {
    const sites = this.store.data.allowedSites || {};
    return {
      level: this.level(),
      levels: Object.values(LEVELS).map(({ id, name, summary }) => ({ id, name, summary })),
      threats: this.threats.state(),
      debounceRules: this.bounce.debounce.length,
      allowedSites: Object.entries(sites).map(([host, info]) => ({ host, ...info })).sort((a, b) => b.at - a.at).slice(0, 50),
      httpAllowed: [...this.store.data.httpAllowed].slice(-50),
      dns: this.dnsApplied || null,
      providers: Object.values(PROVIDERS).map(({ id, name, template }) => ({ id, name, template })),
    };
  }

  handlers() {
    return {
      'netguard:state': () => this.state(),
      'netguard:level': (_sender, payload) => { const state = this.applyLevel(payload?.level); this.browser.push?.(); return state; },
      'netguard:forget': (_sender, payload) => this.forget({ host: payload?.host, all: payload?.all === true }),
      'netguard:refresh': () => this.refreshLists({ force: true }),
      // The warning page: what it is about, and its two ways out.
      'netguard:interstitial': (sender, payload, w) => {
        const found = this.#entryFor(sender, w, payload?.id);
        return found ? this.#describe(found.entry) : null;
      },
      'netguard:back': (sender, payload, w) => {
        const tab = w?.tabOf?.(sender);
        if (!tab) return false;
        return this.#backToSafety(tab, this.#entryFor(sender, w, payload?.id)?.entry || null);
      },
      'netguard:proceed': (sender, payload, w) => {
        const found = this.#entryFor(sender, w, payload?.id);
        if (!found || payload?.confirmed !== true) return false;
        return this.#proceed(found.tab, found.entry);
      },
      'site:certificate': (_sender, _payload, w) => this.certificateCard(w),
    };
  }

  flush() { this.store.save(); }
}

/** The parts of a certificate worth showing, without its PEM. */
function summariseCertificate(cert, error = '') {
  if (!cert) return null;
  const org = (principal) => (Array.isArray(principal?.organizations) ? principal.organizations[0] : '') || '';
  return {
    subjectName: cert.subjectName || cert.subject?.commonName || '',
    subjectOrg: org(cert.subject),
    issuerName: cert.issuerName || cert.issuer?.commonName || '',
    issuerOrg: org(cert.issuer),
    validStart: cert.validStart,
    validExpiry: cert.validExpiry,
    fingerprint: cert.fingerprint || '',
    sha256: derSha256(cert.data),
    serialNumber: cert.serialNumber || '',
    ...(error ? { error } : {}),
  };
}

/** SHA-256 of a PEM certificate, as certificate viewers show it: AB:CD:... */
function derSha256(pem) {
  const body = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  if (!body) return '';
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex').toUpperCase().match(/../g).join(':');
}

/** A site's certificate, asked of it directly (see NetGuard#ensureCertificate). */
function peerCertificate(host, port, address) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, servername: isIpAddress(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, 4000);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const c = socket.getPeerCertificate();
      socket.end();
      if (!c || !c.raw) { resolve(null); return; }
      const seconds = (text) => Math.round((Date.parse(text) || 0) / 1000);
      const one = (value) => (Array.isArray(value) ? value[0] : value) || '';
      resolve({
        subjectName: one(c.subject?.CN), subjectOrg: one(c.subject?.O),
        issuerName: one(c.issuer?.CN), issuerOrg: one(c.issuer?.O),
        validStart: seconds(c.valid_from), validExpiry: seconds(c.valid_to),
        fingerprint: '', sha256: String(c.fingerprint256 || '').toUpperCase(),
        serialNumber: String(c.serialNumber || ''),
      });
    });
  });
}

/** Two history addresses for the same page (a trailing slash or a fragment aside). */
function sameEntry(a, b) {
  if (!a || !b) return false;
  const clean = (u) => String(u).replace(/#.*$/, '').replace(/\/$/, '');
  return clean(a) === clean(b);
}

module.exports = { NetGuard, WEBRTC, DANGEROUS_TYPES, THREAT_LISTS, certProblem, summariseCertificate };
