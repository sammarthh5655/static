'use strict';

/**
 * Sites, as the web means them: the registrable domain, so mail.google.com
 * and www.google.com are one site and google.co.uk is not "co.uk".
 *
 * Not the whole public suffix list - that is 200 KB and changes weekly - but
 * the second-level suffixes real people's sites sit under. Plain JavaScript
 * with no Node or Electron, because the tab preload uses it too.
 */
const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'nhs.uk', 'police.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in', 'nic.in',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.sg', 'com.my', 'com.ph', 'com.pk', 'com.bd',
  'com.eg', 'com.sa', 'com.ng', 'co.za', 'co.ke', 'co.id', 'co.th', 'co.il', 'com.ua', 'com.vn',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'appspot.com', 'azurewebsites.net',
  'cloudfront.net', 'amazonaws.com', 'weebly.com', 'wixsite.com', 'replit.app', 'translate.goog',
]);

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

/** The registrable domain of a host: news.bbc.co.uk -> bbc.co.uk. */
function siteOf(host) {
  const clean = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!clean || isIp(clean)) return clean;
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const lastTwo = parts.slice(-2).join('.');
  return parts.slice(TWO_LEVEL.has(lastTwo) ? -3 : -2).join('.');
}

/** The site of a URL, or '' when it has none. */
function siteOfUrl(url) {
  try { return siteOf(new URL(url).hostname); } catch { return ''; }
}

/** Do two URLs belong to the same site? Unparseable means no. */
function sameSite(a, b) {
  const one = siteOfUrl(a);
  return !!one && one === siteOfUrl(b);
}

/**
 * Loopback, private-network and .local names: this computer and the network
 * it sits on. Never warned about - no public list can know them - and never
 * upgraded to https.
 */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h.endsWith('.lan') || h.endsWith('.home.arpa') ||
    h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^0\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^(fc|fd)[0-9a-f]{2}:/.test(h) ||
    (!h.includes('.') && !h.includes(':'));
}

/**
 * A bare IP address. Public ones are still checked against the threat lists
 * (malware is often served straight from one), but never upgraded: an IP
 * almost never has a certificate that names it.
 */
function isIpAddress(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

module.exports = { siteOf, siteOfUrl, sameSite, isLocalHost, isIpAddress, TWO_LEVEL };
