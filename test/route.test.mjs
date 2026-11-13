import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { apply } from '../src/index.js';

const testHome = mkdtempSync(join(tmpdir(), 'dsh-next-input-test-'));
process.env.DSH_HOME = testHome;
after(() => rmSync(testHome, { recursive: true, force: true }));

function requestFor(body) {
  return new Request('http://127.0.0.1:65488/api/next-input.predict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function install(stream, config) {
  rmSync(join(testHome, 'next-input'), { recursive: true, force: true });
  return harness(stream, config);
}

/**
 * Register the Host routes on a fresh ctx without clearing the settings
 * directory, so a test can present a settings file that already exists.
 */
function harness(stream, config) {
  let route;
  const routes = new Map();
  const calls = [];
  const ctx = {
    effect(fn) {
      fn();
    },
    connection: {
      fetch: {
        register(value) {
          routes.set(value.path, value);
          if (value.path === '/api/next-input.predict') route = value;
          return async () => {};
        },
      },
    },
    sessions: {
      get(id) {
        return id === 'session-1' ? { id } : undefined;
      },
    },
    llm: {
      listProviders() {
        return [{ id: 'deepseek-official' }];
      },
      async listModels(provider) {
        return [{ provider, id: 'fast-model', name: 'Fast model' }];
      },
      async prepareCall(config, signal, configure) {
        const model = { reasoning: { efforts: [{ id: 'low' }] } };
        const controls = typeof configure === 'function' ? configure({}, model) : {};
        const merged = { ...config, ...controls };
        calls.push({
          config: merged,
          options: null,
          provider: merged.provider,
          model: merged.model,
          reasoningEffort: merged.reasoningEffort,
          maxTokens: merged.maxTokens,
        });
        return {
          config: merged,
          stream(options) {
            calls[calls.length - 1].options = options;
            return stream(options);
          },
        };
      },
    },
  };
  apply(ctx, config);
  assert.ok(route, 'the host route is registered');
  return { route, routes, calls };
}

const conversation = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  sessionId: 'session-1',
  answerKey: 'seq:2',
  messages: [
    { role: 'user', text: 'Add a retry to the uploader.' },
    { role: 'assistant', text: 'Done. The uploader now retries twice with backoff.' },
  ],
};

async function* goodStream() {
  yield { type: 'text-delta', index: 0, text: 'Run the uploader tests.' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function* failedStream() {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no credential' } } };
}

test('answers with one cleaned prediction through the current route', async () => {
  const { route, calls } = install(goodStream);
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    suggestion: 'Run the uploader tests.',
    enterToSend: true,
    route: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'answer' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'deepseek-official');
  assert.equal(calls[0].model, 'deepseek-v4-flash');
  assert.equal(calls[0].reasoningEffort, 'low');
  assert.equal(calls[0].maxTokens, 512);
  assert.equal(calls[0].options.maxTokens, 512);
  assert.equal(calls[0].options.reasoningEffort, 'low');
  assert.equal(calls[0].options.sessionId, 'session-1');
  assert.match(calls[0].options.messages[0].content[0].text, /Add a retry to the uploader\./);
  assert.match(calls[0].options.messages[0].content[0].text, /Predict the user's next message now\./);
});

test('rejects a request whose answer route is empty even with a selection', async () => {
  const { route, calls } = install(goodStream);
  const response = await route.fetch(requestFor({
    ...conversation,
    provider: '',
    model: '',
    selection: { provider: 'deepseek-official', model: 'selected-model' },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'missing_model' });
  assert.equal(calls.length, 0);
});

test('rejects requests without an assistant answer', async () => {
  const { route } = install(goodStream);
  const response = await route.fetch(requestFor({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    messages: [{ role: 'user', text: 'hello' }],
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'missing_answer' });
});

test('rejects requests without a model route', async () => {
  const { route } = install(goodStream);
  const response = await route.fetch(requestFor({ messages: conversation.messages }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'missing_model' });
});

test('reports a failed model stream instead of inventing text', async () => {
  const { route } = install(failedStream);
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'model_failed');
  assert.equal(body.code, 'AUTH');
});

test('honors the suggestion length configuration', async () => {
  async function* longStream() {
    yield { type: 'text-delta', index: 0, text: 'one two three four five six' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(longStream, { maxSuggestionChars: 13 });
  const response = await route.fetch(requestFor(conversation));
  const body = await response.json();
  assert.ok(body.suggestion.length <= 13, body.suggestion);
});

test('keeps the most recent context when the conversation is too long', async () => {
  async function* shortStream() {
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route, calls } = install(shortStream, { maxContextChars: 80, maxMessages: 24 });
  const response = await route.fetch(requestFor({
    ...conversation,
    messages: [
      { role: 'user', text: 'HEAD ' + 'x'.repeat(300) + ' TAIL' },
      { role: 'assistant', text: 'recent answer' },
    ],
  }));
  assert.equal(response.status, 200);
  assert.match(calls[0].options.messages[0].content[0].text, /recent answer/);
  assert.match(calls[0].options.messages[0].content[0].text, /HEAD/);
  assert.doesNotMatch(calls[0].options.messages[0].content[0].text, /TAIL/);
});

test('keeps the user request when the final answer fills the budget', async () => {
  async function* shortStream() {
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route, calls } = install(shortStream, { maxContextChars: 200, maxMessages: 24 });
  const response = await route.fetch(requestFor({
    ...conversation,
    messages: [
      { role: 'user', text: 'What should I check next?' },
      { role: 'assistant', text: 'A'.repeat(2000) },
    ],
  }));
  assert.equal(response.status, 200);
  const text = calls[0].options.messages[0].content[0].text;
  assert.match(text, /What should I check next\?/);
  assert.match(text, /AAAA/);
  assert.ok(text.length < 400, String(text.length));
});

// A long conversation with six rounds: without a wide budget the opening
// request is the first thing dropped, which is what Max mode has to avoid.
function longConversation() {
  const messages = [];
  for (let round = 0; round < 6; round += 1) {
    messages.push({ role: 'user', text: `round ${round}: goal marker ${round} ` + 'q'.repeat(40) });
    messages.push({ role: 'assistant', text: `answer ${round}: ` + 'a'.repeat(4000) });
  }
  return { ...conversation, messages };
}

test('Max mode widens the context budget and keeps the opening request', async () => {
  const { route, calls } = install(goodStream, { maxMode: true });
  assert.equal((await route.fetch(requestFor(longConversation()))).status, 200);
  const text = calls[0].options.messages[0].content[0].text;
  // Every round is 76 + 4008 characters, so 32000 characters keep all six.
  // The 0.5.x 8000-character budget drops the opening rounds.
  assert.match(text, /goal marker 0/);
  assert.match(text, /goal marker 3/);
});

test('Max mode leaves an explicit context budget alone', async () => {
  // 7000 rather than 8000: the Max mode defaults only apply while the setting
  // still equals its default, so an explicit value that differs must win.
  const { route, calls } = install(goodStream, { maxMode: true, maxContextChars: 7000 });
  assert.equal((await route.fetch(requestFor(longConversation()))).status, 200);
  const text = calls[0].options.messages[0].content[0].text;
  assert.doesNotMatch(text, /goal marker 0/);
  assert.doesNotMatch(text, /goal marker 3/);
});

test('turning Max mode off keeps the default context budget', async () => {
  const { route, calls } = install(goodStream);
  assert.equal((await route.fetch(requestFor(longConversation()))).status, 200);
  const text = calls[0].options.messages[0].content[0].text;
  assert.doesNotMatch(text, /goal marker 0/);
  assert.doesNotMatch(text, /goal marker 3/);
});

test('Max mode raises the output budget only while it is still default', async () => {
  const raised = install(goodStream, { maxMode: true });
  assert.equal((await raised.route.fetch(requestFor(conversation))).status, 200);
  assert.equal(raised.calls[0].maxTokens, 1024);

  const explicit = install(goodStream, { maxMode: true, maxTokens: 256 });
  assert.equal((await explicit.route.fetch(requestFor(conversation))).status, 200);
  assert.equal(explicit.calls[0].maxTokens, 256);

  const off = install(goodStream);
  assert.equal((await off.route.fetch(requestFor(conversation))).status, 200);
  assert.equal(off.calls[0].maxTokens, 512);
});

test('reports a max-token cut instead of silently returning nothing', async () => {
  async function* cutStream() {
    yield { type: 'text-delta', index: 0, text: 'partial' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
  const { route } = install(cutStream);
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    suggestion: 'partial',
    truncated: true,
    enterToSend: true,
    route: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'answer' },
  });
});

test('advertises enterToSend when the boolean config enables it (the default)', async () => {
  const defaults = install(goodStream);
  const defaultsBody = await (await defaults.route.fetch(requestFor(conversation))).json();
  assert.equal(defaultsBody.enterToSend, true);

  const off = install(goodStream, { enterToSend: false });
  const offBody = await (await off.route.fetch(requestFor(conversation))).json();
  assert.equal(offBody.enterToSend, undefined);

  const ignored = install(goodStream, { enterToSend: 'true' });
  const ignoredBody = await (await ignored.route.fetch(requestFor(conversation))).json();
  assert.equal(ignoredBody.enterToSend, true);
});

test('rejects a missing, unknown, or unregistered route', async () => {
  const { route } = install(goodStream);

  const missing = await route.fetch(requestFor({ ...conversation, sessionId: '' }));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'missing_session' });

  const unknownSession = await route.fetch(requestFor({ ...conversation, sessionId: 'session-2' }));
  assert.equal(unknownSession.status, 404);
  assert.deepEqual(await unknownSession.json(), { error: 'unknown_session' });

  const unknownProvider = await route.fetch(requestFor({ ...conversation, provider: 'not-registered' }));
  assert.equal(unknownProvider.status, 400);
  assert.deepEqual(await unknownProvider.json(), { error: 'unknown_provider' });
});

test('rejects a second in-flight prediction for the same session', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  async function* slowStream() {
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    yield { type: 'text-delta', index: 0, text: 'slow' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(slowStream);
  const first = route.fetch(requestFor(conversation));
  await startedPromise;
  const second = await route.fetch(requestFor(conversation));
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: 'in_flight' });
  release();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.suggestion, 'slow');
  assert.equal(firstBody.route.source, 'answer');
});

function cachedRequest(sessionId, answerKey) {
  const query = new URLSearchParams({ sessionId, answerKey });
  return new Request('http://127.0.0.1:65488/api/next-input.cached?' + query.toString());
}

function dismissRequest(body) {
  return new Request('http://127.0.0.1:65488/api/next-input.dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('serves a cached prediction by answer identity and honors dismissal', async () => {
  const { route, routes } = install(goodStream);
  assert.equal((await route.fetch(requestFor(conversation))).status, 200);

  const cacheRoute = routes.get('/api/next-input.cached');
  const cached = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(cached.cached, true);
  assert.equal(cached.suggestion, 'Run the uploader tests.');
  assert.equal(cached.enterToSend, true);
  assert.equal(cached.predictOnActivate, true);

  const stale = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:1'))).json();
  assert.equal(stale.cached, false);

  const dismissRoute = routes.get('/api/next-input.dismiss');
  const dismissed = await dismissRoute.fetch(dismissRequest({ sessionId: 'session-1', answerKey: 'seq:2' }));
  assert.equal(dismissed.status, 200);

  const after = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(after.cached, false);
  assert.equal(after.dismissed, true);
});

test('advertises predictOnActivate on cache misses (the default)', async () => {
  const defaults = install(goodStream);
  const defaultsCache = defaults.routes.get('/api/next-input.cached');
  const missing = await (await defaultsCache.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(missing.cached, false);
  assert.equal(missing.predictOnActivate, true);

  const off = install(goodStream, { predictOnActivate: false });
  const offCache = off.routes.get('/api/next-input.cached');
  const offMissing = await (await offCache.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(offMissing.predictOnActivate, false);

  // Max mode's "only predict after an answer" wins over the older switch.
  const max = install(goodStream, { maxMode: true, predictOnActivate: true });
  const maxCache = max.routes.get('/api/next-input.cached');
  const maxMissing = await (await maxCache.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(maxMissing.predictOnActivate, false);

  // While Max mode is off the older switch is the only one that counts.
  const inert = install(goodStream, { maxMode: false, predictOnActivate: true, predictOnEndOnly: true });
  const inertCache = inert.routes.get('/api/next-input.cached');
  const inertMissing = await (await inertCache.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(inertMissing.predictOnActivate, true);
});

test('uses an explicit fast prediction route when both fields are set', async () => {
  const { route, calls } = install(goodStream, {
    predictionProvider: 'deepseek-official',
    predictionModel: 'fast-model',
  });
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.equal(calls[0].provider, 'deepseek-official');
  assert.equal(calls[0].model, 'fast-model');
  assert.equal(calls[0].options.provider, 'deepseek-official');
  assert.equal(calls[0].options.model, 'fast-model');
});

test('follows the Session selected model before the answer route', async () => {
  const { route, calls } = install(goodStream);
  const response = await route.fetch(requestFor({
    ...conversation,
    selection: { provider: 'deepseek-official', model: 'selected-model' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls[0].provider, 'deepseek-official');
  assert.equal(calls[0].model, 'selected-model');
  assert.equal(calls[0].options.model, 'selected-model');
  assert.deepEqual(body.route, { provider: 'deepseek-official', model: 'selected-model', source: 'session' });
});

test('keeps the answer route when the selection names an unregistered provider', async () => {
  const { route, calls } = install(goodStream);
  const response = await route.fetch(requestFor({
    ...conversation,
    selection: { provider: 'gone-provider', model: 'selected-model' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls[0].model, 'deepseek-v4-flash');
  assert.deepEqual(body.route, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    source: 'answer',
    fallback: true,
  });
});

test('an explicit prediction route wins over the Session selection', async () => {
  const { route, calls } = install(goodStream, {
    predictionProvider: 'deepseek-official',
    predictionModel: 'fast-model',
  });
  const response = await route.fetch(requestFor({
    ...conversation,
    selection: { provider: 'deepseek-official', model: 'selected-model' },
  }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].model, 'fast-model');
  assert.equal((await response.json()).route.source, 'settings');
});

function settingsRequest(method, body) {
  return new Request('http://127.0.0.1:65488/api/next-input.settings', {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('reads, saves, and resets settings through the settings route', async () => {
  const { route, routes, calls } = install(goodStream);
  const settings = routes.get('/api/next-input.settings');
  const initial = await (await settings.fetch(settingsRequest('GET'))).json();
  assert.equal(initial.editable, true);
  assert.equal(initial.values.maxTokens, 512);
  assert.equal(initial.values.enterToSend, true);
  assert.equal(initial.values.predictOnActivate, true);
  assert.deepEqual(initial.route, { source: 'session' });
  assert.equal(initial.providers[0].id, 'deepseek-official');
  assert.equal(initial.providers[0].models[0].id, 'fast-model');
  assert.equal(initial.defaults.maxTokens, 512);

  const saved = await settings.fetch(settingsRequest('POST', {
    values: {
      maxTokens: 256,
      enterToSend: true,
      predictOnActivate: true,
      predictionProvider: 'deepseek-official',
      predictionModel: 'fast-model',
    },
  }));
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.values.maxTokens, 256);
  assert.equal(savedBody.values.enterToSend, true);
  assert.equal(savedBody.values.predictOnActivate, true);
  const stored = JSON.parse(readFileSync(initial.path, 'utf8'));
  assert.equal(stored.maxTokens, 256);

  const afterSave = await (await settings.fetch(settingsRequest('GET'))).json();
  assert.equal(afterSave.values.predictionModel, 'fast-model');

  assert.equal((await route.fetch(requestFor(conversation))).status, 200);
  assert.equal(calls[0].maxTokens, 256);
  assert.equal(calls[0].model, 'fast-model');

  const reset = await settings.fetch(settingsRequest('POST', { reset: true }));
  const resetBody = await reset.json();
  assert.equal(resetBody.values.maxTokens, 512);
  assert.equal(resetBody.values.enterToSend, true);
  assert.equal(resetBody.values.predictOnActivate, true);
  assert.equal(resetBody.route.source, 'session');
  assert.throws(() => readFileSync(initial.path, 'utf8'));
});

test('rejects invalid settings without touching the file', async () => {
  const { routes } = install(goodStream);
  const settings = routes.get('/api/next-input.settings');
  const initial = await (await settings.fetch(settingsRequest('GET'))).json();

  const outOfRange = await settings.fetch(settingsRequest('POST', { values: { maxTokens: 1 } }));
  assert.equal(outOfRange.status, 400);
  assert.deepEqual(await outOfRange.json(), { error: 'out_of_range', field: 'maxTokens' });

  const incomplete = await settings.fetch(settingsRequest('POST', {
    values: { predictionProvider: 'deepseek-official' },
  }));
  assert.equal(incomplete.status, 400);
  assert.deepEqual(await incomplete.json(), { error: 'prediction_route_incomplete' });

  const unknown = await settings.fetch(settingsRequest('POST', { values: { nope: true } }));
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'unknown_setting', field: 'nope' });
  assert.throws(() => readFileSync(initial.path, 'utf8'));
});

test('loads a settings file written before Max mode existed', async () => {
  // install() clears the settings directory before apply() reads it, so this
  // test builds its own harness without the cleanup: that is exactly the
  // upgrade case, a 0.5.x file already on disk when the Host starts.
  const file = join(testHome, 'next-input', 'settings.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ maxTokens: 300, enterToSend: false }, null, 2));
  const { routes } = harness(goodStream);
  const settings = routes.get('/api/next-input.settings');
  const loaded = await (await settings.fetch(settingsRequest('GET'))).json();
  assert.equal(loaded.values.maxTokens, 300);
  assert.equal(loaded.values.enterToSend, false);
  assert.equal(loaded.values.maxMode, false);
  assert.equal(loaded.values.smartPack, true);
  assert.equal(loaded.values.includeToolActivity, true);
  assert.equal(loaded.values.reasoningEffort, 'model');
  // Reading it never rewrites the file.
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).maxMode, undefined);
});

test('round-trips the Max mode settings and applies them to a prediction', async () => {
  const { route, routes, calls } = install(goodStream);
  const settings = routes.get('/api/next-input.settings');
  const initial = await (await settings.fetch(settingsRequest('GET'))).json();
  // Max mode ships off, and its sub-switches have defaults even when off.
  assert.equal(initial.values.maxMode, false);
  assert.equal(initial.values.reasoningEffort, 'model');
  assert.equal(initial.values.promptVariant, 'next');

  const saved = await settings.fetch(settingsRequest('POST', {
    values: {
      maxMode: true,
      includeToolActivity: false,
      smartPack: false,
      allowMultiline: false,
      reasoningEffort: 'low',
      retryOnFailure: false,
      predictOnEndOnly: false,
      promptVariant: 'legacy',
    },
  }));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.values.maxMode, true);
  assert.equal(body.values.reasoningEffort, 'low');
  assert.equal(body.values.promptVariant, 'legacy');
  assert.equal(body.values.includeToolActivity, false);

  const afterSave = await (await settings.fetch(settingsRequest('GET'))).json();
  assert.equal(afterSave.values.maxMode, true);

  // With Max mode on, the pinned effort is requested and the legacy prompt
  // still wins because `promptVariant` names it. The budgets follow the Max
  // mode defaults because neither was touched here.
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'low');
  assert.equal(calls[0].maxTokens, 1024);
  assert.match(calls[0].options.messages[0].content[0].text, /Predict the user's next message now\./);
  assert.doesNotMatch(calls[0].options.messages[0].content[0].text, /tool_activity/u);
  assert.match(calls[0].options.system, /Keep it short: one or two sentences/u);

  for (const value of ['fast', 'MAX', '']) {
    const rejected = await settings.fetch(settingsRequest('POST', { values: { reasoningEffort: value } }));
    assert.equal(rejected.status, 400, 'reasoningEffort ' + JSON.stringify(value) + ' is not a mode');
  }
});

test('Max mode sends the next prompt and stops pinning the lowest effort', async () => {
  const { route, calls } = install(goodStream, { maxMode: true });
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  // 'model' means "let the provider decide", so no effort is requested.
  assert.equal(calls[0].reasoningEffort, undefined);
  // The prompt states the situation first and asks for structure when the next
  // message carries more than one point, instead of capping the reply's length.
  assert.match(calls[0].options.system, /Work out the situation first/u);
  assert.match(calls[0].options.system, /numbered or bulleted list/u);
  assert.match(calls[0].options.system, /Do not manufacture structure for a one-word answer/u);
  assert.doesNotMatch(calls[0].options.system, /Keep it short: one or two sentences/u);
});

test('Max mode keeps a multiline prediction on a line boundary', async () => {
  async function* multilineStream() {
    yield { type: 'text-delta', index: 0, text: 'Two things:\n' };
    yield { type: 'text-delta', index: 1, text: '1. run the tests\n2. update the changelog\n' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(multilineStream, { maxMode: true });
  const body = await (await route.fetch(requestFor(conversation))).json();
  assert.equal(body.suggestion, 'Two things:\n1. run the tests\n2. update the changelog');
});

test('Max mode cuts a multiline prediction at the last full line', async () => {
  async function* longStream() {
    yield { type: 'text-delta', index: 0, text: 'first line here\nsecond line here\nthird line here\nfourth line' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(longStream, { maxMode: true, maxSuggestionChars: 34 });
  const body = await (await route.fetch(requestFor(conversation))).json();
  assert.equal(body.suggestion, 'first line here\nsecond line here');
});

test('turning Max mode off keeps the 0.5.x single-line prediction', async () => {
  async function* multilineStream() {
    yield { type: 'text-delta', index: 0, text: 'first line\nsecond line' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(multilineStream, { maxMode: false });
  const body = await (await route.fetch(requestFor(conversation))).json();
  assert.equal(body.suggestion, 'first line second line');
});

test('Max mode retries once after a failed attempt', async () => {
  let attempts = 0;
  async function* flakyStream() {
    attempts += 1;
    if (attempts === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'transient' } } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Run the uploader tests.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route } = install(flakyStream, { maxMode: true });
  const response = await route.fetch(requestFor({ ...conversation, answerKey: 'seq:retry' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).suggestion, 'Run the uploader tests.');
  assert.equal(attempts, 2);
});

test('without Max mode a failed attempt is not retried', async () => {
  let attempts = 0;
  async function* flakyStream() {
    attempts += 1;
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'transient' } } };
  }
  const { route } = install(flakyStream, { maxMode: false });
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 502);
  assert.equal(attempts, 1);
});

async function* meteredStream() {
  yield { type: 'text-delta', index: 0, text: 'Run the uploader tests.' };
  yield {
    type: 'usage',
    usage: { inputTokens: 1200, outputTokens: 9, totalTokens: 1209, cacheReadTokens: 800 },
  };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

test('reports token usage per prediction and counts answers served by the cache', async () => {
  const { route, routes } = install(meteredStream);
  const usageRoute = routes.get('/api/next-input.usage');
  assert.ok(usageRoute, 'the usage route is registered');

  const before = await (await usageRoute.fetch(new Request('http://127.0.0.1:65488/api/next-input.usage'))).json();
  assert.equal(before.usage.calls, 0);
  assert.equal(before.usage.totalTokens, 0);

  assert.equal((await route.fetch(requestFor(conversation))).status, 200);

  const after = await (await usageRoute.fetch(new Request('http://127.0.0.1:65488/api/next-input.usage'))).json();
  assert.equal(after.usage.calls, 1);
  assert.equal(after.usage.callsWithUsage, 1);
  assert.equal(after.usage.withoutUsage, 0);
  assert.equal(after.usage.inputTokens, 1200);
  assert.equal(after.usage.outputTokens, 9);
  assert.equal(after.usage.totalTokens, 1209);
  assert.equal(after.usage.cacheReadTokens, 800);
  assert.equal(after.usage.answered, 1);
  assert.equal(after.usage.duplicate, 0);
  assert.equal(after.usage.recent.length, 1);
  assert.equal(after.usage.recent[0].model, 'deepseek-v4-flash');
  assert.equal(after.usage.recent[0].source, 'answer');
  assert.equal(after.usage.recent[0].totalTokens, 1209);
  assert.deepEqual(after.usage.byRoute, [{ id: 'deepseek-official/deepseek-v4-flash', calls: 1, inputTokens: 1200, outputTokens: 9, totalTokens: 1209 }]);

  // The settings page carries the same counters.
  const settings = routes.get('/api/next-input.settings');
  const page = await (await settings.fetch(settingsRequest('GET'))).json();
  assert.equal(page.usage.totalTokens, 1209);

  const reset = await (await settings.fetch(settingsRequest('POST', { resetUsage: true }))).json();
  assert.equal(reset.reset, true);
  assert.equal(reset.usage.totalTokens, 0);
  assert.equal(reset.usage.answered, 0);
});

test('counts a second in-flight prediction for the same answer without calling the model', async () => {
  let gate;
  const gatePromise = new Promise((resolve) => {
    gate = resolve;
  });
  const pending = [];
  let modelCalls = 0;
  // The first stream blocks; a duplicate that slipped past the guard would
  // reach the model and push a second stream — give it a moment to do so.
  async function* slowStream() {
    modelCalls += 1;
    await gatePromise;
    yield { type: 'text-delta', index: 0, text: 'slow' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const { route, routes } = install(slowStream);
  pending.push(route.fetch(requestFor(conversation)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await route.fetch(requestFor(conversation));
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: 'in_flight' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate();
  assert.equal((await pending[0]).status, 200);
  assert.equal(modelCalls, 1);

  const usageRoute = routes.get('/api/next-input.usage');
  const usage = await (await usageRoute.fetch(new Request('http://127.0.0.1:65488/api/next-input.usage'))).json();
  assert.equal(usage.usage.calls, 1);
  assert.equal(usage.usage.duplicate, 1);
});

test('Max mode gives a multiline suggestion room by default', async () => {
  async function* longStream() {
    yield { type: 'text-delta', index: 0, text: Array.from({ length: 12 }, (_v, i) => 'line ' + i + ' of a longer follow-up').join('\n') };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  // The settings default (140) would cut this list; Max mode uses its own cap.
  const max = install(longStream, { maxMode: true });
  const body = await (await max.route.fetch(requestFor(conversation))).json();
  assert.ok(body.suggestion.length > 140, 'the default single-line cap no longer applies');
  assert.ok(body.suggestion.includes('\n'));

  // An explicit cap from the settings page still wins.
  const capped = install(longStream, { maxMode: true, maxSuggestionChars: 60 });
  const cappedBody = await (await capped.route.fetch(requestFor(conversation))).json();
  assert.ok(cappedBody.suggestion.length <= 60);
});

test('tool activity reaches the prompt only in Max mode with the switch on', async () => {
  const body = {
    ...conversation,
    toolActivity: '- edit src/client.js\n- bash: npm test',
  };

  const on = install(goodStream, { maxMode: true });
  await on.route.fetch(requestFor(body));
  const sent = on.calls[0].options.messages[0].content[0].text;
  assert.match(sent, /tool calls the assistant made/u);
  assert.match(sent, /- edit src\/client\.js/u);

  const off = install(goodStream, { maxMode: true, includeToolActivity: false });
  await off.route.fetch(requestFor(body));
  assert.doesNotMatch(off.calls[0].options.messages[0].content[0].text, /edit src\/client\.js/u);

  // Max mode off: the field is ignored even though it was sent.
  const legacy = install(goodStream, { maxMode: false });
  await legacy.route.fetch(requestFor(body));
  assert.doesNotMatch(legacy.calls[0].options.messages[0].content[0].text, /edit src\/client\.js/u);
});

test('a caller cannot push an oversized tool summary into the prompt', async () => {
  const max = install(goodStream, { maxMode: true });
  await max.route.fetch(requestFor({
    ...conversation,
    toolActivity: '- ' + 'x'.repeat(20000),
  }));
  const sent = max.calls[0].options.messages[0].content[0].text;
  assert.ok(sent.length < 12000, 'the summary is bounded before it reaches the model');
});

test('the next prompt explains the tool activity block it may receive', async () => {
  // The prompt has to name the block, otherwise the model sees bare
  // "bash: ..." / "edit ..." lines with no statement that they are context.
  const max = install(goodStream, { maxMode: true });
  await max.route.fetch(requestFor(conversation));
  assert.match(max.calls[0].options.system, /tool calls the assistant made in its latest turn/u);

  // Neither the legacy prompt nor the Max-off path mentions it, so a reader
  // cannot mistake this for something the baseline model is told.
  const legacy = install(goodStream, { maxMode: true, promptVariant: 'legacy' });
  await legacy.route.fetch(requestFor(conversation));
  assert.doesNotMatch(legacy.calls[0].options.system, /tool calls the assistant made/u);

  const off = install(goodStream, { maxMode: false });
  await off.route.fetch(requestFor(conversation));
  assert.doesNotMatch(off.calls[0].options.system, /tool calls the assistant made/u);
});
