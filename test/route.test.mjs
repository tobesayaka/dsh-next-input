import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.deepEqual(await response.json(), { suggestion: 'Run the uploader tests.' });
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

test('reports a max-token cut instead of silently returning nothing', async () => {
  async function* cutStream() {
    yield { type: 'text-delta', index: 0, text: 'partial' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
  const { route } = install(cutStream);
  const response = await route.fetch(requestFor(conversation));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { suggestion: 'partial', truncated: true });
});

test('advertises enterToSend only when the boolean config enables it', async () => {
  const off = install(goodStream);
  const offBody = await (await off.route.fetch(requestFor(conversation))).json();
  assert.equal(offBody.enterToSend, undefined);

  const on = install(goodStream, { enterToSend: true });
  const onBody = await (await on.route.fetch(requestFor(conversation))).json();
  assert.equal(onBody.enterToSend, true);

  const ignored = install(goodStream, { enterToSend: 'true' });
  const ignoredBody = await (await ignored.route.fetch(requestFor(conversation))).json();
  assert.equal(ignoredBody.enterToSend, undefined);
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
  assert.deepEqual(await firstResponse.json(), { suggestion: 'slow' });
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
  assert.equal(cached.enterToSend, false);
  assert.equal(cached.predictOnActivate, false);

  const stale = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:1'))).json();
  assert.equal(stale.cached, false);

  const dismissRoute = routes.get('/api/next-input.dismiss');
  const dismissed = await dismissRoute.fetch(dismissRequest({ sessionId: 'session-1', answerKey: 'seq:2' }));
  assert.equal(dismissed.status, 200);

  const after = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(after.cached, false);
  assert.equal(after.dismissed, true);
});

test('advertises predictOnActivate on cache misses', async () => {
  const { routes } = install(goodStream, { predictOnActivate: true });
  const cacheRoute = routes.get('/api/next-input.cached');
  const missing = await (await cacheRoute.fetch(cachedRequest('session-1', 'seq:2'))).json();
  assert.equal(missing.cached, false);
  assert.equal(missing.predictOnActivate, true);
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
  assert.equal(resetBody.values.enterToSend, false);
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
