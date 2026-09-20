const fs = require('node:fs');
const path = require('node:path');
class JsonStore {
  constructor(directory, name, fallback) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, name + '.json');
    this.fallback = fallback;
    this.data = structuredClone(fallback);
    if (fs.existsSync(this.file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
        // MERGE over the defaults rather than replacing them. Replacing meant
        // any setting added after a profile was created stayed permanently
        // undefined for existing users: a feature would ship, read its own new
        // flag as undefined, and silently do nothing. That is exactly how
        // `blockVideoAds` ended up disabled on every existing profile.
        // Arrays are taken wholesale, because a saved empty list must stay
        // empty rather than being refilled from the defaults.
        this.data = (isPlainObject(saved) && isPlainObject(fallback))
          ? mergeDefaults(structuredClone(fallback), saved)
          : saved;
      }
      catch (error) {
        // Preserve malformed files so recovery never silently destroys user data.
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
        console.error('Recovered invalid JSON store:', name, error.message);
      }
    }
  }
  save(data = this.data) {
    // Write + rename on the same volume: readers see either the old or new file.
    // Small settings/bookmark writes are synchronous; history is debounced separately.
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });

    // Windows can fail the rename with EPERM/EBUSY when something else holds
    // the file open for a moment - an antivirus scanner or the search indexer
    // reacting to the write we just made. It is transient, and a single
    // failure here would otherwise throw into the caller and lose the write.
    // Retrying briefly turns a lost save into a slightly delayed one.
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(temporary, this.file);
        this.data = data;
        return data;
      } catch (error) {
        lastError = error;
        if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'EACCES') break;
        // Synchronous backoff: this path is already synchronous, and the
        // alternative is returning before the data is durable.
        const until = Date.now() + 20 * (attempt + 1);
        while (Date.now() < until) { /* brief spin */ }
      }
    }
    // Do not leave a stale temp file behind for the next save to trip over.
    try { fs.unlinkSync(temporary); } catch { /* already gone */ }
    throw lastError;
  }
}
/** Only plain objects are merged; arrays and class instances are not. */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Overlay `saved` onto `target`, recursing into nested plain objects so a key
 * newly added inside a nested settings group is picked up too.
 */
function mergeDefaults(target, saved) {
  for (const [key, value] of Object.entries(saved)) {
    target[key] = (isPlainObject(value) && isPlainObject(target[key]))
      ? mergeDefaults(target[key], value)
      : value;
  }
  return target;
}

module.exports = { JsonStore, mergeDefaults };
