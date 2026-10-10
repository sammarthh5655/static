const { powerMonitor } = require('electron');
const { ScreenTime, hostOf } = require('../screen-time');
const { Organizer } = require('../organizer');
const { signature } = require('../organizer/classify');
const gemini = require('../ai/gemini');

/** One integration point for tabs, Focus, Screen Time and Organizer.
 * Request blocking is called by the application's ONE webRequest listener.
 * IPC remains available only through the existing trusted-page guard.
 *
 * Tabs live in windows. Blocking and limits apply to every window's tabs;
 * time is counted for the tab on show in the window in use; and the
 * organiser's pages act on the tabs of the window they are open in.
 */
class Productivity {
  constructor(browser) {
    this.browser = browser; this.locked = false; this.timer = null; this.ticks = 0; this.pendingBlocks = new Set();
    this.screenTime = new ScreenTime(browser.dir, { onChange: () => this.changed('screentime:changed') });
    this.organizer = new Organizer(browser.dir, {
      getTabs: () => browser.tabs, allTabs: () => browser.allTabs?.() || [browser.tabs].filter(Boolean),
      resources: browser.resources, ai: gemini, onChange: () => this.changed('organizer:changed') });
    this.lock = () => { this.locked = true; this.screenTime.last = null; };
    this.unlock = () => { this.locked = false; this.screenTime.last = null; };
  }
  /** Every tab, in every window. */
  #everyTab() { return this.organizer.allTabs().flatMap(tabs => [...tabs.tabs.values()]); }
  changed(channel) {
    this.browser.push();
    for (const tab of this.#everyTab()) {
      if (tab.state.internalUrl && !tab.view.webContents.isDestroyed()) tab.view.webContents.send(channel);
    }
  }
  start() {
    if (this.timer) return;
    powerMonitor.on('suspend', this.lock); powerMonitor.on('lock-screen', this.lock);
    powerMonitor.on('resume', this.unlock); powerMonitor.on('unlock-screen', this.unlock);
    this.timer = setInterval(() => { try { this.tick(); } catch (error) { console.error('Productivity timer:', error.message); } }, 1000);
    this.timer.unref();
  }
  policy(url) {
    const time = this.screenTime, focus = this.browser.focus;
    if (time.isUnlocked(url) || time.isAllowed(url, focus.config.allowlist)) return null;
    if (focus.shouldBlock(url)) return { reason: 'focus', domain: hostOf(url) };
    return time.verdict(url);
  }
  block(contentsId, url, verdict) {
    const tab = this.#everyTab().find(t => t.view.webContents.id === contentsId);
    if (!tab || this.pendingBlocks.has(tab.id)) return;
    this.pendingBlocks.add(tab.id); this.screenTime.hit();
    if (verdict.reason === 'focus') this.browser.focus.recordHit();
    // browser:// is a logical route, not a network protocol. Cancel first, then
    // load the allowlisted local page through Tabs; a webRequest redirect fails.
    setImmediate(async () => {
      try {
        // Whichever window holds it by now: it may have moved meanwhile.
        if (!tab.manager?.tabs.has(tab.id)) return;
        await this.organizer.wake(tab.id);
        tab.manager.navigate(tab.id, 'browser://screentime?blocked=' + encodeURIComponent(url) + '&reason=' + verdict.reason);
      } catch (error) { console.error('Screen Time block:', error.message); }
      finally { this.pendingBlocks.delete(tab.id); }
    });
  }
  tick() {
    // The window in use is the one in front; time counts only while it has focus.
    const browser = this.browser, front = browser.front, tab = front?.tabs?.active, win = front?.window;
    const eligible = !!tab && !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() &&
      !this.locked && powerMonitor.getSystemIdleTime() < 300 && !this.organizer.sleeping.has(tab.id);
    this.screenTime.observe({ id: tab?.id, url: tab?.state.displayUrl || '', eligible });
    const warning = tab && eligible && this.screenTime.warning(tab.state.displayUrl);
    if (warning && eligible) browser.notify(warning.domain + ': about ' + warning.seconds + ' seconds left today. You can adjust this in Screen Time.', front);
    for (const item of this.#everyTab()) {
      const verdict = this.policy(item.state.displayUrl);
      if (verdict) this.block(item.view.webContents.id, item.state.displayUrl, verdict);
    }
    this.ticks++;
    if (this.ticks % 5 === 0) this.changed('screentime:changed');
    if (this.ticks % 15 === 0 && !this.organizer.aiBusy && !this.organizer.busy) {
      const tabs = browser.tabs?.list() || [];
      if (tabs.filter(t => hostOf(t.url)).length >= 8) {
        const previous = this.organizer.plan, unchanged = signature(tabs) === previous?.signature;
        this.organizer.localAnalysis();
        if (unchanged && previous.source === 'gemini') {
          this.organizer.plan.groups = previous.groups; this.organizer.plan.source = 'gemini';
        }
        this.changed('organizer:changed');
      }
    }
  }
  handlers() {
    const org = this.organizer, time = this.screenTime;
    const state = () => ({ ...time.state(), focus: this.browser.focus.state() });
    // `w` is the window the page asking is in (see BrowserApplication#guard):
    // the organiser page shows, groups and tidies that window's tabs.
    return {
      'organizer:state': (_sender, _p, w) => org.state(w?.tabs),
      'organizer:analyze': (_sender, p, w) => org.analyze(p?.ai === true, w?.tabs),
      'organizer:apply': (_sender, p, w) => org.apply(p?.selection, w?.tabs),
      'organizer:group': (_sender, p, w) => org.group(p, w?.tabs),
      'organizer:move': (_sender, p, w) => org.move(p, w?.tabs),
      // From the tab menus. The menu's name box closes on { ok: true } and
      // shows the message from a rejection, so nothing larger is returned.
      'organizer:assign': async (_sender, p, w) => { await org.assign(p, w?.tabs); return { ok: true }; },
      'organizer:ungroup': async (_sender, p, w) => { await org.ungroup(p?.id, w?.tabs); return true; },
      'organizer:close-group': async (_sender, p, w) => { await org.closeGroup(p?.id, w?.tabs); return true; },
      'organizer:workspace': (_sender, p) => org.workspace(p?.name),
      'organizer:select-workspace': (_sender, p, w) => org.selectWorkspace(p?.id, w?.tabs),
      'organizer:pin': (_sender, p, w) => org.pin(p?.ids, p?.pinned, w?.tabs),
      'organizer:sleep': (_sender, p, w) => org.sleep(p?.ids, w?.tabs),
      // One tab (`id`), or every tab picked in the strip (`ids`).
      'organizer:wake': async (_sender, p, w) => {
        for (const id of org.ids(Array.isArray(p?.ids) ? p.ids : [p?.id], w?.tabs)) await org.wake(id);
        this.changed('organizer:changed');
      },
      'organizer:close-duplicates': (_sender, _p, w) => org.closeDuplicates(w?.tabs),
      'organizer:save-session': (_sender, p, w) => org.saveSession(p, w?.tabs),
      'organizer:restore-session': (_sender, p, w) => org.restoreSession(p?.id, w?.tabs),
      'organizer:delete-session': (_sender, p) => org.deleteSession(p?.id),
      'organizer:summary': (_sender, _p, w) => org.summary(w?.tabs),
      'organizer:undo': () => org.undo(),
      'screentime:state': state,
      'screentime:update': (_sender, p) => { time.update(p); return state(); },
      'screentime:save-rule': (_sender, p) => { time.saveRule(p); return state(); },
      'screentime:remove-rule': (_sender, p) => { time.removeRule(p?.id); return state(); },
      'screentime:preset': (_sender, p) => { time.preset(p?.id); return state(); },
      'screentime:clear-usage': () => { time.clearUsage(); return state(); },
      'screentime:unlock': (_sender, p) => { time.unlock(p?.url); return state(); },
    };
  }
  flush() { this.screenTime.flush(); this.organizer.flush(); }
  stop() {
    clearInterval(this.timer); this.timer = null; this.flush();
    powerMonitor.removeListener('suspend', this.lock); powerMonitor.removeListener('lock-screen', this.lock);
    powerMonitor.removeListener('resume', this.unlock); powerMonitor.removeListener('unlock-screen', this.unlock);
  }
}
module.exports = { Productivity };
