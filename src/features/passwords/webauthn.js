'use strict';

/**
 * Passkeys: the authenticator half of WebAuthn, done in main.
 *
 * A site asks for a passkey with navigator.credentials.create() and signs in
 * with navigator.credentials.get(). Static answers both itself, as password
 * managers do: an ES256 (P-256) key pair per passkey, the private key sealed in
 * the vault like a password, and responses built to the WebAuthn Level 3
 * format - "none" attestation, a CBOR attestation object, and DER signatures
 * over authenticatorData || SHA-256(clientDataJSON).
 *
 * THE ORIGIN IS NEVER TAKEN FROM THE PAGE. It comes from the frame that made
 * the request, as main sees it, and the relying-party ID a page asks for must
 * be that site's own domain or a parent of it (never a public suffix). That
 * is the whole of WebAuthn's phishing resistance, so it is enforced here, not
 * in the page.
 */

const crypto = require('node:crypto');

/** Static's authenticator model ID. Random, fixed forever. */
const AAGUID = Buffer.from('5b0e4f7c9d2a4c8b8f1e6a3d2c9b7e41', 'hex');
const ES256 = -7;

/* ---- CBOR (just what attestation needs) ---------------------------------- */

function head(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(length, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(length, 1); return b;
}

function cbor(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('CBOR: integers only');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') { const b = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  if (value && typeof value === 'object') return cbor(new Map(Object.entries(value)));
  throw new Error('CBOR: unsupported value');
}

/** A minimal decoder, used by tests and to read a stored COSE key back. */
function decodeCbor(buffer) {
  let at = 0;
  const read = () => {
    const first = buffer[at++];
    const major = first >> 5;
    let length = first & 31;
    if (length === 24) length = buffer[at++];
    else if (length === 25) { length = buffer.readUInt16BE(at); at += 2; }
    else if (length === 26) { length = buffer.readUInt32BE(at); at += 4; }
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) { const out = buffer.subarray(at, at + length); at += length; return out; }
    if (major === 3) { const out = buffer.subarray(at, at + length).toString('utf8'); at += length; return out; }
    if (major === 4) return Array.from({ length }, read);
    if (major === 5) { const map = new Map(); for (let i = 0; i < length; i++) map.set(read(), read()); return map; }
    throw new Error('CBOR: unsupported major type ' + major);
  };
  const value = read();
  return { value, length: at };
}

/* ---- relying party ------------------------------------------------------- */

/** Suffixes under which a name is still public, so no site may claim them. */
const PUBLIC = new Set(['com', 'net', 'org', 'io', 'dev', 'app', 'co', 'in', 'uk', 'de', 'fr', 'jp', 'au', 'br', 'cn', 'ru', 'edu', 'gov',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk', 'co.kr', 'co.nz', 'co.za', 'github.io', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net']);

/**
 * The origin a request may act for, or an error. WebAuthn needs a secure
 * context: https, or http on localhost.
 */
function checkOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return { error: 'SecurityError' }; }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { error: 'SecurityError' };
  return { origin: url.origin, host: url.hostname.toLowerCase() };
}

/** Is `rpId` this host or a registrable parent of it? */
function validRpId(rpId, host) {
  const id = String(rpId || '').toLowerCase().replace(/\.$/, '');
  if (!id || /[^a-z0-9.-]/.test(id)) return false;
  if (!(host === id || host.endsWith('.' + id))) return false;
  if (id === 'localhost') return true;
  if (!id.includes('.') || PUBLIC.has(id)) return false;
  return true;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64url = (text) => Buffer.from(String(text || ''), 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** clientDataJSON, members in the order the spec serialises them. */
function clientData(type, challenge, origin, crossOrigin = false) {
  return Buffer.from(JSON.stringify({ type, challenge: b64url(challenge), origin, crossOrigin }), 'utf8');
}

/** COSE_Key for an EC2 P-256 public key. */
function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(new Map([[1, 2], [3, ES256], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
}

function authData(rpId, { up = true, uv = false, attested = null } = {}) {
  let flags = 0;
  if (up) flags |= 0x01;
  if (uv) flags |= 0x04;
  if (attested) flags |= 0x40;
  const parts = [sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), Buffer.alloc(4)]; // sign count stays 0, like every synced provider
  if (attested) {
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(attested.credentialId.length);
    parts.push(AAGUID, idLength, attested.credentialId, attested.cose);
  }
  return Buffer.concat(parts);
}

/**
 * Check a create() request and pick what to do with it.
 * @returns {{error?: string, rpId?: string, user?: object, ...}}
 */
function parseCreate(options, origin) {
  const where = checkOrigin(origin);
  if (where.error) return where;
  const pk = options || {};
  const rpId = String(pk.rp?.id || where.host).toLowerCase();
  if (!validRpId(rpId, where.host)) return { error: 'SecurityError' };
  const challenge = fromB64url(pk.challenge);
  const userId = fromB64url(pk.user?.id);
  if (challenge.length < 16 || !userId.length || userId.length > 64) return { error: 'TypeError' };
  const algs = (pk.pubKeyCredParams || []).filter((p) => p?.type === 'public-key').map((p) => p.alg);
  if (algs.length && !algs.includes(ES256)) return { error: 'NotSupportedError' };
  const selection = pk.authenticatorSelection || {};
  if (selection.authenticatorAttachment === 'cross-platform') return { error: 'NotSupportedError' };
  return {
    origin: where.origin,
    rpId,
    rpName: String(pk.rp?.name || rpId).slice(0, 120),
    challenge,
    user: {
      id: userId,
      name: String(pk.user?.name || '').slice(0, 200),
      displayName: String(pk.user?.displayName || pk.user?.name || '').slice(0, 200),
    },
    exclude: (pk.excludeCredentials || []).map((c) => b64url(fromB64url(c?.id))),
    userVerification: selection.userVerification || 'preferred',
    wantsCredProps: !!pk.extensions?.credProps,
  };
}

function parseGet(options, origin) {
  const where = checkOrigin(origin);
  if (where.error) return where;
  const pk = options || {};
  const rpId = String(pk.rpId || where.host).toLowerCase();
  if (!validRpId(rpId, where.host)) return { error: 'SecurityError' };
  const challenge = fromB64url(pk.challenge);
  if (challenge.length < 16) return { error: 'TypeError' };
  return {
    origin: where.origin,
    rpId,
    challenge,
    allow: (pk.allowCredentials || []).map((c) => b64url(fromB64url(c?.id))),
    userVerification: pk.userVerification || 'preferred',
  };
}

/**
 * A new passkey. Returns what to store (with the private key as PKCS#8 for
 * the caller to seal) and the response to hand the page.
 */
function register(request, { uv }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = crypto.randomBytes(32);
  const cose = coseKey(publicKey);
  const data = authData(request.rpId, { up: true, uv, attested: { credentialId, cose } });
  const client = clientData('webauthn.create', request.challenge, request.origin);
  const attestation = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
  return {
    stored: {
      credentialId: b64url(credentialId),
      rpId: request.rpId,
      rpName: request.rpName,
      userId: b64url(request.user.id),
      userName: request.user.name,
      displayName: request.user.displayName,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
    response: {
      id: b64url(credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientDataJSON: b64url(client),
      attestationObject: b64url(attestation),
      authenticatorData: b64url(data),
      publicKey: b64url(publicKey.export({ format: 'der', type: 'spki' })),
      publicKeyAlgorithm: ES256,
      transports: ['internal', 'hybrid'],
      extensions: request.wantsCredProps ? { credProps: { rk: true } } : {},
    },
  };
}

/** Sign in with a stored passkey whose private key the caller has opened. */
function assert(request, passkey, privatePkcs8, { uv }) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privatePkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  const data = authData(request.rpId, { up: true, uv });
  const client = clientData('webauthn.get', request.challenge, request.origin);
  const signature = crypto.sign('sha256', Buffer.concat([data, sha256(client)]), key);
  return {
    id: passkey.credentialId,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientDataJSON: b64url(client),
    authenticatorData: b64url(data),
    signature: b64url(signature),
    userHandle: passkey.userId,
    extensions: {},
  };
}

module.exports = { parseCreate, parseGet, register, assert, validRpId, checkOrigin, cbor, decodeCbor, AAGUID, ES256 };
