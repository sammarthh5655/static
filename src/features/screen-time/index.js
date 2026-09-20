const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');

const MINUTE = 60000;
const PRESETS = {
  study: { name: 'Study', minutes: 20, focusMinutes: 50 },
  work: { name: 'Work', minutes: 30, focusMinutes: 90 },
  gaming: { name: 'Gaming', minutes: 45, focusMinutes: 60 },
  legal: { name: 'Legal Research', minutes: 15, focusMinutes: 120 },
  custom: { name: 'Custom', minutes: 30, focusMinutes: 45 },
};
const SITES = [
  ['instagram.com', 'Instagram'], ['facebook.com', 'Facebook'], ['x.com', 'X / Twitter'],
  ['reddit.com', 'Reddit'], ['snapchat.com', 'Snapchat'], ['tiktok.com', 'TikTok'],
  ['amazon.in', 'Amazon India'], ['flipkart.com', 'Flipkart'], ['bbc.com', 'BBC News'],
  ['news.google.com', 'Google News'], ['youtube.com', 'YouTube (optional)'],
];

function domain(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 500) return '';
  try {
    const u = new URL(text.includes('://') ? text : 'https://' + text);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port ||
        (!u.hostname.includes('.') && u.hostname !== 'localhost')) return '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'twitter.com' ? 'x.com' : host === 'youtu.be' ? 'youtube.com' : host;
  } catch { return ''; }
}
function hostOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? domain(u.hostname) : ''; } catch { return ''; }
}
function matches(host, root) { return !!root && (host === root || host.endsWith('.' + root)); }
function dayKey(time) {
  const d = new Date(time);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function minutesOf(time) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
function scheduled(schedule, time) {
  const date = new Date(time), day = date.getDay(), minute = date.getHours() * 60 + date.getMinutes();
  const start = minutesOf(schedule.start), end = minutesOf(schedule.end);
  if (start === end) return schedule.days.includes(day); // equal times = all selected day
  if (start < end) return schedule.days.includes(day) && minute >= start && minute < end;
  return (schedule.days.includes(day) && minute >= start) ||
    (schedule.days.includes((day + 6) % 7) && minute < end);
}
function cleanSchedule(value) {
  if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.start) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.end) || !Array.isArray(value.days)) {
    throw new Error('Choose valid schedule times and days.');
  }
  const days = [...new Set(value.days)].filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) throw new Error('Choose at least one day.');
  return { days, start: value.start, end: value.end };
}

class ScreenTime {
  constructor(dir, { now = Date.now, onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.store = new JsonStore(dir, 'screen-time', {
      enabled: true, preset: 'custom', rules: [], allowlist: [], usage: {}, unlocks: {}, counters: {},
    });
    this.last = null;
    this.warned = new Set();
    this.lastFlush = now();
    this.dirty = false;
  }
  get config() { return this.store.data; }
  changed() { this.flush(); this.onChange(); }
  isAllowed(url, extra = []) {
    const host = hostOf(url);
    return [...this.config.allowlist, ...extra].some(item => matches(host, domain(item)));
  }
  isUnlocked(url) { return (this.config.unlocks[hostOf(url)] || 0) > this.now(); }
  used(root, date = dayKey(this.now())) {
    return Object.entries(this.config.usage[date] || {}).reduce((sum, [host, ms]) =>
      sum + (matches(host, root) ? ms : 0), 0);
  }

  // Only count consecutive samples from the same active, foreground web tab.
  // Long gaps, suspend/resume and clock changes never turn into phantom usage.
  observe(context, time = this.now()) {
    const current = { id: context.id, host: hostOf(context.url), eligible: !!context.eligible, time };
    const previous = this.last;
    this.last = current;
    const elapsed = previous ? time - previous.time : 0;
    if (this.config.enabled && elapsed > 0 && elapsed <= 15000 && previous.eligible &&
        current.eligible && current.host && current.host === previous.host && current.id === previous.id) {
      this.record(current.host, previous.time, time);
    }
    if (time - this.lastFlush >= 15000) this.flush();
  }
  record(host, start, end) {
    // Local calendar days, including DST and midnight, rather than rolling 24h.
    while (start < end) {
      const date = new Date(start);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const stop = Math.min(end, midnight), key = dayKey(start);
      const day = this.config.usage[key] ||= {};
      day[host] = (Number(day[host]) || 0) + stop - start;
      start = stop;
    }
    this.dirty = true;
  }
  verdict(url) {
    if (!this.config.enabled || this.isAllowed(url) || this.isUnlocked(url)) return null;
    const host = hostOf(url);
    for (const rule of this.config.rules) {
      if (!rule.enabled || !matches(host, rule.domain)) continue;
      const usedMs = this.used(rule.domain);
      if (rule.schedules.some(s => scheduled(s, this.now()))) return { reason: 'schedule', domain: rule.domain, ruleId: rule.id };
      if (rule.dailyMinutes !== null && usedMs >= rule.dailyMinutes * MINUTE) {
        return { reason: 'limit', domain: rule.domain, ruleId: rule.id, usedMs, limitMinutes: rule.dailyMinutes };
      }
    }
    return null;
  }
  warning(url) {
    if (!this.config.enabled || this.isAllowed(url) || this.isUnlocked(url)) return null;
    const host = hostOf(url);
    for (const rule of this.config.rules) {
      if (!rule.enabled || rule.dailyMinutes === null || !matches(host, rule.domain)) continue;
      const remaining = rule.dailyMinutes * MINUTE - this.used(rule.domain);
      const threshold = Math.min(MINUTE, rule.dailyMinutes * MINUTE * .2);
      const key = dayKey(this.now()) + ':' + rule.id + ':' + rule.dailyMinutes;
      if (remaining > 0 && remaining <= threshold && !this.warned.has(key)) {
        this.warned.add(key);
        return { domain: rule.domain, seconds: Math.ceil(remaining / 1000) };
      }
    }
    return null;
  }
  update(input) {
    if (typeof input?.enabled === 'boolean') this.config.enabled = input.enabled;
    if (input?.allowlist !== undefined) {
      if (!Array.isArray(input.allowlist) || input.allowlist.length > 200) throw new Error('Use up to 200 allowed domains.');
      const list = input.allowlist.map(domain);
      if (list.some(item => !item)) throw new Error('Enter valid domains in the allowlist.');
      this.config.allowlist = [...new Set(list)];
    }
    this.last = null;
    this.changed();
    return this.state();
  }
  saveRule(input) {
    if (!input || typeof input !== 'object') throw new Error('Enter a website rule.');
    const root = domain(input.domain);
    if (!root) throw new Error('Enter a valid website domain, without a port.');
    const minutes = input.dailyMinutes === null || input.dailyMinutes === '' ? null : Number(input.dailyMinutes);
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440)) throw new Error('Daily minutes must be between 0 and 1440.');
    if (!Array.isArray(input.schedules) || input.schedules.length > 8) throw new Error('Use up to eight schedules.');
    const schedules = input.schedules.map(cleanSchedule);
    if (minutes === null && !schedules.length) throw new Error('Set a daily limit or a pause schedule.');
    const previous = input.id ? this.config.rules.find(rule => rule.id === input.id) : this.config.rules.find(rule => rule.domain === root);
    if (input.id && !previous) throw new Error('This rule no longer exists.');
    if (!previous && this.config.rules.length >= 200) throw new Error('The rule limit is 200 websites.');
    const rule = { id: previous?.id || randomUUID(), domain: root, dailyMinutes: minutes,
      schedules, enabled: input.enabled !== false, managedByPreset: false };
    this.config.rules = this.config.rules.filter(item => item.id !== rule.id);
    this.config.rules.push(rule);
    this.config.preset = 'custom';
    this.changed();
    return rule;
  }
  removeRule(id) {
    this.config.rules = this.config.rules.filter(rule => rule.id !== id);
    this.changed();
  }
  preset(id) {
    if (!PRESETS[id]) throw new Error('Unknown preset.');
    if (id !== 'custom') {
      const manual = this.config.rules.filter(rule => !rule.managedByPreset);
      const suggested = SITES.slice(0, 6).filter(([root]) => !manual.some(rule => rule.domain === root))
        .map(([root]) => ({ id: randomUUID(), domain: root, dailyMinutes: PRESETS[id].minutes,
          schedules: [], enabled: true, managedByPreset: true }));
      this.config.rules = [...manual, ...suggested];
    }
    this.config.preset = id;
    this.changed();
    return this.state();
  }
  unlock(url) {
    const host = hostOf(url);
    if (!host) throw new Error('Only web pages can be unlocked.');
    this.config.unlocks[host] = this.now() + 5 * MINUTE;
    const key = dayKey(this.now());
    (this.config.counters[key] ||= { blocks: 0, unlocks: 0 }).unlocks++;
    this.changed();
    return this.config.unlocks[host];
  }
  hit() {
    const key = dayKey(this.now());
    (this.config.counters[key] ||= { blocks: 0, unlocks: 0 }).blocks++;
    this.dirty = true;
  }
  clearUsage() {
    this.config.usage = {}; this.config.counters = {}; this.warned.clear(); this.last = null;
    this.changed();
  }
  state() {
    const today = dayKey(this.now()), weekly = [];
    const current = new Date(this.now());
    for (let offset = 6; offset >= 0; offset--) {
      const day = dayKey(new Date(current.getFullYear(), current.getMonth(), current.getDate() - offset).getTime());
      weekly.push({ day, ms: Object.values(this.config.usage[day] || {}).reduce((sum, ms) => sum + ms, 0),
        ...(this.config.counters[day] || { blocks: 0, unlocks: 0 }) });
    }
    const sites = Object.entries(this.config.usage[today] || {}).map(([domain, ms]) => ({ domain, ms })).sort((a, b) => b.ms - a.ms);
    return { enabled: this.config.enabled, preset: this.config.preset, allowlist: this.config.allowlist,
      rules: this.config.rules.map(rule => ({ ...rule, usedMs: this.used(rule.domain) })),
      today, sites, weekly, todayMs: weekly[6].ms, weekMs: weekly.reduce((sum, day) => sum + day.ms, 0),
      unlocks: Object.entries(this.config.unlocks).filter(([, until]) => until > this.now()).map(([domain, until]) => ({ domain, until })),
      presets: Object.entries(PRESETS).map(([id, value]) => ({ id, ...value })), catalog: SITES };
  }
  flush() {
    const cutoff = new Date(this.now()); cutoff.setDate(cutoff.getDate() - 90);
    const oldest = dayKey(cutoff.getTime());
    for (const key of Object.keys(this.config.usage)) if (key < oldest) delete this.config.usage[key];
    for (const key of Object.keys(this.config.counters)) if (key < oldest) delete this.config.counters[key];
    for (const [host, until] of Object.entries(this.config.unlocks)) if (until <= this.now()) delete this.config.unlocks[host];
    this.store.save(); this.lastFlush = this.now(); this.dirty = false;
    if (this.warned.size > 1000) this.warned.clear();
  }
}
module.exports = { ScreenTime, domain, hostOf, matches, dayKey, scheduled, cleanSchedule, PRESETS };
