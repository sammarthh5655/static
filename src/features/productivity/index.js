const { powerMonitor } = require('electron');
const { ScreenTime, hostOf } = require('../screen-time');
const { Organizer } = require('../organizer');
const { signature } = require('../organizer/classify');
const gemini = require('../ai/gemini');

/** One integration point for tabs, Focus, Screen Time and Organizer.
 * Request blocking is called by the application's ONE webRequest listener.
 * IPC remains available only through the existing trusted-page guard.
 */
class Productivity {
  constructor(browser) {
    this.browser = browser; this.locked = false; this.timer = null; this.ticks = 0; this.pendingBlocks = new Set();
    this.screenTime = new ScreenTime(browser.dir, { onChange: () => this.changed('screentime:changed') });
    this.organizer = new Organizer(browser.dir, { getTabs: () => browser.tabs, resources: browser.resources, ai: gemini,
      onChange: () => this.changed('organizer:changed') });
    this.lock = () => { this.locked = true; this.screenTime.last = null; };
    this.unlock = () => { this.locked = false; this.screenTime.last = null; };
  }
  changed(channel) {
    this.browser.push();
    for (const tab of this.browser.tabs?.tabs.values() || []) {
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
    const tab = [...(this.browser.tabs?.tabs.values() || [])].find(t => t.view.webContents.id === contentsId);
    if (!tab || this.pendingBlocks.has(tab.id)) return;
    this.pendingBlocks.add(tab.id); this.screenTime.hit();
    if (verdict.reason === 'focus') this.browser.focus.recordHit();
    // browser:// is a logical route, not a network protocol. Cancel first, then
    // load the allowlisted local page through Tabs; a webRequest redirect fails.
    setImmediate(async () => {
      try {
        if (!this.browser.tabs.tabs.has(tab.id)) return;
        await this.organizer.wake(tab.id);
        this.browser.tabs.navigate(tab.id, 'browser://screentime?blocked=' + encodeURIComponent(url) + '&reason=' + verdict.reason);
      } catch (error) { console.error('Screen Time block:', error.message); }
      finally { this.pendingBlocks.delete(tab.id); }
    });
  }
  tick() {
    const browser = this.browser, tab = browser.tabs?.active, win = browser.window;
    const eligible = !!tab && !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() &&
      !this.locked && powerMonitor.getSystemIdleTime() < 300 && !this.organizer.sleeping.has(tab.id);
    this.screenTime.observe({ id: tab?.id, url: tab?.state.displayUrl || '', eligible });
    const warning = tab && this.screenTime.warning(tab.state.displayUrl);
    if (warning && eligible) browser.notify(warning.domain + ': about ' + warning.seconds + ' seconds left today. You can adjust this in Screen Time.');
    for (const item of browser.tabs?.tabs.values() || []) {
      const verdict = this.policy(item.state.displayUrl);
      if (verdict) this.block(item.view.webContents.id, item.state.displayUrl, verdict);
    }
    this.ticks++;
    if (this.ticks % 5 === 0) this.changed('screentime:changed');
    if (this.ticks % 15 === 0 && !this.organizer.aiBusy && !this.organizer.busy) {
      const tabs = browser.tabs?.list() || [];
      if (tabs.filter(t => hostOf(t.url)).length >= 8 && signature(tabs) !== this.organizer.plan?.signature) {
        this.organizer.localAnalysis(); this.changed('organizer:changed');
      }
    }
  }
  handlers() {
    const org = this.organizer, time = this.screenTime;
    const state = () => ({ ...time.state(), focus: this.browser.focus.state() });
    return {
      'organizer:state': () => org.state(),
      'organizer:analyze': (_sender, p) => org.analyze(p?.ai === true),
      'organizer:apply': () => org.apply(),
      'organizer:group': (_sender, p) => org.group(p),
      'organizer:move': (_sender, p) => org.move(p),
      'organizer:workspace': (_sender, p) => org.workspace(p?.name),
      'organizer:select-workspace': (_sender, p) => org.selectWorkspace(p?.id),
      'organizer:pin': (_sender, p) => org.pin(p?.ids, p?.pinned),
      'organizer:sleep': (_sender, p) => org.sleep(p?.ids),
      'organizer:wake': async (_sender, p) => { await org.wake(p?.id); this.changed('organizer:changed'); },
      'organizer:close-duplicates': () => org.closeDuplicates(),
      'organizer:save-session': (_sender, p) => org.saveSession(p),
      'organizer:restore-session': (_sender, p) => org.restoreSession(p?.id),
      'organizer:delete-session': (_sender, p) => org.deleteSession(p?.id),
      'organizer:summary': () => org.summary(),
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
