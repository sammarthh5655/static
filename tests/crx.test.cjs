const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseCrx, extractZip, unpackCrxFile, idFromKey, LIMITS } = require('../src/features/extensions/crx');
const fx = require('./fixtures/crx.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'static-crx-'));

/** Run `fn(dir)` with a scratch folder that is always removed. */
function inTmp(fn) {
  const dir = tmp();
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Everything under `dir`, as forward-slash relative paths. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p).split(path.sep).join('/') + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const rejects = (fn, code) => assert.throws(fn, (error) => {
  assert.strictEqual(error.code, code, 'expected ' + code + ', got ' + error.code + ': ' + error.message);
  return true;
});

/* ---- the container ---- */

test('a signed CRX3 is accepted and its ID comes from the key that signed it', () => {
  const pkg = fx.crx(fx.extensionArchive());
  const parsed = parseCrx(pkg.buffer);
  assert.strictEqual(parsed.id, pkg.id);
  assert.strictEqual(parsed.id, idFromKey(pkg.signer.publicDer));
  assert.match(parsed.id, /^[a-p]{32}$/);
});

test('one changed byte in the archive fails the signature check', () => {
  const pkg = fx.crx(fx.extensionArchive());
  const tampered = Buffer.from(pkg.buffer);
  tampered[tampered.length - 40] ^= 0x01;
  rejects(() => parseCrx(tampered), 'signature');
});

test('a corrupted signature is refused', () => {
  rejects(() => parseCrx(fx.crx(fx.extensionArchive(), { corruptSignature: true }).buffer), 'signature');
});

test('a package cannot claim another extension\'s ID', () => {
  // Signed properly by its own key, but declaring the ID of someone else's
  // key: installing it would replace that extension.
  const victim = fx.keyPair();
  const pkg = fx.crx(fx.extensionArchive(), { claimDer: victim.publicDer });
  rejects(() => parseCrx(pkg.buffer), 'id');
});

test('presenting a victim\'s public key without its private key fails', () => {
  const victim = fx.keyPair();
  const pkg = fx.crx(fx.extensionArchive(), { claimDer: victim.publicDer, presentDer: victim.publicDer });
  rejects(() => parseCrx(pkg.buffer), 'signature');
});

test('CRX2, unknown versions, and non-CRX files are refused with a reason', () => {
  const crx2 = Buffer.alloc(16);
  crx2.write('Cr24', 0, 'latin1');
  crx2.writeUInt32LE(2, 4);
  rejects(() => parseCrx(crx2), 'crx2');
  const v9 = Buffer.from(crx2);
  v9.writeUInt32LE(9, 4);
  rejects(() => parseCrx(v9), 'format');
  rejects(() => parseCrx(Buffer.from('PK\x03\x04 a plain zip')), 'format');
  rejects(() => parseCrx(Buffer.alloc(0)), 'format');
});

test('a header that claims more bytes than the file has is refused', () => {
  const pkg = fx.crx(fx.extensionArchive());
  const cut = Buffer.from(pkg.buffer.subarray(0, 40));
  rejects(() => parseCrx(cut), 'header');
});

/* ---- the archive ---- */

test('a valid archive unpacks exactly its files', () => inTmp((dir) => {
  const dest = path.join(dir, 'out');
  extractZip(fx.extensionArchive(), dest);
  assert.deepStrictEqual(tree(dest), ['icons/', 'icons/readme.txt', 'manifest.json']);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'icons', 'readme.txt'), 'utf8'), 'hello from the fixture');
}));

for (const name of ['../escape.txt', 'a/../../escape.txt', '/abs.txt', 'C:/abs.txt', 'c:evil.txt', '..\\escape.txt', 'a\\..\\..\\escape.txt']) {
  test('an entry named ' + JSON.stringify(name) + ' cannot write outside the folder', () => inTmp((dir) => {
    const dest = path.join(dir, 'out');
    rejects(() => extractZip(fx.zip([{ name, data: 'x' }]), dest), 'path');
    assert.deepStrictEqual(tree(dir), [], 'nothing may be written anywhere');
  }));
}

for (const name of ['CON', 'aux.json', 'sub/nul.txt', 'trailing.', 'trailing ', 'stream.txt:hidden']) {
  test('a Windows-unsafe name ' + JSON.stringify(name) + ' is refused', () => inTmp((dir) => {
    rejects(() => extractZip(fx.zip([{ name, data: 'x' }]), path.join(dir, 'out')), 'path');
  }));
}

test('a symbolic link entry is refused', () => inTmp((dir) => {
  const link = fx.zip([{ name: 'link', data: '/etc/passwd', method: 0, external: (0o120777 << 16) >>> 0 }]);
  rejects(() => extractZip(link, path.join(dir, 'out')), 'zip');
  assert.deepStrictEqual(tree(dir), []);
}));

test('two entries with the same name are refused, case-insensitively', () => inTmp((dir) => {
  rejects(() => extractZip(fx.zip([{ name: 'a.js', data: '1' }, { name: 'a.js', data: '2' }]), path.join(dir, 'o1')), 'zip');
  rejects(() => extractZip(fx.zip([{ name: 'A.js', data: '1' }, { name: 'a.js', data: '2' }]), path.join(dir, 'o2')), 'zip');
}));

test('an entry that inflates past its declared size stops at the declared size', () => inTmp((dir) => {
  // Declares 10 bytes, holds a megabyte of zeros: the classic size lie.
  const bomb = fx.zip([{ name: 'big.bin', data: Buffer.alloc(1024 * 1024), size: 10 }]);
  rejects(() => extractZip(bomb, path.join(dir, 'out')), 'size');
}));

test('declaring a size of zero does not bypass the limit', () => inTmp((dir) => {
  const bomb = fx.zip([{ name: 'zero.bin', data: Buffer.alloc(64 * 1024), size: 0 }]);
  rejects(() => extractZip(bomb, path.join(dir, 'out')), 'size');
}));

test('an entry smaller than it claims is refused', () => inTmp((dir) => {
  const short = fx.zip([{ name: 's.txt', data: 'abc', size: 50 }]);
  rejects(() => extractZip(short, path.join(dir, 'out')), 'size');
}));

test('the total unpacked size is capped while inflating', () => inTmp((dir) => {
  const limits = { ...LIMITS, totalBytes: 100 * 1024 };
  const many = fx.zip([
    { name: 'a.bin', data: Buffer.alloc(60 * 1024) },
    { name: 'b.bin', data: Buffer.alloc(60 * 1024) },
  ]);
  rejects(() => extractZip(many, path.join(dir, 'out'), limits), 'size');
}));

test('too many entries are refused before anything is written', () => inTmp((dir) => {
  const limits = { ...LIMITS, entries: 3 };
  const many = fx.zip(Array.from({ length: 4 }, (_, i) => ({ name: 'f' + i, data: 'x' })));
  rejects(() => extractZip(many, path.join(dir, 'out'), limits), 'size');
  assert.deepStrictEqual(tree(dir), []);
}));

test('two entries that share the same data are refused before anything is written', () => inTmp((dir) => {
  const shared = fx.zip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', aliasOf: 0 }]);
  rejects(() => extractZip(shared, path.join(dir, 'out')), 'zip');
  assert.deepStrictEqual(tree(dir), []);
}));

test('thousands of entries pointing at one blob cannot make unpacking slow', () => inTmp((dir) => {
  // The reviewed attack, scaled down: deflate data made only of empty stored
  // blocks inflates to nothing, so every size and CRC check passes - yet
  // each entry that points at it costs a full pass over it. Shared data is
  // now refused up front, so this is fast however large it is made.
  const empty = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
  const blob = Buffer.concat([...Array(200000).fill(empty), Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff])]);
  const entries = [{ name: 'manifest.json', data: '{}' }, { name: 'p', raw: blob, size: 0, crc: 0 }];
  for (let i = 0; i < 5000; i++) entries.push({ name: 'f' + i, aliasOf: 1 });
  const started = Date.now();
  rejects(() => extractZip(fx.zip(entries), path.join(dir, 'out')), 'zip');
  assert.ok(Date.now() - started < 2000, 'took ' + (Date.now() - started) + 'ms');
  assert.deepStrictEqual(tree(dir), []);
}));

test('an encrypted entry is refused', () => inTmp((dir) => {
  rejects(() => extractZip(fx.zip([{ name: 'e.txt', data: 'x', flags: 0x1 }]), path.join(dir, 'out')), 'zip');
}));

test('a damaged CRC is refused', { skip: typeof require('node:zlib').crc32 !== 'function' }, () => inTmp((dir) => {
  rejects(() => extractZip(fx.zip([{ name: 'c.txt', data: 'hello', crc: 12345 }]), path.join(dir, 'out')), 'zip');
}));

test('an unsupported compression method is refused', () => inTmp((dir) => {
  rejects(() => extractZip(fx.zip([{ name: 'm.txt', data: 'x', method: 12 }]), path.join(dir, 'out')), 'zip');
}));

test('random bytes are not mistaken for an archive', () => inTmp((dir) => {
  rejects(() => extractZip(crypto.randomBytes(4096), path.join(dir, 'out')), 'zip');
}));

test('the destination must not already exist', () => inTmp((dir) => {
  assert.throws(() => extractZip(fx.extensionArchive(), dir), /already exists/);
}));

/* ---- the whole file ---- */

test('unpackCrxFile writes the key into the manifest so the ID stays stable', () => inTmp((dir) => {
  const pkg = fx.crx(fx.extensionArchive({ name: 'Keyed', version: '2.3.4' }));
  const file = path.join(dir, 'x.crx');
  fs.writeFileSync(file, pkg.buffer);
  const dest = path.join(dir, 'out');
  const result = unpackCrxFile(file, dest);
  assert.strictEqual(result.id, pkg.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.name, 'Keyed');
  assert.strictEqual(manifest.version, '2.3.4');
  // Electron derives an extension's ID from this key exactly as Chrome does.
  assert.strictEqual(idFromKey(Buffer.from(manifest.key, 'base64')), pkg.id);
}));

test('a package with no manifest leaves nothing behind', () => inTmp((dir) => {
  const pkg = fx.crx(fx.zip([{ name: 'readme.txt', data: 'no manifest' }]));
  const file = path.join(dir, 'x.crx');
  fs.writeFileSync(file, pkg.buffer);
  rejects(() => unpackCrxFile(file, path.join(dir, 'out')), 'manifest');
  assert.deepStrictEqual(tree(dir), ['x.crx']);
}));

test('a manifest without a valid version is refused', () => inTmp((dir) => {
  const archive = fx.zip([{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'n', version: 'latest' }) }]);
  const file = path.join(dir, 'x.crx');
  fs.writeFileSync(file, fx.crx(archive).buffer);
  rejects(() => unpackCrxFile(file, path.join(dir, 'out')), 'manifest');
}));

test('an oversized file is refused before it is read', () => inTmp((dir) => {
  const file = path.join(dir, 'x.crx');
  fs.writeFileSync(file, fx.crx(fx.extensionArchive()).buffer);
  rejects(() => unpackCrxFile(file, path.join(dir, 'out'), { ...LIMITS, fileBytes: 100 }), 'size');
}));
