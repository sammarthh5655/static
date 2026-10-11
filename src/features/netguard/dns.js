'use strict';

/**
 * Secure DNS: which resolver Chromium asks, and how.
 *
 * Off        the computer's own resolver, in the clear, as it always was.
 * Automatic  Chromium's default: if the resolver the computer already uses
 *            also speaks DNS-over-HTTPS (Cloudflare, Google, Quad9 and the
 *            other well-known ones do), the same provider is asked over an
 *            encrypted connection instead. Anything else stays as it is, so
 *            nothing can break.
 * Secure     always one provider, always encrypted. If that provider cannot
 *            be reached, pages do not load - there is no quiet fallback to
 *            plain DNS, which is the point and the trade-off.
 *
 * Templates are the ones Chromium itself ships for these providers
 * (net/dns/public/doh_provider_entry.cc), so they are known to work with its
 * resolver.
 */
const PROVIDERS = {
  cloudflare: { id: 'cloudflare', name: 'Cloudflare', template: 'https://chrome.cloudflare-dns.com/dns-query' },
  google: { id: 'google', name: 'Google', template: 'https://dns.google/dns-query{?dns}' },
  quad9: { id: 'quad9', name: 'Quad9', template: 'https://dns.quad9.net/dns-query' },
  nextdns: { id: 'nextdns', name: 'NextDNS', template: 'https://chromium.dns.nextdns.io' },
};

const MODES = ['off', 'automatic', 'secure'];

/**
 * A DNS-over-HTTPS template someone typed, cleaned - or '' when it is not one.
 *
 * Only https: anything else would send every lookup in the clear to wherever
 * it pointed. No user name or password (a template is shown in Settings and
 * must not carry a secret), no fragment, and the only variable allowed is
 * RFC 8484's `{?dns}`, so a typo cannot become a template Chromium rejects.
 */
function normaliseTemplate(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 512) return '';
  const bare = text.replace(/\{\?dns\}$/, '');
  if (/[{}\s]/.test(bare)) return '';
  let url;
  try { url = new URL(bare); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) return '';
  // A host must look like one: a name with a dot, or a bracketed IPv6.
  if (!/\./.test(url.hostname) && !url.hostname.startsWith('[')) return '';
  return url.href + (text.endsWith('{?dns}') ? '{?dns}' : '');
}

/**
 * What app.configureHostResolver is given for these settings. Secure with no
 * usable template (a custom one that was never filled in) falls back to
 * Automatic rather than to a mode that resolves nothing at all.
 */
function resolverConfig(settings) {
  const mode = MODES.includes(settings?.secureDns) ? settings.secureDns : 'automatic';
  if (mode !== 'secure') return { secureDnsMode: mode, secureDnsServers: [] };
  const provider = settings.secureDnsProvider === 'custom'
    ? normaliseTemplate(settings.secureDnsCustom)
    : PROVIDERS[settings.secureDnsProvider]?.template || PROVIDERS.cloudflare.template;
  if (!provider) return { secureDnsMode: 'automatic', secureDnsServers: [] };
  return { secureDnsMode: 'secure', secureDnsServers: [provider] };
}

module.exports = { PROVIDERS, MODES, normaliseTemplate, resolverConfig };
