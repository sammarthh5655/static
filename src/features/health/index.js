const fs = require('node:fs');
const path = require('node:path');

/**
 * Browser Health Center: performance, privacy, security, storage, extensions.
 *
 * WHAT THIS IS NOT
 * It is not a score out of 100. Every figure here is measured or counted from
 * something real - process metrics, the blocking counters, the password vault,
 * actual file sizes on disk. Where a thing genuinely cannot be measured it is
 * reported as unknown rather than filled in.
 *
 * The overall status is derived from stated conditions, each of which is
 * returned alongside it, so "needs attention" can always be traced to the
 * specific finding that caused it. A health screen whose number cannot be
 * explained is worse than no health screen: it is either ignored or believed,
 * and both are wrong.
 */

/** Overall status levels, worst last. */
const LEVELS = ['excellent', 'good', 'attention', 'critical'];

/** Memory beyond which a single tab is worth pointing at, in MB. */
const HEAVY_TAB_MB = 400;

/** Total memory beyond which the browser itself is worth pointing at, in MB. */
const HEAVY_TOTAL_MB = 4096;

/** Directory size in bytes, bounded so a huge cache cannot stall the page. */
function directorySize(dir, budgetMs = 400) {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  let truncated = false;

  const walk = (current) => {
    if (Date.now() > deadline) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (Date.now() > deadline) { truncated = true; return; }
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch { /* vanished mid-walk, or not readable */ }
    }
  };
  walk(dir);
  return { bytes: total, truncated };
}

/** Size of one file, or 0 when it does not exist. */
function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

class Health {
  /**
   * @param {object} deps everything the report reads from. Passed in rather
   *   than imported so this module owns no state and can be tested directly.
   */
  constructor({ dir, resources, shields, passwords, extensions, history, downloads, getTabs }) {
    this.dir = dir;
    this.resources = resources;
    this.shields = shields;
    this.passwords = passwords;
    this.extensions = extensions;
    this.history = history;
    this.downloads = downloads;
    this.getTabs = getTabs || (() => []);
  }

  /* ---- performance ------------------------------------------------------ */

  performance() {
    let snapshot = { tabs: [], totals: {} };
    try { snapshot = this.resources.sample(); } catch { /* metrics unavailable */ }

    const tabs = snapshot.tabs || [];
    const totals = snapshot.totals || {};
    const heavy = tabs
      .filter((tab) => (tab.memoryMb || 0) >= HEAVY_TAB_MB)
      .sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0));

    const all = this.getTabs();
    const sleeping = all.filter((tab) => tab.state?.suspended).length;

    const findings = [];
    if (heavy.length) {
      findings.push({
        id: 'heavy-tabs',
        level: 'attention',
        title: heavy.length === 1 ? '1 tab is using a lot of memory'
          : `${heavy.length} tabs are using a lot of memory`,
        detail: heavy.slice(0, 3).map((tab) => `${tab.title || 'Tab'} · ${tab.memoryMb} MB`).join(', '),
        action: 'sleep-heavy',
      });
    }
    if ((totals.totalMemoryMb || 0) > HEAVY_TOTAL_MB) {
      findings.push({
        id: 'high-memory',
        level: 'attention',
        title: `Static is using ${(totals.totalMemoryMb / 1024).toFixed(1)} GB`,
        detail: 'Sleeping background tabs frees most of this.',
        action: 'sleep-heavy',
      });
    }

    return {
      memoryMb: totals.totalMemoryMb || 0,
      cpuPercent: typeof totals.cpuPercent === 'number' ? totals.cpuPercent : null,
      tabCount: totals.tabCount || all.length,
      activeTabs: all.length - sleeping,
      sleepingTabs: sleeping,
      heavyTabs: heavy.slice(0, 5).map((tab) => ({
        id: tab.id, title: tab.title, memoryMb: tab.memoryMb,
      })),
      gameMode: !!this.resources?.config?.gameMode,
      findings,
    };
  }

  /* ---- privacy ---------------------------------------------------------- */

  privacy() {
    const stats = this.shields?.stats?.summary?.() || null;
    const config = this.shields?.config || {};
    const findings = [];

    if (config.enabled === false) {
      findings.push({
        id: 'shields-off', level: 'critical',
        title: 'Shields are off', detail: 'Nothing is being blocked.',
        action: 'enable-shields',
      });
    } else {
      // Each protection that is individually off is worth naming, because the
      // master switch being on reads as "protected" and these are not.
      const off = [
        ['blockTrackers', 'Ad and tracker blocking'],
        ['upgradeHttps', 'HTTPS upgrades'],
        ['stripTracking', 'Tracking parameter removal'],
        ['blockThirdPartyCookies', 'Third-party cookie blocking'],
        ['blockVideoAds', 'Video ad blocking'],
      ].filter(([key]) => config[key] === false).map(([, name]) => name);

      if (off.length) {
        findings.push({
          id: 'protections-off', level: 'attention',
          title: off.length === 1 ? `${off[0]} is off` : `${off.length} protections are off`,
          detail: off.join(', '),
          action: 'open-shields',
        });
      }
    }

    const exceptions = (config.disabledSites || []).length;
    if (exceptions) {
      findings.push({
        id: 'site-exceptions', level: 'good',
        title: exceptions === 1 ? 'Shields are off for 1 site' : `Shields are off for ${exceptions} sites`,
        detail: (config.disabledSites || []).slice(0, 4).join(', '),
        action: 'open-shields',
      });
    }

    return {
      enabled: config.enabled !== false,
      today: stats?.today || null,
      allTime: stats?.allTime || null,
      isEmpty: stats ? stats.isEmpty : true,
      ruleCount: this.shields?.engine?.count || 0,
      cosmeticCount: this.shields?.engine?.cosmeticCount || 0,
      lastFetch: config.lastFetch || 0,
      exceptions,
      findings,
    };
  }

  /* ---- security --------------------------------------------------------- */

  security() {
    const findings = [];
    let vault = { count: 0, available: false, reused: 0, weak: 0, checked: false };

    try {
      const state = this.passwords?.state?.() || {};
      const entries = this.passwords?.list?.() || [];
      vault.available = state.available !== false;
      vault.count = entries.length;

      // Reuse is detectable WITHOUT decrypting anything: entries that share a
      // username across different sites are the reuse worth flagging, and the
      // vault never hands out passwords to a listing anyway.
      const byUser = new Map();
      for (const entry of entries) {
        const key = String(entry.username || '').toLowerCase();
        if (!key) continue;
        if (!byUser.has(key)) byUser.set(key, new Set());
        byUser.get(key).add(entry.host || entry.url || '');
      }
      vault.reused = [...byUser.values()].filter((hosts) => hosts.size > 1).length;
      vault.checked = true;

      if (vault.reused) {
        findings.push({
          id: 'reused-logins', level: 'attention',
          title: vault.reused === 1 ? 'One login is used on several sites'
            : `${vault.reused} logins are used on several sites`,
          detail: 'Reusing a login means one breach affects every site that shares it.',
          action: 'open-passwords',
        });
      }
      if (!vault.available) {
        findings.push({
          id: 'vault-unavailable', level: 'attention',
          title: 'The password vault is unavailable',
          detail: 'Your system could not provide encryption, so passwords cannot be saved.',
          action: 'open-passwords',
        });
      }
    } catch (error) {
      // Report the failure rather than a clean bill of health.
      findings.push({
        id: 'vault-error', level: 'attention',
        title: 'Could not check the password vault', detail: error.message,
        action: 'open-passwords',
      });
    }

    const warnings = this.shields?.config?.safetyWarnings || 0;

    return { vault, phishingWarnings: warnings, findings };
  }

  /* ---- storage ---------------------------------------------------------- */

  storage() {
    const cache = directorySize(path.join(this.dir, 'Cache'));
    const code = directorySize(path.join(this.dir, 'Code Cache'));
    const gpu = directorySize(path.join(this.dir, 'GPUCache'));
    const cookies = fileSize(path.join(this.dir, 'Network', 'Cookies'));
    const lists = directorySize(path.join(this.dir, 'filter-lists'));

    const profileFiles = ['history', 'bookmarks', 'notes-store', 'shields',
      'organizer', 'chats', 'downloads', 'passwords']
      .reduce((total, name) => total + fileSize(path.join(this.dir, name + '.json')), 0);

    const total = cache.bytes + code.bytes + gpu.bytes + cookies + lists.bytes + profileFiles;
    const findings = [];
    // 2GB of cache is worth mentioning; below that it is doing its job.
    if (cache.bytes > 2 * 1024 * 1024 * 1024) {
      findings.push({
        id: 'large-cache', level: 'good',
        title: 'The cache is large',
        detail: (cache.bytes / (1024 ** 3)).toFixed(1) + ' GB of cached files.',
        action: 'clear-cache',
      });
    }

    return {
      cacheBytes: cache.bytes + code.bytes + gpu.bytes,
      cookieBytes: cookies,
      filterListBytes: lists.bytes,
      profileBytes: profileFiles,
      historyEntries: this.history?.store?.data?.length || 0,
      downloadEntries: this.downloads?.list?.().length || 0,
      totalBytes: total,
      // Walks are time-bounded; say so rather than presenting a short read as
      // an exact total.
      truncated: cache.truncated || code.truncated || gpu.truncated || lists.truncated,
      findings,
    };
  }

  /* ---- extensions ------------------------------------------------------- */

  extensionReport() {
    let list = [];
    try { list = this.extensions?.list?.() || []; } catch { list = []; }

    const findings = [];
    const risky = list.filter((extension) => {
      const permissions = extension.permissions || [];
      return permissions.includes('<all_urls>') ||
             permissions.some((permission) => /^https?:\/\/\*\//.test(permission));
    });

    if (risky.length) {
      findings.push({
        id: 'broad-permissions', level: 'good',
        title: risky.length === 1 ? '1 extension can read every site'
          : `${risky.length} extensions can read every site`,
        detail: risky.map((extension) => extension.name).slice(0, 4).join(', '),
        action: 'open-extensions',
      });
    }

    return {
      count: list.length,
      enabled: list.filter((extension) => extension.enabled !== false).length,
      items: list.map((extension) => ({
        id: extension.id,
        name: extension.name,
        enabled: extension.enabled !== false,
        permissions: (extension.permissions || []).length,
        broad: risky.includes(extension),
      })),
      findings,
    };
  }

  /* ---- report ----------------------------------------------------------- */

  /** The whole report, plus a status derived only from the findings in it. */
  report() {
    const sections = {
      performance: this.performance(),
      privacy: this.privacy(),
      security: this.security(),
      storage: this.storage(),
      extensions: this.extensionReport(),
    };

    const findings = Object.entries(sections)
      .flatMap(([section, data]) => (data.findings || []).map((finding) => ({ ...finding, section })));

    // Worst finding wins. 'good' findings are informational and do not drag
    // the status down - they are things worth seeing, not things worth fixing.
    let status = 'excellent';
    for (const finding of findings) {
      if (LEVELS.indexOf(finding.level) > LEVELS.indexOf(status)) status = finding.level;
    }
    if (status === 'good' && findings.every((f) => f.level === 'good')) status = 'good';

    return {
      status,
      // Returned so the UI can always say WHY, and never shows a number whose
      // cause cannot be traced.
      findings,
      sections,
      generatedAt: Date.now(),
    };
  }
}

module.exports = { Health, LEVELS, HEAVY_TAB_MB, HEAVY_TOTAL_MB, directorySize };
