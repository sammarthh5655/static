'use strict';

/**
 * "Compare prices", for the Shopping page: window.priceCompare.
 *
 * One product - typed in, or the one on the page the person was on - priced
 * at ten or more shops in their country. Main decides the shops and builds
 * every link (a search on that shop's own site), so all this page does with
 * the model's answer is lay it out: figures, short notes and a summary, each
 * placed with textContent.
 *
 * Every figure is an estimate, and the page says so in three places: the
 * badge beside the product, the line saying where the prices came from, and
 * the note at the foot. A comparison that looked like live prices would be
 * worse than none.
 */
(function () {

const { invoke, element, icon } = window.page;

const SORTS = [
  { id: 'cheapest', label: 'Cheapest first' },
  { id: 'dearest', label: 'Dearest first' },
  { id: 'name', label: 'A–Z' },
  { id: 'confidence', label: 'Most certain' },
];

const CONFIDENCE = {
  page: { rank: 0, dots: 3, label: 'Shown on the page you were on' },
  high: { rank: 1, dots: 3, label: 'High confidence' },
  medium: { rank: 2, dots: 2, label: 'Medium confidence' },
  low: { rank: 3, dots: 1, label: 'Low confidence' },
};

const REGION_KEY = 'static.prices.region';

/* ---- small helpers ------------------------------------------------------------ */

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private or blocked storage */ }
}
function recall(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

/** ₹29,990 / £249 / $12.99, in the region's own grouping (en-IN writes lakhs). */
function money(value, comparison) {
  try {
    return new Intl.NumberFormat(comparison.locale, {
      style: 'currency', currency: comparison.currency,
      maximumFractionDigits: value < 100 ? 2 : 0, minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return comparison.currency + ' ' + Math.round(value).toLocaleString();
  }
}

/** "2026-10-09" as "9 October 2026" (or "9 Oct 2026" when short). */
function dateText(iso, short = false) {
  const [year, month, day] = String(iso || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    day: 'numeric', month: short ? 'short' : 'long', year: 'numeric',
  });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** How long one "base" motion step is right now; 0 when animations are off. */
function motionMs() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim();
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return 200;
  return /ms$/.test(value) ? number : number * 1000;
}

/** A shop's monogram, tinted by its hue so a long list can be read by colour. */
function monogram(name, hue, extra = '') {
  const mark = element('span', { class: 'pc-mono ' + extra, 'aria-hidden': 'true' }, [
    element('span', { text: String(name || '?').replace(/^the\s+/i, '').charAt(0).toUpperCase() }),
  ]);
  mark.style.setProperty('--hue', String(Number(hue) || 0));
  return mark;
}

/** A small text button that says what it did for a moment, as the read result's do. */
function actionButton(label, iconName, run) {
  const text = element('span', { text: label });
  const button = element('button', { class: 'rp-action' }, [icon(iconName, { size: 14 }), text]);
  button.addEventListener('click', async () => {
    const said = await run(button);
    if (!said) return;
    text.textContent = said;
    button.classList.add('done');
    setTimeout(() => { text.textContent = label; button.classList.remove('done'); }, 1500);
  });
  return button;
}

/** Open a shop's search beside this page, in front - the comparison stays put. */
function openShop(url, event) {
  const background = !!(event && (event.button === 1 || event.ctrlKey || event.metaKey));
  return invoke('tabs:new', { url, background }).catch(() => {});
}

/* ---- the component ------------------------------------------------------------- */

function create() {
  let regions = [];
  let regionId = recall(REGION_KEY);
  let recent = null;          // the page "Compare prices" would use, from main
  let busy = false;
  let comparison = null;      // last shopping:prices response
  let lastAsk = null;         // { query } - for "Compare again"
  let sort = 'cheapest';
  let stepTimer = 0;

  /* ---- the panel ---- */

  const input = element('input', {
    class: 'pc-input', type: 'text', maxlength: '160', spellcheck: 'false',
    placeholder: 'Type a product, e.g. Sony WH-1000XM5',
    'aria-label': 'Product to compare',
  });
  const clearButton = element('button', {
    class: 'pc-clear', type: 'button', title: 'Clear', 'aria-label': 'Clear',
    onclick: () => { input.value = ''; paintFrom(); input.focus(); },
  }, [icon('close', { size: 13 })]);
  const regionSelect = element('select', { class: 'pc-region', 'aria-label': 'Country' });
  const goButton = element('button', { class: 'rp-go pc-go', type: 'submit' }, [
    icon('tag', { size: 16 }),
    element('span', { class: 'pc-go-label', text: 'Compare prices' }),
  ]);
  const from = element('div', { class: 'pc-from', 'aria-live': 'polite' });

  const form = element('form', { class: 'pc-form' }, [
    element('label', { class: 'pc-field' }, [icon('search', { size: 15 }), input, clearButton]),
    element('div', { class: 'pc-region-wrap' }, [icon('planet', { size: 14 }), regionSelect]),
    goButton,
  ]);
  form.addEventListener('submit', (event) => { event.preventDefault(); run(); });
  input.addEventListener('input', paintFrom);
  regionSelect.addEventListener('change', () => {
    regionId = regionSelect.value;
    remember(REGION_KEY, regionId);
    paintFrom();
  });

  // A ladder of price tags, the shortest lit: the whole idea in one picture.
  const ladder = element('div', { class: 'pc-ladder', 'aria-hidden': 'true' },
    [0, 1, 2, 3, 4].map((index) => element('span', { class: 'pc-rung pc-rung-' + index })));

  const panel = element('section', { class: 'pc-panel', id: 'compare-prices' }, [
    element('div', { class: 'pc-panel-glow', 'aria-hidden': 'true' }),
    element('div', { class: 'pc-panel-top' }, [
      element('div', { class: 'pc-panel-copy' }, [
        element('div', { class: 'rp-eyebrow', text: 'Compare prices' }),
        element('h2', { class: 'rp-heading', text: 'Where is it cheapest?' }),
        element('p', {
          class: 'rp-blurb',
          text: 'Approximate prices at ten or more shops, picked for the kind of product. '
            + 'Each one links to a search on that shop’s own site, so you see the real price before you buy.',
        }),
      ]),
      ladder,
    ]),
    form,
    from,
  ]);

  const result = element('div', { class: 'pc-result-slot' });

  function currentRegion() {
    return regions.find((entry) => entry.id === regionId) || regions[0] || null;
  }

  /** Under the form: what will be compared if the box is left empty. */
  function paintFrom() {
    const typed = input.value.trim();
    clearButton.hidden = !typed;
    const where = currentRegion();
    if (typed) {
      from.replaceChildren(element('span', { class: 'pc-from-text' }, [
        icon('info', { size: 13 }),
        element('span', { text: 'Comparing what you typed' + (where ? ' at shops in ' + where.name : '') + '.' }),
      ]));
    } else if (recent) {
      from.replaceChildren(
        element('span', { class: 'pc-from-text', text: 'Leave it empty to compare the product on' }),
        element('button', {
          type: 'button', class: 'pc-from-page', title: 'Compare prices for ' + (recent.title || recent.host),
          onclick: () => run({ query: '' }),
        }, [
          element('span', { class: 'pc-from-title', text: recent.title || recent.host }),
          element('span', { class: 'pc-from-host', text: recent.host }),
        ]),
      );
    } else {
      from.replaceChildren(element('span', { class: 'pc-from-text' }, [
        icon('info', { size: 13 }),
        element('span', { text: 'Type a product, or open its page in a tab and come back.' }),
      ]));
    }
    goButton.disabled = busy || (!typed && !recent);
    goButton.querySelector('.pc-go-label').textContent = busy ? 'Comparing…' : 'Compare prices';
    panel.classList.toggle('is-busy', busy);
  }

  function paintRegions() {
    if (!regions.some((entry) => entry.id === regionId)) regionId = '';
    regionSelect.replaceChildren(...regions.map((entry) => {
      const symbol = money(0, entry).replace(/[\d.,\s]/g, '') || entry.currency;
      return element('option', { value: entry.id, text: entry.name + ' · ' + symbol });
    }));
    regionSelect.value = currentRegion()?.id || '';
    regionId = regionSelect.value;
  }

  /* ---- waiting ---- */

  function renderWaiting(target) {
    const where = currentRegion();
    const preview = where?.preview || [];
    const shopName = (index) => preview[index % Math.max(preview.length, 1)]?.name || 'the shops';
    const step = element('span', { class: 'rp-step', text: 'Checking ' + shopName(0) + '…' });
    let index = 0;
    clearInterval(stepTimer);
    stepTimer = setInterval(() => {
      index += 1;
      step.textContent = index % 4 === 3 ? 'Weighing up the offers…' : 'Checking ' + shopName(index) + '…';
      step.classList.remove('rp-step-in');
      void step.offsetWidth;
      step.classList.add('rp-step-in');
    }, 1400);

    const rows = preview.slice(0, 7).map((shop, row) => {
      const line = element('div', { class: 'pc-wait-row' }, [
        monogram(shop.name, shop.hue),
        element('span', { class: 'pc-wait-name', text: shop.name }),
        element('span', { class: 'pc-wait-bar' }),
      ]);
      line.style.setProperty('--i', String(row));
      return line;
    });

    result.replaceChildren(element('div', { class: 'panel-card pc-result pc-waiting', 'aria-busy': 'true' }, [
      element('div', { class: 'rp-loading-head' }, [
        element('span', { class: 'pc-wait-mark' }, [icon('tag', { size: 16 })]),
        element('div', {}, [
          element('div', {
            class: 'rp-loading-title',
            text: 'Comparing ' + (target || 'the product') + (where ? ' across shops in ' + where.name : ''),
          }),
          step,
        ]),
      ]),
      element('div', { class: 'pc-wait-rows' }, rows),
    ]));
  }

  /* ---- the comparison ---- */

  function sorted(rows) {
    const priced = rows.filter((row) => row.price !== null);
    const blank = rows.filter((row) => row.price === null);
    const byName = (a, b) => a.name.localeCompare(b.name);
    const order = {
      cheapest: (a, b) => a.price - b.price || byName(a, b),
      dearest: (a, b) => b.price - a.price || byName(a, b),
      name: byName,
      confidence: (a, b) => (CONFIDENCE[a.confidence]?.rank ?? 9) - (CONFIDENCE[b.confidence]?.rank ?? 9) || a.price - b.price,
    }[sort];
    // Shops without an estimate always go last: they are still worth a
    // search, but never "cheapest".
    return sort === 'name' ? [...rows].sort(byName) : [...priced.sort(order), ...blank.sort(byName)];
  }

  function confidenceDots(level) {
    const spec = CONFIDENCE[level];
    if (!spec) return element('span', { class: 'pc-conf pc-conf-none', text: '–', title: 'No estimate' });
    return element('span', { class: 'pc-conf pc-conf-' + level, title: spec.label, 'aria-label': spec.label },
      [0, 1, 2].map((dot) => element('span', { class: 'pc-dot' + (dot < spec.dots ? ' on' : '') })));
  }

  function shopRow(row, stats) {
    const share = row.price === null || stats.max === stats.min
      ? (row.price === null ? 0 : 1)
      : (row.price - stats.min) / (stats.max - stats.min);
    // The cheapest bar is the shortest, but never so short it reads as empty.
    const width = row.price === null ? 0 : 28 + share * 72;
    const bar = element('span', { class: 'pc-bar' }, [element('span', { class: 'pc-bar-fill' })]);
    bar.style.setProperty('--w', width.toFixed(1) + '%');

    const extra = row.price !== null && stats.min && row.price > stats.min
      ? '+' + money(row.price - stats.min, comparison) : '';

    const node = element('div', {
      class: 'pc-row' + (row.best ? (stats.crowded ? ' is-tied' : ' is-best') : '') + (row.price === null ? ' is-blank' : '') + (row.onPage ? ' is-page' : ''),
      role: 'row', 'data-id': row.id,
    }, [
      element('div', { class: 'pc-cell pc-cell-shop', role: 'cell' }, [
        monogram(row.name, row.hue, row.brand ? 'pc-mono-brand' : ''),
        element('div', { class: 'pc-shop-text' }, [
          element('div', { class: 'pc-shop-name' }, [
            element('span', { text: row.name }),
            row.best && !stats.crowded ? element('span', { class: 'pc-badge pc-badge-best' }, [icon('check', { size: 11 }), element('span', { text: 'Best price' })]) : null,
            row.best && stats.crowded ? element('span', { class: 'pc-badge pc-badge-tied', text: 'Lowest' }) : null,
            row.onPage ? element('span', { class: 'pc-badge pc-badge-page', text: 'Your page' }) : null,
          ]),
          element('div', { class: 'pc-shop-note', text: row.note || row.domain }),
        ]),
      ]),
      element('div', { class: 'pc-cell pc-cell-bar', role: 'cell', 'aria-hidden': 'true' }, [bar]),
      element('div', { class: 'pc-cell pc-cell-price', role: 'cell' }, row.price === null
        ? [element('span', { class: 'pc-price-none', text: 'No estimate' })]
        : [
            element('span', { class: 'pc-price', text: (row.confidence === 'page' ? '' : '≈ ') + money(row.price, comparison) }),
            extra ? element('span', { class: 'pc-price-extra', text: extra }) : null,
          ]),
      element('div', { class: 'pc-cell pc-cell-conf', role: 'cell' }, [confidenceDots(row.price === null ? '' : row.confidence)]),
      element('div', { class: 'pc-cell pc-cell-link', role: 'cell' }, [
        element('button', {
          class: 'pc-search', type: 'button',
          title: row.id === 'page' ? 'Open the page you were on' : 'Search ' + row.name + ' for ' + comparison.searchTerm,
          onclick: (event) => openShop(row.url, event),
          onauxclick: (event) => { if (event.button === 1) openShop(row.url, event); },
        }, [element('span', { text: row.id === 'page' ? 'Open' : 'Search' }), icon('external', { size: 12 })]),
      ]),
    ]);
    return node;
  }

  /**
   * Re-order the rows, gliding each from where it was to where it goes (FLIP),
   * so a change of sort reads as the list rearranging rather than a new list.
   */
  function reorder(body, stats) {
    const before = new Map([...body.children].map((node) => [node.dataset.id, node.getBoundingClientRect().top]));
    const rows = sorted(comparison.rows);
    const byId = new Map([...body.children].map((node) => [node.dataset.id, node]));
    body.append(...rows.map((row) => byId.get(row.id) || shopRow(row, stats)));
    const ms = motionMs();
    if (!ms) return;
    for (const node of body.children) {
      const was = before.get(node.dataset.id);
      if (was === undefined) continue;
      const delta = was - node.getBoundingClientRect().top;
      if (!delta) continue;
      node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], {
        duration: ms * 2, easing: 'cubic-bezier(.2, .8, .2, 1)',
      });
    }
  }

  /** The best figure counts up to itself, once, as the card arrives. */
  function countUp(node, value) {
    const ms = motionMs();
    node.textContent = money(value, comparison);
    if (!ms || value < 10) return;
    const started = performance.now();
    const length = ms * 4;
    const tick = (now) => {
      const t = Math.min(1, (now - started) / length);
      const eased = 1 - Math.pow(1 - t, 3);
      const shown = value * eased;
      node.textContent = money(value >= 100 ? Math.round(shown) : Math.round(shown * 100) / 100, comparison);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function asText() {
    const data = comparison;
    const lines = [
      `Prices for ${data.product} at shops in ${data.regionName} - APPROXIMATE, ${dateText(data.date)}.`,
      data.basis === 'search' ? 'From Google Search results.' : 'From the assistant’s knowledge, not live prices.',
      '',
      ...sorted(data.rows).map((row) => `${row.name}: ${row.price === null ? 'no estimate' : money(row.price, data)}`
        + (row.best ? ' (best)' : '') + (row.note ? ' - ' + row.note : '') + '\n  ' + row.url),
      '',
      data.summary,
      ...data.tips.map((tip) => '- ' + tip),
      '',
      'Check before buying: prices, offers and stock change daily.',
    ];
    return lines.filter((line, index, all) => line || all[index - 1]).join('\n').trim();
  }

  function renderComparison() {
    const data = comparison;
    const priced = data.rows.filter((row) => row.price !== null);
    const stats = {
      min: priced.length ? Math.min(...priced.map((row) => row.price)) : 0,
      max: priced.length ? Math.max(...priced.map((row) => row.price)) : 0,
    };
    // A tie is a tie: every shop at the lowest figure is marked, and named.
    const winners = priced.filter((row) => row.best);
    // When most shops share the lowest figure there is no single winner to
    // light up; they are tagged quietly and the headline says it is much
    // the same everywhere.
    stats.crowded = winners.length > 3;
    const best = winners[0];
    const bestAt = stats.crowded
      ? 'at ' + winners.length + ' shops - much the same everywhere'
      : winners.length > 2
        ? 'at ' + winners[0].name + ' and ' + (winners.length - 1) + ' others'
        : 'at ' + winners.map((row) => row.name).join(' and ');
    const approx = dateText(data.date, true);

    /* the headline: product, what kind, and that it is approximate */
    const head = element('div', { class: 'pc-result-head' }, [
      element('div', { class: 'pc-chips' }, [
        element('span', { class: 'rp-kind' }, [icon('tag', { size: 12 }), element('span', { text: data.categoryName })]),
        element('span', { class: 'pc-approx', title: 'Estimates, not live prices. Check before buying.' }, [
          icon('warn', { size: 12 }),
          element('span', { text: 'Approximate · ' + approx }),
        ]),
        data.model ? element('span', { class: 'rp-model', text: data.model }) : null,
      ]),
      element('h3', { class: 'pc-product', text: data.product }),
      element('div', { class: 'pc-basis pc-basis-' + data.basis }, [
        icon(data.basis === 'search' ? 'search' : 'sparkle', { size: 13 }),
        element('span', {
          text: data.basis === 'search'
            ? 'From Google Search results on ' + dateText(data.date) + ' - sources below.'
            : 'From the assistant’s own knowledge, not live prices, so they may be months out of date.',
        }),
      ]),
    ]);

    /* three figures */
    const bestValue = element('span', { class: 'pc-stat-value' });
    const stats3 = element('div', { class: 'pc-stats' }, [
      element('div', { class: 'pc-stat pc-stat-best' + (best ? '' : ' is-empty') }, [
        element('span', { class: 'pc-stat-label', text: 'Best estimate' }),
        best ? bestValue : element('span', { class: 'pc-stat-value', text: '–' }),
        element('span', { class: 'pc-stat-note', text: best ? bestAt : 'No shop had an estimate' }),
      ]),
      element('div', { class: 'pc-stat' }, [
        element('span', { class: 'pc-stat-label', text: 'Could save' }),
        element('span', { class: 'pc-stat-value', text: priced.length > 1 ? money(stats.max - stats.min, data) : '–' }),
        element('span', {
          class: 'pc-stat-note',
          text: priced.length > 1 ? 'cheapest to dearest' : 'needs two estimates',
        }),
      ]),
      element('div', { class: 'pc-stat' }, [
        element('span', { class: 'pc-stat-label', text: 'Shops' }),
        element('span', { class: 'pc-stat-value', text: String(data.rows.length) }),
        element('span', { class: 'pc-stat-note', text: priced.length + ' with an estimate' }),
      ]),
    ]);
    if (best) countUp(bestValue, best.price);

    /* sorting and actions */
    const body = element('div', { class: 'pc-rows', role: 'rowgroup' });
    const sortButtons = SORTS.map((option) => element('button', {
      type: 'button', class: 'pc-sort-option' + (option.id === sort ? ' selected' : ''),
      'aria-pressed': String(option.id === sort), 'data-sort': option.id,
      onclick: () => setSort(option.id),
    }, [element('span', { text: option.label })]));
    const sortBar = element('div', { class: 'pc-sort', role: 'group', 'aria-label': 'Sort the shops' }, [
      icon('sort', { size: 13 }),
      ...sortButtons,
    ]);

    function setSort(next) {
      if (next === sort) return;
      sort = next;
      for (const button of sortButtons) {
        const on = button.dataset.sort === sort;
        button.classList.toggle('selected', on);
        button.setAttribute('aria-pressed', String(on));
      }
      for (const header of headers) header.setAttribute('aria-sort', ariaSort(header.dataset.sort));
      reorder(body, stats);
    }

    function ariaSort(id) {
      if (id === 'cheapest' && sort === 'dearest') return 'descending';
      return id && id === sort ? 'ascending' : 'none';
    }

    const header = (label, id, extra = '') => {
      const node = element('div', {
        class: 'pc-cell pc-th ' + extra, role: 'columnheader', 'aria-sort': ariaSort(id),
      }, [id ? element('button', {
        type: 'button', class: 'pc-th-button', 'data-sort': id,
        // The price heading flips between cheapest and dearest first.
        onclick: () => setSort(id === 'cheapest' && sort === 'cheapest' ? 'dearest' : id),
      }, [element('span', { text: label }), icon('sort', { size: 11 })]) : element('span', { text: label })]);
      node.dataset.sort = id || '';
      return node;
    };
    const headers = [
      header('Shop', 'name', 'pc-cell-shop'),
      header('', '', 'pc-cell-bar'),
      header('Price', 'cheapest', 'pc-cell-price'),
      header('Sure?', 'confidence', 'pc-cell-conf'),
      header('', '', 'pc-cell-link'),
    ];

    const table = element('div', { class: 'pc-table', role: 'table', 'aria-label': 'Prices at each shop' }, [
      element('div', { class: 'pc-row pc-row-head', role: 'row' }, headers),
      body,
    ]);
    body.append(...sorted(data.rows).map((row, index) => {
      const node = shopRow(row, stats);
      node.style.setProperty('--i', String(index));
      return node;
    }));

    const tools = element('div', { class: 'pc-tools' }, [
      sortBar,
      element('div', { class: 'pc-actions' }, [
        actionButton('Copy', 'copy', async () => {
          try { await navigator.clipboard.writeText(asText()); return 'Copied'; } catch { return 'Copy failed'; }
        }),
        actionButton('Save to Notes', 'bookmark', async () => {
          await invoke('notes:add', {
            kind: 'summary',
            title: 'Prices: ' + data.product,
            body: asText(),
            url: data.source?.url || data.rows[0]?.url,
            tags: ['shopping', 'prices'],
          });
          return 'Saved';
        }),
        actionButton('Compare again', 'reload', () => { run(lastAsk || {}); return ''; }),
      ]),
    ]);

    /* what the assistant made of it */
    const advice = data.summary || data.tips.length ? element('div', { class: 'pc-advice' }, [
      data.summary ? element('div', { class: 'rp-section rp-section-verdict' }, [
        element('div', { class: 'rp-section-head' }, [icon('sparkle', { size: 14 }), element('span', { text: 'In short' })]),
        element('p', { class: 'rp-verdict', text: data.summary }),
      ]) : null,
      data.tips.length ? element('div', { class: 'rp-section' }, [
        element('div', { class: 'rp-section-head' }, [icon('tag', { size: 14 }), element('span', { text: 'Ways to pay less' })]),
        element('ul', { class: 'rp-list' }, data.tips.map((tip) => element('li', { class: 'pc-tip', text: tip }))),
      ]) : null,
    ]) : null;

    const sources = data.sources?.length ? element('div', { class: 'pc-sources' }, [
      element('div', { class: 'rp-section-head' }, [icon('search', { size: 14 }), element('span', { text: 'Sources' })]),
      element('div', { class: 'pc-source-list' }, data.sources.map((source) => element('button', {
        type: 'button', class: 'pc-source', title: source.title || source.url,
        onclick: (event) => openShop(source.url, event),
      }, [
        icon('external', { size: 11 }),
        element('span', { text: source.title || hostOf(source.url) }),
      ]))),
      data.queries?.length ? element('div', { class: 'pc-source-list pc-queries' }, [
        element('span', { class: 'pc-queries-label', text: 'Searched for' }),
        ...data.queries.map((query) => element('button', {
          type: 'button', class: 'pc-source pc-query', title: 'Search Google for ' + query.text,
          onclick: (event) => openShop(query.url, event),
        }, [icon('search', { size: 11 }), element('span', { text: query.text })])),
      ]) : null,
    ]) : null;

    const card = element('div', { class: 'panel-card pc-result' }, [
      head,
      stats3,
      tools,
      table,
      advice,
      sources,
      element('p', { class: 'rp-disclaimer pc-disclaimer' }, [icon('warn', { size: 13 }), element('span', {}, [
        element('strong', { text: 'Approximate prices, put together on ' + dateText(data.date) + '. Check before buying. ' }),
        element('span', {
          text: (data.basis === 'search'
            ? 'They come from search results, which can lag behind the shop. '
            : 'They come from what the assistant knows, not from the shops today, and it can be wrong. ')
            + 'Prices, sellers, offers and stock change every day; each Search link shows the shop’s live price.',
        }),
      ])]),
    ]);
    result.replaceChildren(card);
  }

  function renderError(message, notProduct) {
    result.replaceChildren(element('div', { class: 'panel-card rp-result rp-error pc-error' }, [
      element('div', { class: 'rp-error-mark' }, [icon(notProduct ? 'info' : 'warn', { size: 18 })]),
      element('div', { class: 'rp-error-body' }, [
        element('div', {
          class: 'rp-error-title',
          text: notProduct ? 'That does not look like something you can buy' : 'Prices could not be compared',
        }),
        element('p', { class: 'rp-error-text', text: message || 'Something went wrong.' }),
      ]),
      element('button', { class: 'rp-action', onclick: () => run(lastAsk || {}) }, [
        icon('reload', { size: 14 }), element('span', { text: 'Try again' }),
      ]),
    ]));
  }

  /**
   * Compare. `query` overrides the box: '' means "the page I was on" even
   * when something is typed (the hero's button and the page chip say so).
   */
  async function run({ query } = {}) {
    if (busy) return;
    const ask = { query: query === undefined ? input.value.trim() : String(query) };
    if (!ask.query && !recent) { paintFrom(); input.focus(); return; }
    // Comparing the page you were on: the box is emptied so it says so too.
    if (query === '') input.value = '';
    lastAsk = ask;
    busy = true;
    paintFrom();
    renderWaiting(ask.query ? '“' + ask.query + '”' : (recent?.title || 'the product'));
    result.scrollIntoView({ block: 'nearest', behavior: motionMs() ? 'smooth' : 'auto' });
    const response = await invoke('shopping:prices', { query: ask.query, region: currentRegion()?.id })
      .catch((error) => ({ ok: false, error: error.message }));
    busy = false;
    clearInterval(stepTimer);
    paintFrom();
    // Only a newer comparison from this page cancels one, and that one draws
    // its own card; this must not leave the waiting card behind for ever.
    if (response?.cancelled) {
      if (result.querySelector('.pc-waiting')) result.replaceChildren();
      return;
    }
    if (!response?.ok) { comparison = null; renderError(response?.error, response?.notProduct); return; }
    comparison = response;
    sort = 'cheapest';
    renderComparison();
  }

  /** Called with the page "Read this page" would read, whenever it changes. */
  function setRecent(next) {
    if (JSON.stringify(next) === JSON.stringify(recent)) return;
    recent = next;
    paintFrom();
  }

  invoke('shopping:price-regions').then((response) => {
    regions = response?.regions || [];
    if (!regionId) regionId = response?.defaultRegion || '';
    paintRegions();
    paintFrom();
  }).catch(() => {});

  /** Bring the panel into view - smoothly only when motion is wanted. */
  function reveal() {
    panel.scrollIntoView({ block: 'start', behavior: motionMs() ? 'smooth' : 'auto' });
  }

  paintFrom();
  return {
    panel, result, run, setRecent, reveal,
    compareProduct: (name) => {
      if (busy) return undefined; // one comparison at a time; the box keeps saying which
      input.value = String(name || '').slice(0, 160);
      paintFrom();
      return run();
    },
  };
}

window.priceCompare = { create };

})();
