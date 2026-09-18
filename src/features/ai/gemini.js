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
 * Default model.
 *
 * The `-latest` alias rather than a pinned version on purpose: Google retires
 * specific model ids (a pinned gemini-2.0-flash already 404s with "no longer
 * available"), and a browser feature should not break because a model rotated.
 * Flash is the right speed/quality trade-off for interactive answers.
 */
const DEFAULT_MODEL = 'gemini-flash-latest';

/** Used where answer quality matters more than latency (summaries, legal). */
const QUALITY_MODEL = 'gemini-pro-latest';

/** Tried when the default model is overloaded - smaller, less contended. */
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

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
  const attempts = options.retries ?? 4;
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await generateOnce(options);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts || options.signal?.aborted) break;

      // Exponential backoff with jitter: 0.6s, 1.2s, 2.4s, 4.8s. Flash models
      // return "experiencing high demand" in bursts, and a couple of quick
      // retries is not enough to ride one out - without this the user sees a
      // failure for something that would have succeeded a moment later.
      const base = 600 * Math.pow(2, attempt);
      const delay = base + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Fall back to the lite model once the preferred one keeps refusing;
      // a fast answer from a smaller model beats an error message.
      if (attempt >= 1 && !options.model) {
        options = { ...options, model: FALLBACK_MODEL };
      }
    }
  }
  throw lastError;
}

function generateOnce({ prompt, system, context, model = DEFAULT_MODEL, temperature = 0.4, signal } = {}) {
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

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      topP: 0.95,
      maxOutputTokens: 2048,
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

module.exports = { generate, hasKey, DEFAULT_MODEL, QUALITY_MODEL, FALLBACK_MODEL };
