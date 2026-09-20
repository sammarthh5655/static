const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../src/main/storage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'static-store-'));

test('rapid consecutive saves all land', () => {
  // On Windows the write+rename can fail transiently with EPERM when an
  // antivirus scanner or the search indexer briefly holds the file it just
  // saw written. A single failure used to throw into the caller and lose the
  // write - clearing a few hundred notes was enough to hit it.
  const dir = tmp();
  try {
    const store = new JsonStore(dir, 'rapid', { items: [] });
    for (let i = 0; i < 250; i++) {
      store.data.items.push(i);
      store.save();
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'rapid.json'), 'utf8'));
    assert.strictEqual(onDisk.items.length, 250);
    assert.strictEqual(fs.existsSync(path.join(dir, 'rapid.json.tmp')), false,
      'a failed save must not leave a temp file for the next one to trip over');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved data is readable by a fresh store', () => {
  const dir = tmp();
  try {
    new JsonStore(dir, 'round', { value: 1 }).save({ value: 42 });
    assert.strictEqual(new JsonStore(dir, 'round', { value: 1 }).data.value, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
