/**
 * Passkeys and saved-password sign-in, the page half.
 *
 * Sites ask for passkeys through navigator.credentials. Static answers those
 * calls itself (features/passwords/webauthn.js), so this installs a thin
 * replacement for create() and get() in the PAGE's own world, at
 * document-start, before any of the site's scripts run.
 *
 * The replacement does nothing but carry the request to main through one
 * function handed across the context bridge, and turn main's answer back into
 * real-looking PublicKeyCredential objects. Everything that decides anything -
 * which origin is asking, which site it may act for, whether the person agreed
 * - happens in main, from the frame main sees. When Static has no answer (a
 * security key, a phone, an algorithm it does not do), the call goes to the
 * browser's own implementation untouched.
 *
 * Also answers the Credential Management API for passwords, which is how
 * sites that support it sign people in automatically.
 */
const { contextBridge, ipcRenderer } = require('electron');

/* eslint-disable no-restricted-globals */
function install(bridge, closed) {
  const container = window.CredentialsContainer && CredentialsContainer.prototype;
  if (!container || !navigator.credentials || container.create.__static) return;
  const nativeCreate = container.create;
  const nativeGet = container.get;
  const nativeStore = container.store;
  const nativePrevent = container.preventSilentAccess;
  let counter = 0;

  const bytes = (source) => {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new TypeError('Expected a BufferSource');
  };
  const toB64 = (source) => {
    const view = bytes(source);
    let text = '';
    for (let i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (text) => {
    const clean = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  };
  const fail = (name) => new DOMException(
    name === 'NotAllowedError' ? 'The operation either timed out or was not allowed.'
      : name === 'InvalidStateError' ? 'The authenticator already holds a credential for this account.'
      : name === 'SecurityError' ? 'This site may not use that relying party ID.'
      : name === 'AbortError' ? 'The operation was aborted.' : 'The request is not supported.', name);

  function createPayload(pk) {
    return {
      rp: { id: pk.rp && pk.rp.id, name: pk.rp && pk.rp.name },
      user: { id: toB64(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: toB64(pk.challenge),
      pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg })),
      excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ type: c.type, id: toB64(c.id) })),
      authenticatorSelection: pk.authenticatorSelection ? {
        authenticatorAttachment: pk.authenticatorSelection.authenticatorAttachment,
        residentKey: pk.authenticatorSelection.residentKey,
        requireResidentKey: pk.authenticatorSelection.requireResidentKey,
        userVerification: pk.authenticatorSelection.userVerification,
      } : undefined,
      extensions: { credProps: !!(pk.extensions && pk.extensions.credProps) },
      timeout: pk.timeout,
    };
  }

  function getPayload(pk) {
    return {
      rpId: pk.rpId,
      challenge: toB64(pk.challenge),
      allowCredentials: (pk.allowCredentials || []).map((c) => ({ type: c.type, id: toB64(c.id) })),
      userVerification: pk.userVerification,
      timeout: pk.timeout,
    };
  }

  function credential(r, created) {
    const raw = {
      clientDataJSON: fromB64(r.clientDataJSON),
    };
    let response;
    if (created) {
      response = {
        clientDataJSON: raw.clientDataJSON,
        attestationObject: fromB64(r.attestationObject),
        getTransports: () => r.transports.slice(),
        getAuthenticatorData: () => fromB64(r.authenticatorData),
        getPublicKey: () => fromB64(r.publicKey),
        getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      };
      if (window.AuthenticatorAttestationResponse) Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype);
    } else {
      response = {
        clientDataJSON: raw.clientDataJSON,
        authenticatorData: fromB64(r.authenticatorData),
        signature: fromB64(r.signature),
        userHandle: r.userHandle ? fromB64(r.userHandle) : null,
      };
      if (window.AuthenticatorAssertionResponse) Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype);
    }
    const json = () => ({
      id: r.id,
      rawId: r.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: created
        ? { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData,
            transports: r.transports.slice(), publicKey: r.publicKey, publicKeyAlgorithm: r.publicKeyAlgorithm }
        : { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || undefined },
      clientExtensionResults: JSON.parse(JSON.stringify(r.extensions || {})),
    });
    const out = {
      id: r.id,
      rawId: fromB64(r.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => JSON.parse(JSON.stringify(r.extensions || {})),
      toJSON: json,
    };
    if (window.PublicKeyCredential) Object.setPrototypeOf(out, PublicKeyCredential.prototype);
    return out;
  }

  /** Run one request through main, honouring the page's AbortSignal. */
  function ask(op, payload, signal) {
    const id = ++counter;
    if (signal && signal.aborted) return Promise.reject(fail('AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => { bridge('abort', { id }); reject(fail('AbortError')); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(bridge(op, { ...payload, id })).then((answer) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(answer || { fallback: true });
      }, () => resolve({ fallback: true }));
    });
  }

  /**
   * The browser's own WebAuthn: security keys, phones, system passkeys. Under
   * a probe it is closed - it opens a Windows Security window on the screen.
   */
  const system = (target, self, args) => (closed ? Promise.reject(fail('NotAllowedError')) : Reflect.apply(target, self, args));

  /** Replace a method while keeping it looking like the browser's own. */
  const replace = (name, native, handler) => {
    const wrapped = new Proxy(native, { apply: (target, self, args) => handler.call(self, args, target) });
    Object.defineProperty(wrapped, '__static', { value: true });
    Object.defineProperty(container, name, { value: wrapped, writable: true, configurable: true, enumerable: true });
  };

  replace('create', nativeCreate, async function (args, native) {
    const options = args[0];
    if (!options || !options.publicKey) return Reflect.apply(native, this, args);
    let payload;
    try { payload = createPayload(options.publicKey); } catch (error) { return system(native, this, args); }
    const answer = await ask('create', { options: payload }, options.signal);
    if (answer.fallback) return system(native, this, args);
    if (answer.error) throw fail(answer.error);
    return credential(answer.credential, true);
  });

  replace('get', nativeGet, async function (args, native) {
    const options = args[0] || {};
    if (options.publicKey) {
      let payload;
      try { payload = getPayload(options.publicKey); } catch (error) { return system(native, this, args); }
      const answer = await ask('get', { options: payload, mediation: options.mediation || 'optional' }, options.signal);
      if (answer.fallback) return system(native, this, args);
      if (answer.error) throw fail(answer.error);
      return credential(answer.credential, false);
    }
    if (options.password) {
      const answer = await ask('password-get', { mediation: options.mediation || 'optional' }, options.signal);
      if (answer.credential && window.PasswordCredential) {
        return new PasswordCredential({ id: answer.credential.id, password: answer.credential.password, name: answer.credential.name || '' });
      }
      if (!answer.fallback) return null;
    }
    return Reflect.apply(native, this, args);
  });

  if (nativeStore) {
    replace('store', nativeStore, async function (args, native) {
      const cred = args[0];
      if (cred && cred.type === 'password' && typeof cred.password === 'string') {
        await ask('password-store', { id: String(cred.id || ''), password: cred.password, name: String(cred.name || '') });
        return cred;
      }
      return Reflect.apply(native, this, args);
    });
  }
  if (nativePrevent) {
    replace('preventSilentAccess', nativePrevent, async function (args, native) {
      await ask('prevent-silent', {});
      try { return await Reflect.apply(native, this, args); } catch { return undefined; }
    });
  }

  // Static is a platform authenticator with a user-verifying method, so the
  // "offer passkeys?" checks sites make must say so.
  if (window.PublicKeyCredential) {
    const yes = (name) => {
      const native = PublicKeyCredential[name];
      if (typeof native !== 'function') return;
      Object.defineProperty(PublicKeyCredential, name, {
        value: new Proxy(native, { apply: () => Promise.resolve(true) }), writable: true, configurable: true,
      });
    };
    yes('isUserVerifyingPlatformAuthenticatorAvailable');
    yes('isConditionalMediationAvailable');
    const capabilities = PublicKeyCredential.getClientCapabilities;
    if (typeof capabilities === 'function') {
      Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', {
        value: new Proxy(capabilities, {
          apply: (target, self, args) => Promise.resolve(Reflect.apply(target, self, args)).catch(() => ({})).then((native) => ({
            ...native, conditionalGet: true, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true,
          })),
        }),
        writable: true, configurable: true,
      });
    }
  }
}

/** Main answers; this side only carries the request. */
function bridge(op, payload) {
  return ipcRenderer.invoke('webauthn:request', { op: String(op), payload }).catch(() => ({ fallback: true }));
}

function start() {
  let answer = false;
  try { answer = ipcRenderer.sendSync('webauthn:enabled'); } catch { /* main decides */ }
  if (answer !== true && answer !== 'probe') return;
  try { contextBridge.executeInMainWorld({ func: install, args: [bridge, answer === 'probe'] }); } catch { /* the browser's own passkeys still work */ }
}

module.exports = { start, install };
