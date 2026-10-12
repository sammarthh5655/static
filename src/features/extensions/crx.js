/**
 * Reading a .crx file someone picked from disk: verify it, then unpack it.
 *
 * Pure Node, no Electron, so every rule below is unit tested
 * (tests/crx.test.cjs) without launching the browser.
 *
 * Why this exists rather than reusing electron-chrome-web-store:
 * - Its `installExtension()` takes a Web Store ID, not a file. Given a path it
 *   asked Google for an extension "named" after that path and always failed.
 * - Its CRX reader never checks a signature. It only matches the declared ID
 *   against a key in the header. That is fine for files it downloads from
 *   Google over HTTPS, but a file from disk can be anything: without a real
 *   signature check, a crafted .crx carrying another extension's public key
 *   would install over that extension under its ID.
 * - It unpacks with adm-zip, whose open advisories (symlink-following writes,
 *   decompression bombs, duplicate entries resolving differently) all concern
 *   exactly this situation: an archive nobody vetted.
 *
 * So: CRX3 only (Chrome itself stopped accepting CRX2), every signature in the
 * header must verify, the declared ID must belong to one of the RSA keys that
 * signed it, and the ZIP is unpacked by the small reader below, which refuses
 * anything it cannot prove is safe instead of trying to make it safe.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = {
  fileBytes: 256 * 1024 * 1024,     // the .crx on disk
  totalBytes: 512 * 1024 * 1024,    // everything it unpacks to, together
  entries: 20000,
};

/** A CRX problem the person can act on. `code` is for tests and logs. */
class CrxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrxError';
    this.code = code;
  }
}

/* ---- extension IDs --------------------------------------------------------- */

/**
 * Chrome's extension ID for a public key: the first 16 bytes of SHA-256 of the
 * DER key, as hex, with 0-f written as a-p (so an ID is never all digits).
 * Electron derives the same ID from a manifest "key", which is why writing the
 * key into manifest.json keeps the ID stable across reinstalls and restarts.
 */
function idFromKey(publicKeyDer) {
  return idFromHex(crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32));
}

function idFromHex(hex) {
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/* ---- a minimal protobuf reader ---------------------------------------------
   The CRX3 header is a protobuf. Only three message shapes are needed, all of
   them bytes fields, so a general decoder would be dead weight. Unknown fields
   are skipped by wire type, as protobuf requires. */

function readVarint(buf, state) {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (state.at >= buf.length) throw new CrxError('header', 'The .crx header is cut short.');
    const byte = buf[state.at++];
    // Multiply rather than shift: shifts are 32-bit in JavaScript.
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return result;
    shift += 7;
  }
  throw new CrxError('header', 'The .crx header is malformed.');
}

/** Every length-delimited field, as { field, value } in order. */
function readBytesFields(buf) {
  const out = [];
  const state = { at: 0 };
  while (state.at < buf.length) {
    const tag = readVarint(buf, state);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 2) {
      const length = readVarint(buf, state);
      if (state.at + length > buf.length) throw new CrxError('header', 'The .crx header is cut short.');
      out.push({ field, value: buf.subarray(state.at, state.at + length) });
      state.at += length;
    } else if (wire === 0) readVarint(buf, state);
    else if (wire === 1) state.at += 8;
    else if (wire === 5) state.at += 4;
    else throw new CrxError('header', 'The .crx header is malformed.');
    if (state.at > buf.length) throw new CrxError('header', 'The .crx header is cut short.');
  }
  return out;
}

/** AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; } */
function readProof(buf) {
  const proof = { publicKey: null, signature: null };
  for (const { field, value } of readBytesFields(buf)) {
    if (field === 1) proof.publicKey = value;
    else if (field === 2) proof.signature = value;
  }
  return proof;
}

/* ---- the CRX container ----------------------------------------------------- */

const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');

/**
 * Parse and verify a CRX3 file. Returns the extension ID, the public key that
 * vouches for it (DER), and the ZIP archive inside.
 *
 * Verification follows Chrome's CRX3 verifier: every RSA and ECDSA proof in
 * the header must verify over (prefix, signed header data, archive), and at
 * least one RSA key must hash to the ID the header declares.
 */
function parseCrx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'Cr24') {
    throw new CrxError('format', 'This is not a Chrome extension package (.crx).');
  }
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    throw new CrxError('crx2', 'This is an old CRX2 package. Chrome no longer installs these; use a CRX3 package or load the folder unpacked.');
  }
  if (version !== 3) throw new CrxError('format', 'This .crx uses an unknown package version (' + version + ').');

  const headerSize = buffer.readUInt32LE(8);
  if (12 + headerSize > buffer.length) throw new CrxError('header', 'The .crx header is cut short.');
  const header = buffer.subarray(12, 12 + headerSize);
  const archive = buffer.subarray(12 + headerSize);

  // CrxFileHeader { repeated proof sha256_with_rsa = 2; repeated proof
  // sha256_with_ecdsa = 3; bytes signed_header_data = 10000; }
  const rsa = [];
  const ecdsa = [];
  let signedHeaderData = null;
  for (const { field, value } of readBytesFields(header)) {
    if (field === 2) rsa.push(readProof(value));
    else if (field === 3) ecdsa.push(readProof(value));
    else if (field === 10000) signedHeaderData = value;
  }
  if (!signedHeaderData) throw new CrxError('unsigned', 'This .crx has no signed header, so it cannot be verified.');

  // SignedData { bytes crx_id = 1; }
  const crxId = readBytesFields(signedHeaderData).find((f) => f.field === 1)?.value;
  if (!crxId || crxId.length !== 16) throw new CrxError('unsigned', 'This .crx does not declare its extension ID.');
  const id = idFromHex(crxId.toString('hex'));

  if (!rsa.length) throw new CrxError('unsigned', 'This .crx is not signed with an RSA key, so it cannot be verified.');

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signed = Buffer.concat([SIGNED_DATA_PREFIX, length, signedHeaderData, archive]);

  const check = (proof) => {
    if (!proof.publicKey || !proof.signature) return false;
    try {
      const key = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
      return crypto.verify('sha256', signed, key, proof.signature);
    } catch { return false; }
  };
  if (![...rsa, ...ecdsa].every(check)) {
    throw new CrxError('signature', 'This .crx failed its signature check. It may be damaged or tampered with.');
  }
  // The ID must be vouched for by a key that actually signed this file.
  // Otherwise a package could claim another extension's ID and replace it.
  const owner = rsa.find((proof) => idFromKey(proof.publicKey) === id);
  if (!owner) throw new CrxError('id', 'This .crx declares an extension ID that none of its signing keys owns.');

  return { id, publicKey: Buffer.from(owner.publicKey), archive };
}

/* ---- a deliberately strict ZIP reader -------------------------------------- */

// Device names Windows will not create as files, in any folder, with any extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** The entry name as safe relative path segments, or a CrxError. */
function safeSegments(name) {
  if (!name || name.includes('\0')) throw new CrxError('path', 'The package contains an entry with no usable name.');
  // ZIP uses forward slashes; a backslash is either a Windows-made archive or
  // an attempt to smuggle a separator past a check. Either way, treat it as one.
  const normal = name.replace(/\\/g, '/');
  if (normal.startsWith('/') || /^[a-z]:/i.test(normal)) {
    throw new CrxError('path', 'The package tries to write outside its own folder (' + name + ').');
  }
  const segments = normal.split('/').filter((s) => s !== '');
  if (!segments.length) throw new CrxError('path', 'The package contains an entry with no usable name.');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new CrxError('path', 'The package tries to write outside its own folder (' + name + ').');
    }
    // ':' is an NTFS alternate data stream; trailing dots and spaces are
    // silently stripped by Windows, so two names could land on one file.
    if (segment.includes(':') || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
      throw new CrxError('path', 'The package contains a file name this system cannot store safely (' + name + ').');
    }
  }
  return segments;
}

/**
 * Unpack `archive` into `dest`, which must not exist yet. Returns the list of
 * files written (relative, forward slashes).
 *
 * Refuses rather than repairs: encrypted entries, symlinks, ZIP64, unknown
 * compression, names that escape `dest`, two entries with one name, a declared
 * size that does not match what the data inflates to, and anything that would
 * pass the size limits. Sizes are enforced DURING inflation (maxOutputLength),
 * so a decompression bomb stops at the limit instead of filling memory.
 */
function extractZip(archive, dest, limits = LIMITS) {
  if (fs.existsSync(dest)) throw new Error('extractZip: destination already exists: ' + dest);

  // End of central directory: the last 22 bytes, plus up to 64 KiB of comment.
  const floor = Math.max(0, archive.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = archive.length - 22; i >= floor; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new CrxError('zip', 'The package contents are not a readable ZIP archive.');
  const count = archive.readUInt16LE(eocd + 10);
  const dirSize = archive.readUInt32LE(eocd + 12);
  const dirStart = archive.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirStart === 0xffffffff || dirSize === 0xffffffff) {
    throw new CrxError('zip', 'The package uses ZIP64, which is too large to install.');
  }
  if (count > limits.entries) throw new CrxError('size', 'The package contains too many files.');
  if (dirStart + dirSize > eocd) throw new CrxError('zip', 'The package contents are damaged.');

  const seen = new Set();
  const plan = [];
  let at = dirStart;
  for (let n = 0; n < count; n++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== 0x02014b50) {
      throw new CrxError('zip', 'The package contents are damaged.');
    }
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const external = archive.readUInt32LE(at + 38);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new CrxError('zip', 'The package contains an encrypted file.');
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new CrxError('zip', 'The package uses ZIP64, which is too large to install.');
    }
    // A Unix mode lives in the high 16 bits. This reader never creates links,
    // but a package that ships one is refused outright rather than flattened.
    if (((external >>> 16) & 0o170000) === 0o120000) {
      throw new CrxError('zip', 'The package contains a symbolic link (' + name + ').');
    }

    const directory = name.endsWith('/') || name.endsWith('\\');
    const segments = safeSegments(directory ? name.replace(/[\\/]+$/, '') : name);
    const key = segments.join('/').toLowerCase(); // case-insensitive file systems
    if (!directory) {
      if (seen.has(key)) throw new CrxError('zip', 'The package contains two files named ' + name + '.');
      seen.add(key);
    }
    if (method !== 0 && method !== 8) throw new CrxError('zip', 'The package uses an unsupported compression method.');
    plan.push({ name, segments, directory, method, crc, compressed, size, local });
  }

  fs.mkdirSync(dest, { recursive: true });
  const written = [];
  let total = 0;
  for (const entry of plan) {
    const target = path.join(dest, ...entry.segments);
    // Belt and braces: the segments were checked, but the joined path is what
    // touches the disk, so it is checked too.
    const relative = path.relative(dest, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new CrxError('path', 'The package tries to write outside its own folder (' + entry.name + ').');
    }
    if (entry.directory) { fs.mkdirSync(target, { recursive: true }); continue; }

    const header = entry.local;
    if (header + 30 > archive.length || archive.readUInt32LE(header) !== 0x04034b50) {
      throw new CrxError('zip', 'The package contents are damaged.');
    }
    const start = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
    if (start + entry.compressed > archive.length) throw new CrxError('zip', 'The package contents are damaged.');
    const raw = archive.subarray(start, start + entry.compressed);

    const budget = limits.totalBytes - total;
    if (entry.size > budget) throw new CrxError('size', 'The package unpacks to more than this browser will install.');
    let data;
    if (entry.method === 0) data = raw;
    else {
      try {
        // One byte more than declared: inflating past the declared size is a
        // lie about the size, and is caught below rather than trusted.
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(budget, entry.size + 1) || 1 });
      } catch (error) {
        if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new CrxError('size', 'A file in the package is larger than it claims to be (' + entry.name + ').');
        }
        throw new CrxError('zip', 'A file in the package could not be decompressed (' + entry.name + ').');
      }
    }
    if (data.length !== entry.size) {
      throw new CrxError('size', 'A file in the package is not the size it claims to be (' + entry.name + ').');
    }
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== entry.crc) {
      throw new CrxError('zip', 'A file in the package is damaged (' + entry.name + ').');
    }
    total += data.length;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 'wx': never follow or overwrite anything already there.
    fs.writeFileSync(target, data, { flag: 'wx' });
    written.push(entry.segments.join('/'));
  }
  return written;
}

/**
 * Read, verify and unpack `file` into `dest` (which must not exist).
 * Returns { id, publicKey, manifest } with the manifest already carrying its
 * "key", so Electron derives the same ID as Chrome would.
 */
function unpackCrxFile(file, dest, limits = LIMITS) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new CrxError('format', 'That is not a file.');
  if (stat.size > limits.fileBytes) throw new CrxError('size', 'This .crx is larger than this browser will install.');
  const crx = parseCrx(fs.readFileSync(file));
  try {
    extractZip(crx.archive, dest, limits);
    const manifestPath = path.join(dest, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    } catch {
      throw new CrxError('manifest', 'This package has no readable manifest.json.');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new CrxError('manifest', 'This package has no readable manifest.json.');
    }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
      throw new CrxError('manifest', 'This package\'s manifest.json is missing a name or a valid version.');
    }
    if (![2, 3].includes(manifest.manifest_version)) {
      throw new CrxError('manifest', 'This package uses an unsupported manifest version.');
    }
    manifest.key = crx.publicKey.toString('base64');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { id: crx.id, publicKey: crx.publicKey, manifest };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { parseCrx, extractZip, unpackCrxFile, idFromKey, CrxError, LIMITS };
