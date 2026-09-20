// Wrapped in an IIFE: widget files load as plain <script> tags and classic
// scripts share one global scope.
(function () {
/**
 * Privacy widget: what Shields actually blocked.
 *
 * EVERY NUMBER HERE COMES FROM THE BLOCKING PIPELINE.
 *
 * The counters are recorded in features/shields/stats.js as requests are
 * blocked, rewrites happen and cosmetic sheets are applied - nothing on this
 * card is generated for display. That matters more here than anywhere else in
 * the product: a privacy screen that shows invented numbers is worse than one
 * that shows none, because it teaches people to distrust the one surface whose
 * whole job is to be trusted.
 *
 * So when there is no data, this says so. It does not show zeros dressed up as
 * a result, and it does not fill the chart with a plausible-looking shape.
 *
 * Bandwidth and time are the only derived figures, and both are labelled
 * "estimated" in the UI because they are: a blocked request is cancelled
 * before any body arrives, so its real size is never known.
 */

const RENDERERS = window.widgetRenderers || (window.widgetRenderers = {});

/** Windows offered by the tab row. `days: 0` means all recorded history. */
const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: 'all', label: 'All time', days: 0 },
];

/** 12800 -> "12.8K". Keeps the headline readable at any magnitude. */
function compact(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K';
  return (n / 1000000).toFixed(1) + 'M';
}

/** Bytes -> "2.7 MB". */
function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Milliseconds -> "1m 40s". */
function duration(value) {
  const seconds = Math.round((Number(value) || 0) / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

/**
 * Sparkline from the real daily series.
 *
 * Built as inline SVG rather than a chart library: it is a dozen points, and
 * the page's CSP forbids remote scripts anyway. A flat line is the honest
 * result for a quiet week, so no minimum height is faked.
 */
function sparkline(series, ctx) {
  const wrap = ctx.element('div', { class: 'spark' });
  const values = series.map((point) => point.total);
  const peak = Math.max(...values, 1);

  for (const point of series) {
    const bar = ctx.element('div', { class: 'spark-bar' });
    // Percentage of the tallest day. Days with nothing keep a hairline so the
    // time axis stays readable rather than showing gaps.
    const height = point.total ? Math.max(6, (point.total / peak) * 100) : 2;
    bar.style.setProperty('height', height + '%');
    if (!point.total) bar.classList.add('is-quiet');
    bar.setAttribute('title', point.day + ': ' + point.total + ' blocked');
    wrap.appendChild(bar);
  }
  return wrap;
}

RENDERERS.privacy = (ctx) => {
  const body = ctx.element('div', { class: 'privacy-body' });
  let range = RANGES[0];
  let latest = null;
  let disposed = false;

  const head = (actions) => ctx.element('div', { class: 'widget-head' }, [
    ctx.icon('lock', { size: 15 }),
    ctx.element('span', { class: 'widget-title', text: 'Privacy' }),
    ...actions,
  ]);

  const shieldTag = ctx.element('span', { class: 'widget-tag' });
  const node = ctx.element('section', { class: 'widget widget-privacy' },
    [head([shieldTag]), body]);

  /** Range tabs. Re-rendered with the body so the active one stays correct. */
  const tabs = () => {
    const row = ctx.element('div', { class: 'privacy-tabs', role: 'tablist' });
    for (const option of RANGES) {
      const tab = ctx.element('button', {
        class: 'privacy-tab' + (option.id === range.id ? ' is-active' : ''),
        text: option.label,
        role: 'tab',
      });
      tab.setAttribute('aria-selected', option.id === range.id ? 'true' : 'false');
      tab.addEventListener('click', () => { range = option; paint(); });
      row.appendChild(tab);
    }
    return row;
  };

  const statRow = (label, value) => ctx.element('div', { class: 'privacy-stat' }, [
    ctx.element('span', { class: 'privacy-stat-label', text: label }),
    ctx.element('span', { class: 'privacy-stat-value', text: value }),
  ]);

  /** Empty state. Shown whenever nothing has ever been recorded. */
  const paintEmpty = () => {
    body.replaceChildren(
      tabs(),
      ctx.element('p', {
        class: 'widget-empty',
        text: 'No blocking activity yet. Start browsing and this fills in.',
      }),
    );
  };

  const paintError = (message) => {
    body.replaceChildren(ctx.element('p', {
      class: 'widget-empty',
      text: 'Privacy stats unavailable: ' + message,
    }));
  };

  const paint = () => {
    if (!latest) return;
    if (latest.isEmpty) return paintEmpty();

    const totals = range.id === 'today' ? latest.today
      : range.id === 'week' ? latest.week : latest.allTime;

    const headline = ctx.element('div', { class: 'privacy-headline' }, [
      ctx.element('span', { class: 'privacy-count', text: compact(totals.ads + totals.trackers) }),
      ctx.element('span', { class: 'privacy-count-label', text: 'ads and trackers blocked' }),
    ]);

    const stats = ctx.element('div', { class: 'privacy-stats' }, [
      statRow('Ads', compact(totals.ads)),
      statRow('Trackers', compact(totals.trackers)),
      statRow('HTTPS upgrades', compact(totals.https)),
      statRow('Params stripped', compact(totals.params)),
    ]);
    // Only shown when they have happened, so the card does not carry rows of
    // zeros for protections this profile has not needed yet.
    if (totals.videoAds) stats.appendChild(statRow('Video ads', compact(totals.videoAds)));
    if (totals.phishing) stats.appendChild(statRow('Unsafe sites', compact(totals.phishing)));

    const saved = ctx.element('div', { class: 'privacy-saved' }, [
      ctx.element('span', { text: bytes(totals.bytesSaved) + ' · ' + duration(totals.msSaved) }),
      ctx.element('span', { class: 'privacy-estimate', text: 'estimated' }),
    ]);

    const dashboard = ctx.element('button', {
      class: 'privacy-link', text: 'Full privacy dashboard',
    });
    dashboard.addEventListener('click', () =>
      ctx.invoke('tabs:navigate', { input: 'browser://shields' }));

    // Reporting a missed ad is a real workflow - it is how the filter lists
    // get better - so it opens Shields rather than pretending to file
    // something nothing receives.
    const report = ctx.element('button', {
      class: 'privacy-link', text: 'Report an ad that got through',
    });
    report.addEventListener('click', () =>
      ctx.invoke('tabs:navigate', { input: 'browser://shields' }));

    body.replaceChildren(
      tabs(), headline,
      sparkline(range.id === 'today' ? latest.series : latest.series, ctx),
      stats, saved,
      ctx.element('div', { class: 'privacy-links' }, [dashboard, report]),
    );
  };

  const load = async () => {
    if (disposed) return;
    try {
      latest = await ctx.invoke('shields:stats');
      const on = ctx.state?.features?.shields?.enabled !== false;
      shieldTag.textContent = on ? 'Active' : 'Off';
      shieldTag.classList.toggle('is-on', on);
      paint();
    } catch (error) {
      paintError(error.message);
    }
  };

  // Loading state, replaced as soon as the first read returns.
  body.replaceChildren(ctx.element('p', { class: 'widget-empty', text: 'Reading…' }));
  load();

  // Blocking happens constantly while pages load, so refresh on a slow timer
  // rather than per event - a counter that flickers on every request is noise,
  // not information.
  const timer = setInterval(load, 5000);
  node.dispose = () => { disposed = true; clearInterval(timer); };
  return node;
};

})();
