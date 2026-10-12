/**
 * Builds .crx files for tests: real CRX3 packages signed with a fresh RSA key,
 * and ZIP archives that can be made to lie (wrong sizes, escaping names,
 * symlinks, duplicates) so the installer's refusals can be exercised.
 *
 * Not a probe and not a unit test: shared by tests/crx.test.cjs and
 * tests/extlocal.cjs.
 */
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** zlib.crc32 where Node has it, else a small table implementation. */
const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) >>> 0 : (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/**
 * A ZIP archive. Each entry: { name, data, method = 8, size?, crc?, flags?, external? }
 * `size` and `crc` override what the headers claim, to build lying archives.
 */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((e.external ?? (0o100644 << 16)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/* ---- protobuf, the three shapes CRX3 needs ---- */
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
function field(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicDer: publicKey.export({ type: 'spki', format: 'der' }) };
}

function idOf(publicDer) {
  return crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * A CRX3 package around `archive`.
 *   signer         { privateKey, publicDer } that signs it (default: a fresh key)
 *   claimDer       public key whose ID the header declares (default: the signer's)
 *   presentDer     public key placed in the proof (default: the signer's)
 *   corruptSignature  flip a byte of the signature
 */
function crx(archive, options = {}) {
  const signer = options.signer || keyPair();
  const claim = options.claimDer || signer.publicDer;
  const present = options.presentDer || signer.publicDer;
  const crxId = crypto.createHash('sha256').update(claim).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signedHeaderData, archive]);
  const signature = crypto.sign('sha256', signed, signer.privateKey);
  if (options.corruptSignature) signature[10] ^= 0xff;
  const proof = Buffer.concat([field(1, present), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);
  const top = Buffer.alloc(12);
  top.write('Cr24', 0, 'latin1');
  top.writeUInt32LE(3, 4);
  top.writeUInt32LE(header.length, 8);
  return { buffer: Buffer.concat([top, header, archive]), id: idOf(claim), signer };
}

/** A minimal, valid extension archive. */
function extensionArchive({ name = 'Fixture Extension', version = '1.0.0', extra = [] } = {}) {
  return zip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name, version, description: 'test fixture' }) },
    { name: 'icons/', data: '', method: 0 },
    { name: 'icons/readme.txt', data: 'hello from the fixture' },
    ...extra,
  ]);
}

module.exports = { zip, crx, keyPair, idOf, extensionArchive, crc32 };
