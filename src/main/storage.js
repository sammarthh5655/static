const fs = require('node:fs');
const path = require('node:path');
class JsonStore {
  constructor(directory, name, fallback) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, name + '.json');
    this.fallback = fallback;
    this.data = structuredClone(fallback);
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
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
    fs.renameSync(temporary, this.file);
    this.data = data;
    return data;
  }
}
module.exports = { JsonStore };
