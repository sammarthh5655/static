'use strict';
(function () {

/**
 * Settings > Privacy & Security: the network protection block - Safe
 * Browsing, secure connections and tracking protection (features/netguard).
 *
 * Every control writes one setting and main pushes the result back, so what
 * is drawn is always what is in force. The tracking protection level is read
 * from the switches, never stored: change one by hand and it says Custom.
 */

const { invoke, onState, $, timeAgo } = window.page;

let applying = false;
let latest = {};

function update(patch, onError) {
  if (applying) return Promise.resolve();
  return invoke('settings:update', patch).catch((error) => {
    if (onError) onError(error);
    else $('#settings-status').textContent = error.message;
  });
}

// ---- Safe Browsing -------------------------------------------------------
for (const radio of document.querySelectorAll('input[name="net-safe"]')) {
  radio.addEventListener('change', () => { if (radio.checked) update({ safeBrowsing: radio.value }); });
}
$('#net-lists-refresh').addEventListener('click', async () => {
  const button = $('#net-lists-refresh');
  button.disabled = true;
  $('#net-lists').textContent = 'Downloading the threat lists…';
  try {
    const result = await invoke('netguard:refresh');
    if (result && result.ok === false && !result.fetched) $('#net-lists').textContent = 'The lists could not be downloaded. The ones already on this computer are still in use.';
  } catch (error) {
    $('#net-lists').textContent = error.message;
  }
  button.disabled = false;
  paint();
});
$('#net-forget').addEventListener('click', () => invoke('netguard:forget', { all: true }).catch(() => {}));

// ---- Secure connections --------------------------------------------------
$('#net-httpsOnly').addEventListener('change', (event) => update({ httpsOnly: event.target.checked }));
$('#net-secureDns').addEventListener('change', (event) => update({ secureDns: event.target.value }));
$('#net-dnsProvider').addEventListener('change', (event) => {
  const provider = event.target.value;
  // Custom with nothing typed yet: show the box first, apply once it is filled.
  $('#net-custom-field').hidden = provider !== 'custom';
  if (provider === 'custom' && !latest.secureDnsCustom) { $('#net-dnsCustom').focus(); return; }
  update({ secureDnsProvider: provider });
});
const custom = $('#net-dnsCustom');
const customHint = 'A DNS-over-HTTPS address, such as https://dns.example.com/dns-query';
custom.addEventListener('change', () => {
  const value = custom.value.trim();
  $('#net-custom-hint').textContent = customHint;
  $('#net-custom-hint').classList.remove('net-error');
  update(value ? { secureDnsCustom: value, secureDnsProvider: 'custom' } : { secureDnsCustom: '' }, (error) => {
    $('#net-custom-hint').textContent = error.message;
    $('#net-custom-hint').classList.add('net-error');
  });
});
custom.addEventListener('keydown', (event) => { if (event.key === 'Enter') custom.blur(); });

// ---- Tracking protection -------------------------------------------------
for (const radio of document.querySelectorAll('input[name="net-level"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked || radio.value === 'custom' || applying) return;
    invoke('netguard:level', { level: radio.value }).catch((error) => { $('#settings-status').textContent = error.message; });
  });
}
for (const key of ['bounceTracking', 'ampSkip', 'gpc', 'doNotTrack']) {
  $('#net-' + key).addEventListener('change', (event) => update({ [key]: event.target.checked }));
}
for (const key of ['referrerPolicy', 'webrtcPolicy']) {
  $('#net-' + key).addEventListener('change', (event) => update({ [key]: event.target.value }));
}

// ---- drawing ---------------------------------------------------------------
let net = null;

const DNS_HINTS = {
  automatic: 'Uses an encrypted connection whenever the resolver your computer already uses supports one. Nothing changes where your lookups go.',
  secure: 'Every address is looked up over an encrypted connection to the provider below, so your network cannot see or change them.',
  off: 'Addresses are looked up by your computer’s own resolver, unencrypted. Your network can see every site you look up.',
};
const WEBRTC_HINTS = {
  standard: 'Video calls use only your public connection, so sites cannot learn your local network address.',
  strict: 'Video calls can only go through a proxy or VPN if you use one, so your real address stays hidden. Some calls may not connect.',
  off: 'Video calls can use every network connection this computer has, including its local addresses.',
};

function paint() {
  const s = latest;
  applying = true;
  for (const radio of document.querySelectorAll('input[name="net-safe"]')) radio.checked = radio.value === (s.safeBrowsing || 'standard');
  $('#net-safe-off').hidden = s.safeBrowsing !== 'off';

  $('#net-httpsOnly').checked = s.httpsOnly === true;
  $('#net-secureDns').value = s.secureDns || 'automatic';
  $('#net-dns-hint').textContent = DNS_HINTS[s.secureDns || 'automatic'];
  const secure = s.secureDns === 'secure';
  $('#net-provider-field').hidden = !secure;
  // A provider being chosen (custom, not yet typed) stays as chosen.
  if (document.activeElement !== $('#net-dnsProvider') && !(secure && $('#net-dnsProvider').value === 'custom' && !s.secureDnsCustom)) {
    $('#net-dnsProvider').value = s.secureDnsProvider || 'cloudflare';
  }
  $('#net-custom-field').hidden = !secure || $('#net-dnsProvider').value !== 'custom';
  if (document.activeElement !== custom) custom.value = s.secureDnsCustom || '';

  for (const key of ['bounceTracking', 'ampSkip', 'gpc']) $('#net-' + key).checked = s[key] !== false;
  $('#net-doNotTrack').checked = s.doNotTrack === true;
  $('#net-referrerPolicy').value = s.referrerPolicy || 'standard';
  $('#net-webrtcPolicy').value = s.webrtcPolicy || 'standard';
  $('#net-webrtc-hint').textContent = WEBRTC_HINTS[s.webrtcPolicy || 'standard'];

  if (net) {
    const level = net.level || 'standard';
    for (const radio of document.querySelectorAll('input[name="net-level"]')) radio.checked = radio.value === level;
    document.querySelector('.net-tile-custom').classList.toggle('is-active', level === 'custom');
    for (const option of net.levels || []) {
      const line = $('#net-level-' + option.id);
      if (line) line.textContent = option.summary;
    }
    const threats = net.threats || {};
    const names = (threats.lists || []).map((list) => list.name);
    const entries = threats.entries || 0;
    $('#net-lists').textContent = entries
      ? (names.length ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : 'Threat lists') + ' · ' +
        entries.toLocaleString() + ' dangerous addresses' + (threats.fetchedAt ? ' · updated ' + timeAgo(threats.fetchedAt) : '')
      : 'Not downloaded yet. They download by themselves in the background, or now with Update now.';
    const allowed = (net.allowedSites || []).length + (net.httpAllowed || []).length;
    $('#net-allowed').textContent = allowed
      ? allowed + (allowed === 1 ? ' site you chose to open despite a warning: ' : ' sites you chose to open despite a warning: ') +
        [...(net.allowedSites || []).map((site) => site.host), ...(net.httpAllowed || [])].slice(0, 4).join(', ') + (allowed > 4 ? '…' : '')
      : 'None. Static warns about every listed site.';
    $('#net-forget').disabled = !allowed;
  }
  applying = false;
}

onState((state) => {
  latest = state.settings || {};
  net = state.features?.netguard || net;
  paint();
});

})();
