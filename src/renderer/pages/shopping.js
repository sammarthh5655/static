'use strict';

/**
 * browser://shopping - is it worth it, where is it cheapest, and which one?
 *
 * Three actions on one page, in the order people shop: read the product
 * they were looking at (readpage.js), compare what it costs at other shops
 * (prices.js), and compare several products open in tabs (below).
 *
 * For the tab comparison the model returns a fixed field-per-line block per
 * product (see features/workspaces SHOPPING_SYSTEM), which this page parses
 * into a table. Parsing a known shape rather than asking for JSON keeps the
 * output readable when a field is missing, which on real shopping pages is
 * often.
 */
(function () {

const { invoke, onState, element, icon } = window.page;

let busy = false;
let result = null;
let error = '';
let sources = [];
let shellApi = null;
let openTabs = new Set();   // ids of the tabs open now, from pushed state

/**
 * "Compare prices" sits beside "Read this page" in the hero, and has its own
 * panel below the reading: the hero button compares the page you were on,
 * the panel takes a product typed in.
 */
const prices = window.priceCompare.create();
const heroPrices = element('button', {
  class: 'pc-hero-button', title: 'Compare the price of this product at other shops',
  onclick: () => {
    prices.reveal();
    prices.run({ query: '' });
  },
}, [icon('tag', { size: 15 }), element('span', { text: 'Compare prices' })]);

/**
 * "Read this page" (readpage.js) leads: most shopping is one product at a
 * time, and the question is whether THIS one is worth it.
 */
const readPage = window.readPage.create({
  mode: 'shopping',
  actions: [heroPrices],
  onTarget: (recent) => {
    heroPrices.disabled = !recent;
    prices.setRecent(recent);
  },
});

/* ---- parsing -------------------------------------------------------------- */

const FIELDS = [
  ['PRICE', 'Price'],
  ['RATING', 'Rating'],
  ['DELIVERY', 'Delivery'],
  ['WARRANTY', 'Warranty'],
  ['SELLER', 'Seller'],
  ['RETURNS', 'Returns'],
  ['KEY SPECS', 'Key specs'],
  ['BEST FOR', 'Best for'],
];

/** Split the model's blocks into products plus the closing verdict. */
function parse(text) {
  const products = [];
  let verdict = '';

  const clean = String(text || '').replace(/\*\*|__/g, '');
  const verdictAt = clean.search(/^\s*VERDICT:/m);
  const body = verdictAt >= 0 ? clean.slice(0, verdictAt) : clean;
  if (verdictAt >= 0) verdict = clean.slice(verdictAt).replace(/^\s*VERDICT:\s*/, '').trim();

  for (const block of body.split(/\n\s*\n/)) {
    if (!/^\s*PRODUCT:/m.test(block)) continue;
    const product = { fields: {} };
    for (const line of block.split('\n')) {
      const match = /^([A-Z ]+):\s*(.*)$/.exec(line.replace(/^[-*•]\s*/, '').trim());
      if (!match) continue;
      if (match[1] === 'PRODUCT') product.name = match[2];
      else product.fields[match[1]] = match[2];
    }
    if (product.name) products.push(product);
  }
  return { products, verdict };
}

/** The first figure in a price line ("₹7,999 (was ₹12,999)" is 7999), or null. */
function priceNumber(value) {
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(String(value || ''));
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isMissing(value) {
  return !value || /^(not found|none|n\/a|not stated)\.?$/i.test(String(value).trim());
}

/* ---- rendering ------------------------------------------------------------ */

/** The page's own icon, or its first letter. */
function siteMark(source) {
  const letter = () => element('span', { class: 'rp-mark-letter', text: (source?.host || '?').charAt(0).toUpperCase() });
  const mark = element('span', { class: 'rp-mark' });
  if (source?.favicon) {
    const img = element('img', { src: source.favicon, alt: '', width: '12', height: '12' });
    img.addEventListener('error', () => img.replaceWith(letter()));
    mark.append(img);
  } else {
    mark.append(letter());
  }
  return mark;
}

function comparisonTable(products) {
  // A column per product, a row per field - the shape people actually compare in.
  const figures = products.map((product) => (isMissing(product.fields.PRICE) ? null : priceNumber(product.fields.PRICE)));
  const known = figures.filter((value) => value !== null);
  const lowest = known.length >= 2 ? Math.min(...known) : null;

  const cells = [element('div', { class: 'cmp-label cmp-head' })];
  products.forEach((product, index) => {
    // The model says which tab each product came from; going by position
    // alone would put one product's site under another when it skips a page
    // or reorders them.
    const said = Number(/\d+/.exec(product.fields.TAB || '')?.[0]);
    const source = sources[Number.isInteger(said) && said >= 1 && said <= sources.length ? said - 1 : index];
    cells.push(element('div', { class: 'cmp-head' }, [
      element('div', { class: 'cmp-name', text: product.name }),
      source ? element('button', {
        class: 'cmp-from', title: 'Go to ' + source.url,
        // Switches to the tab rather than navigating this page away from
        // the comparison - or, once that tab has been closed, opens the page
        // again in a new one rather than doing nothing.
        onclick: () => (source.id && openTabs.has(source.id)
          ? invoke('tabs:select', { id: source.id })
          : invoke('tabs:new', { url: source.url })).catch(() => {}),
      }, [siteMark(source), element('span', { text: source.host || source.url })]) : null,
      element('button', {
        class: 'cmp-prices-link', title: 'Compare the price of ' + product.name + ' at other shops',
        onclick: () => {
          prices.reveal();
          prices.compareProduct(product.name);
        },
      }, [icon('tag', { size: 11 }), element('span', { text: 'Compare prices' })]),
    ]));
  });

  for (const [key, label] of FIELDS) {
    cells.push(element('div', { class: 'cmp-label', text: label }));
    products.forEach((product, index) => {
      const value = product.fields[key] || 'not found';
      const missing = isMissing(value);
      const isPrice = key === 'PRICE';
      const isLowest = isPrice && lowest !== null && figures[index] === lowest;
      cells.push(element('div', {
        class: [missing ? 'cmp-missing' : '', isPrice && !missing ? 'cmp-price-row' : '', isLowest ? 'cmp-lowest' : ''].filter(Boolean).join(' '),
      }, [
        element('span', { text: value }),
        isLowest ? element('span', { class: 'cmp-price-badge', text: 'Lowest' }) : null,
      ]));
    });
  }

  const table = element('div', { class: 'cmp-table', role: 'table' }, cells);
  table.style.setProperty('--n', String(products.length));
  return element('div', { class: 'cmp-scroll' }, [table]);
}

const compareButton = element('button', { class: 'cmp-go', onclick: () => compare() }, [
  icon('tabs', { size: 15 }),
  element('span', { class: 'cmp-go-label', text: 'Compare now' }),
]);

const comparePanel = element('div', { class: 'panel-card cmp-panel' }, [
  element('div', { class: 'cmp-panel-mark', 'aria-hidden': 'true' }, [element('span'), element('span'), element('span')]),
  element('div', { class: 'cmp-panel-copy' }, [
    element('div', { class: 'cmp-panel-title', text: 'Compare open products' }),
    element('p', {
      class: 'cmp-panel-text',
      text: 'Open each product in its own tab, then compare them side by side. Pages are read from '
        + 'the tabs you already have open - nothing is fetched separately.',
    }),
  ]),
  compareButton,
]);

const compareSlot = element('div', { class: 'cmp-slot' });

function renderCompare() {
  compareButton.disabled = busy;
  compareButton.querySelector('.cmp-go-label').textContent = busy ? 'Comparing…' : 'Compare now';

  if (busy) {
    compareSlot.replaceChildren(element('div', { class: 'panel-card cmp-result rp-loading', 'aria-busy': 'true' }, [
      element('div', { class: 'rp-loading-head' }, [
        element('span', { class: 'pc-wait-mark' }, [icon('tabs', { size: 16 })]),
        element('div', {}, [
          element('div', { class: 'rp-loading-title', text: 'Reading your open tabs' }),
          element('span', { class: 'rp-step', text: 'Lining the products up side by side…' }),
        ]),
      ]),
      element('div', { class: 'rp-skeleton' }, Array.from({ length: 6 }, () => element('span'))),
    ]));
    return;
  }
  if (error) {
    compareSlot.replaceChildren(element('div', { class: 'panel-card cmp-result rp-error' }, [
      element('div', { class: 'rp-error-mark' }, [icon('warn', { size: 18 })]),
      element('div', { class: 'rp-error-body' }, [
        element('div', { class: 'rp-error-title', text: 'Those tabs could not be compared' }),
        element('p', { class: 'rp-error-text compare-error', text: error }),
      ]),
      element('button', { class: 'rp-action', onclick: () => compare() }, [icon('reload', { size: 14 }), element('span', { text: 'Try again' })]),
    ]));
    return;
  }
  const parsed = result ? parse(result.text) : null;
  if (!parsed || !parsed.products.length) {
    compareSlot.replaceChildren(result ? element('div', { class: 'panel-card cmp-result' }, [
      element('div', { class: 'rp-plain', text: String(result.text || '') }),
    ]) : '');
    return;
  }

  compareSlot.replaceChildren(element('div', { class: 'panel-card cmp-result' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('grid', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Side by side' }),
      result?.model ? element('span', { class: 'rp-model', text: result.model }) : null,
    ]),
    comparisonTable(parsed.products),
    parsed.verdict ? element('div', { class: 'rp-section rp-section-verdict cmp-verdict' }, [
      element('div', { class: 'rp-section-head' }, [icon('sparkle', { size: 14 }), element('span', { text: 'Verdict' })]),
      element('p', { class: 'rp-verdict compare-verdict', text: parsed.verdict }),
    ]) : null,
    element('p', { class: 'rp-disclaimer' }, [icon('info', { size: 13 }), element('span', {
      text: 'Read from the page text, so anything the page renders later or hides behind a click may show as '
        + '"not found". Check the price on the site before buying.',
    })]),
  ]));
}

async function compare() {
  if (busy) return;
  busy = true;
  error = '';
  renderCompare();
  const response = await invoke('shopping:compare').catch((failure) => ({ ok: false, error: failure.message }));
  busy = false;
  if (response?.cancelled) {
    // Only a newer comparison from this page cancels one, and it draws its own.
    renderCompare();
    return;
  }
  if (response?.ok) {
    result = response;
    sources = response.sources || [];
  } else {
    error = response?.error || 'Could not compare those pages.';
    result = null;
  }
  renderCompare();
}

// Built once: re-inserting these would restart every entrance animation on
// the page each time one part of it changed.
const content = element('div', { class: 'shopping-page' }, [
  readPage.hero,
  readPage.result,
  prices.panel,
  prices.result,
  element('h2', { class: 'section-heading', text: 'Or compare several products' }),
  comparePanel,
  compareSlot,
  window.narrator ? window.narrator.dock : null,
]);

shellApi = window.shell.mount({
  mode: 'shopping',
  title: 'Shopping',
  subtitle: 'Is it worth it, and where is it cheapest?',
  content,
});

// Pushed whenever a tab changes, which is when the page "Read this page"
// would read can change too.
onState((next) => {
  if (next?.modes) shellApi?.setState(next.modes);
  if (Array.isArray(next?.tabs)) openTabs = new Set(next.tabs.map((tab) => tab.id));
  readPage.refresh();
});

renderCompare();

})();
