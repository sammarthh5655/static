const CATEGORIES = ['Work', 'Study', 'Coding', 'Shopping', 'Legal', 'Research', 'Entertainment', 'Social', 'Finance', 'Travel'];
const COLORS = ['#47baff', '#a78bfa', '#52d6b1', '#f4ba62', '#a6b8f5', '#7ac8e4', '#e799cd', '#ed9393', '#9fc674', '#ddaa79'];
const RULES = [
  ['Legal', /indiankanoon|sci\.gov|judgment|judgement|supremecourt|legal|court|\.pdf(?:\W|$)/i],
  ['Coding', /github|gitlab|stackoverflow|developer\.|developer docs|javascript|python|programming|api reference|npmjs|codepen/i],
  ['Shopping', /amazon\.|flipkart|ebay|myntra|shopping|buy |product|checkout|cart|warranty/i],
  ['Study', /wikipedia|khanacademy|coursera|edx\.|udemy|tutorial|lesson|study|textbook|lecture|education/i],
  ['Finance', /bank|finance|invest|stock|trading|moneycontrol|zerodha|groww|bloomberg/i],
  ['Travel', /travel|tripadvisor|booking\.|airbnb|flight|hotel|makemytrip|irctc/i],
  ['Social', /instagram|facebook|twitter|(?:\/\/)x\.com|reddit|snapchat|discord|whatsapp|linkedin/i],
  ['Entertainment', /youtube|netflix|twitch|spotify|music|movie|gaming|gameplay/i],
  ['Work', /mail\.|outlook|notion|slack|teams\.|trello|asana|docs\.google|office\.|calendar/i],
];
function webURL(value) { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } }
function signature(tabs) { return JSON.stringify(tabs.filter(t => webURL(t.url)).map(t => [t.id, t.url, t.title]).sort()); }
function analyze(tabs, now = Date.now()) {
  const web = tabs.filter(t => webURL(t.url));
  const groups = new Map(), urls = new Map(), domains = new Map();
  for (const tab of web) {
    const u = webURL(tab.url), text = tab.title + ' ' + u.hostname + u.pathname;
    const category = RULES.find(([, pattern]) => pattern.test(text))?.[0] || 'Research';
    if (!groups.has(category)) groups.set(category, { name: category, category, color: COLORS[CATEGORIES.indexOf(category)], ids: [] });
    groups.get(category).ids.push(tab.id);
    // Keep query strings and fragments: different searches or documents are not duplicates.
    if (!urls.has(u.href)) urls.set(u.href, []);
    urls.get(u.href).push(tab);
    if (!domains.has(u.hostname)) domains.set(u.hostname, []);
    domains.get(u.hostname).push(tab.id);
  }
  const duplicates = [...urls.values()].filter(items => items.length > 1).map(items => {
    items.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.pinned) - Number(a.pinned) || b.lastActiveAt - a.lastActiveAt);
    return { keep: items[0].id, ids: items.slice(1).map(t => t.id), url: items[0].url };
  });
  return { source: 'local', signature: signature(tabs), analyzedAt: now, groups: [...groups.values()], duplicates,
    sameDomain: [...domains].filter(([, ids]) => ids.length > 1).map(([domain, ids]) => ({ domain, ids })),
    inactive: web.filter(t => !t.active && !t.pinned && now - t.lastActiveAt >= 30 * 60000).map(t => t.id),
    heavy: web.filter(t => t.memoryMb >= 350).map(t => t.id) };
}
function aiMetadata(tabs) { return tabs.filter(t => webURL(t.url)).slice(0, 200).map(t => ({ id: t.id, title: String(t.title).replace(/[\x00-\x1f]/g, ' ').slice(0, 160), domain: webURL(t.url).hostname })); }
function parseGroups(text, tabs, fallback) {
  const parsed = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(parsed.groups) || parsed.groups.length > 30) throw new Error('Invalid group response.');
  const valid = new Set(aiMetadata(tabs).map(t => t.id)), seen = new Set(), groups = [];
  for (const item of parsed.groups) {
    if (!item || !Array.isArray(item.ids)) continue;
    const ids = item.ids.filter(id => valid.has(id) && !seen.has(id) && seen.add(id));
    if (!ids.length) continue;
    const category = CATEGORIES.includes(item.category) ? item.category : 'Research';
    const name = String(item.name || category).replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60) || category;
    groups.push({ name, category, color: COLORS[CATEGORIES.indexOf(category)], ids });
  }
  if (!groups.length) throw new Error('No usable groups returned.');
  for (const group of fallback) { const ids = group.ids.filter(id => !seen.has(id)); if (ids.length) groups.push({ ...group, ids }); }
  return groups;
}
module.exports = { CATEGORIES, COLORS, webURL, signature, analyze, aiMetadata, parseGroups };
