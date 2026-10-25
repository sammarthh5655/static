'use strict';
(function () {
/**
 * The vault's lock: the lock screen, the master password and device-unlock
 * settings, and the passkeys list.
 *
 * Nothing secret passes through here except what the person types into a
 * master-password box, which goes straight to main and is not kept.
 */
const { invoke, element, icon, favicon, timeAgo } = window.page;

let lock = { hasMaster: false, locked: false, deviceUnlock: false, lockAfter: 15, lockAfterChoices: [], device: {} };
let passkeys = [];
let open = '';          // which master-password form is showing: '', 'set', 'change', 'remove'
let notice = '';
let armed = null;       // passkey id waiting for a second click to delete

const LOCK_NAMES = { 1: '1 min', 5: '5 min', 15: '15 min', 60: '1 hour', 240: '4 hours', 0: 'When Static closes' };

const errorText = (error) => String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function padlock() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'pv-padlock');
  svg.innerHTML = '<defs><linearGradient id="pv-lock-fill" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" class="pv-stop-a"/><stop offset="1" class="pv-stop-b"/></linearGradient></defs>'
    + '<path class="pv-shackle" d="M20 29 V20 a12 12 0 0 1 24 0 V29"/>'
    + '<rect class="pv-body" x="12" y="28" width="40" height="30" rx="8" fill="url(#pv-lock-fill)"/>'
    + '<circle class="pv-keyhole" cx="32" cy="41" r="4"/><path class="pv-keyhole" d="M30.5 43 h3 l1 7 h-5 z"/>';
  return svg;
}

/* ---- lock screen ------------------------------------------------------------ */

function lockScreen(counts, onUnlocked) {
  const root = element('section', { class: 'pv-lock' });
  const error = element('p', { class: 'pv-lock-error', role: 'alert' });
  const input = element('input', { type: 'password', placeholder: 'Master password', autocomplete: 'current-password', 'aria-label': 'Master password' });
  const go = element('button', { type: 'submit', class: 'pv-lock-go', text: 'Unlock' });
  const emblem = element('div', { class: 'pv-lock-emblem' }, [element('span', { class: 'pv-lock-halo' }), padlock()]);
  const opened = async () => {
    root.classList.add('is-opening');
    setTimeout(onUnlocked, 650);
  };
  const form = element('form', { class: 'pv-lock-form' }, [icon('key', { size: 16 }), input, go]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value || go.disabled) return;
    go.disabled = true;
    go.textContent = 'Checking…';
    error.textContent = '';
    const result = await invoke('passwords:unlock', { password: input.value }).catch((e) => ({ ok: false, error: errorText(e) }));
    go.disabled = false;
    go.textContent = 'Unlock';
    if (result?.ok) { input.value = ''; return opened(); }
    error.textContent = result?.error || 'That did not work.';
    form.classList.remove('is-wrong');
    void form.offsetWidth;
    form.classList.add('is-wrong');
    input.select();
  });

  const device = lock.deviceUnlock && lock.device?.available
    ? element('button', { type: 'button', class: 'pv-lock-device' }, [icon('user', { size: 16 }), 'Unlock with ' + lock.device.label])
    : null;
  device?.addEventListener('click', async () => {
    device.disabled = true;
    error.textContent = '';
    const result = await invoke('passwords:unlock-device').catch((e) => ({ ok: false, error: errorText(e) }));
    device.disabled = false;
    if (result?.ok) return opened();
    error.textContent = result?.error || 'That did not work.';
  });

  const bits = [
    counts.count ? counts.count + (counts.count === 1 ? ' login' : ' logins') : '',
    counts.passkeys ? counts.passkeys + (counts.passkeys === 1 ? ' passkey' : ' passkeys') : '',
    lock.lockAfter ? 'locks after ' + LOCK_NAMES[lock.lockAfter] + ' unused' : 'locks when Static closes',
  ].filter(Boolean);

  const forgot = element('button', { type: 'button', class: 'pv-lock-forgot', text: 'Forgot your master password?' });
  forgot.addEventListener('click', () => {
    const view = forgotScreen(onUnlocked, () => { view.replaceWith(root); setTimeout(() => input.focus(), 40); });
    root.replaceWith(view);
  });

  root.append(...[
    element('div', { class: 'pv-lock-aura', 'aria-hidden': 'true' }),
    emblem,
    element('h2', { class: 'pv-lock-title', text: 'Your passwords are locked' }),
    element('p', { class: 'pv-lock-sub', text: 'Enter your master password to see and fill them. New logins can still be saved while locked.' }),
    form,
    error,
    device,
    forgot,
    element('p', { class: 'pv-lock-meta', text: bits.join(' · ') }),
  ].filter(Boolean));
  setTimeout(() => input.focus(), 60);
  return root;
}

/* ---- security settings ----------------------------------------------------- */

function passwordForm(kind, redraw) {
  const fields = kind === 'set'
    ? [['next', 'New master password', 'new-password'], ['confirm', 'Type it again', 'new-password']]
    : kind === 'change'
      ? [['current', 'Current master password', 'current-password'], ['next', 'New master password', 'new-password'], ['confirm', 'Type the new one again', 'new-password']]
      : [['current', 'Master password', 'current-password']];
  const inputs = {};
  const grid = element('div', { class: 'pv-form-grid' }, fields.map(([key, label, autocomplete]) => {
    inputs[key] = element('input', { type: 'password', autocomplete });
    return element('label', { class: 'pw-field' }, [element('span', { text: label }), inputs[key]]);
  }));
  const meter = element('div', { class: 'pv-meter' }, [element('span')]);
  const meterText = element('span', { class: 'pv-meter-text' });
  if (inputs.next) {
    inputs.next.addEventListener('input', () => {
      const score = strength(inputs.next.value);
      meter.dataset.score = String(score);
      meter.firstChild.style.width = (score * 25) + '%';
      meterText.textContent = ['', 'Too easy to guess', 'Could be stronger', 'Good', 'Strong'][score];
    });
  }
  const error = element('p', { class: 'pw-error' });
  const labels = { set: 'Turn on master password', change: 'Change master password', remove: 'Turn off master password' };
  const submit = element('button', { type: 'submit', class: 'pill selected' + (kind === 'remove' ? ' danger-fill' : ''), text: labels[kind] });
  const form = element('form', { class: 'pv-form' }, [
    kind === 'remove'
      ? element('p', { class: 'muted', text: 'Your saved passwords and passkeys stay; they go back to being protected by your computer’s own encryption only.' })
      : element('p', { class: 'muted', text: 'Pick something you will remember. After it is set, make a recovery key below and keep it somewhere safe - that is your way back in if you ever forget this password.' }),
    grid,
    inputs.next ? element('div', { class: 'pv-meter-row' }, [meter, meterText]) : null,
    error,
    element('div', { class: 'pw-row' }, [submit, element('button', { type: 'button', class: 'pill', text: 'Cancel', onclick: () => { open = ''; redraw(); } })]),
  ].filter(Boolean));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    if (inputs.confirm && inputs.confirm.value !== inputs.next.value) { error.textContent = 'The two new passwords are not the same.'; return; }
    if (inputs.next && strength(inputs.next.value) < 2) { error.textContent = 'Make it longer - at least 8 characters, ideally a few words.'; return; }
    submit.disabled = true;
    const channel = { set: 'passwords:set-master', change: 'passwords:change-master', remove: 'passwords:remove-master' }[kind];
    const result = await invoke(channel, { password: inputs.next?.value, current: inputs.current?.value, next: inputs.next?.value })
      .catch((e) => ({ ok: false, error: errorText(e) }));
    submit.disabled = false;
    if (!result?.ok) { error.textContent = result?.error || 'That did not work.'; return; }
    open = '';
    await load();
    notice = { set: 'Master password is on. Your vault now locks itself.', change: 'Master password changed.', remove: 'Master password is off.' }[kind];
    redraw();
  });
  setTimeout(() => (inputs.current || inputs.next).focus(), 30);
  return form;
}

/** 0-4, from length and variety. Deliberately simple and explained, not magic. */
function strength(value) {
  const text = String(value || '');
  if (text.length < 8) return text ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((r) => r.test(text)).length;
  if (text.length >= 16 || (text.length >= 12 && classes >= 3)) return 4;
  if (text.length >= 10 && classes >= 2) return 3;
  return 2;
}

function securityCard(redraw) {
  const device = lock.device || {};
  const status = element('span', { class: 'pv-chip' + (lock.hasMaster ? ' is-on' : '') }, [
    element('span', { class: 'pv-chip-dot' }), lock.hasMaster ? 'On' : 'Off',
  ]);
  const actions = lock.hasMaster
    ? [
        element('button', { type: 'button', class: 'pill', text: 'Change', onclick: () => { open = open === 'change' ? '' : 'change'; notice = ''; redraw(); } }),
        element('button', { type: 'button', class: 'pill', text: 'Turn off', onclick: () => { open = open === 'remove' ? '' : 'remove'; notice = ''; redraw(); } }),
      ]
    : [element('button', { type: 'button', class: 'pill selected', text: 'Set up', onclick: () => { open = open === 'set' ? '' : 'set'; notice = ''; redraw(); } })];

  const deviceOn = lock.deviceUnlock;
  const deviceBlocked = !lock.hasMaster ? 'Set a master password first - it stays your way back in.' : !device.available ? device.reason : '';
  const deviceSwitch = element('button', {
    type: 'button', role: 'switch', class: 'pw-toggle pv-device', 'aria-checked': String(deviceOn),
    disabled: deviceBlocked && !deviceOn ? '' : null,
  }, [
    element('span', { class: 'pv-device-icon' }, [icon('user', { size: 18 })]),
    element('span', { class: 'pw-toggle-text' }, [
      element('strong', { text: 'Unlock with ' + (device.label || 'your face or fingerprint') }),
      element('span', { text: deviceBlocked || 'Face, fingerprint or ' + (device.label === 'Windows Hello' ? 'Windows Hello PIN' : 'Touch ID') + ' instead of typing your master password.' }),
    ]),
    element('span', { class: 'pw-switch', 'aria-hidden': 'true' }),
  ]);
  const deviceError = element('p', { class: 'pw-error' });
  deviceSwitch.addEventListener('click', async () => {
    deviceSwitch.disabled = true;
    const result = await invoke('passwords:device', { enabled: !deviceOn }).catch((e) => ({ ok: false, error: errorText(e) }));
    deviceSwitch.disabled = false;
    if (!result?.ok) { deviceError.textContent = result?.error || 'That did not work.'; return; }
    await load();
    redraw();
  });

  const choices = element('div', { class: 'pv-seg', role: 'radiogroup', 'aria-label': 'Lock after' }, (lock.lockAfterChoices || []).map((minutes) => element('button', {
    type: 'button', role: 'radio', 'aria-checked': String(lock.lockAfter === minutes),
    class: 'pv-seg-btn' + (lock.lockAfter === minutes ? ' is-active' : ''), text: LOCK_NAMES[minutes] || minutes + ' min',
    disabled: lock.hasMaster ? null : '',
    onclick: async () => { await invoke('passwords:lock-after', { minutes }); await load(); redraw(); },
  })));

  return element('div', { class: 'panel-card pv-security' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('lock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Security' }),
      lock.hasMaster ? element('button', { type: 'button', class: 'pill', text: 'Lock now', onclick: async () => { await invoke('passwords:lock'); } }) : null,
    ].filter(Boolean)),
    element('div', { class: 'pv-master' }, [
      element('div', { class: 'pv-master-glyph' }, [padlock()]),
      element('div', { class: 'pv-master-text' }, [
        element('div', { class: 'pv-master-title' }, [element('strong', { text: 'Master password' }), status]),
        element('p', { class: 'muted', text: lock.hasMaster
          ? 'Your passwords and passkeys are sealed with a key only your master password opens - not even something running as you on this computer can read them while the vault is locked.'
          : 'Adds a second lock on top of your computer’s encryption: Static asks for it before showing or filling a password, and locks again on its own.' }),
      ]),
      element('div', { class: 'pv-master-actions' }, actions),
    ]),
    open ? passwordForm(open, redraw) : null,
    notice ? element('p', { class: 'pw-ok', text: notice }) : null,
    lock.hasMaster ? recoveryControl(redraw) : null,
    deviceSwitch,
    deviceError,
    element('div', { class: 'pv-lockafter' + (lock.hasMaster ? '' : ' is-off') }, [
      element('div', { class: 'pw-toggle-text' }, [
        element('strong', { text: 'Lock after' }),
        element('span', { text: 'Also locks when the computer sleeps or its screen locks.' }),
      ]),
      choices,
    ]),
  ].filter(Boolean));
}

/**
 * The recovery-key control inside the Security card: make or replace the key
 * (shown once, to copy and save), or forget it. It is the honest answer to a
 * forgotten master password - the vault key is wrapped under it too - and
 * needs no account or server.
 */
function recoveryControl(redraw) {
  const shown = element('div', { class: 'pv-recovery-code', hidden: true });
  const error = element('p', { class: 'pw-error' });

  const makeButton = element('button', {
    type: 'button', class: 'pill' + (lock.hasRecovery ? '' : ' selected'),
    text: lock.hasRecovery ? 'Make a new one' : 'Make a recovery key',
  });
  makeButton.addEventListener('click', async () => {
    error.textContent = '';
    makeButton.disabled = true;
    const result = await invoke('passwords:make-recovery').catch((e) => ({ ok: false, error: errorText(e) }));
    makeButton.disabled = false;
    if (!result?.ok) { error.textContent = result?.error || 'That did not work.'; return; }
    const copy = element('button', { type: 'button', class: 'pill', text: 'Copy' });
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(result.code).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    });
    shown.hidden = false;
    shown.replaceChildren(
      element('p', { class: 'muted', text: 'Write this down and keep it safe. It is shown only once, and anyone who has it can reset your master password.' }),
      element('div', { class: 'pv-recovery-row' }, [element('code', { text: result.code }), copy]),
    );
    await load();
    // Redraw the chip/buttons, but keep the code on screen until the user leaves.
    const refreshed = recoveryControl(redraw);
    refreshed.querySelector('.pv-recovery-code').replaceWith(shown);
    control.replaceWith(refreshed);
  });

  const buttons = [makeButton];
  if (lock.hasRecovery) {
    const forget = element('button', { type: 'button', class: 'pill', text: 'Forget it' });
    forget.addEventListener('click', async () => {
      await invoke('passwords:remove-recovery').catch(() => {});
      await load();
      redraw();
    });
    buttons.push(forget);
  }

  const control = element('div', { class: 'pv-recovery' }, [
    element('div', { class: 'pv-recovery-head' }, [
      element('div', {}, [
        element('strong', { text: 'Recovery key' }),
        element('p', { class: 'muted', text: lock.hasRecovery
          ? 'A recovery key is set. Keep your copy safe - it resets your master password if you forget it.'
          : 'A one-time code that resets your master password if you forget it. Make one and keep it somewhere safe.' }),
      ]),
      element('div', { class: 'pw-row' }, buttons),
    ]),
    shown,
    error,
  ]);
  return control;
}

/**
 * The "I forgot my master password" flow, opened from the lock screen. With a
 * recovery key: enter it and a new master password. Without one: the only way
 * on is to clear the vault, which is spelled out and confirmed.
 */
function forgotScreen(onDone, onCancel) {
  const root = element('section', { class: 'pv-forgot' });
  const error = element('p', { class: 'pw-error', role: 'alert' });
  const back = element('button', { type: 'button', class: 'pill', text: 'Back' });
  back.addEventListener('click', onCancel);

  if (lock.hasRecovery) {
    const code = element('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Recovery key' });
    const next = element('input', { type: 'password', placeholder: 'New master password', autocomplete: 'new-password', 'aria-label': 'New master password' });
    const confirm = element('input', { type: 'password', placeholder: 'Type it again', autocomplete: 'new-password', 'aria-label': 'Confirm new master password' });
    const go = element('button', { type: 'submit', class: 'pv-lock-go', text: 'Reset master password' });
    const form = element('form', { class: 'pv-forgot-form' }, [
      element('label', { class: 'pw-field' }, [element('span', { text: 'Recovery key' }), code]),
      element('label', { class: 'pw-field' }, [element('span', { text: 'New master password' }), next]),
      element('label', { class: 'pw-field' }, [element('span', { text: 'Type it again' }), confirm]),
      error,
      element('div', { class: 'pw-row' }, [go, back]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      if (next.value !== confirm.value) { error.textContent = 'The two new passwords are not the same.'; return; }
      if (strength(next.value) < 2) { error.textContent = 'Make the new password at least 8 characters.'; return; }
      go.disabled = true;
      const result = await invoke('passwords:reset-recovery', { code: code.value, next: next.value }).catch((e) => ({ ok: false, error: errorText(e) }));
      go.disabled = false;
      if (!result?.ok) { error.textContent = result?.error || 'That did not work.'; code.select(); return; }
      await load();
      onDone();
    });
    root.append(
      element('h2', { class: 'pv-lock-title', text: 'Reset your master password' }),
      element('p', { class: 'pv-lock-sub', text: 'Enter the recovery key you saved, and choose a new master password. Your logins and passkeys are kept.' }),
      form,
    );
    setTimeout(() => code.focus(), 40);
  } else {
    const go = element('button', { type: 'button', class: 'pv-lock-go danger-fill', text: 'Clear the vault and start over' });
    let armed = false;
    go.addEventListener('click', async () => {
      if (!armed) { armed = true; go.textContent = 'Click again to erase everything'; return; }
      await invoke('passwords:reset-vault').catch(() => {});
      await load();
      onDone();
    });
    root.append(
      element('h2', { class: 'pv-lock-title', text: 'No recovery key was set' }),
      element('p', { class: 'pv-lock-sub', text: 'Your saved passwords are sealed with a key only your master password opens. Without it, and without a recovery key, they genuinely cannot be read - not by Static, not by anyone.' }),
      element('p', { class: 'pv-lock-sub', text: 'The only way forward is to clear the vault and start again. Everything saved will be lost. Next time, make a recovery key in Security so this cannot happen.' }),
      element('div', { class: 'pw-row' }, [go, back]),
      error,
    );
  }
  return root;
}

/* ---- passkeys ----------------------------------------------------------------- */

function passkeysCard(redraw) {
  const rows = passkeys.map((passkey) => {
    const confirming = armed === passkey.id;
    const remove = element('button', { type: 'button', class: 'pill' + (confirming ? ' danger-fill' : ' danger'), text: confirming ? 'Delete for good' : 'Delete' });
    remove.addEventListener('click', async () => {
      if (!confirming) { armed = passkey.id; redraw(); setTimeout(() => { if (armed === passkey.id) { armed = null; redraw(); } }, 4000); return; }
      armed = null;
      await invoke('passwords:remove-passkey', { id: passkey.id });
      await load();
      redraw();
    });
    return element('div', { class: 'pv-passkey' }, [
      favicon('https://' + passkey.rpId, 20),
      element('div', { class: 'pv-passkey-text' }, [
        element('strong', { text: passkey.rpId }),
        element('span', { text: [passkey.userName || passkey.displayName || 'Account', 'created ' + timeAgo(passkey.createdAt),
          passkey.lastUsed ? 'used ' + timeAgo(passkey.lastUsed) : 'not used yet'].join(' · ') }),
      ]),
      confirming ? element('span', { class: 'pv-passkey-warn', text: 'The site will not accept it again.' }) : null,
      remove,
    ].filter(Boolean));
  });
  return element('div', { class: 'panel-card pv-passkeys' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('key', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Passkeys' }),
      element('span', { class: 'pv-count', text: String(passkeys.length) }),
    ]),
    ...(rows.length ? rows : [element('div', { class: 'pv-empty' }, [
      element('p', { text: 'No passkeys yet.' }),
      element('p', { class: 'muted', text: 'When a site offers “Create a passkey”, Static keeps it here, sealed like a password. Next time you sign in with ' + (lock.device?.label || 'your fingerprint or face') + ' - no password to type, and nothing a fake site can steal.' }),
    ])]),
  ]);
}

async function load() {
  const [state, list] = await Promise.all([
    invoke('passwords:lock-state').catch(() => lock),
    invoke('passwords:passkeys').catch(() => []),
  ]);
  // A notice about the master password is stale once it changes some other way.
  if (state && state.hasMaster !== lock.hasMaster) notice = '';
  lock = state || lock;
  passkeys = list || [];
  return lock;
}

window.passwordSecurity = { load, lockScreen, securityCard, passkeysCard, get state() { return lock; } };
})();
