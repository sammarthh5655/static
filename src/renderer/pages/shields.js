'use strict';

/**
 * browser://shields - the ad manager.
 *
 * What Shields stopped, when, from whom and on which sites, with the switches
 * that govern it. Every figure comes from the blocking pipeline itself
 * (features/shields/stats.js): nothing here is generated for display, and the
 * only derived numbers - data and time saved - are labelled as estimates.
 *
 * Two refresh loops: the statistics every few seconds, and the live feed and
 * open tabs faster, only while the page is visible.
 */
(function () {

const { invoke, onState, element, icon, favicon } = window.page;
const SVG_NS = 'http://www.w3.org/2000/svg';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = { config: {}, rules: 0, lists: [], disabledSites: [] };
let stats = null;
let activity = { recent: [], tabs: [] };
let range = 'today';
let chartMode = 'hours';
let livePaused = false;
let openTab = null;
let firstPaint = true;
let shellApi = null;

const RANGES = [
  { id: 'today', label: 'Today', key: 'today' },
  { id: 'week', label: '7 days', key: 'week' },
  { id: 'month', label: '30 days', key: 'month' },
  { id: 'all', label: 'All time', key: 'allTime' },
];

/** Donut slices, in drawing order. `redirect` and `scriptlet` overlap the others, so they are left out. */
const SLICES = [
  { key: 'ads', label: 'Ads', tone: 'ads' },
  { key: 'trackers', label: 'Trackers', tone: 'trackers' },
  { key: 'videoAds', label: 'Video ads', tone: 'video' },
  { key: 'cookies', label: 'Cookies', tone: 'cookies' },
  { key: 'params', label: 'Tracking links', tone: 'params' },
  { key: 'https', label: 'HTTPS upgrades', tone: 'https' },
];

/* ---- formatting ------------------------------------------------------------ */

const number = (value) => (Number(value) || 0).toLocaleString();

function compact(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  return n.toLocaleString();
}

function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function duration(ms) {
  const exact = (Number(ms) || 0) / 1000;
  if (exact < 10) return (Math.round(exact * 10) / 10) + 's';
  const seconds = Math.round(exact);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + 'h ' + (minutes % 60) + 'm';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

function since(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function clock(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children.filter(Boolean));
  return node;
}

/**
 * A number that counts up to its value. Remembers what it last showed, so a
 * refresh animates from the old figure rather than from zero.
 */
const shown = new Map();
function counter(id, value, format = number) {
  const node = element('span', { class: 'sh-num' });
  const target = Number(value) || 0;
  const from = shown.has(id) ? shown.get(id) : 0;
  shown.set(id, target);
  if (REDUCED || from === target) { node.textContent = format(target); return node; }
  node.textContent = format(from);
  const start = performance.now();
  const span = firstPaint ? 1100 : 600;
  const step = (now) => {
    const t = Math.min(1, (now - start) / span);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = format(Math.round(from + (target - from) * eased));
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return node;
}

/* ---- hero -------------------------------------------------------------------- */

function emblem(on) {
  return element('div', { class: 'sh-emblem' + (on ? ' is-on' : '') }, [
    element('span', { class: 'sh-emblem-ring r1' }),
    element('span', { class: 'sh-emblem-ring r2' }),
    element('span', { class: 'sh-emblem-orbit' }, [element('i'), element('i'), element('i')]),
    svg('svg', { viewBox: '0 0 64 64', class: 'sh-emblem-shield', 'aria-hidden': 'true' }, [
      svg('defs', {}, [
        svg('linearGradient', { id: 'sh-shield-fill', x1: '0', y1: '0', x2: '1', y2: '1' }, [
          svg('stop', { offset: '0', class: 'sh-stop-a' }),
          svg('stop', { offset: '1', class: 'sh-stop-b' }),
        ]),
      ]),
      svg('path', { d: 'M32 5 L54 13 V30 C54 44 44.5 54.5 32 59 C19.5 54.5 10 44 10 30 V13 Z', fill: 'url(#sh-shield-fill)', class: 'sh-shield-body' }),
      svg('path', { d: on ? 'M22 32 L29 39 L43 24' : 'M24 24 L40 40 M40 24 L24 40', class: 'sh-shield-mark' }),
    ]),
  ]);
}

function donut(totals) {
  const values = SLICES.map((slice) => ({ ...slice, value: totals[slice.key] || 0 }));
  const sum = values.reduce((n, slice) => n + slice.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  const ring = svg('svg', { viewBox: '0 0 128 128', class: 'sh-donut-svg', 'aria-hidden': 'true' }, [
    svg('circle', { cx: 64, cy: 64, r: R, class: 'sh-donut-track' }),
  ]);
  let offset = 0;
  const GAP = sum ? 2.2 : 0;
  for (const slice of values) {
    if (!slice.value) continue;
    const length = Math.max(0, (slice.value / sum) * C - GAP);
    const arc = svg('circle', {
      cx: 64, cy: 64, r: R, class: 'sh-donut-arc tone-' + slice.tone,
      'stroke-dasharray': length + ' ' + (C - length),
      'stroke-dashoffset': String(-offset),
    });
    arc.append(svg('title', {}, []));
    arc.lastChild.textContent = slice.label + ': ' + number(slice.value);
    ring.append(arc);
    offset += (slice.value / sum) * C;
  }
  const total = sum;
  return element('div', { class: 'sh-donut' + (firstPaint && !REDUCED ? ' is-entering' : '') }, [
    element('div', { class: 'sh-donut-figure' }, [
      ring,
      element('div', { class: 'sh-donut-center' }, [
        counter('donut-' + range, total, compact),
        element('span', { class: 'sh-donut-caption', text: RANGES.find((r) => r.id === range).label.toLowerCase() }),
      ]),
    ]),
    element('div', { class: 'sh-legend' }, values.map((slice) => element('div', { class: 'sh-legend-row' + (slice.value ? '' : ' is-zero') }, [
      element('span', { class: 'sh-dot tone-' + slice.tone }),
      element('span', { class: 'sh-legend-label', text: slice.label }),
      element('span', { class: 'sh-legend-value', text: compact(slice.value) }),
    ]))),
  ]);
}

function hero() {
  const on = state.config.enabled !== false;
  const life = stats?.lifetime || { blocked: 0, ads: 0, trackers: 0 };
  const all = stats?.allTime || {};
  const current = stats?.[RANGES.find((r) => r.id === range).key] || {};
  return element('section', { class: 'sh-hero' }, [
    element('div', { class: 'sh-hero-aura', 'aria-hidden': 'true' }),
    emblem(on),
    element('div', { class: 'sh-hero-main' }, [
      element('div', { class: 'sh-kicker', text: 'Ad manager' }),
      element('div', { class: 'sh-count' }, [counter('lifetime', life.blocked)]),
      element('div', { class: 'sh-count-label' }, [
        element('span', { text: 'ads and trackers stopped' }),
        stats?.firstDay ? element('span', { class: 'sh-since', text: 'since ' + since(stats.firstDay) }) : null,
      ]),
      element('div', { class: 'sh-split' }, [
        element('span', { class: 'sh-split-part' }, [element('span', { class: 'sh-dot tone-ads' }), counter('life-ads', life.ads), ' ads']),
        element('span', { class: 'sh-split-part' }, [element('span', { class: 'sh-dot tone-trackers' }), counter('life-trackers', life.trackers), ' trackers']),
        life.videoAds ? element('span', { class: 'sh-split-part' }, [element('span', { class: 'sh-dot tone-video' }), counter('life-video', life.videoAds), ' video ads']) : null,
      ]),
      element('div', { class: 'sh-chips' }, [
        element('span', { class: 'sh-chip' + (on ? ' is-on' : ' is-off') }, [element('span', { class: 'sh-chip-pulse' }), on ? 'Protecting' : 'Shields are off']),
        element('span', { class: 'sh-chip', text: compact(state.rules) + ' rules · ' + (state.lists?.length || 0) + ' lists' }),
        all.bytesSaved ? element('span', { class: 'sh-chip', title: 'An estimate: blocked requests never download, so their real size is never known.' },
          ['≈ ' + bytes(all.bytesSaved) + ' and ' + duration(all.msSaved) + ' saved']) : null,
      ]),
    ]),
    donut(current),
  ]);
}

/* ---- range and tiles ----------------------------------------------------------- */

function rangeTabs() {
  return element('div', { class: 'sh-range', role: 'tablist' }, RANGES.map((option) => element('button', {
    class: 'sh-range-tab' + (option.id === range ? ' is-active' : ''),
    role: 'tab', 'aria-selected': String(option.id === range),
    text: option.label,
    onclick: () => { range = option.id; paintStats(); },
  })));
}

function tiles() {
  const t = stats?.[RANGES.find((r) => r.id === range).key] || {};
  const tile = (id, value, label, tone, glyph, format = number, note = '') => element('div', { class: 'sh-tile tone-' + tone }, [
    element('div', { class: 'sh-tile-icon' }, [icon(glyph, { size: 15 })]),
    element('div', { class: 'sh-tile-value' }, [counter(range + '-' + id, value, format)]),
    element('div', { class: 'sh-tile-label' }, [label, note ? element('em', { text: note }) : null]),
  ]);
  return element('div', { class: 'sh-tiles' }, [
    tile('ads', t.ads, 'Ads blocked', 'ads', 'shield'),
    tile('trackers', t.trackers, 'Trackers blocked', 'trackers', 'lock'),
    tile('video', t.videoAds, 'Video ads removed', 'video', 'wave'),
    tile('cookies', t.cookies, 'Third-party cookies', 'cookies', 'close'),
    tile('params', t.params, 'Tracking links cleaned', 'params', 'sparkle'),
    tile('https', t.https, 'Upgraded to HTTPS', 'https', 'check'),
    tile('cosmetic', t.cosmetic, 'Pages de-cluttered', 'cosmetic', 'grid'),
    tile('bytes', t.bytesSaved, 'Data saved', 'saved', 'download', bytes, 'estimate'),
    tile('time', t.msSaved, 'Time saved', 'saved', 'clock', duration, 'estimate'),
  ]);
}

/* ---- chart ----------------------------------------------------------------------- */

function chart() {
  const hours = chartMode === 'hours';
  const points = hours
    ? (stats?.hourly || []).map((p) => ({ label: String(p.at).padStart(2, '0') + ':00', ads: p.ads, trackers: p.trackers, other: p.other }))
    : (stats?.series30 || []).map((p) => ({ label: since(p.day), ads: p.ads, trackers: p.trackers, other: p.other }));
  const peak = Math.max(1, ...points.map((p) => p.ads + p.trackers + p.other));
  const W = 720;
  const H = 180;
  const gap = hours ? 5 : 4;
  const bar = (W - gap * (points.length - 1)) / Math.max(1, points.length);
  const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'sh-chart-svg' + (firstPaint && !REDUCED ? ' is-entering' : '') });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    plot.append(svg('line', { x1: 0, x2: W, y1: H - fraction * H + 0.5, y2: H - fraction * H + 0.5, class: 'sh-grid' }));
  }
  points.forEach((point, index) => {
    const x = index * (bar + gap);
    let y = H;
    const column = svg('g', { class: 'sh-col', style: `--i:${index}` });
    for (const lane of ['trackers', 'ads', 'other']) {
      if (!point[lane]) continue;
      const h = Math.max(1.5, (point[lane] / peak) * (H - 6));
      y -= h;
      column.append(svg('rect', { x, y, width: bar, height: h, rx: Math.min(3, bar / 3), class: 'sh-bar lane-' + lane }));
    }
    if (y === H) column.append(svg('rect', { x, y: H - 2, width: bar, height: 2, rx: 1, class: 'sh-bar lane-quiet' }));
    column.append(svg('rect', { x: x - gap / 2, y: 0, width: bar + gap, height: H, class: 'sh-hit', 'data-index': index }));
    plot.append(column);
  });

  const tip = element('div', { class: 'sh-tip', hidden: '' });
  const frame = element('div', { class: 'sh-chart-frame' }, [plot, tip]);
  frame.addEventListener('mousemove', (event) => {
    const index = Number(event.target?.dataset?.index);
    if (!Number.isFinite(index)) { tip.hidden = true; return; }
    const point = points[index];
    tip.replaceChildren(
      element('strong', { text: point.label }),
      element('span', {}, [element('i', { class: 'sh-dot tone-ads' }), number(point.ads) + ' ads']),
      element('span', {}, [element('i', { class: 'sh-dot tone-trackers' }), number(point.trackers) + ' trackers']),
      point.other ? element('span', {}, [element('i', { class: 'sh-dot tone-other' }), number(point.other) + ' other']) : null,
    );
    tip.hidden = false;
    const box = frame.getBoundingClientRect();
    const x = ((index + 0.5) * (bar + gap) / W) * box.width;
    tip.style.left = Math.min(box.width - 150, Math.max(0, x - 70)) + 'px';
  });
  frame.addEventListener('mouseleave', () => { tip.hidden = true; });

  const every = hours ? 6 : 7;
  const axis = element('div', { class: 'sh-axis' }, points.map((point, index) => element('span', {
    text: index % every === 0 || index === points.length - 1 ? (index === points.length - 1 ? (hours ? 'now' : 'today') : point.label) : '',
  })));
  const total = points.reduce((n, p) => n + p.ads + p.trackers + p.other, 0);

  return card('Activity', 'wave', [
    element('div', { class: 'sh-seg' }, [
      ['hours', '24 hours'], ['days', '30 days'],
    ].map(([id, label]) => element('button', {
      class: 'sh-seg-btn' + (chartMode === id ? ' is-active' : ''), text: label,
      onclick: () => { chartMode = id; paintStats(); },
    }))),
  ], [
    element('div', { class: 'sh-chart-meta' }, [
      element('span', { class: 'sh-chart-total', text: number(total) }),
      element('span', { class: 'muted', text: hours ? ' blocked in the last 24 hours · peak ' + number(peak) + ' in an hour' : ' blocked in the last 30 days · busiest day ' + number(peak) }),
    ]),
    frame,
    axis,
    element('div', { class: 'sh-key' }, [
      element('span', {}, [element('i', { class: 'sh-dot tone-ads' }), 'Ads']),
      element('span', {}, [element('i', { class: 'sh-dot tone-trackers' }), 'Trackers']),
      element('span', {}, [element('i', { class: 'sh-dot tone-other' }), 'Cookies, links and page clean-up']),
    ]),
  ]);
}

/* ---- who and where ----------------------------------------------------------------- */

function card(title, glyph, actions, body, extra = '') {
  return element('section', { class: 'sh-card ' + extra }, [
    element('div', { class: 'sh-card-head' }, [
      element('span', { class: 'sh-card-icon' }, [icon(glyph, { size: 14 })]),
      element('span', { class: 'sh-card-title', text: title }),
      ...actions,
    ]),
    ...body,
  ]);
}

function topHosts() {
  const hosts = stats?.topHosts || [];
  const peak = Math.max(1, ...hosts.map((h) => h.count));
  return card('Most blocked', 'shield', [element('span', { class: 'sh-card-note', text: 'all time' })], hosts.length
    ? [element('ol', { class: 'sh-rank' }, hosts.map((host, index) => {
        const kind = host.ads >= host.trackers ? 'ads' : 'trackers';
        const row = element('li', { class: 'sh-rank-row' }, [
          element('span', { class: 'sh-rank-n', text: String(index + 1) }),
          element('div', { class: 'sh-rank-main' }, [
            element('div', { class: 'sh-rank-line' }, [
              element('span', { class: 'sh-rank-name', text: host.name }),
              element('span', { class: 'sh-tag tone-' + kind, text: kind === 'ads' ? 'Ad' : 'Tracker' }),
              element('span', { class: 'sh-rank-count', text: number(host.count) }),
            ]),
            element('div', { class: 'sh-meter' }, [element('span', { class: 'tone-' + kind })]),
          ]),
        ]);
        row.querySelector('.sh-meter span').style.width = Math.max(3, (host.count / peak) * 100) + '%';
        return row;
      }))]
    : [element('p', { class: 'sh-empty', text: 'Nothing blocked yet. Browse a little and the worst offenders show up here.' })]);
}

function topSites() {
  const sites = stats?.topSites || [];
  const disabled = new Set(state.disabledSites || []);
  return card('Where it happened', 'grid', [element('span', { class: 'sh-card-note', text: 'all time' })], sites.length
    ? [element('div', { class: 'sh-sites' }, sites.map((site) => {
        const off = [...disabled].some((host) => host === site.name || host.endsWith('.' + site.name));
        return element('div', { class: 'sh-site' }, [
          favicon('https://' + site.name, 18),
          element('span', { class: 'sh-site-name', text: site.name }),
          element('span', { class: 'sh-site-count', text: number(site.count) }),
          siteSwitch(site.name, !off),
        ]);
      }))]
    : [element('p', { class: 'sh-empty', text: 'The sites where the most was blocked will be listed here.' })]);
}

function siteSwitch(host, on) {
  return element('button', {
    class: 'sh-switch' + (on ? ' is-on' : ''), role: 'switch', 'aria-checked': String(on),
    title: on ? 'Shields are on for ' + host + '. Click to pause them here.' : 'Shields are paused on ' + host + '. Click to turn them back on.',
    onclick: async () => { await invoke('shields:site', { host, enabled: !on }); await refresh(); },
  }, [element('span', { class: 'sh-switch-knob' })]);
}

/* ---- open tabs -------------------------------------------------------------------------- */

function tabsCard() {
  const tabs = activity.tabs || [];
  return card('Open tabs', 'tabs', [element('span', { class: 'sh-card-note', text: 'this visit' })], tabs.length
    ? tabs.map((tab) => {
        let host = tab.host;
        try { host = host || new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
        const expanded = openTab === tab.id && tab.sources?.length;
        return element('div', { class: 'sh-tab' + (expanded ? ' is-open' : '') }, [
          element('button', {
            class: 'sh-tab-row',
            onclick: () => { openTab = openTab === tab.id ? null : tab.id; paintLive(); },
          }, [
            favicon(tab.url, 18),
            element('span', { class: 'sh-tab-text' }, [
              element('span', { class: 'sh-tab-title', text: tab.title || host }),
              element('span', { class: 'sh-tab-host', text: host }),
            ]),
            element('span', { class: 'sh-tab-count' + (tab.count ? '' : ' is-zero') }, [
              element('strong', { text: number(tab.count) }), ' blocked',
            ]),
          ]),
          siteSwitch(host, tab.active !== false),
          expanded ? element('div', { class: 'sh-tab-sources' }, tab.sources.map((source) => element('div', { class: 'sh-source' }, [
            element('span', { text: source.host }),
            element('span', { class: 'sh-source-count', text: '×' + source.count }),
          ]))) : null,
        ]);
      })
    : [element('p', { class: 'sh-empty', text: 'Open a web page and its blocked requests show up here as it loads.' })]);
}

/* ---- live feed ----------------------------------------------------------------------------- */

const TYPE_NAMES = { script: 'Script', image: 'Image', xhr: 'Request', subFrame: 'Frame', stylesheet: 'Style', media: 'Media', ping: 'Beacon', font: 'Font', webSocket: 'Socket', mainFrame: 'Page', object: 'Plugin', other: 'Other' };

function liveCard() {
  const rows = (activity.recent || []).slice(0, 40);
  const pause = element('button', {
    class: 'sh-seg-btn' + (livePaused ? ' is-active' : ''), text: livePaused ? 'Resume' : 'Pause',
    onclick: () => { livePaused = !livePaused; paintLive(); if (!livePaused) poll(); },
  });
  return card('Live', 'wave', [
    element('span', { class: 'sh-live-dot' + (livePaused ? ' is-paused' : '') }),
    pause,
  ], rows.length
    ? [element('div', { class: 'sh-feed' }, rows.map((item, index) => {
        let path = '';
        try { const u = new URL(item.url); path = u.pathname.length > 1 ? u.pathname : ''; } catch { /* keep blank */ }
        return element('div', { class: 'sh-feed-row' + (index === 0 && !livePaused ? ' is-new' : ''), title: item.url }, [
          element('span', { class: 'sh-feed-time', text: clock(item.at) }),
          element('span', { class: 'sh-tag tone-' + (item.category === 'ads' ? 'ads' : 'trackers'), text: item.category === 'ads' ? 'Ad' : 'Tracker' }),
          element('span', { class: 'sh-feed-what' }, [
            element('strong', { text: item.host }),
            element('span', { text: path }),
          ]),
          element('span', { class: 'sh-feed-type', text: TYPE_NAMES[item.type] || item.type }),
          element('span', { class: 'sh-feed-on', text: item.site ? 'on ' + item.site : '' }),
          element('span', { class: 'sh-feed-action' + (item.action === 'redirected' ? ' is-soft' : ''), text: item.action === 'redirected' ? 'Neutralised' : 'Blocked' }),
        ]);
      }))]
    : [element('p', { class: 'sh-empty', text: 'Blocked requests appear here the moment they happen. Only the latest are kept, in memory - never on disk.' })], 'sh-live');
}

/* ---- controls ---------------------------------------------------------------------------------- */

function toggle(key, label, hint) {
  const on = !!state.config[key];
  const master = key === 'enabled';
  return element('button', {
    class: 'sh-toggle' + (master ? ' is-master' : '') + (!master && state.config.enabled === false ? ' is-muted' : ''),
    role: 'switch', 'aria-checked': String(on),
    onclick: () => invoke('shields:update', { [key]: !on }).then(refresh),
  }, [
    element('span', { class: 'sh-toggle-text' }, [element('strong', { text: label }), element('span', { text: hint })]),
    element('span', { class: 'sh-switch' + (on ? ' is-on' : '') }, [element('span', { class: 'sh-switch-knob' })]),
  ]);
}

function controlsCard() {
  const update = element('button', {
    class: 'sh-seg-btn', text: 'Update lists',
    onclick: async () => {
      update.textContent = 'Updating…';
      update.disabled = true;
      const result = await invoke('shields:refresh').catch(() => null);
      update.textContent = result?.ok ? 'Updated' : 'Could not update';
      setTimeout(() => { update.textContent = 'Update lists'; update.disabled = false; }, 2200);
      refresh();
    },
  });
  const updated = state.lastFetch ? 'Lists updated ' + window.page.timeAgo(state.lastFetch) : (state.usingCache ? 'Using downloaded lists' : 'Using the small built-in list');
  return card('Protection', 'lock', [element('span', { class: 'sh-card-note', text: updated }), update], [
    element('div', { class: 'sh-toggles' }, [
      toggle('enabled', 'Shields', 'The master switch for everything on this page.'),
      toggle('blockTrackers', 'Block ads and trackers', 'Requests to ad and tracking networks are stopped before they leave.'),
      toggle('blockVideoAds', 'Block video ads', 'Pre-rolls and mid-rolls on YouTube and players using the common ad SDKs.'),
      toggle('hideAdSlots', 'Hide leftover ad space', 'Collapses the empty boxes a blocked ad would have filled.'),
      toggle('blockThirdPartyCookies', 'Block third-party cookies', 'Other sites cannot read or set cookies on the page you are on.'),
      toggle('stripTracking', 'Clean tracking links', 'Removes utm_*, fbclid, gclid and friends from addresses you open.'),
      toggle('upgradeHttps', 'Upgrade to HTTPS', 'Opens http:// sites over https:// when they support it. Local addresses are left alone.'),
    ]),
  ]);
}

function pausedCard() {
  const sites = state.disabledSites || [];
  if (!sites.length) return null;
  return card('Paused on these sites', 'warn', [element('span', { class: 'sh-card-note', text: sites.length + (sites.length === 1 ? ' site' : ' sites') })],
    [element('div', { class: 'sh-sites' }, sites.map((host) => element('div', { class: 'sh-site' }, [
      favicon('https://' + host, 18),
      element('span', { class: 'sh-site-name', text: host }),
      element('button', { class: 'sh-seg-btn', text: 'Protect again', onclick: async () => { await invoke('shields:site', { host, enabled: true }); refresh(); } }),
    ])))]);
}

function notesCard() {
  let armed = null;
  const reset = element('button', { class: 'sh-seg-btn is-danger', text: 'Reset statistics' });
  reset.addEventListener('click', async () => {
    if (!armed) {
      reset.textContent = 'Click again to reset';
      armed = setTimeout(() => { armed = null; reset.textContent = 'Reset statistics'; }, 3500);
      return;
    }
    clearTimeout(armed);
    shown.clear();
    stats = await invoke('shields:reset-stats');
    firstPaint = true;
    painted = '';
    paintStats();
  });
  return card('How this is counted', 'info', [reset], [
    element('p', { class: 'muted', text: 'Every number on this page is counted by the blocker as it works: a request stopped, a cookie refused, a link cleaned. Data and time saved are estimates - a blocked request never downloads, so its real size is never known - and are kept deliberately low.' }),
    element('p', { class: 'muted', text: 'Statistics stay on this device. Which sites had trackers blocked is cleared with your browsing history; the live feed is never written to disk.' }),
  ]);
}

/* ---- paint ---------------------------------------------------------------------------------- */

const slots = {};
const root = element('div', { class: 'sh' });
for (const name of ['hero', 'range', 'tiles', 'chart', 'who', 'tabs', 'live', 'controls', 'paused', 'notes']) {
  slots[name] = element('div', { class: 'sh-slot sh-slot-' + name });
  root.append(slots[name]);
}
const put = (name, node) => slots[name].replaceChildren(...[node].filter(Boolean));

function paintStats() {
  put('hero', hero());
  put('range', rangeTabs());
  put('tiles', tiles());
  put('chart', chart());
  put('who', element('div', { class: 'sh-cols' }, [topHosts(), topSites()]));
  put('controls', controlsCard());
  put('paused', pausedCard());
  put('notes', notesCard());
  firstPaint = false;
}

function paintLive() {
  put('tabs', tabsCard());
  put('live', liveCard());
}

shellApi = window.shell.mount({
  mode: 'shields',
  title: 'Shields',
  subtitle: 'Your ad manager',
  content: root,
});

let painted = '';
async function refresh() {
  const [nextState, nextStats] = await Promise.all([invoke('shields:state'), invoke('shields:stats')]);
  state = nextState || state;
  stats = nextStats || stats;
  // Redrawn only when something changed, so a chart being read is not
  // swapped out from under the pointer every few seconds.
  const key = JSON.stringify([state, stats]);
  if (key === painted) return;
  painted = key;
  paintStats();
}

async function poll() {
  if (document.hidden) return;
  try {
    const next = await invoke('shields:activity', { limit: 40 });
    if (!livePaused) activity = next;
    else activity = { ...activity, tabs: next.tabs };
    paintLive();
  } catch { /* the next tick tries again */ }
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('shields:changed', refresh);

refresh().then(poll);
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
setInterval(() => { if (!livePaused) poll(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); poll(); } });

})();
