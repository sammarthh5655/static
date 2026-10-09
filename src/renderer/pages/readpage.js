'use strict';

/**
 * "Read this page", for the Legal and Shopping mode pages: window.readPage.
 *
 * A mode page is a tab of its own, so "this page" means the web page the
 * person was on before they came here. Main works out which one that is
 * (workspace:recent-page) and the hero names it before anything is read, so
 * nobody has to wonder which tab is about to be analysed.
 *
 * The model answers in labelled sections (features/workspaces READ_PAGE),
 * which are laid out here as their own blocks. Everything it says is placed
 * with textContent, never parsed as markup. When the answer does not follow
 * the shape, it is shown as written rather than lost.
 */
(function () {

const { invoke, element, icon } = window.page;
const narrator = window.narrator;

const MODES = {
  legal: {
    eyebrow: 'Read this page',
    heading: 'Understand the page you were just on',
    blurb: 'A plain-English summary, who is involved, the clauses that matter, '
      + 'what has to be done by when, and anything that should give you pause.',
    empty: 'Open a contract, terms page, policy or judgment in a tab, then come back here.',
    steps: ['Reading the fine print…', 'Finding the parties…', 'Weighing each clause…',
      'Listing deadlines…', 'Looking for red flags…'],
    noun: 'legal reading',
  },
  shopping: {
    eyebrow: 'Read this page',
    heading: 'Is it worth buying?',
    blurb: 'The real price, the specs that matter, what reviewers on the page '
      + 'say, and what to check before you pay.',
    empty: 'Open a product page in a tab, then come back here.',
    steps: ['Finding the price…', 'Picking out the specs…', 'Reading the reviews…',
      'Weighing up the value…', 'Checking the small print…'],
    noun: 'shopping read',
  },
};

/* ---- parsing ------------------------------------------------------------------ */

/**
 * Split the answer into its labelled sections: { LABEL: { lead, items } }.
 * Tolerates the usual drift - stray markdown, a label on its own line with the
 * text below it, bullets drawn as "•" or "*".
 */
function parseSections(text, labels) {
  const known = new Set([...labels, 'NOT LEGAL', 'NOT A PRODUCT']);
  const sections = {};
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*\*|__/g, '').replace(/^#+\s*/, '').trim();
    if (!line) continue;
    // Labels are asked for in capitals; "Summary:" is the same label.
    const match = /^([A-Za-z][A-Za-z ,&]*[A-Za-z])\s*:\s*(.*)$/.exec(line);
    const label = match ? match[1].toUpperCase() : '';
    if (match && known.has(label)) {
      current = { lead: match[2].trim(), items: [] };
      sections[label] = current;
      continue;
    }
    if (!current) continue;
    const bullet = /^(?:[-•*–]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) current.items.push(bullet[1].trim());
    else if (current.items.length) current.items[current.items.length - 1] += ' ' + line;
    else current.lead = current.lead ? current.lead + ' ' + line : line;
  }
  return sections;
}

/** "Name - role" into its two halves; the whole line as the first when there is no dash. */
function splitPair(line, separator = /\s+[-–—]\s+/) {
  const match = separator.exec(line);
  if (!match) return [line, ''];
  return [line.slice(0, match.index).trim(), line.slice(match.index + match[0].length).trim()];
}

/** "Automatic renewal: what it means" with the short name in bold, when it has one. */
function withTitle(line) {
  const match = /^([^:.]{2,42}):\s+(.+)$/.exec(line);
  if (!match) return element('span', { text: line });
  return element('span', {}, [element('strong', { class: 'rp-item-title', text: match[1] + ': ' }), match[2]]);
}

/**
 * "₹7,999 (was ₹12,999, 38% off)" into the price itself and the rest, so the
 * figure can be large and the small print small.
 */
function splitPrice(price) {
  const match = /^(.*?\d[\d,.]*(?:\s?(?:INR|USD|EUR|GBP))?)(?:\s*[(;–]\s*|,\s+|\s+-\s+|\s+)(.+?)\)?$/.exec(price);
  // A range ("£20 to £30") is one figure, not a price and a note.
  if (!match || match[1].length >= 24 || /^to\s/i.test(match[2])) return [price, ''];
  return [match[1].trim(), match[2].trim()];
}

function isMissing(value) {
  return !value || /^(not found|none|n\/a|not stated|not given)\.?$/i.test(value.trim());
}

/* ---- small builders ------------------------------------------------------------ */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** The page's own icon, or its first letter when it has none or it fails. */
function siteMark(source) {
  const letter = () => element('span', {
    class: 'rp-mark-letter', text: (source?.host || '?').charAt(0).toUpperCase(),
  });
  const mark = element('span', { class: 'rp-mark' });
  if (source?.favicon) {
    const img = element('img', { src: source.favicon, alt: '', width: '18', height: '18' });
    img.addEventListener('error', () => img.replaceWith(letter()));
    mark.append(img);
  } else {
    mark.append(letter());
  }
  return mark;
}

/** A small text button that says what it did for a moment. */
function actionButton(label, iconName, run, extraClass = '') {
  const text = element('span', { text: label });
  const button = element('button', { class: 'rp-action ' + extraClass }, [icon(iconName, { size: 14 }), text]);
  button.addEventListener('click', async () => {
    const said = await run(button);
    if (!said) return;
    text.textContent = said;
    button.classList.add('done');
    setTimeout(() => { text.textContent = label; button.classList.remove('done'); }, 1500);
  });
  button.label = text;
  return button;
}

/* ---- the component --------------------------------------------------------------- */

function create({ mode, onUseAsSource = null, disclaimer = () => '' }) {
  const copy = MODES[mode];
  let recent = null;      // the page that would be read, from main
  let busy = false;
  let answer = null;      // last workspace:read-page response
  let stepTimer = 0;
  let spoken = [];        // [{ text, el }] - the result, in reading order

  /* ---- hero ---- */

  const sourceSlot = element('div', { class: 'rp-target' });
  const readButton = element('button', { class: 'rp-go', onclick: () => read() }, [
    icon('sparkle', { size: 16 }),
    element('span', { class: 'rp-go-label', text: 'Read this page' }),
  ]);
  const listenPageButton = element('button', {
    class: 'rp-listen-page', title: 'Read the page itself aloud',
    onclick: () => listenToPage(),
  }, [icon('volume', { size: 15 }), element('span', { text: 'Listen to it' })]);

  const heroNote = element('p', { class: 'rp-hero-note', role: 'status' });

  const lines = Array.from({ length: 7 }, (_, index) => element('span', { class: 'rp-doc-line rp-doc-line-' + index }));
  const illustration = element('div', { class: 'rp-doc rp-doc-' + mode, 'aria-hidden': 'true' }, [
    element('div', { class: 'rp-doc-sheet' }, [
      ...lines,
      mode === 'shopping' ? element('span', { class: 'rp-doc-tag' }) : element('span', { class: 'rp-doc-seal' }),
      element('span', { class: 'rp-doc-beam' }),
    ]),
  ]);

  const hero = element('section', { class: 'rp-hero rp-hero-' + mode }, [
    element('div', { class: 'rp-hero-glow', 'aria-hidden': 'true' }),
    element('div', { class: 'rp-hero-copy' }, [
      element('div', { class: 'rp-eyebrow', text: copy.eyebrow }),
      element('h2', { class: 'rp-heading', text: copy.heading }),
      element('p', { class: 'rp-blurb', text: copy.blurb }),
      sourceSlot,
      element('div', { class: 'rp-hero-actions' }, [readButton, listenPageButton]),
      heroNote,
    ]),
    illustration,
  ]);

  function paintTarget() {
    if (!recent) {
      sourceSlot.replaceChildren(element('div', { class: 'rp-target-empty' }, [
        icon('info', { size: 14 }),
        element('span', { text: copy.empty }),
      ]));
    } else {
      sourceSlot.replaceChildren(
        element('span', { class: 'rp-target-label', text: 'The page you were on' }),
        element('button', {
          class: 'rp-target-page', title: 'Go to ' + recent.url,
          onclick: () => invoke('tabs:select', { id: recent.id }),
        }, [
          siteMark(recent),
          element('span', { class: 'rp-target-title', text: recent.title || recent.host }),
          element('span', { class: 'rp-target-host', text: recent.loading ? 'still loading…' : recent.host }),
        ]),
      );
    }
    readButton.disabled = busy || !recent;
    listenPageButton.disabled = !recent || !narrator?.available();
    if (!narrator?.available()) listenPageButton.title = 'Read aloud is not available on this computer';
    readButton.querySelector('.rp-go-label').textContent = busy ? 'Reading…' : 'Read this page';
    hero.classList.toggle('is-busy', busy);
    hero.classList.toggle('has-target', !!recent);
  }

  let refreshTimer = 0;
  /** Ask main again which page would be read. Cheap, and debounced. */
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const next = await invoke('workspace:recent-page').catch(() => null);
      const value = next?.ok ? next : null;
      if (JSON.stringify(value) === JSON.stringify(recent)) return;
      recent = value;
      heroNote.textContent = '';
      paintTarget();
    }, 120);
  }

  /* ---- result ---- */

  const result = element('div', { class: 'rp-result-slot' });

  function say(el, text) {
    if (text && String(text).trim()) spoken.push({ el, text: String(text).trim() });
    return el;
  }

  function sectionCard(label, iconName, body, extra = '') {
    const heading = say(element('div', { class: 'rp-section-head' }, [
      icon(iconName, { size: 14 }),
      element('span', { text: label }),
    ]), label + '.');
    return element('section', { class: 'rp-section ' + extra }, [heading, body]);
  }

  function listOf(items, build) {
    return element('ul', { class: 'rp-list' }, items.map((item) => say(build(item), item.replace(/^\[[^\]]*\]\s*/, ''))));
  }

  function renderLegal(sections, body) {
    const summary = sections.SUMMARY?.lead || '';
    const kind = sections.DOCUMENT?.lead || '';
    body.append(element('div', { class: 'rp-lead rp-stagger' }, [
      kind && !isMissing(kind) ? say(element('div', { class: 'rp-kind' }, [icon('doc', { size: 13 }), element('span', { text: kind })]), kind) : null,
      summary ? say(element('p', { class: 'rp-summary', text: summary }), summary) : null,
    ]));

    const grid = element('div', { class: 'rp-grid' });
    const parties = sections.PARTIES?.items || [];
    if (parties.length) {
      grid.append(sectionCard('Parties', 'user', element('div', { class: 'rp-parties' }, parties.map((line) => {
        const [name, role] = splitPair(line);
        return say(element('div', { class: 'rp-party' }, [
          element('span', { class: 'rp-party-name', text: name }),
          role ? element('span', { class: 'rp-party-role', text: role }) : null,
        ]), line);
      }))));
    }
    const clauses = sections['KEY CLAUSES']?.items || [];
    if (clauses.length) {
      grid.append(sectionCard('Key clauses', 'doc', listOf(clauses, (line) => {
        const [name, meaning] = splitPair(line);
        return element('li', { class: 'rp-clause' }, [
          element('span', { class: 'rp-clause-name', text: meaning ? name : '' }),
          element('span', { class: 'rp-clause-text', text: meaning || name }),
        ]);
      })));
    }
    const duties = sections['OBLIGATIONS AND DEADLINES']?.items || [];
    if (duties.length) {
      grid.append(sectionCard('Obligations and deadlines', 'clock', listOf(duties, (line) => {
        const when = /^\[([^\]]{1,48})\]\s*(.*)$/.exec(line);
        return element('li', { class: 'rp-duty' + (when ? ' dated' : '') }, [
          when ? element('span', { class: 'rp-when', text: when[1] }) : null,
          // "[Monthly] the customer must pay" reads as a sentence once the
          // date is lifted out into its pill, so it starts with a capital.
          element('span', { text: when ? when[2].charAt(0).toUpperCase() + when[2].slice(1) : line }),
        ]);
      }), 'rp-wide'));
    }
    const risks = sections['RISKS AND RED FLAGS']?.items || [];
    if (risks.length) {
      // Most serious first, whatever order the model gave them in.
      const weight = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const ranked = risks.map((line) => {
        const level = /^\[(HIGH|MEDIUM|LOW)\]\s*/i.exec(line);
        return { level: level ? level[1].toUpperCase() : 'MEDIUM', text: level ? line.slice(level[0].length) : line };
      }).sort((a, b) => weight[a.level] - weight[b.level]);
      grid.append(sectionCard('Risks and red flags', 'warn', element('ul', { class: 'rp-list rp-risks' }, ranked.map((risk) => say(
        element('li', { class: 'rp-risk rp-risk-' + risk.level.toLowerCase() }, [
          element('span', { class: 'rp-level', text: { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }[risk.level] }),
          withTitle(risk.text),
        ]), risk.level.toLowerCase() + ' risk: ' + risk.text))), 'rp-wide rp-section-risk'));
    }
    const questions = sections['ASK ABOUT']?.items || [];
    if (questions.length) {
      grid.append(sectionCard('Worth asking', 'help', listOf(questions, (line) => element('li', { class: 'rp-question', text: line })), 'rp-wide'));
    }
    body.append(grid);
  }

  const VALUE_CLASS = { 'great value': 'great', 'fair value': 'fair', 'poor value': 'poor' };

  function renderShopping(sections, body) {
    const name = sections.PRODUCT?.lead || answer.source?.title || 'This product';
    const price = sections.PRICE?.lead || '';
    const rating = sections.RATING?.lead || '';
    const value = (sections.VALUE?.lead || 'Hard to say').replace(/\.$/, '');
    const valueClass = VALUE_CLASS[value.toLowerCase()] || 'unsure';

    body.append(element('div', { class: 'rp-product rp-stagger' }, [
      element('div', { class: 'rp-product-main' }, [
        say(element('h3', { class: 'rp-product-name', text: name }), name),
        element('div', { class: 'rp-product-facts' }, [
          say(isMissing(price)
            ? element('span', { class: 'rp-price missing', text: 'Price not shown' })
            : element('span', { class: 'rp-price-block' }, [
                element('span', { class: 'rp-price', text: splitPrice(price)[0] }),
                splitPrice(price)[1] ? element('span', { class: 'rp-price-note', text: splitPrice(price)[1] }) : null,
              ]),
            isMissing(price) ? 'The page does not show a price.' : 'Price: ' + price),
          !isMissing(rating) ? say(element('span', { class: 'rp-rating' }, [icon('star', { size: 13, filled: true }), element('span', { text: rating })]), 'Rated ' + rating) : null,
        ]),
      ]),
      say(element('div', { class: 'rp-value rp-value-' + valueClass }, [
        element('span', { class: 'rp-value-label', text: 'Value' }),
        element('span', { class: 'rp-value-word', text: value }),
      ]), 'Value: ' + value + '.'),
    ]));

    const grid = element('div', { class: 'rp-grid' });
    const specs = sections.SPECS?.items || [];
    if (specs.length) {
      grid.append(sectionCard('Key specs', 'grid', element('dl', { class: 'rp-specs' }, specs.map((line) => {
        const [label, detail] = splitPair(line, /\s*:\s+/);
        return say(element('div', { class: 'rp-spec' }, [
          element('dt', { text: detail ? label : 'Spec' }),
          element('dd', { text: detail || label }),
        ]), line);
      })), 'rp-wide'));
    }
    const pros = sections.PROS?.items || [];
    const cons = sections.CONS?.items || [];
    if (pros.length) grid.append(sectionCard('What people like', 'check', listOf(pros, (line) => element('li', { class: 'rp-pro', text: line })), 'rp-section-pros'));
    if (cons.length) grid.append(sectionCard('What to watch', 'warn', listOf(cons, (line) => element('li', { class: 'rp-con', text: line })), 'rp-section-cons'));

    const reviews = sections.REVIEWS?.lead || '';
    if (reviews) {
      grid.append(sectionCard('What the reviews say', 'chat',
        say(element('blockquote', { class: 'rp-quote', text: reviews }), reviews), 'rp-wide'));
    }
    const verdict = sections.VERDICT?.lead || '';
    if (verdict) {
      grid.append(sectionCard('Verdict', 'sparkle', say(element('p', { class: 'rp-verdict', text: verdict }), verdict), 'rp-wide rp-section-verdict'));
    }
    const checks = sections['CHECK BEFORE BUYING']?.items || [];
    if (checks.length) {
      // Ticks are for the person's own use while they check; nothing is kept.
      // The whole row is the checkbox, not just the little box: that is where
      // people click.
      const toggle = (row) => {
        const on = !row.classList.contains('ticked');
        row.classList.toggle('ticked', on);
        row.setAttribute('aria-checked', String(on));
      };
      grid.append(sectionCard('Check before buying', 'shield', element('ul', { class: 'rp-list rp-checks' }, checks.map((line) => say(
        element('li', {
          class: 'rp-check', role: 'checkbox', tabindex: '0', 'aria-checked': 'false',
          onclick: (event) => toggle(event.currentTarget),
          onkeydown: (event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            event.preventDefault();
            toggle(event.currentTarget);
          },
        }, [
          element('span', { class: 'rp-tick', 'aria-hidden': 'true' }, [icon('check', { size: 12 })]),
          element('span', { text: line }),
        ]), line))), 'rp-wide'));
    }
    body.append(grid);
  }

  function plainText() {
    return String(answer?.text || '').trim();
  }

  const listenButton = actionButton('Listen', 'volume', () => {
    const state = narrator.state();
    if (state.key === 'result' && (state.playing || state.paused)) { narrator.toggle(); return ''; }
    narrator.play({
      title: (mode === 'legal' ? 'Legal reading of ' : 'Shopping read of ') + (answer?.source?.title || 'the page'),
      items: spoken.length ? spoken : narrator.paragraphs(plainText()),
      key: 'result',
    });
    return '';
  }, 'rp-action-listen');

  function paintListen() {
    if (!narrator) return;
    const state = narrator.state();
    const mine = state.key === 'result';
    listenButton.label.textContent = mine && state.playing ? 'Pause' : mine && state.paused ? 'Carry on' : 'Listen';
    listenButton.classList.toggle('active', mine && (state.playing || state.paused));
    listenButton.disabled = !narrator.available();
    const pageMine = state.key === 'page' && (state.playing || state.paused);
    listenPageButton.classList.toggle('active', pageMine);
    listenPageButton.querySelector('span').textContent = pageMine ? (state.playing ? 'Pause' : 'Carry on') : 'Listen to it';
  }
  narrator?.subscribe(paintListen);

  function renderResult() {
    spoken = [];
    if (busy) {
      const step = element('span', { class: 'rp-step', text: copy.steps[0] });
      let index = 0;
      clearInterval(stepTimer);
      stepTimer = setInterval(() => {
        index = (index + 1) % copy.steps.length;
        step.textContent = copy.steps[index];
        step.classList.remove('rp-step-in');
        void step.offsetWidth;
        step.classList.add('rp-step-in');
      }, 1900);
      result.replaceChildren(element('div', { class: 'panel-card rp-result rp-loading', 'aria-busy': 'true' }, [
        element('div', { class: 'rp-loading-head' }, [
          recent ? siteMark(recent) : null,
          element('div', {}, [
            element('div', { class: 'rp-loading-title', text: 'Reading ' + (recent?.host || 'the page') }),
            step,
          ]),
        ]),
        element('div', { class: 'rp-skeleton' }, Array.from({ length: 6 }, () => element('span'))),
      ]));
      return;
    }
    clearInterval(stepTimer);
    if (!answer) { result.replaceChildren(); return; }

    if (!answer.ok) {
      result.replaceChildren(element('div', { class: 'panel-card rp-result rp-error' }, [
        element('div', { class: 'rp-error-mark' }, [icon('warn', { size: 18 })]),
        element('div', { class: 'rp-error-body' }, [
          element('div', { class: 'rp-error-title', text: 'That page could not be read' }),
          element('p', { class: 'rp-error-text', text: answer.error || 'Something went wrong.' }),
        ]),
        element('button', { class: 'rp-action', onclick: () => read() }, [icon('reload', { size: 14 }), element('span', { text: 'Try again' })]),
      ]));
      return;
    }

    const source = answer.source || {};
    const sections = parseSections(answer.text, answer.sections || []);
    const body = element('div', { class: 'rp-body' });
    const notApplicable = sections['NOT LEGAL'] || sections['NOT A PRODUCT'];
    const shaped = Object.keys(sections).length >= 2;

    if (notApplicable) {
      body.append(element('div', { class: 'rp-notice' }, [
        icon('info', { size: 16 }),
        element('div', {}, [
          element('div', { class: 'rp-notice-title', text: mode === 'legal' ? 'Nothing legal to read here' : 'This does not look like a product page' }),
          say(element('p', { text: notApplicable.lead }), notApplicable.lead),
        ]),
      ]));
    } else if (!shaped) {
      body.append(say(element('div', { class: 'rp-plain', text: plainText() }), plainText()));
    } else if (mode === 'legal') {
      renderLegal(sections, body);
    } else {
      renderShopping(sections, body);
    }

    const tools = [
      listenButton,
      actionButton('Copy', 'copy', async () => {
        try { await navigator.clipboard.writeText(plainText()); return 'Copied'; } catch { return 'Copy failed'; }
      }),
      actionButton('Save to Notes', 'bookmark', async () => {
        await invoke('notes:add', {
          kind: 'summary',
          title: (mode === 'legal' ? 'Legal reading: ' : 'Shopping read: ') + (source.title || source.host),
          body: plainText(),
          url: source.url,
          tags: [mode],
        });
        return 'Saved';
      }),
      mode === 'legal' && onUseAsSource && answer.pageText
        ? actionButton('Use as source', 'import', () => { onUseAsSource(answer.pageText, source); return 'In the source box'; })
        : null,
      actionButton('Read again', 'reload', () => { read(); return ''; }),
    ];

    const card = element('div', { class: 'panel-card rp-result' }, [
      element('div', { class: 'rp-result-head' }, [
        element('button', {
          class: 'rp-source', title: 'Go to ' + source.url,
          onclick: () => source.id && invoke('tabs:select', { id: source.id }).catch(() => {}),
        }, [
          siteMark(source),
          element('span', { class: 'rp-source-text' }, [
            element('span', { class: 'rp-source-title', text: source.title || source.host }),
            element('span', {
              class: 'rp-source-meta',
              text: [
                source.host || hostOf(source.url),
                source.selection ? 'just the part you selected' : null,
                source.words ? source.words.toLocaleString() + ' words read' : null,
              ].filter(Boolean).join(' · '),
            }),
          ]),
        ]),
        answer.model ? element('span', { class: 'rp-model', text: answer.model }) : null,
      ]),
      element('div', { class: 'rp-tools' }, tools.filter(Boolean)),
      body,
      mode === 'legal' && disclaimer()
        ? element('p', { class: 'rp-disclaimer' }, [icon('info', { size: 13 }), element('span', { text: disclaimer() })])
        : null,
      mode === 'shopping'
        ? element('p', { class: 'rp-disclaimer' }, [icon('info', { size: 13 }), element('span', {
            text: 'Read from the page as it is now. Prices and stock change - check them on the site before you pay.',
          })])
        : null,
    ]);
    result.replaceChildren(card);
    paintListen();
  }

  async function read() {
    if (busy) return;
    if (narrator?.state().key === 'result') narrator.stop();
    busy = true;
    heroNote.textContent = '';
    // Name the page now: the hero may not have caught up with a tab switch.
    // A tab closed since then is forgotten rather than named in the error.
    const latest = await invoke('workspace:recent-page').catch(() => null);
    recent = latest?.ok ? latest : null;
    paintTarget();
    renderResult();
    result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    answer = await invoke('workspace:read-page', { mode }).catch((error) => ({ ok: false, error: error.message }));
    busy = false;
    paintTarget();
    renderResult();
  }

  async function listenToPage() {
    const state = narrator.state();
    if (state.key === 'page' && (state.playing || state.paused)) { narrator.toggle(); return; }
    heroNote.textContent = '';
    const page = await invoke('workspace:page-text').catch((error) => ({ ok: false, error: error.message }));
    if (!page?.ok) {
      // Said beside the button that was pressed, so a reading already on
      // screen is not swapped for an error about something else.
      heroNote.textContent = page?.error || 'That page could not be read.';
      return;
    }
    narrator.play({ title: page.title || page.host || 'The page', items: narrator.paragraphs(page.text), key: 'page' });
  }

  paintTarget();
  refresh();
  return { hero, result, refresh, read, parseSections };
}

window.readPage = { create, parseSections };

})();
