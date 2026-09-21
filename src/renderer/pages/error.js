'use strict';

/**
 * Error page. The tab loads static://error/?code=&desc=&url= when a top-level
 * navigation fails (see features/tabs did-fail-load).
 */
const params = new URLSearchParams(location.search);
const code = params.get('code') || '';
const desc = params.get('desc') || '';
const url = params.get('url') || '';

const FRIENDLY = {
  '-105': ['This site can’t be reached', 'The server’s DNS address could not be found. Check the spelling of the address.'],
  '-102': ['This site can’t be reached', 'The site refused to connect.'],
  '-106': ['No internet', 'Check your network connection and try again.'],
  '-118': ['This site can’t be reached', 'The site took too long to respond.'],
  '-7': ['This site can’t be reached', 'The connection timed out.'],
  '-200': ['Your connection is not private', 'The site’s certificate does not match its name.'],
  '-201': ['Your connection is not private', 'The site’s certificate has expired or is not yet valid.'],
  '-202': ['Your connection is not private', 'The site’s certificate is not trusted.'],
  '-501': ['Your connection is not private', 'The site returned an insecure response.'],
  '-6': ['File not found', 'The file could not be found.'],
  '-20': ['Blocked', 'This request was blocked (possibly by an extension).'],
  '-27': ['Blocked', 'This request was blocked by an extension or client.'],
  crash: ['Aw, snap!', 'Something went wrong while displaying this page.'],
};

const [title, message] = FRIENDLY[code] || ['This site can’t be reached', 'The page could not be loaded.'];
document.getElementById('title').textContent = title;
document.getElementById('msg').textContent = message;
document.getElementById('url').textContent = url;
document.getElementById('code').textContent = desc ? `${desc} (${code})` : code;
document.title = title;

document.getElementById('reload').addEventListener('click', () => {
  if (url) pages.invoke('tabs:navigate', url);
});
