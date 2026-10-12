/**
 * A stand-in for Gemini, for probes.
 *
 * Test runs never call the real API (src/features/ai/gemini.js refuses
 * off-screen): its free allowance is the person's, and probes once used it
 * up. Probes that need answers used to fail by construction because of that.
 *
 * The stand-in replaces only the HTTP transport, so everything above it is
 * still the real thing: the request body, the model chain and its retries,
 * response parsing, and the whole UI. Its answers are deterministic and are
 * computed FROM the request, so a check like "remembers earlier turns" still
 * means something: the stand-in can only answer "BANANA" to "what did you
 * just say?" if the earlier turns were actually sent.
 *
 * `node scripts/start.cjs --<probe> --live-gemini` (or `npm run probes --
 * --live-gemini`) uses the real API instead, to check the key and the model
 * ids. That spends the person's allowance, so it is never the default.
 */

const live = () => process.env.STATIC_LIVE_GEMINI === '1';

/** The text of every part of one content entry. */
const textOf = (content) => (content?.parts || []).map((part) => part.text || '').join('\n');

/**
 * Answer a generateContent body the way a cooperative model would. It writes
 * markdown, as models do, UNLESS the system instruction asks for plain text -
 * so a check for "no stray asterisks" fails if the app stops asking.
 */
function answer(body) {
  const text = compose(body);
  const plain = /no markdown/i.test(textOf(body?.systemInstruction));
  return plain ? text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^- /gm, '') : text;
}

function compose(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const last = contents[contents.length - 1];
  const parts = (last?.parts || []).map((part) => part.text || '');
  const context = parts.find((text) => /^Context from the page/.test(text)) || '';
  const question = parts.filter((text) => !/^Context from the page/.test(text)).join('\n').trim();
  const history = contents.slice(0, -1);

  let match;
  if ((match = /Reply with exactly:\s*(\S+)/i.exec(question))) return match[1];
  if (/what word did you just reply with/i.test(question)) {
    const earlier = [...history].reverse().find((content) => content.role === 'model');
    return earlier ? 'I replied with ' + textOf(earlier).trim() + '.' : 'There is no earlier reply in this conversation.';
  }
  if (/capital of france/i.test(question)) return 'Paris.';
  if ((match = /(\d+)\s*(?:times|x|\*)\s*(\d+)/i.exec(question))) return String(Number(match[1]) * Number(match[2]));
  if (context) {
    // Drawn from the page, as an answer about it would be.
    const page = context.replace(/^Context from the page the user is viewing:\s*/, '').replace(/\s+/g, ' ').trim();
    const sentences = page.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20).slice(0, 3);
    return '**From the page:**\n\n' + (sentences.length ? sentences : [page.slice(0, 200)]).map((s) => '- ' + s).join('\n');
  }
  return 'Here is a **stand-in** answer to "' + question.slice(0, 80) + '". It is long enough to read as a real reply, with a second sentence.';
}

/** A transport with the shape of the real one: (model, body, { signal, timeout }) -> { status, json }. */
function transport({ delay = 1200 } = {}) {
  return (model, body, { signal } = {}) => new Promise((resolve, reject) => {
    const cancelled = () => Object.assign(new Error('Cancelled'), { kind: 'cancelled' });
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        status: 200,
        json: {
          candidates: [{ content: { role: 'model', parts: [{ text: answer(body) }] }, finishReason: 'STOP' }],
          modelVersion: 'stand-in-' + model,
        },
      });
    }, delay);
    function onAbort() { clearTimeout(timer); reject(cancelled()); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Put the stand-in in place on `gemini` (src/features/ai/gemini.js) unless
 * this is a live run. Returns { live, use() } - `use()` puts it back after a
 * probe has swapped in a failing transport of its own.
 */
function install(gemini, options) {
  const fake = transport(options);
  const use = () => gemini._testing.useTransport(live() ? null : fake);
  use();
  console.log(live() ? '  (live Gemini: this run spends the real allowance)' : '  (stand-in Gemini: no network, no allowance spent)');
  return { live: live(), use };
}

module.exports = { install, answer, transport, live };
