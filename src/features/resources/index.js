const { app } = require('electron');
const { JsonStore } = require('../../main/storage');

/**
 * Resource monitoring and tab suspension.
 *
 * WHAT THIS CAN AND CANNOT DO - read before changing anything here:
 *
 * Electron exposes `app.getAppMetrics()`, which reports real per-process CPU
 * percentage and working-set memory. Processes are matched to tabs through
 * `webContents.getOSProcessId()`. So MEASUREMENT is genuine.
 *
 * There is NO API to cap a renderer's memory or throttle its CPU to a
 * percentage. Chromium does not expose one, and no amount of Electron code
 * creates it. The only real levers are:
 *   - webContents.setBackgroundThrottling(true)  throttle timers when hidden
 *   - webContents.setAudioMuted(true)            stop audio work
 *   - webContents.close()                        discard the tab entirely
 *
 * Therefore the "limits" in this module are POLICIES, not enforcement: they
 * decide when to warn, mute, throttle or suspend. A slider claiming to cap RAM
 * at 2 GB would be a lie, so this module does not offer one.
 */

/** How often metrics are sampled while a resources page is watching. */
const SAMPLE_MS = 2000;

/** Memory policies. `suspendAbove` is per-tab working set in MB. */
const MEMORY_MODES = {
  light: { id: 'light', name: 'Light', suspendAbove: 250, warnTotal: 1500 },
  balanced: { id: 'balanced', name: 'Balanced', suspendAbove: 600, warnTotal: 3000 },
  performance: { id: 'performance', name: 'Performance', suspendAbove: 0, warnTotal: 6000 },
  custom: { id: 'custom', name: 'Custom', suspendAbove: 400, warnTotal: 2500 },
};

/** CPU policies. `idleMinutes` is how long before an inactive tab is suspended. */
const CPU_MODES = {
  gaming: { id: 'gaming', name: 'Gaming', idleMinutes: 2, muteBackground: true, heavyPercent: 25 },
  work: { id: 'work', name: 'Work', idleMinutes: 20, muteBackground: false, heavyPercent: 45 },
  battery: { id: 'battery', name: 'Battery Saver', idleMinutes: 5, muteBackground: true, heavyPercent: 20 },
  performance: { id: 'performance', name: 'Performance', idleMinutes: 0, muteBackground: false, heavyPercent: 70 },
};

class Resources {
  /**
   * @param {string}   dir      userData directory
   * @param {object}   deps
   * @param {Function} deps.getTabs      () => tab records from features/tabs
   * @param {Function} deps.getActiveId  () => active tab id
   * @param {Function} deps.onChange     called when state changes
   */
  constructor(dir, { getTabs, getActiveId, onChange } = {}) {
    this.store = new JsonStore(dir, 'resources', {
      memoryMode: 'balanced',
      cpuMode: 'work',
      autoSuspend: true,
      gameMode: false,
      customSuspendAbove: 400,
    });
    this.getTabs = getTabs || (() => []);
    this.getActiveId = getActiveId || (() => null);
    this.onChange = onChange || (() => {});

    /** tabId -> { suspendedAt, url, title, reason } */
    this.suspended = new Map();
    /** tabId -> last time it was the active tab. */
    this.lastActive = new Map();
    /** Snapshot of settings before Game Mode, so it can be restored exactly. */
    this.preGameMode = null;
    this.timer = null;
    this.latest = { tabs: [], totals: {}, sampledAt: 0 };
  }

  get config() { return this.store.data; }

  memoryPolicy() {
    const mode = MEMORY_MODES[this.config.memoryMode] || MEMORY_MODES.balanced;
    if (mode.id !== 'custom') return mode;
    return { ...mode, suspendAbove: Number(this.config.customSuspendAbove) || 400 };
  }

  cpuPolicy() {
    return CPU_MODES[this.config.cpuMode] || CPU_MODES.work;
  }

  /**
   * Sample real per-process metrics and attribute them to tabs.
   *
   * getAppMetrics reports CPU as an average since the PREVIOUS call, so
   * sampling on a steady interval is what makes the numbers meaningful.
   */
  sample() {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));

    const tabs = [];
    let totalMemory = 0;
    let totalCpu = 0;

    for (const tab of this.getTabs()) {
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;

      let pid = null;
      try { pid = wc.getOSProcessId(); } catch { pid = null; }
      const metric = pid ? byPid.get(pid) : null;

      // Several tabs can share one renderer process when they are same-site,
      // so memory here is per-process and may be shared - say so in the UI
      // rather than pretending it is exact per-tab attribution.
      const memoryMb = metric ? Math.round((metric.memory?.workingSetSize || 0) / 1024) : 0;
      const cpuPercent = metric ? Math.round((metric.cpu?.percentCPUUsage || 0) * 10) / 10 : 0;

      totalMemory += memoryMb;
      totalCpu += cpuPercent;

      tabs.push({
        id: tab.id,
        pid,
        title: tab.state?.title || 'Tab',
        url: tab.state?.displayUrl || '',
        memoryMb,
        cpuPercent,
        active: tab.id === this.getActiveId(),
        audible: !wc.isDestroyed() && wc.isCurrentlyAudible ? wc.isCurrentlyAudible() : false,
        suspended: this.suspended.has(tab.id),
        heavy: cpuPercent >= this.cpuPolicy().heavyPercent ||
               memoryMb >= this.memoryPolicy().suspendAbove && this.memoryPolicy().suspendAbove > 0,
      });
    }

    // Browser overhead: everything that is not a tab renderer (the chrome
    // view, GPU, network service, extensions).
    const tabPids = new Set(tabs.map((tab) => tab.pid).filter(Boolean));
    const overheadMb = metrics
      .filter((metric) => !tabPids.has(metric.pid))
      .reduce((sum, metric) => sum + (metric.memory?.workingSetSize || 0) / 1024, 0);

    this.latest = {
      sampledAt: Date.now(),
      tabs: tabs.sort((a, b) => b.memoryMb - a.memoryMb),
      totals: {
        tabMemoryMb: totalMemory,
        overheadMb: Math.round(overheadMb),
        totalMemoryMb: totalMemory + Math.round(overheadMb),
        cpuPercent: Math.round(totalCpu * 10) / 10,
        tabCount: tabs.length,
        suspendedCount: this.suspended.size,
      },
      policy: {
        memory: this.memoryPolicy(),
        cpu: this.cpuPolicy(),
        gameMode: !!this.config.gameMode,
        autoSuspend: !!this.config.autoSuspend,
      },
    };
    return this.latest;
  }

  /** Start sampling. Idempotent, so several pages can watch at once. */
  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => {
      this.sample();
      if (this.config.autoSuspend) this.enforce();
      this.onChange();
    }, SAMPLE_MS);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Apply the active policy.
   *
   * This never closes the active tab, and never touches a tab playing audio -
   * discarding what someone is listening to would be worse than the memory it
   * frees.
   */
  enforce() {
    const memory = this.memoryPolicy();
    const cpu = this.cpuPolicy();
    const activeId = this.getActiveId();
    const now = Date.now();

    for (const tab of this.latest.tabs) {
      if (tab.id === activeId) { this.lastActive.set(tab.id, now); continue; }
      if (tab.suspended || tab.audible) continue;

      const idleMs = now - (this.lastActive.get(tab.id) || now);
      const idleTooLong = cpu.idleMinutes > 0 && idleMs > cpu.idleMinutes * 60000;
      const tooHeavy = memory.suspendAbove > 0 && tab.memoryMb > memory.suspendAbove;

      if (idleTooLong || tooHeavy) {
        this.suspend(tab.id, tooHeavy ? 'memory' : 'idle');
      }
    }
  }

  /**
   * Suspend a tab.
   *
   * Chromium has no "freeze this tab" API, so suspension is: mute it, throttle
   * its background timers, and remember where it was. A full discard
   * (closing the webContents) frees the most memory but loses page state, so
   * it is opt-in through `discard`.
   */
  suspend(tabId, reason = 'manual', { discard = false } = {}) {
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || this.suspended.has(tabId)) return { ok: false };
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false };
    if (tabId === this.getActiveId()) return { ok: false, error: 'The active tab is never suspended.' };

    const url = tab.state?.displayUrl || wc.getURL();
    this.suspended.set(tabId, {
      suspendedAt: Date.now(),
      url,
      title: tab.state?.title || url,
      reason,
      discarded: discard,
      memoryMb: this.latest.tabs.find((entry) => entry.id === tabId)?.memoryMb || 0,
    });

    try {
      wc.setAudioMuted(true);
      wc.setBackgroundThrottling(true);
      if (discard) {
        // Park on a blank page: this releases the page's memory while keeping
        // the tab, its title and its URL so it can be restored.
        wc.loadURL('about:blank');
      }
    } catch { /* the tab may have gone in the meantime */ }

    this.onChange();
    return { ok: true };
  }

  resume(tabId) {
    const record = this.suspended.get(tabId);
    if (!record) return { ok: false };
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    const wc = tab?.view?.webContents;
    this.suspended.delete(tabId);
    this.lastActive.set(tabId, Date.now());

    if (wc && !wc.isDestroyed()) {
      try {
        wc.setAudioMuted(false);
        if (record.discarded && record.url) wc.loadURL(record.url);
      } catch { /* ignore */ }
    }
    this.onChange();
    return { ok: true };
  }

  resumeAll() {
    for (const id of [...this.suspended.keys()]) this.resume(id);
    return { ok: true };
  }

  update(patch) {
    const next = { ...this.config };
    if (MEMORY_MODES[patch?.memoryMode]) next.memoryMode = patch.memoryMode;
    if (CPU_MODES[patch?.cpuMode]) next.cpuMode = patch.cpuMode;
    if (typeof patch?.autoSuspend === 'boolean') next.autoSuspend = patch.autoSuspend;
    if (patch?.customSuspendAbove !== undefined) {
      const value = Number(patch.customSuspendAbove);
      if (Number.isFinite(value)) next.customSuspendAbove = Math.max(100, Math.min(4000, value));
    }
    this.store.save(next);
    this.onChange();
    return next;
  }

  /**
   * Game Mode: one switch that applies the most aggressive policy and reports
   * what it actually freed, with an exact restore.
   */
  setGameMode(on) {
    if (on && !this.config.gameMode) {
      const before = this.sample();
      this.preGameMode = {
        memoryMode: this.config.memoryMode,
        cpuMode: this.config.cpuMode,
        autoSuspend: this.config.autoSuspend,
        memoryMb: before.totals.totalMemoryMb,
      };
      this.store.save({
        ...this.config,
        gameMode: true,
        memoryMode: 'light',
        cpuMode: 'gaming',
        autoSuspend: true,
      });

      // Suspend every inactive, silent tab immediately rather than waiting for
      // the idle timer - the point of Game Mode is to free resources NOW.
      const activeId = this.getActiveId();
      for (const tab of before.tabs) {
        if (tab.id !== activeId && !tab.audible) this.suspend(tab.id, 'game-mode');
      }
      this.start();
    } else if (!on && this.config.gameMode) {
      const restore = this.preGameMode || {};
      this.resumeAll();
      this.store.save({
        ...this.config,
        gameMode: false,
        memoryMode: restore.memoryMode || 'balanced',
        cpuMode: restore.cpuMode || 'work',
        autoSuspend: restore.autoSuspend !== undefined ? restore.autoSuspend : true,
      });
      this.preGameMode = null;
    }
    this.onChange();
    return this.config;
  }

  /** What Game Mode saved, for the "performance saved" readout. */
  savings() {
    if (!this.config.gameMode || !this.preGameMode) return null;
    const now = this.sample();
    const freed = this.preGameMode.memoryMb - now.totals.totalMemoryMb;
    return {
      freedMb: Math.max(0, freed),
      beforeMb: this.preGameMode.memoryMb,
      nowMb: now.totals.totalMemoryMb,
      suspendedCount: this.suspended.size,
    };
  }

  state() {
    return {
      ...this.latest,
      config: this.config,
      suspended: [...this.suspended.entries()].map(([id, record]) => ({ id, ...record })),
      savings: this.savings(),
      modes: {
        memory: Object.values(MEMORY_MODES),
        cpu: Object.values(CPU_MODES),
      },
    };
  }

  flush() { this.store.save(); this.stop(); }
}

module.exports = { Resources, MEMORY_MODES, CPU_MODES };
