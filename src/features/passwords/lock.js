'use strict';

/**
 * The master password's cryptography.
 *
 * Without a master password every secret in the vault is encrypted by the
 * operating system alone (safeStorage: DPAPI, Keychain, libsecret), so anything
 * running as you can ask the OS to decrypt it. A master password adds a layer
 * the OS cannot open on its own:
 *
 *   master password --scrypt--> key-encryption key --AES-GCM--> vault private key
 *
 * The vault key is an X25519 key pair. Secrets are sealed to its PUBLIC half
 * (an ephemeral X25519 exchange, HKDF, AES-256-GCM), so a login can still be
 * saved while the vault is locked, and opening one needs the private half,
 * which exists in memory only between an unlock and the next lock.
 *
 * AES-GCM authenticates, so a wrong master password is detected by the key
 * failing to unwrap - no password hash is stored anywhere.
 */

const crypto = require('node:crypto');

/** scrypt at N=2^16: ~64 MB and a fraction of a second, per attempt. */
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024;
const SEALED = 'x1:';
const INFO = Buffer.from('static-vault-v1');

function deriveKek(password, salt, kdf = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** AES-256-GCM: iv(12) | tag(16) | ciphertext. */
function aesSeal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function aesOpen(key, blob, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

/** The raw 32-byte X25519 public key from a KeyObject. */
function rawPublic(publicKey) {
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
}

function publicFromRaw(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

/**
 * A new vault: a fresh key pair, its private half wrapped under the master
 * password. Returns the record to store and the unlocked private key.
 */
async function createLock(password) {
  const salt = crypto.randomBytes(16);
  const kek = await deriveKek(password, salt);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pub = rawPublic(publicKey);
  return {
    record: {
      v: 1,
      kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
      publicKey: pub.toString('base64'),
      wrapped: aesSeal(kek, pkcs8, pub).toString('base64'),
      createdAt: Date.now(),
    },
    privateKey,
  };
}

/** The private key, or null for a wrong password. */
async function unlockLock(record, password) {
  const kek = await deriveKek(password, Buffer.from(record.kdf.salt, 'base64'), record.kdf);
  try {
    const pkcs8 = aesOpen(kek, Buffer.from(record.wrapped, 'base64'), Buffer.from(record.publicKey, 'base64'));
    return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

/** Re-wrap the same private key under a new master password. */
async function rewrapLock(record, privateKey, password) {
  const salt = crypto.randomBytes(16);
  const kek = await deriveKek(password, salt);
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    ...record,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    wrapped: aesSeal(kek, pkcs8, Buffer.from(record.publicKey, 'base64')).toString('base64'),
  };
}

/** The private key as bytes, for the device (biometric) copy. */
function exportPrivate(privateKey) {
  return privateKey.export({ format: 'der', type: 'pkcs8' });
}

function importPrivate(pkcs8) {
  return crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
}

/** Seal a string to the vault's public key. Needs no unlock. */
function seal(publicKeyB64, plain) {
  const vaultPub = Buffer.from(publicKeyB64, 'base64');
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(vaultPub) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, vaultPub]), INFO, 32));
  return SEALED + Buffer.concat([ephPub, aesSeal(key, Buffer.from(String(plain), 'utf8'), ephPub)]).toString('base64');
}

/** Open a sealed string with the unlocked private key. Throws if tampered. */
function open(privateKey, publicKeyB64, sealed) {
  const blob = Buffer.from(String(sealed).slice(SEALED.length), 'base64');
  const ephPub = blob.subarray(0, 32);
  const vaultPub = Buffer.from(publicKeyB64, 'base64');
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicFromRaw(ephPub) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, vaultPub]), INFO, 32));
  return aesOpen(key, blob.subarray(32), ephPub).toString('utf8');
}

const isSealed = (value) => typeof value === 'string' && value.startsWith(SEALED);

/**
 * How long to make someone wait after wrong guesses. scrypt already costs
 * each attempt a fraction of a second; this stops a script at the unlock box
 * from making thousands.
 */
function penaltyMs(failures) {
  if (failures < 5) return 0;
  return Math.min(60_000, 2000 * 2 ** (failures - 5));
}

module.exports = { createLock, unlockLock, rewrapLock, exportPrivate, importPrivate, seal, open, isSealed, penaltyMs, KDF };
