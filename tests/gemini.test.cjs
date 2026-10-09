const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in key, so the client believes it is configured. The real key is
// never touched here: the network is replaced with a fake for every test.
process.env.GEMINI_API_KEY = 'test-key-0123456789';
const gemini = require('../src/features/ai/gemini');
const { _testing } = gemini;

const ok = (text) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });
const refuse = (status, message, details) => ({ status, json: { error: { code: status, message, details } } });
const INVALID = refuse(400, 'Request contains an invalid argument.');
const BUSY = refuse(503, 'This model is currently experiencing high demand.');
const QUOTA = refuse(429, 'You exceeded your current quota, please check your plan and billing details.');
const RETIRED = refuse(404, 'This model models/x is no longer available to new users.');

/** Install a fake network; returns the log of what was asked of it. */
function fake(t, answer) {
  const calls = [];
  _testing.reset();
  _testing.useTransport(async (model, body, options) => {
    const call = { model, thinking: body.generationConfig.thinkingConfig || null, body, options };
    calls.push(call);
    return answer(call, calls.length);
  });
  t.after(() => { _testing.useTransport(null); _testing.reset(); });
  // Keep the chain's own log lines out of the test output.
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  return calls;
}

test('a model that refuses a zero thinking budget does not end the request', async (t) => {
  // The bug behind "Request contains an invalid argument": the lite models
  // reject thinkingBudget 0, and that 400 used to abort the whole chain.
  const calls = fake(t, ({ model, thinking }) => {
    if (model !== 'gemini-3.6-flash' || !thinking) return BUSY;
    return thinking.thinkingBudget === 0 ? INVALID : ok('answered');
  });
  const result = await gemini.generate({ prompt: 'hi', thinking: 0, retries: 0 });
  assert.equal(result.text, 'answered');
  assert.equal(result.model, 'gemini-3.6-flash');
  const tried = calls.filter((c) => c.model === 'gemini-3.6-flash').map((c) => c.thinking);
  assert.deepEqual(tried, [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }]);
});

test('the thinking shape that worked is remembered for the next question', async (t) => {
  const calls = fake(t, ({ thinking }) =>
    thinking?.thinkingBudget === 0 ? INVALID : ok('fine'));
  await gemini.generate({ prompt: 'one', thinking: 0 });
  const before = calls.length;
  await gemini.generate({ prompt: 'two', thinking: 0 });
  assert.equal(calls.length - before, 1, 'the refused shape is not paid for twice');
  assert.deepEqual(calls.at(-1).thinking, { thinkingLevel: 'minimal' });
});

test('lite models start on the thinking level they accept', () => {
  assert.deepEqual(_testing.thinkingShapes('gemini-flash-lite-latest', 0)[0], { thinkingLevel: 'minimal' });
  assert.deepEqual(_testing.thinkingShapes('gemini-3-flash-preview', 0)[0], { thinkingBudget: 0 });
  assert.deepEqual(_testing.thinkingShapes('gemini-3-flash-preview', undefined), [null]);
});

test('an overloaded model hands over to the next one straight away', async (t) => {
  const calls = fake(t, ({ model }) => model === gemini.DEFAULT_MODEL ? BUSY : ok('from the fallback'));
  const started = Date.now();
  const result = await gemini.generate({ prompt: 'hi' });
  assert.equal(result.model, gemini.FALLBACK_MODELS[0]);
  assert.ok(Date.now() - started < 300, 'no backoff before trying a different model');
  assert.deepEqual(calls.map((c) => c.model), [gemini.DEFAULT_MODEL, gemini.FALLBACK_MODELS[0]]);
});

test('a model out of quota or retired is left alone afterwards', async (t) => {
  const calls = fake(t, ({ model }) =>
    model === gemini.DEFAULT_MODEL ? QUOTA : model === gemini.FALLBACK_MODELS[0] ? RETIRED : ok('yes'));
  await gemini.generate({ prompt: 'first' });
  const before = calls.length;
  const result = await gemini.generate({ prompt: 'second' });
  assert.equal(result.model, gemini.FALLBACK_MODELS[1]);
  assert.equal(calls.length - before, 1, 'went straight to a model that answers');
});

test('when every model is resting, they are still asked', async (t) => {
  fake(t, () => QUOTA);
  await assert.rejects(gemini.generate({ prompt: 'a' }));
  _testing.useTransport(async () => ok('back'));
  const result = await gemini.generate({ prompt: 'b' });
  assert.equal(result.text, 'back');
});

test('a refused key stops at once, says so plainly, and never shows the key', async (t) => {
  const calls = fake(t, () => refuse(400, 'API key not valid: test-key-0123456789',
    [{ reason: 'API_KEY_INVALID' }]));
  const error = await gemini.generate({ prompt: 'hi' }).catch((e) => e);
  assert.equal(calls.length, 1);
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /key/);
  assert.doesNotMatch(error.message + error.detail, /test-key-0123456789/);
});

test('the same refusal from two models is the request, not the model', async (t) => {
  const calls = fake(t, () => INVALID);
  const error = await gemini.generate({ prompt: 'hi' }).catch((e) => e);
  assert.equal(calls.length, 2);
  assert.equal(error.kind, 'invalid');
  assert.doesNotMatch(error.message, /invalid argument/, 'Google\'s wording is not shown to people');
});

test('quota everywhere is reported as the allowance being used up', async (t) => {
  fake(t, () => QUOTA);
  const error = await gemini.generate({ prompt: 'hi' }).catch((e) => e);
  assert.equal(error.kind, 'quota');
  assert.match(error.message, /allowance/);
});

test('a stalled model cannot keep the person waiting past the deadline', async (t) => {
  fake(t, (call) => new Promise((resolve, reject) => {
    setTimeout(() => reject(Object.assign(new Error('timed out'), { kind: 'timeout' })), call.options.timeout);
  }));
  const started = Date.now();
  const error = await gemini.generate({ prompt: 'hi', deadline: 2500, attemptTimeout: 1000 }).catch((e) => e);
  assert.ok(Date.now() - started < 4000);
  assert.equal(error.kind, 'timeout');
});

test('cancelling stops the chain', async (t) => {
  const controller = new AbortController();
  const calls = fake(t, () => {
    controller.abort();
    return Promise.reject(Object.assign(new Error('Cancelled'), { kind: 'cancelled' }));
  });
  const error = await gemini.generate({ prompt: 'hi', signal: controller.signal }).catch((e) => e);
  assert.equal(error.message, 'Cancelled');
  assert.equal(calls.length, 1);
});

test('a malformed model id from a page is ignored rather than put in a URL', async (t) => {
  const calls = fake(t, () => ok('fine'));
  await gemini.generate({ prompt: 'hi', model: '../../evil?x=' });
  assert.equal(calls[0].model, gemini.DEFAULT_MODEL);
});

test('thought summaries are not part of the answer', async (t) => {
  fake(t, () => ({ status: 200, json: { candidates: [{ content: { parts: [
    { text: 'working it out', thought: true }, { text: 'The answer.' },
  ] } }] } }));
  assert.equal((await gemini.generate({ prompt: 'hi' })).text, 'The answer.');
});

test('a safety refusal is not retried on every model', async (t) => {
  const calls = fake(t, () => ({ status: 200, json: { candidates: [{ finishReason: 'SAFETY' }] } }));
  const error = await gemini.generate({ prompt: 'hi' }).catch((e) => e);
  assert.equal(calls.length, 1);
  assert.equal(error.kind, 'blocked');
});

test('page text is made safe to send', () => {
  const cleaned = _testing.clean('ok \uD83D\u0000\u0007 done\nnext\tcol');
  assert.ok(cleaned.isWellFormed ? cleaned.isWellFormed() : true);
  assert.doesNotMatch(cleaned, /[\u0000\u0007]/);
  assert.match(cleaned, /done\nnext\tcol/);
  // History is trimmed, roles normalised, and blank turns dropped.
  const body = _testing.buildBody({ prompt: 'q', history: [
    { role: 'assistant', text: 'x' }, { role: 'model', text: '' }, { role: 'model', text: 'y' },
  ] }, null);
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
});

test('a daily allowance rests the model for longer than a per-minute one', () => {
  const daily = _testing.classify(429, { error: { message: 'You exceeded your current quota', details: [
    { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  ] } });
  const minute = _testing.classify(429, { error: { message: 'You exceeded your current quota', details: [
    { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { retryDelay: '12s' },
  ] } });
  assert.equal(daily.kind, 'quota');
  assert.ok(daily.rest >= 30 * 60 * 1000);
  assert.equal(minute.rest, 13000);
});

test('a refused thinking level is not mistaken for a retired model', () => {
  const error = _testing.classify(400, { error: { message: 'Thinking level MINIMAL is not supported for this model.' } });
  assert.equal(error.kind, 'invalid');
});

/* ---- grounding in Google Search ------------------------------------------------ */

const grounded = (text, chunks, queries) => ({ status: 200, json: { candidates: [{
  content: { parts: [{ text }] }, finishReason: 'STOP',
  groundingMetadata: { groundingChunks: chunks, webSearchQueries: queries },
}] } });

test('a search request asks for the google_search tool, and a plain one does not', async (t) => {
  const calls = fake(t, () => ok('fine'));
  await gemini.generate({ prompt: 'plain' });
  await gemini.generate({ prompt: 'searched', search: true });
  assert.equal(calls[0].body.tools, undefined);
  assert.deepEqual(calls[1].body.tools, [{ google_search: {} }]);
});

test('a grounded answer brings its sources, and only web addresses', async (t) => {
  fake(t, () => grounded('{"a":1}', [
    { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'amazon.in' } },
    { web: { uri: 'javascript:alert(1)', title: 'bad' } },
    { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'again' } },
    { retrievedContext: { uri: 'x' } },
  ], ['sony xm5 price india']));
  const result = await gemini.generate({ prompt: 'p', search: true });
  assert.equal(result.text, '{"a":1}');
  assert.deepEqual(result.grounding.sources, [
    { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'amazon.in' },
  ]);
  assert.deepEqual(result.grounding.queries, ['sony xm5 price india']);
});

test('search refused for quota does not rest the model for plain questions', async (t) => {
  // Against the shipped key a model can refuse every search while answering
  // plain prompts: the two allowances must be tracked apart.
  const calls = fake(t, ({ body }) => (body.tools ? QUOTA : ok('plain answer')));
  await assert.rejects(gemini.generate({ prompt: 'p', search: true, retries: 0 }), (error) => error.kind === 'quota');
  const before = calls.length;
  const result = await gemini.generate({ prompt: 'p' });
  assert.equal(result.model, gemini.DEFAULT_MODEL, 'the default model still answers plain questions');
  assert.equal(calls.length - before, 1);
  assert.equal(result.grounding, undefined);
});
