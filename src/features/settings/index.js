const { JsonStore } = require('../../main/storage');
const { resolveInput } = require('../../shared/urls');
const DEFAULTS = { searchEngine: 'google', bookmarksBar: true, homepage: 'browser://newtab', newTabBehavior: 'newtab' };
class Settings {
  constructor(dir) {
    this.store = new JsonStore(dir, 'settings', DEFAULTS);
    this.value = { ...DEFAULTS, ...this.store.data };
  }
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    const next = { ...this.value };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'searchEngine' && ['google', 'brave'].includes(value)) next[key] = value;
      else if (key === 'bookmarksBar' && typeof value === 'boolean') next[key] = value;
      else if (key === 'newTabBehavior' && ['newtab', 'homepage'].includes(value)) next[key] = value;
      else if (key === 'homepage' && typeof value === 'string' && value.length <= 16384) next[key] = resolveInput(value, next.searchEngine);
      else throw new Error('Invalid setting: ' + key);
    }
    this.store.save(next);
    this.value = next;
    return next;
  }
}
module.exports = { Settings, DEFAULTS };
