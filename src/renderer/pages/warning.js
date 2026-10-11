'use strict';
(function () {

/**
 * browser://warning - the page shown instead of a dangerous site, a
 * certificate that cannot be trusted, or (in HTTPS-only mode) a site with no
 * secure version.
 *
 * Main keeps what each warning is about under a random token; this page asks
 * for it by that token and can only ever act on that warning, in this tab
 * (features/netguard). Going ahead past a dangerous site takes two deliberate
 * clicks behind Details. Back to safety is the one obvious thing to do.
 */

const { invoke, onState, $, element, timeAgo } = window.page;
const params = new URLSearchParams(location.search);
const token = params.get('id') || '';
const asked = params.get('url') || '';

const SVG = 'http://www.w3.org/2000/svg';

/** The emblem: a shield with a mark, drawn here so it can be large and crisp. */
function emblem(kind) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '40');
  svg.setAttribute('height', '40');
  const path = (d, cls) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    if (cls) p.setAttribute('class', cls);
    svg.append(p);
  };
  path('M32 5 9 13.5v16.8C9 45 19 55.7 32 59c13-3.3 23-14 23-28.7V13.5Z', 'wn-shield');
  if (kind === 'cert' || kind === 'nohttps') {
    path('M24 30v-5a8 8 0 0 1 16 0v5M21.5 30h21v15h-21Z', 'wn-mark');
    path('M32 36v3.5', 'wn-mark');
  } else {
    path('M32 20v16', 'wn-mark');
    path('M32 43.5v.5', 'wn-mark');
  }
  return svg;
}

const longDate = (seconds) => new Date(seconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Everything each kind of warning says. */
function copyFor(info) {
  const host = info.host || '';
  if (info.kind === 'threat') {
    const t = info.threat || {};
    const ledes = {
      malware: 'Opening it could put software on your computer that steals your data or damages your files.',
      phishing: 'It is a known phishing page: it pretends to be a site you trust, such as a bank, a shop or a sign-in page, to get your passwords or card details.',
      badware: 'It has been seen pushing fake downloads, fake virus warnings, scams or software nobody asked for.',
    };
    return {
      tone: 'danger', page: 'Dangerous site ahead', eyebrow: 'Dangerous site ahead · ' + (t.label || 'Threat'),
      title: t.title || 'This site is dangerous',
      lede: ledes[t.kind] || ledes.malware,
      facts: [
        ['Threat', t.label],
        ['Listed on', t.list],
        ['From', t.source],
        ['Matched', t.matched],
        ['Address', info.url],
        info.lists?.fetchedAt ? ['Lists updated', timeAgo(info.lists.fetchedAt)] : null,
      ],
      foot: 'Checked on this computer against ' + (info.lists?.entries ? info.lists.entries.toLocaleString() + ' listed addresses' : 'published threat lists') +
        '. Nothing about your browsing was sent anywhere.',
      risk: 'If you are sure this listing is wrong, you can open ' + host + ' anyway. Static will remember that for this site, and you can undo it from the site card.',
      continueLabel: 'Continue to ' + host,
      confirm: 'Open ' + host + ' even though ' + (t.list || 'a threat list') + ' lists it as ' + String(t.label || 'dangerous').toLowerCase() + '?',
      canProceed: true,
    };
  }
  if (info.kind === 'suspicious') {
    const reasons = (info.assessment?.reasons || []).slice(0, 4);
    return {
      tone: 'danger', page: 'Possible fake site', eyebrow: 'Possible fake site',
      title: 'This site looks like a fake',
      lede: 'Its address imitates a site you may know. Fake sites like this are made to collect passwords and card details.',
      reasons: reasons.map((r) => [r.title, r.detail]),
      facts: [
        ['Address', info.url],
        ['How sure', (info.assessment?.score >= 80 ? 'Very likely fake' : 'Likely fake') + ' · ' + reasons.length + (reasons.length === 1 ? ' sign' : ' signs')],
      ],
      foot: 'Static’s fake-site check looks only at the address, on this computer. Nothing was sent anywhere.',
      risk: 'If this is the site you meant to open, you can go ahead. Static will remember that for ' + host + '.',
      continueLabel: 'Continue to ' + host,
      confirm: 'Open ' + host + '? Only do this if you are sure it is the real site.',
      canProceed: true,
    };
  }
  if (info.kind === 'cert') {
    const c = info.cert || {};
    const cert = c.certificate;
    return {
      tone: 'danger', page: 'Connection not private', eyebrow: 'Connection not private · ' + (c.title || 'Certificate problem'),
      title: 'Your connection to this site is not private',
      lede: (c.detail || 'The connection to this site cannot be verified.') + ' Someone could be trying to read what you send, such as passwords, messages or card details.',
      facts: [
        ['Problem', c.title],
        ['Error', c.code],
        cert ? ['Issued to', cert.subjectName] : null,
        cert ? ['Issued by', [cert.issuerName, cert.issuerOrg].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ')] : null,
        cert && cert.validExpiry ? ['Valid until', longDate(cert.validExpiry)] : null,
        cert && (cert.sha256 || cert.fingerprint) ? ['SHA-256', cert.sha256 || String(cert.fingerprint).replace(/^sha256\//, '')] : null,
        ['Address', info.url],
      ],
      foot: 'This computer could not verify the certificate the site sent, so nothing was loaded from it.',
      risk: c.canProceed
        ? 'If this is your own device or a network you manage, you can go ahead with this exact certificate until Static closes.'
        : 'This certificate cannot be trusted at all, so there is no way to go ahead.',
      continueLabel: c.canProceed ? 'Continue to ' + host + ' (not secure)' : '',
      confirm: 'Open ' + host + ' over a connection that cannot be verified?',
      canProceed: !!c.canProceed,
    };
  }
  if (info.kind === 'nohttps') {
    return {
      tone: 'warn', page: 'Not secure', eyebrow: 'HTTPS-only mode · not secure',
      title: 'This site has no secure version',
      lede: 'Static tried to open it over an encrypted connection, but the site does not offer one. Anyone on your network could see what you send it, or change what it shows you.',
      facts: [
        ['Address', info.url],
        ['Tried', info.url.replace(/^http:/, 'https:')],
        ['Result', 'No working https'],
      ],
      foot: 'HTTPS-only mode asks before any page opens without encryption. You can turn it off in Settings.',
      plain: 'Continue over http',
      canProceed: true,
    };
  }
  return null;
}

/** Exact, machine-made values are set in the monospace face; words are not. */
const EXACT = new Set(['Matched', 'Address', 'Tried', 'Error', 'SHA-256']);

function fact([label, value]) {
  return element('div', { class: EXACT.has(label) ? 'exact' : null }, [element('dt', { text: label }), element('dd', { text: String(value) })]);
}

function render(info) {
  const copy = info ? copyFor(info) : null;
  document.body.dataset.tone = copy?.tone || 'neutral';
  $('#emblem').replaceChildren(emblem(info?.kind));
  if (!copy) {
    // Opened later (a restored tab, a reload an hour on): the warning is gone,
    // and the address is checked again if you try it.
    document.title = 'Warning expired';
    $('#eyebrow').textContent = 'Warning expired';
    $('#title').textContent = 'This warning is no longer current';
    $('#host').textContent = hostOf(asked);
    $('#host-line').hidden = !hostOf(asked);
    $('#lede').textContent = 'Static keeps a warning only while it is fresh. Go back, or try the address again: it will be checked again first.';
    $('#back').textContent = 'Go back';
    $('#details-toggle').hidden = true;
    const again = $('#plain-continue');
    again.hidden = !/^https?:/i.test(asked);
    again.textContent = 'Try again';
    again.onclick = () => invoke('tabs:navigate', { input: asked }).catch(() => {});
    $('#foot').textContent = '';
    return;
  }
  document.title = copy.page;
  $('#eyebrow').textContent = copy.eyebrow;
  $('#title').textContent = copy.title;
  $('#host').textContent = info.host;
  $('#lede').textContent = copy.lede;
  $('#back').textContent = info.kind === 'nohttps' ? 'Go back' : 'Back to safety';

  const reasons = $('#reasons');
  reasons.hidden = !copy.reasons?.length;
  reasons.replaceChildren(...(copy.reasons || []).map(([title, detail]) =>
    element('li', {}, [element('strong', { text: title }), detail ? element('span', { text: detail }) : null])));

  $('#facts').replaceChildren(...copy.facts.filter((row) => row && row[1]).map(fact));
  $('#foot').textContent = copy.foot;

  // HTTPS-only: a plain choice, remembered for the site. Everything else
  // that can be gone past is behind Details, then a second, deliberate step.
  const plain = $('#plain-continue');
  plain.hidden = !copy.plain;
  if (copy.plain) {
    plain.textContent = copy.plain;
    plain.onclick = () => proceed(plain);
  }
  const risk = $('#risk');
  risk.hidden = !copy.risk;
  $('#risk-text').textContent = copy.risk || '';
  const go = $('#continue');
  go.hidden = !copy.canProceed || !copy.continueLabel;
  go.textContent = copy.continueLabel || '';
  $('#confirm-text').textContent = copy.confirm || '';
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function proceed(button) {
  button.disabled = true;
  try {
    const ok = await invoke('netguard:proceed', { id: token, confirmed: true });
    if (!ok) { button.disabled = false; $('#foot').textContent = 'That could not be opened. Go back and try the address again.'; }
  } catch (error) {
    button.disabled = false;
    $('#foot').textContent = error.message;
  }
}

$('#back').addEventListener('click', () => invoke('netguard:back', { id: token }).catch(() => {}));
$('#details-toggle').addEventListener('click', () => {
  const details = $('#details');
  details.hidden = !details.hidden;
  $('#details-toggle').setAttribute('aria-expanded', String(!details.hidden));
  $('#details-toggle').textContent = details.hidden ? 'Details' : 'Hide details';
  if (details.hidden) { $('#confirm').hidden = true; $('#continue').hidden = !$('#continue').textContent; }
});
$('#continue').addEventListener('click', () => {
  $('#continue').hidden = true;
  $('#confirm').hidden = false;
  $('#confirm-no').focus();
});
$('#confirm-no').addEventListener('click', () => {
  $('#confirm').hidden = true;
  $('#continue').hidden = false;
  $('#continue').focus();
});
$('#confirm-yes').addEventListener('click', () => proceed($('#confirm-yes')));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#confirm').hidden) $('#confirm-no').click();
});

onState((state) => {
  document.body.classList.toggle('still', state?.settings?.animations === false);
});

invoke('netguard:interstitial', { id: token })
  .catch(() => null)
  .then((info) => {
    render(info);
    $('#card').hidden = false;
    $('#back').focus();
  });

})();
