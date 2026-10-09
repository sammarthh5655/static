const { net } = require('electron');

/**
 * Gemini client.
 *
 * Runs ONLY in the main process. The API key never crosses an IPC boundary and
 * never exists in renderer or page context: a renderer sends a prompt, main
 * makes the HTTPS call, main sends back text. That is the whole contract.
 *
 * `net.request` is used rather than fetch so the call goes through Chromium's
 * network stack (proxy settings, system certificates) like every other request
 * the browser makes.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Models.
 *
 * Every id below was checked against the key this build ships with (October
 * 2026) with a plain prompt, a system instruction and a page's worth of
 * context.
 *
 * A note on pinning: Google retires specific ids, and it does so faster than
 * you would expect - gemini-2.0-flash and the whole 2.5 family already return
 * "no longer available" against this key. The chain deliberately mixes
 * `-latest` aliases (which survive a rotation) with current pinned ids (which
 * have their own separate quota). A retired id is not fatal - it is skipped,
 * and remembered as retired for the rest of the session - but it costs a round
 * trip the first time, so keep this list honest.
 *
 * Image, speech and music models (nano-banana-*, *-image, *-tts, lyria-*) are
 * NOT usable here: they do not write text, and they carry a much tighter
 * free-tier quota that 429s almost immediately on text prompts.
 */
const DEFAULT_MODEL = 'gemini-3-flash-preview';

/**
 * Used where answer quality matters more than latency (legal). Pro has little
 * or no free-tier quota, so this is a preference, never a requirement: the
 * chain carries on to the flash models when it says no.
 */
const QUALITY_MODEL = 'gemini-pro-latest';

/**
 * Tried in order when the model above fails with an overload or a quota error.
 *
 * On the free tier each model has its OWN quota, so "exceeded your current
 * quota" on one model says nothing about the next - falling back to a single
 * alternative is not enough, because that one can be exhausted too. Walking a
 * chain of distinct models is what actually keeps answering.
 *
 * Ordered by how quickly each one answers a short, no-thinking question, with
 * the lite models last: they are the quickest of all but the least careful,
 * so they are the answer of last resort rather than the first choice.
 */
const FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
];

/** First fallback, kept as a named export for tests and callers. */
const FALLBACK_MODEL = FALLBACK_MODELS[0];

/** Hard ceiling on a prompt, so a huge page selection cannot be sent whole. */
const MAX_PROMPT_CHARS = 60000;

/** Most turns of history sent back with a question. */
const MAX_HISTORY_TURNS = 20;

/** Largest thinking budget a caller may ask for. */
const MAX_THINKING = 24576;

/** How long one request may take, and the whole chain, unless told otherwise. */
const ATTEMPT_TIMEOUT = 40000;
const TOTAL_DEADLINE = 75000;

/**
 * How long a model that reported "quota exceeded" is left alone. A daily
 * allowance will not come back this afternoon, but a per-minute one will be
 * back in seconds - and resting the default model for ten minutes over a
 * burst of questions would mean ten minutes of second-best answers.
 */
const DAILY_QUOTA_REST = 60 * 60 * 1000;
const MINUTE_QUOTA_REST = 60 * 1000;

/** Not worth starting a request with less time left than this. */
const MIN_ATTEMPT = 1500;

function loadKey() {
  // Environment wins in development; otherwise the baked-in file. Both are
  // read here in main and nowhere else.
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return (require('../../main/secure/load').keys().gemini || '').trim();
  } catch {
    return '';
  }
}

let cachedKey = null;
function apiKey() {
  if (cachedKey === null) cachedKey = loadKey();
  return cachedKey;
}

function hasKey() {
  return !!apiKey();
}

/* ---- what we have learnt about each model this session ------------------- */

/**
 * Models to leave alone for a while: retired ones for the session, quota-
 * exhausted ones until their window plausibly reopens. Without this, every
 * single question paid for the same refusals before reaching a model that
 * answers - the pro model alone added a round trip to every legal request.
 */
const restingUntil = new Map();

/**
 * Which way of saying "think less" each model accepts.
 *
 * There is no single shape the whole family takes. Measured against this key:
 * the lite models reject `thinkingBudget: 0` with a bare "Request contains an
 * invalid argument", while gemini-3.7/3.8-flash and gemini-flash-latest reject
 * `thinkingLevel: 'minimal'` - and the old code sent a budget of 0 to every
 * model and treated any 400 as fatal. So the moment the chain reached a lite
 * model, the whole request failed with that unhelpful message. Now a refused
 * shape moves to the next one on the SAME model, and the shape that worked is
 * remembered so the refusal is paid for once per session, not per question.
 */
const learntShape = new Map();

/**
 * What the two maps above are keyed by. A request grounded in Google Search
 * draws on a SEPARATE allowance from a plain one - against this key a model
 * can refuse every search ("exceeded your current quota") while answering
 * plain questions happily - so a refused search must never rest the model
 * for everyone else.
 */
function slot(model, search) {
  return search ? model + '|search' : model;
}

function resting(model, now = Date.now()) {
  const until = restingUntil.get(model);
  if (until === undefined) return false;
  if (until > now) return true;
  restingUntil.delete(model);
  return false;
}

/** Shapes to try, most economical first. `null` means "send no thinking config". */
function thinkingShapes(model, thinking) {
  if (thinking === undefined) return [null];
  if (thinking === 0) {
    // Lite models are known to refuse a zero budget; start them on the level.
    return /lite/.test(model)
      ? [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null]
      : [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, null];
  }
  return [{ thinkingBudget: thinking }, { thinkingLevel: thinking <= 2048 ? 'low' : 'high' }, null];
}

function shapesFor(model, thinking, search) {
  const all = thinkingShapes(model, thinking);
  const known = learntShape.get(slot(model, search) + '|' + thinking);
  if (known === undefined) return all;
  return [all[known], ...all.filter((_, index) => index !== known)];
}

/* ---- input hygiene -------------------------------------------------------- */

/**
 * Page text arrives with whatever the page had in it. Slicing at a fixed
 * length can cut an emoji in half, and pages carry stray control characters;
 * neither should ever be the reason a request is refused.
 */
function clean(value, limit = MAX_PROMPT_CHARS) {
  let text = String(value ?? '').slice(0, limit);
  if (typeof text.toWellFormed === 'function') text = text.toWellFormed();
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** A caller-supplied thinking budget, or undefined for "the model's default". */
function thinkingOption(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(Math.round(number), MAX_THINKING);
}

/** Model ids are spliced into a URL; only accept ones shaped like an id. */
function validModel(model) {
  return typeof model === 'string' && /^[a-z0-9][a-z0-9.-]{1,63}$/.test(model);
}

function buildBody({ prompt, system, context, history, temperature, maxOutputTokens, search }, shape) {
  // Page context is prepended as a separate part so the model can tell the
  // difference between the page and the question.
  const parts = [];
  if (context) {
    parts.push({ text: 'Context from the page the user is viewing:\n\n' + clean(context) });
  }
  parts.push({ text: clean(prompt) });

  // Prior turns, so the AI page can hold a real conversation rather than
  // answering every question cold. The API expects 'model' for assistant
  // turns, not 'assistant'.
  const contents = [];
  const turns = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];
  for (const turn of turns) {
    const role = turn?.role === 'model' ? 'model' : 'user';
    const text = clean(turn?.text);
    if (text.trim()) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts });

  const temp = Number(temperature);
  const body = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(temp) ? Math.min(Math.max(temp, 0), 2) : 0.4,
      topP: 0.95,
      // A ceiling the caller can lower. 8192 is right for a long summary and
      // wasteful for a sidebar reply: the models spend their thinking budget
      // in proportion to what they are allowed to produce, so an answer that
      // was always going to be three sentences still took a long path to get
      // there.
      maxOutputTokens: Math.min(Math.max(Number(maxOutputTokens) || 8192, 64), 8192),
      // Gemini 3 spends a separate, sizeable budget on reasoning before it
      // writes anything. That is worth paying for a summary and not for
      // "what is this page about" - thinking 0 is what makes a short answer
      // feel immediate.
      ...(shape ? { thinkingConfig: shape } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: clean(system, 8000) }] };
  // Grounding: the model may run Google searches and answer from the results.
  // Only ever switched on by a caller in main, never by what a page sends.
  if (search) body.tools = [{ google_search: {} }];
  return body;
}

/* ---- the wire ------------------------------------------------------------- */

/**
 * One HTTPS round trip. Resolves with the status and parsed body whatever the
 * status; rejects only when no answer came back at all (network, timeout,
 * cancel). Swappable so the chain logic can be tested without the network.
 */
function netTransport(model, body, { signal, timeout }) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    });
    request.setHeader('Content-Type', 'application/json');
    // Header rather than a query string: the key then stays out of URLs, and
    // so out of logs and crash reports.
    request.setHeader('x-goog-api-key', apiKey());

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const fail = (kind, message) => {
      const error = new Error(message);
      error.kind = kind;
      return error;
    };

    // net.request has no timeout of its own: a stalled connection would leave
    // the sidebar saying "Thinking…" for ever.
    const timer = setTimeout(() => {
      request.abort();
      finish(reject, fail('timeout', `No answer within ${Math.round(timeout / 1000)}s.`));
    }, timeout);
    const onAbort = () => { request.abort(); finish(reject, fail('cancelled', 'Cancelled')); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* a proxy page, or a cut-off body */ }
        finish(resolve, { status: response.statusCode, json });
      });
      response.on('error', (error) => finish(reject, fail('network', error.message || 'The connection dropped.')));
    });
    request.on('error', (error) => finish(reject, fail('network', error.message || 'Could not reach Gemini.')));

    request.write(JSON.stringify(body));
    request.end();
  });
}

let transport = netTransport;

/* ---- reading Google's answer ---------------------------------------------- */

/**
 * How long to leave a model alone after a quota refusal. Google lists which
 * allowances were hit (QuotaFailure) and often how long to wait (RetryInfo,
 * "37s"); a per-day allowance in that list outranks any short delay.
 */
function quotaRest(json) {
  const details = json?.error?.details || [];
  const daily = details.some((detail) => (detail?.violations || [])
    .some((violation) => /PerDay/i.test(String(violation?.quotaId || ''))));
  if (daily) return DAILY_QUOTA_REST;
  for (const detail of details) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(detail?.retryDelay || ''));
    if (match) return Math.ceil(Number(match[1]) * 1000) + 1000;
  }
  return MINUTE_QUOTA_REST;
}

/**
 * Sort a refusal into something the chain can act on. The status code alone
 * is not enough: 400 covers a bad key, an unsupported setting and a malformed
 * request, and 429 covers both "slow down" and "nothing left today".
 */
function classify(status, json) {
  const message = String(json?.error?.message || '');
  const reasons = (json?.error?.details || []).map((detail) => String(detail?.reason || '')).join(' ');
  const kind =
    /API_KEY|API key|SERVICE_DISABLED|has not been used in project|referer|referrer|blocked by the key/i.test(message + ' ' + reasons) || status === 401
      ? 'auth'
      : /location is not supported|not available in your country/i.test(message)
        ? 'region'
        // A 403 that does not mention the key is this model being off-limits
        // to this key, not the key being bad: the next model may well answer.
        : /no longer available|not found|is not supported for generateContent|unknown model/i.test(message) || status === 404 || status === 403
          ? 'retired'
          : status === 429 && /quota|billing|exceeded/i.test(message)
            ? 'quota'
            : status === 429 || status >= 500
              ? 'busy'
              : 'invalid';
  const error = new Error(scrubKey(message || `Gemini request failed (${status}).`));
  error.kind = kind;
  error.status = status;
  if (kind === 'quota') error.rest = quotaRest(json);
  return error;
}

/** Text from a 200, or an error saying why there is none. */
function readAnswer(json) {
  if (!json) {
    const error = new Error('Gemini sent back something that was not an answer.');
    error.kind = 'busy';
    throw error;
  }
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    // Thought summaries are the model's working, not its answer.
    .filter((part) => !part.thought)
    .map((part) => part.text || '')
    .join('')
    .trim();
  if (text) return text;

  const blocked = json.promptFeedback?.blockReason
    || (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII|IMAGE_SAFETY/.test(candidate?.finishReason || '')
      ? candidate.finishReason : '');
  const error = new Error(blocked
    ? `Gemini did not answer (${blocked}).`
    : `Gemini returned an empty answer (${candidate?.finishReason || 'no candidates'}).`);
  // A safety refusal will be the same on every model; an empty answer (all
  // the budget spent thinking, say) is worth one more model.
  error.kind = blocked ? 'blocked' : 'empty';
  throw error;
}

/**
 * The web pages a grounded answer was drawn from, and what was searched for.
 * Google hands these back as its own redirect links; only http(s) addresses
 * are kept, so nothing else can reach a page as a link.
 */
function readGrounding(json) {
  const meta = json?.candidates?.[0]?.groundingMetadata;
  if (!meta) return null;
  const sources = [];
  const seen = new Set();
  for (const chunk of meta.groundingChunks || []) {
    const url = String(chunk?.web?.uri || '');
    if (!/^https?:\/\//i.test(url) || url.length > 2048 || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: clean(chunk.web.title || '', 160).trim() });
    if (sources.length >= 12) break;
  }
  const queries = (meta.webSearchQueries || [])
    .map((query) => clean(query, 160).trim()).filter(Boolean).slice(0, 8);
  return sources.length || queries.length ? { sources, queries } : null;
}

/* ---- what the person reads ------------------------------------------------- */

const FRIENDLY = {
  auth: 'Google turned down Static’s AI key, so the assistant can’t answer. ' +
    'If the key was just restricted in Google AI Studio, check the Generative Language API is still allowed.',
  region: 'Gemini isn’t available in your country or region yet, so the assistant can’t answer here.',
  quota: 'The assistant has used up its free allowance for now. It refills on its own – try again a little later.',
  busy: 'Gemini is very busy at the moment. Give it a few seconds and try again.',
  timeout: 'Gemini took too long to answer. Try again in a moment.',
  network: 'Couldn’t reach Gemini. Check your internet connection and try again.',
  blocked: 'Gemini chose not to answer that one. Try asking it a different way.',
  invalid: 'Gemini couldn’t take that request. Try a shorter question or a smaller selection.',
  empty: 'Gemini came back without an answer. Try again.',
};

/**
 * The error a caller throws on. Its message is written for the person in
 * front of the browser - "Request contains an invalid argument" told them
 * nothing - while `detail` keeps Google's own words for the log.
 */
function friendly(error) {
  if (error?.kind === 'cancelled') return error;
  const kind = FRIENDLY[error?.kind] ? error.kind : 'busy';
  const wrapped = new Error(FRIENDLY[kind]);
  wrapped.kind = kind;
  wrapped.status = error?.status;
  wrapped.detail = scrubKey(String(error?.message || ''));
  return wrapped;
}

/** Which failure to report when every model said no in its own way. */
function worst(failures) {
  // The most actionable first: a key problem beats "busy", and "busy" beats
  // a pile of quota refusals only when something was merely busy.
  const order = ['auth', 'region', 'blocked', 'network', 'timeout', 'busy', 'empty', 'quota', 'invalid', 'retired'];
  const sorted = [...failures].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const pick = sorted[0];
  // Every model retired is a build that needs new ids; to the person it is
  // the same as the service being unavailable.
  if (pick?.kind === 'retired') return Object.assign(pick, { kind: 'busy' });
  return pick;
}

function log(model, error) {
  // Main-process console only, and scrubbed: enough to tell from a terminal
  // why an answer took the route it did, without the key or the prompt.
  console.warn(`[ai] ${model}: ${error.kind}${error.status ? ' ' + error.status : ''} - ${scrubKey(String(error.message)).slice(0, 160)}`);
}

/* ---- one model ---------------------------------------------------------------- */

/**
 * Ask one model, trying the ways of switching thinking down until one is
 * accepted. Resolves with text or rejects with a classified error.
 */
async function askModel(model, options, timeLeft) {
  const shapes = shapesFor(model, options.thinking, options.search);
  const all = thinkingShapes(model, options.thinking);
  let lastError;
  for (const shape of shapes) {
    const budget = Math.min(timeLeft(), options.attemptTimeout ?? ATTEMPT_TIMEOUT);
    if (budget < MIN_ATTEMPT) break;
    const { status, json } = await transport(model, buildBody(options, shape),
      { signal: options.signal, timeout: budget });
    if (status === 200) {
      const text = readAnswer(json);
      if (options.thinking !== undefined) {
        learntShape.set(slot(model, options.search) + '|' + options.thinking,
          all.findIndex((s) => JSON.stringify(s) === JSON.stringify(shape)));
      }
      return { text, grounding: options.search ? readGrounding(json) : null };
    }
    lastError = classify(status, json);
    // A 400 while a thinking setting was sent is almost always that setting:
    // the lite models answer it with nothing more specific than "invalid
    // argument". Try the next shape on the same model before giving up on it.
    if (lastError.kind === 'invalid' && shape) continue;
    throw lastError;
  }
  throw lastError || Object.assign(new Error('Out of time.'), { kind: 'timeout' });
}

/* ---- the chain ---------------------------------------------------------------- */

/**
 * Ask Gemini, walking the model chain until one answers.
 *
 * @param {object}   options
 * @param {string}   options.prompt      the user's question
 * @param {string}   [options.system]    system instruction
 * @param {string}   [options.context]   page text the answer should draw on
 * @param {Array}    [options.history]   earlier turns: {role: 'user'|'model', text}
 * @param {string}   [options.model]     pin to exactly this model
 * @param {string}   [options.preferModel] try this one first, then the chain
 * @param {number}   [options.temperature]
 * @param {number}   [options.maxOutputTokens]
 * @param {number}   [options.thinking]  0 = as little as the model allows
 * @param {number}   [options.retries]   extra passes over models that were busy
 * @param {number}   [options.deadline]  ms for the whole request
 * @param {number}   [options.attemptTimeout] ms for any one model
 * @param {boolean}  [options.search]  ground the answer in Google Search results
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text: string, model: string, grounding?: {sources: Array, queries: Array}}>}
 */
async function generate(options = {}) {
  if (!hasKey()) {
    throw Object.assign(new Error('AI is unavailable: no Gemini key is configured in this build.'), { kind: 'auth' });
  }
  if (!options.prompt || !String(options.prompt).trim()) {
    throw Object.assign(new Error('Ask a question first.'), { kind: 'invalid' });
  }
  options = { ...options, thinking: thinkingOption(options.thinking) };

  // `model` pins the request to exactly one model - used by tests and by
  // callers that genuinely need a specific one.
  //
  // `preferModel` puts a model at the FRONT of the normal chain instead. That
  // is what a caller wanting higher quality should use: it gets the better
  // model when it is available, and still degrades to the rest of the chain
  // rather than failing outright when that model is out of quota.
  const pinned = validModel(options.model) ? options.model : null;
  const preferred = validModel(options.preferModel) ? options.preferModel : null;
  const full = pinned
    ? [pinned]
    : [...new Set([preferred, DEFAULT_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  // Skip models already known to be retired or out of quota - unless that
  // would leave nothing, in which case try them anyway: a cooldown is a
  // guess, and a guess must never be the reason nothing was asked.
  const awake = full.filter((model) => !resting(slot(model, options.search)));
  let queue = awake.length ? awake : full;

  const started = Date.now();
  const deadline = started + (options.deadline ?? TOTAL_DEADLINE);
  const timeLeft = () => deadline - Date.now();
  const passes = 1 + Math.max(0, options.retries ?? 1);
  const failures = [];
  const invalidSeen = new Set();

  for (let pass = 0; pass < passes && queue.length; pass++) {
    if (pass > 0) {
      // Everything left was merely busy. Overload comes in short bursts, so
      // a moment's pause before the second pass usually finds one free.
      const pause = Math.min(700 * pass + Math.random() * 300, timeLeft() - MIN_ATTEMPT);
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    const busy = [];
    for (const model of queue) {
      if (timeLeft() < MIN_ATTEMPT) break;
      try {
        const { text, grounding } = await askModel(model, options, timeLeft);
        return grounding ? { text, model, grounding } : { text, model };
      } catch (error) {
        if (options.signal?.aborted || error.kind === 'cancelled') {
          throw Object.assign(new Error('Cancelled'), { kind: 'cancelled' });
        }
        if (!error.kind) error.kind = 'network';
        log(options.search ? model + ' (search)' : model, error);
        failures.push(error);
        // Nothing another model can fix: say so now rather than after
        // walking the whole chain.
        if (error.kind === 'auth' || error.kind === 'region' || error.kind === 'blocked') throw friendly(error);
        if (error.kind === 'retired') { restingUntil.set(slot(model, options.search), Infinity); continue; }
        if (error.kind === 'quota') {
          restingUntil.set(slot(model, options.search), Date.now() + (error.rest || MINUTE_QUOTA_REST));
          continue;
        }
        if (error.kind === 'invalid') {
          // The same refusal from two different models is the request, not
          // the model - every other model would refuse it too.
          if (invalidSeen.has(error.message)) throw friendly(error);
          invalidSeen.add(error.message);
          continue;
        }
        busy.push(model);
      }
    }
    queue = busy;
  }

  if (!failures.length) throw friendly({ kind: 'timeout', message: 'Out of time before any model answered.' });
  throw friendly(worst(failures));
}

/** Defence in depth: never let the key appear in an error shown to a renderer. */
function scrubKey(message) {
  const key = apiKey();
  message = String(message);
  if (key && message.includes(key)) return message.split(key).join('[redacted]');
  return message;
}

/**
 * Test seams. `useTransport` swaps the network for a fake so the chain's
 * decisions can be checked without spending quota; `reset` forgets what this
 * session has learnt about each model.
 */
const _testing = {
  useTransport(fn) { transport = fn || netTransport; },
  reset() { restingUntil.clear(); learntShape.clear(); },
  thinkingShapes, classify, clean, friendly, buildBody, readGrounding,
};

module.exports = {
  generate, hasKey, DEFAULT_MODEL, QUALITY_MODEL, FALLBACK_MODEL, FALLBACK_MODELS, _testing,
};
