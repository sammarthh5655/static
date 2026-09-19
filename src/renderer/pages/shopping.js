'use strict';

/**
 * browser://shopping - compare the product pages currently open.
 *
 * The model returns a fixed field-per-line block per product (see
 * features/workspaces SHOPPING_SYSTEM), which this page parses into a table.
 * Parsing a known shape rather than asking for JSON keeps the output readable
 * when a field is missing, which on real shopping pages is often.
 */
(function () {

const { invoke, onState, element, icon, openUrl } = window.page;

let busy = false;
let result = null;
let error = '';
let sources = [];
let shellApi = null;

const content = element('div');

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

  const verdictAt = text.search(/^VERDICT:/m);
  const body = verdictAt >= 0 ? text.slice(0, verdictAt) : text;
  if (verdictAt >= 0) verdict = text.slice(verdictAt).replace(/^VERDICT:\s*/, '').trim();

  for (const block of body.split(/\n\s*\n/)) {
    if (!/^PRODUCT:/m.test(block)) continue;
    const product = { fields: {} };
    for (const line of block.split('\n')) {
      const match = /^([A-Z ]+):\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === 'PRODUCT') product.name = match[2];
      else product.fields[match[1]] = match[2];
    }
    if (product.name) products.push(product);
  }
  return { products, verdict };
}

/* ---- rendering ------------------------------------------------------------ */

function comparisonTable(products) {
  // A column per product, a row per field - the shape people actually compare in.
  const header = element('div', { class: 'compare-row compare-head' }, [
    element('div', { class: 'compare-label' }),
    ...products.map((product, index) => element('div', { class: 'compare-cell' }, [
      element('div', { class: 'compare-name', text: product.name }),
      sources[index]
        ? element('button', {
            class: 'compare-source',
            text: hostOf(sources[index].url),
            title: sources[index].url,
            onclick: (event) => openUrl(sources[index].url, event),
          })
        : null,
    ])),
  ]);

  const rows = FIELDS.map(([key, label]) => element('div', { class: 'compare-row' }, [
    element('div', { class: 'compare-label', text: label }),
    ...products.map((product) => {
      const value = product.fields[key] || 'not found';
      const missing = /^not found$/i.test(value);
      return element('div', {
        class: 'compare-cell' + (missing ? ' missing' : ''),
        text: value,
      });
    }),
  ]));

  return element('div', { class: 'compare-table' }, [header, ...rows]);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function render() {
  const parsed = result ? parse(result.text) : null;

  content.replaceChildren(...[
    element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon('search', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Compare open products' }),
        element('button', {
          class: 'pill' + (busy ? '' : ' selected'),
          text: busy ? 'Comparing…' : 'Compare now',
          disabled: busy ? 'true' : null,
          onclick: compare,
        }),
      ]),
      element('p', {
        class: 'muted',
        text: 'Open each product in its own tab, then compare. Pages are read from '
          + 'the tabs you already have open — nothing is fetched separately.',
      }),
    ]),

    error ? element('div', { class: 'panel-card' }, [
      element('p', { class: 'compare-error', text: error }),
    ]) : null,

    parsed && parsed.products.length ? element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon('grid', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Comparison' }),
        result?.model ? element('span', { class: 'muted', text: result.model }) : null,
      ]),
      comparisonTable(parsed.products),
      element('p', {
        class: 'muted limits-note',
        text: 'Read from the page text, so anything the page renders later or hides '
          + 'behind a click may show as "not found". Check the price on the site '
          + 'before buying.',
      }),
    ]) : null,

    parsed && parsed.verdict ? element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon('sparkle', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Verdict' }),
      ]),
      element('div', { class: 'compare-verdict', text: parsed.verdict }),
    ]) : null,
  ].filter(Boolean));
}

async function compare() {
  busy = true;
  error = '';
  render();
  const response = await invoke('shopping:compare');
  busy = false;
  if (response?.ok) {
    result = response;
    sources = response.sources || [];
  } else {
    error = response?.error || 'Could not compare those pages.';
    result = null;
  }
  render();
}

shellApi = window.shell.mount({
  mode: 'shopping',
  title: 'Shopping',
  subtitle: 'Compare products side by side',
  content,
});

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });

render();

})();
