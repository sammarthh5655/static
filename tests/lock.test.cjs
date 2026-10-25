const test = require('node:test');
const assert = require('node:assert/strict');
const lock = require('../src/features/passwords/lock');

// The lock's crypto is pure Node (no Electron), so it can be tested directly.
// A faster KDF keeps the test quick; the code paths are the same.
const FAST = { N: 2 ** 12, r: 8, p: 1 };

test('a recovery key opens the same vault the master password does', async () => {
  const { record, privateKey } = await lock.createLock('correct horse battery staple');
  // Something sealed to the vault's public key, as a saved password is.
  const secret = 'hunter2';
  const sealed = lock.seal(record.publicKey, secret);

  const { code, recovery } = await lock.makeRecovery(record, privateKey);
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/, 'code is five groups of four');
  const withRecovery = { ...record, recovery };

  // The recovery code unwraps the SAME private key, so the secret opens.
  const key = await lock.unlockRecovery(withRecovery, code);
  assert.ok(key, 'recovery code unlocks');
  assert.equal(lock.open(key, record.publicKey, sealed), secret);

  // Spacing and case do not matter; a wrong code does not open.
  assert.ok(await lock.unlockRecovery(withRecovery, code.replace(/-/g, '').toLowerCase()));
  assert.equal(await lock.unlockRecovery(withRecovery, 'AAAA-BBBB-CCCC-DDDD-EEEE'), null);
  assert.equal(await lock.unlockRecovery(record, code), null, 'no recovery record means no unlock');
});

test('after a recovery reset the new master password works and the old one does not', async () => {
  const { record, privateKey } = await lock.createLock('first password');
  const { code, recovery } = await lock.makeRecovery(record, privateKey);
  const withRecovery = { ...record, recovery };

  const key = await lock.unlockRecovery(withRecovery, code);
  const rewrapped = await lock.rewrapLock(withRecovery, key, 'a brand new password');

  assert.ok(await lock.unlockLock(rewrapped, 'a brand new password'), 'new master password opens');
  assert.equal(await lock.unlockLock(rewrapped, 'first password'), null, 'old one no longer opens');
  // The recovery key is carried over by rewrapLock, so it still works.
  assert.ok(await lock.unlockRecovery(rewrapped, code), 'recovery key still works after reset');
});
