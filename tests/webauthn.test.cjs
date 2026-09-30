const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const webauthn = require('../src/features/passwords/webauthn');

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const challenge = () => b64(crypto.randomBytes(32));

/**
 * Verify a registration the way a relying party's server does, using nothing
 * from the authenticator but the bytes it returned.
 */
function verifyRegistration(response, { rpId, origin, challenge: expected }) {
  const client = JSON.parse(Buffer.from(response.clientDataJSON, 'base64url').toString('utf8'));
  assert.deepStrictEqual(Object.keys(client), ['type', 'challenge', 'origin', 'crossOrigin']);
  assert.strictEqual(client.type, 'webauthn.create');
  assert.strictEqual(client.challenge, expected);
  assert.strictEqual(client.origin, origin);
  const attestation = webauthn.decodeCbor(Buffer.from(response.attestationObject, 'base64url')).value;
  assert.strictEqual(attestation.get('fmt'), 'none');
  const data = attestation.get('authData');
  assert.deepStrictEqual(data.subarray(0, 32), crypto.createHash('sha256').update(rpId).digest());
  const flags = data[32];
  assert.ok(flags & 0x01, 'user present');
  assert.ok(flags & 0x40, 'attested credential data');
  const idLength = data.readUInt16BE(53);
  const credentialId = data.subarray(55, 55 + idLength);
  assert.strictEqual(b64(credentialId), response.id);
  const cose = webauthn.decodeCbor(data.subarray(55 + idLength)).value;
  assert.strictEqual(cose.get(3), -7);
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(cose.get(-2)), y: b64(cose.get(-3)) }, format: 'jwk' });
  assert.strictEqual(publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), response.publicKey);
  return { publicKey, credentialId: response.id, uv: !!(flags & 0x04) };
}

function verifyAssertion(response, publicKey, { rpId, origin, challenge: expected }) {
  const client = JSON.parse(Buffer.from(response.clientDataJSON, 'base64url').toString('utf8'));
  assert.strictEqual(client.type, 'webauthn.get');
  assert.strictEqual(client.challenge, expected);
  assert.strictEqual(client.origin, origin);
  const data = Buffer.from(response.authenticatorData, 'base64url');
  assert.strictEqual(data.length, 37);
  assert.deepStrictEqual(data.subarray(0, 32), crypto.createHash('sha256').update(rpId).digest());
  const signed = Buffer.concat([data, crypto.createHash('sha256').update(Buffer.from(response.clientDataJSON, 'base64url')).digest()]);
  return crypto.verify('sha256', signed, publicKey, Buffer.from(response.signature, 'base64url'));
}

const createOptions = (extra = {}) => ({
  rp: { name: 'Example', id: 'example.com' },
  user: { id: b64(Buffer.from('user-1234')), name: 'sam@example.com', displayName: 'Sam' },
  challenge: challenge(),
  pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  extensions: { credProps: true },
  ...extra,
});

test('a passkey registers and signs in, and a relying party can verify both', () => {
  const options = createOptions();
  const request = webauthn.parseCreate(options, 'https://login.example.com');
  assert.ok(!request.error, request.error);
  const { stored, response } = webauthn.register(request, { uv: true });
  const reg = verifyRegistration(response, { rpId: 'example.com', origin: 'https://login.example.com', challenge: options.challenge });
  assert.strictEqual(reg.uv, true);
  assert.deepStrictEqual(response.extensions, { credProps: { rk: true } });
  assert.strictEqual(stored.userId, options.user.id);

  const getOptions = { challenge: challenge(), rpId: 'example.com', allowCredentials: [{ type: 'public-key', id: stored.credentialId }] };
  const get = webauthn.parseGet(getOptions, 'https://www.example.com');
  const signIn = webauthn.assert(get, stored, stored.privatePkcs8, { uv: false });
  assert.strictEqual(signIn.userHandle, options.user.id);
  assert.ok(verifyAssertion(signIn, reg.publicKey, { rpId: 'example.com', origin: 'https://www.example.com', challenge: getOptions.challenge }));
});

test('a signature over someone else\'s challenge does not verify', () => {
  const request = webauthn.parseCreate(createOptions(), 'https://example.com');
  const { stored, response } = webauthn.register(request, { uv: false });
  const reg = verifyRegistration(response, { rpId: 'example.com', origin: 'https://example.com', challenge: b64(request.challenge) });
  const get = webauthn.parseGet({ challenge: challenge() }, 'https://example.com');
  const signIn = webauthn.assert(get, stored, stored.privatePkcs8, { uv: false });
  const forged = { ...signIn, clientDataJSON: b64(Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge(), origin: 'https://example.com', crossOrigin: false }))) };
  assert.strictEqual(verifyAssertion({ ...forged, clientDataJSON: forged.clientDataJSON }, reg.publicKey, { rpId: 'example.com', origin: 'https://example.com', challenge: JSON.parse(Buffer.from(forged.clientDataJSON, 'base64url')).challenge }), false);
});

test('a site can only claim its own domain', () => {
  assert.ok(webauthn.validRpId('example.com', 'login.example.com'));
  assert.ok(webauthn.validRpId('login.example.com', 'login.example.com'));
  assert.ok(!webauthn.validRpId('evil.com', 'example.com'));
  assert.ok(!webauthn.validRpId('ample.com', 'example.com'));
  assert.ok(!webauthn.validRpId('com', 'example.com'));
  assert.ok(!webauthn.validRpId('co.uk', 'shop.co.uk'));
  assert.ok(!webauthn.validRpId('github.io', 'me.github.io'));
  assert.ok(webauthn.validRpId('localhost', 'localhost'));
  assert.strictEqual(webauthn.parseCreate(createOptions({ rp: { id: 'evil.com', name: 'x' } }), 'https://example.com').error, 'SecurityError');
});

test('only secure origins may use passkeys', () => {
  assert.strictEqual(webauthn.parseGet({ challenge: challenge() }, 'http://example.com').error, 'SecurityError');
  assert.ok(!webauthn.parseGet({ challenge: challenge() }, 'http://localhost:8080').error);
  assert.strictEqual(webauthn.parseGet({ challenge: challenge() }, 'file:///c:/x.html').error, 'SecurityError');
});

test('requests Static cannot serve are handed to the system', () => {
  assert.strictEqual(webauthn.parseCreate(createOptions({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }), 'https://example.com').error, 'NotSupportedError');
  assert.strictEqual(webauthn.parseCreate(createOptions({ authenticatorSelection: { authenticatorAttachment: 'cross-platform' } }), 'https://example.com').error, 'NotSupportedError');
  assert.strictEqual(webauthn.parseCreate(createOptions({ challenge: b64(Buffer.alloc(4)) }), 'https://example.com').error, 'TypeError');
});

test('CBOR round-trips what attestation uses', () => {
  const value = new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.alloc(300, 7)], [-2, 5], [1, -7]]);
  const back = webauthn.decodeCbor(webauthn.cbor(value)).value;
  assert.strictEqual(back.get('fmt'), 'none');
  assert.strictEqual(back.get('authData').length, 300);
  assert.strictEqual(back.get(1), -7);
});
