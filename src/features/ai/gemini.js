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
 * Verified against the key this build ships with - all three answer plain,
 * system-instruction and page-context prompts.
 *
 * A note on pinning: Google retires specific ids, and it does so faster than
 * you would expect - gemini-2.0-flash, gemini-2.5-flash and gemini-2.5-flash-lite
 * all already return "no longer available" against this key. Every entry below
 * was verified to answer before being listed, and the chain deliberately mixes
 * `-latest` aliases (which survive a rotation) with current pinned ids (which
 * have their own separate quota). A retired id in the chain is not fatal - the
 * loop simply moves on - but it wastes a round trip, so keep this list honest.
 *
 * Image models (gemini-*-flash-image, nano-banana-*) are NOT usable here: they
 * generate pictures, and they carry a much tighter free-tier quota that 429s
 * almost immediately on text prompts.
 */
const DEFAULT_MODEL = 'gemini-3-flash-preview';

/** Used where answer quality matters more than latency (summaries, legal). */
const QUALITY_MODEL = 'gemini-pro-latest';

/**
 * Tried in order when the model above fails with an overload or a quota error.
 *
 * On the free tier each model has its OWN daily quota, so "exceeded your
 * current quota" on one model says nothing about the next - falling back to a
 * single alternative is not enough, because that one can be exhausted too.
 * Walking a chain of distinct model families is what actually keeps answering.
 */
const FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
];

/** First fallback, kept as a named export for tests and callers. */
const FALLBACK_MODEL = FALLBACK_MODELS[0];

/** Hard ceiling on a prompt, so a huge page selection cannot be sent whole. */
const MAX_PROMPT_CHARS = 60000;

function loadKey() {
  // Environment wins in development; otherwise the baked-in file. Both are
  // read here in main and nowhere else.
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return (require('../../main/secure/keys').gemini || '').trim();
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

/**
 * One request to Gemini.
 *
 * @param {object}   options
 * @param {string}   options.prompt      the user's question
 * @param {string}   [options.system]    system instruction
 * @param {string}   [options.context]   page text the answer should draw on
 * @param {string}   [options.model]
 * @param {number}   [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text: string, model: string}>}
 */
/** Status codes worth retrying: rate limit, overload, and transient 5xx. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * `generate` with backoff. Gemini returns "currently experiencing high demand"
 * often enough that surfacing it to the user on the first try would make the
 * feature feel broken when it is merely busy.
 */
async function generate(options = {}) {
  // `model` pins the request to exactly one model - used by tests and by
  // callers that genuinely need a specific one.
  //
  // `preferModel` puts a model at the FRONT of the normal chain instead. That
  // is what a caller wanting higher quality should use: it gets the better
  // model when it is available, and still degrades to the rest of the chain
  // rather than failing outright when that model is out of quota.
  const chain = options.model
    ? [options.model]
    : options.preferModel
      ? [options.preferModel, DEFAULT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== options.preferModel)]
      : [DEFAULT_MODEL, ...FALLBACK_MODELS];

  let lastError;
  for (const model of chain) {
    // Retry the SAME model briefly before moving on: overload is usually a
    // short burst, whereas a quota error is good for the rest of the day.
    const attempts = options.retries ?? 2;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        return await generateOnce({ ...options, model });
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw error;
        // Quota is exhausted until the window resets - retrying the same model
        // just burns time, so move to the next one immediately.
        if (error.quota) break;
        // A retired model will never answer; move to the next one rather than
        // failing the whole request.
        if (error.retired) break;
        if (!error.retryable) throw error;
        if (attempt === attempts) break;

        // Exponential backoff with jitter: ~0.6s then ~1.2s. Flash models
        // return "experiencing high demand" in bursts, and answering a moment
        // later beats showing the user an error.
        const delay = 600 * Math.pow(2, attempt) + Math.random() * 300;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

function generateOnce({ prompt, system, context, history, model = DEFAULT_MODEL, temperature = 0.4, signal } = {}) {
  const key = apiKey();
  if (!key) {
    return Promise.reject(new Error('AI is unavailable: no Gemini key is configured in this build.'));
  }
  if (!prompt || !String(prompt).trim()) {
    return Promise.reject(new Error('Ask a question first.'));
  }

  // Page context is prepended as a separate part so the model can tell the
  // difference between the page and the question.
  const parts = [];
  if (context) {
    parts.push({ text: 'Context from the page the user is viewing:\n\n' +
      String(context).slice(0, MAX_PROMPT_CHARS) });
  }
  parts.push({ text: String(prompt).slice(0, MAX_PROMPT_CHARS) });

  // Prior turns, so the AI page can hold a real conversation rather than
  // answering every question cold. The API expects 'model' for assistant
  // turns, not 'assistant'.
  const contents = [];
  for (const turn of Array.isArray(history) ? history : []) {
    const role = turn.role === 'model' ? 'model' : 'user';
    const text = String(turn.text || '').slice(0, MAX_PROMPT_CHARS);
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts });

  const body = {
    contents,
    generationConfig: {
      temperature,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    });
    request.setHeader('Content-Type', 'application/json');
    // Header rather than a query string: the key then stays out of URLs, and
    // so out of logs and crash reports.
    request.setHeader('x-goog-api-key', key);

    let aborted = false;
    const onAbort = () => { aborted = true; request.abort(); reject(new Error('Cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return reject(new Error('Gemini returned a response that could not be read.')); }

        if (response.statusCode !== 200) {
          // Surface the API's own message, but never echo the key back.
          const message = parsed?.error?.message || `Gemini request failed (${response.statusCode}).`;
          const error = new Error(scrubKey(message));
          error.status = response.statusCode;
          // Overload is reported as 429/503 and is worth retrying; a bad
          // request or a revoked key is not.
          error.retryable = RETRYABLE.has(response.statusCode);
          // A 429 covers BOTH "slow down" and "daily quota gone", and only the
          // message distinguishes them. Quota means skip to the next model
          // rather than waiting out a window that will not reopen today.
          error.quota = /quota|billing|exceeded/i.test(message);
          // Google retires ids on its own schedule; treat that as "try the
          // next model", not as a hard failure.
          error.retired = /no longer available|not found|is not supported/i.test(message);
          return reject(error);
        }

        const candidate = parsed?.candidates?.[0];
        const text = (candidate?.content?.parts || [])
          .map((part) => part.text || '')
          .join('')
          .trim();

        if (!text) {
          const blocked = parsed?.promptFeedback?.blockReason || candidate?.finishReason;
          return reject(new Error(blocked
            ? `Gemini did not answer (${blocked}).`
            : 'Gemini returned an empty answer.'));
        }
        resolve({ text, model });
      });
    });

    request.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) return;
      // A network blip is always worth one more try.
      const wrapped = new Error(scrubKey(error.message || 'Could not reach Gemini.'));
      wrapped.retryable = true;
      reject(wrapped);
    });

    request.write(JSON.stringify(body));
    request.end();
  });
}

/** Defence in depth: never let the key appear in an error shown to a renderer. */
function scrubKey(message) {
  const key = apiKey();
  if (key && message.includes(key)) return message.split(key).join('[redacted]');
  return message;
}

module.exports = { generate, hasKey, DEFAULT_MODEL, QUALITY_MODEL, FALLBACK_MODEL, FALLBACK_MODELS };
