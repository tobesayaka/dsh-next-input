import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8');

function makeStorage() {
  const entries = new Map();
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
    key(index) {
      const keys = [...entries.keys()];
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    get length() {
      return entries.size;
    },
  };
}

function loadClient(storage, options = {}) {
  let bundle;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          bundle = value;
        },
      },
      __DSH_NEXT_INPUT_TEST__: true,
      localStorage: storage,
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame() {
        return 0;
      },
      cancelAnimationFrame() {},
      setTimeout() {
        return 0;
      },
      clearTimeout() {},
      getComputedStyle() {
        return {};
      },
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
    },
    queueMicrotask,
    console,
    fetch: options.fetch === undefined
      ? async () => {
        throw new Error('not used');
      }
      : options.fetch,
    AbortController,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });

  assert.equal(bundle.id, 'dsh-next-input');
  const fakeReact = {
    createElement() {
      return {};
    },
    useRef() {
      return { current: null };
    },
    useState() {
      return [null, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore() {
      return 0;
    },
    useCallback(fn) {
      return fn;
    },
  };
  // Taken by reference on purpose: a caller may fill the object after loading.
  const react = options.react === undefined ? fakeReact : options.react;
  return bundle.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected module: ' + name);
  });
}

test('the client half loads and registers the composer overlay', () => {
  const client = loadClient(makeStorage());

  assert.equal(typeof client.apply, 'function');
  const registrations = [];
  const ctx = {
    // `inject: ['locale']` means the service exists by the time apply runs.
    locale: { register: () => () => {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'en', revision: 0 }), subscribe: () => () => {} },
    get() {
      return undefined;
    },
    effect(fn) {
      fn();
    },
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
      },
    },
  };
  client.apply(ctx);
  const composer = registrations.find((entry) => entry.options.name === 'conversation.input.overlay');
  assert.ok(composer);
  assert.equal(composer.options.id, 'next-input');
  assert.equal(typeof composer.component, 'function');

  // One page, one place: the section only. No copy under Built-in plugins.
  assert.equal(
    registrations.filter((entry) => entry.options.name === 'settings.plugins.tab').length,
    0,
    'the settings page is not duplicated as a tab under Built-in plugins',
  );
  const section = registrations.find((entry) => entry.options.name === 'settings.section');
  assert.ok(section, 'a top-level settings section names the plugin');
  assert.equal(section.options.id, 'next-input');
  assert.equal(section.options.label(), 'Next input');
  assert.equal(typeof section.component, 'function');
  const icon = registrations.find((entry) => entry.options.name === 'settings.section.icon');
  assert.ok(icon, 'the settings section has a nav icon');
  assert.equal(icon.options.id, 'next-input');
  assert.equal(typeof icon.component, 'function');

  const entries = [
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        surfaceOp: 'append',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 2,
        surfaceOp: 'append',
        data: {
          message: {
            source: { kind: 'model', provider: 'p', model: 'm1' },
            content: [{ type: 'text', text: 'world' }],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 3,
        surfaceOp: 'append',
        data: { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'ignored' }] },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 4,
        surfaceOp: 'replace',
        data: {
          message: {
            source: { kind: 'model', provider: 'p', model: 'ignored' },
            content: [{ type: 'text', text: 'ignored' }],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 5,
        surfaceOp: 'append',
        data: {
          message: {
            source: { kind: 'model', provider: 'p', model: 'm2' },
            content: [
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: 'done' },
            ],
          },
        },
      },
    },
  ];
  const conversation = client.__test.readConversation({
    binding() {
      return {
        eventSource: {
          getSnapshot() {
            return { entries };
          },
        },
      };
    },
  }, 'session-1');
  assert.equal(JSON.stringify(conversation.messages), JSON.stringify([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'world' },
    { role: 'assistant', text: 'done' },
  ]));
  assert.equal(JSON.stringify(conversation.model), JSON.stringify({ provider: 'p', model: 'm2' }));
  assert.equal(conversation.answerKey, 'seq:5');

  const longEntries = [
    {
      type: 'event',
      event: {
        type: 'user/message',
        surfaceOp: 'append',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'What next?' }] },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          message: {
            source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'text', text: 'A'.repeat(2000) }],
          },
        },
      },
    },
  ];
  const longConversation = client.__test.readConversation({
    binding() {
      return {
        eventSource: {
          getSnapshot() {
            return { entries: longEntries };
          },
        },
      };
    },
  }, 'session-2');
  assert.equal(JSON.stringify(longConversation.messages[0]), JSON.stringify({ role: 'user', text: 'What next?' }));
  assert.ok(longConversation.messages[longConversation.messages.length - 1].text.endsWith('A'));
  assert.ok(longConversation.messages.reduce((sum, message) => sum + message.text.length, 0) <= 7000);

  const duplicate = client.__test.readConversation({
    binding() {
      return {
        eventSource: {
          getSnapshot() {
            return {
              entries: [
                { type: 'event', event: { type: 'user/message', seq: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'same' }] } } },
                { type: 'event', event: { type: 'user/message', seq: 2, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'same' }] } } },
                { type: 'event', event: { type: 'assistant/message', seq: 3, surfaceOp: 'append', data: { message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } } } },
              ],
            };
          },
        },
      };
    },
  }, 'session-3');
  assert.equal(JSON.stringify(duplicate.messages), JSON.stringify([
    { role: 'user', text: 'same' },
    { role: 'assistant', text: 'ok' },
  ]));
});

test('reads the Session model selection from the modelSelection projection', () => {
  const client = loadClient(makeStorage());
  const faceOf = (value) => ({
    getSnapshot() {
      return value;
    },
  });
  const sessionsWith = (value) => ({
    binding() {
      return { projections: { faceOf(key) { return faceOf(key === 'modelSelection' ? value : undefined); } } };
    },
  });

  assert.equal(JSON.stringify(client.__test.readSelection(
    sessionsWith({ lastUsed: { provider: 'p', model: 'm1' }, next: { provider: 'p', model: 'm2' } }),
    'session-1',
  )), JSON.stringify({ provider: 'p', model: 'm2' }));
  assert.equal(JSON.stringify(client.__test.readSelection(
    sessionsWith({ lastUsed: { provider: 'p', model: 'm1' }, next: null }),
    'session-1',
  )), JSON.stringify({ provider: 'p', model: 'm1' }));

  // Capability absent, empty face, or incomplete values degrade to null.
  assert.equal(client.__test.readSelection({ binding() { return {}; } }, 'session-1'), null);
  assert.equal(client.__test.readSelection(sessionsWith(undefined), 'session-1'), null);
  assert.equal(client.__test.readSelection(sessionsWith({ lastUsed: { provider: '', model: 'm' }, next: null }), 'session-1'), null);
  assert.equal(client.__test.readSelection(sessionsWith({ lastUsed: null, next: null }), 'session-1'), null);
  assert.equal(client.__test.readSelection({ binding() { throw new Error('gone'); } }, 'session-1'), null);
  assert.equal(client.__test.readSelection(undefined, 'session-1'), null);
});

test('the copy and the settings labels follow the DSH locale service', () => {
  const client = loadClient(makeStorage());
  // `locale` is an injected dependency: the service is there before apply runs.
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale']);

  const dicts = new Map();
  let revision = 0;
  // Shaped like `dsh-client-locale`'s LocaleRuntime: one namespace map, a
  // second register of the same language throws, `bind(ns)(key)` falls back to
  // English and then to the key.
  const service = {
    active: 'zh',
    bind(ns) {
      return (key) => {
        const table = dicts.get(ns) || {};
        const text = table[this.active] && table[this.active][key];
        if (text !== undefined) return text;
        const english = table.en && table.en[key];
        return english !== undefined ? english : key;
      };
    },
    getSnapshot() {
      return { active: this.active, revision };
    },
    subscribe() {
      return () => {};
    },
    register(ns, languages) {
      if (dicts.has(ns)) throw new Error('locale namespace "' + ns + '" already registered');
      dicts.set(ns, languages);
      revision += 1;
      return () => dicts.delete(ns);
    },
  };
  const registrations = [];
  const effects = [];
  const ctx = {
    locale: service,
    get() {
      return undefined;
    },
    effect(fn, label) {
      effects.push(label);
      fn();
    },
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
      },
    },
  };
  client.apply(ctx);

  // Both baseline languages are registered under one namespace, from one call.
  assert.deepEqual([...effects].filter((label) => typeof label === 'string' && label.includes('dictionaries')), ['dsh-next-input: dictionaries']);
  assert.deepEqual(Object.keys(dicts.get('dsh-next-input')).sort(), ['en', 'zh']);
  assert.equal(dicts.get('dsh-next-input').zh.hint, '按 Tab 采纳这则预测');
  assert.equal(dicts.get('dsh-next-input').en.settingsNav, 'Next input');
  assert.deepEqual(Object.keys(dicts.get('dsh-next-input').zh).sort(), Object.keys(dicts.get('dsh-next-input').en).sort());

  const section = registrations.find((entry) => entry.options.name === 'settings.section');
  assert.equal(section.options.label(), '下一步输入');
  service.active = 'en';
  revision += 1;
  assert.equal(section.options.label(), 'Next input');
});
/**
 * A tiny React stand-in for a settings page: hook slots persist between
 * renders, every state update re-renders the page, and an effect is allowed
 * to be asynchronous (it runs after the render that scheduled it).
 */
const harnessApi = {
  useSyncExternalStore: () => 0,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

function pageHarness(page) {
  const hooks = { refs: [], states: [], effects: [] };
  let cursor = 0;
  let scheduled = false;
  const api = harnessApi;
  Object.assign(api, {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) };
    },
    useRef(value) {
      const index = cursor;
      cursor += 1;
      hooks.refs[index] = hooks.refs[index] === undefined ? { current: value } : hooks.refs[index];
      return hooks.refs[index];
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (hooks.states[index] === undefined) hooks.states[index] = { value: initial };
      return [hooks.states[index].value, (next) => {
        hooks.states[index].value = typeof next === 'function' ? next(hooks.states[index].value) : next;
        scheduled = true;
      }];
    },
    useEffect(fn) {
      hooks.effects.push(fn);
    },
    useLayoutEffect(fn) {
      hooks.effects.push(fn);
    },
    useSyncExternalStore: () => 0,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  });
  const render = () => {
    cursor = 0;
    hooks.effects = [];
    const tree = page({});
    // Effects run after the render, like React: the fetch settles later and
    // flips `loading`, which schedules another render.
    for (const effect of hooks.effects) effect();
    return tree;
  };
  const settle = async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!scheduled) continue;
      scheduled = false;
      render();
    }
  };
  return { api, render, settle };
}

function labelsOf(tree) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (node.props !== undefined && typeof node.props['aria-label'] === 'string') found.push(node.props);
    walk(node.children);
  };
  walk(tree);
  return new Map(found.map((props) => [props['aria-label'], props]));
}

test('renders the Max mode section with its sub-switches locked while off', async () => {
  const settings = {
    values: {
      maxSuggestionChars: 400, maxContextChars: 32000, maxMessages: 64, maxTokens: 1024, timeoutMs: 20000,
      enterToSend: true, predictOnActivate: true, predictionProvider: '', predictionModel: '',
      maxMode: false, includeToolActivity: true, smartPack: true, allowMultiline: true,
      reasoningEffort: 'model', retryOnFailure: true, predictOnEndOnly: true, promptVariant: 'next',
    },
    providers: [],
  };
  // The harness object is created before the bundle loads: the module binds
  // `React.createElement` at load time, so the methods must already be there.
  const react = harnessApi;
  const client = loadClient(makeStorage(), {
    react,
    fetch: async () => ({ ok: true, json: async () => settings }),
  });
  const registrations = [];
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'en', revision: 0 }), subscribe: () => () => {} },
    get() { return undefined; },
    effect(fn) { fn(); },
    slots: { inject(_k, cb) { cb(); }, register(o, c) { registrations.push({ options: o, component: c }); } },
  };
  client.apply(ctx);
  const page = registrations.find((entry) => entry.options.name === 'settings.section').component;
  const harness = pageHarness(page);

  harness.render();
  await harness.settle();
  const tree = harness.render();
  const controls = labelsOf(tree);

  // `t()` resolves through the locale service, so labels are the English copy.
  assert.ok(controls.has('Enable Max mode'), 'the master switch renders');
  assert.equal(controls.get('Enable Max mode').disabled, false, 'the master switch is always editable');
  for (const label of ['Include tool activity', 'Improved context packing', 'Allow multiline suggestions',
    'Reasoning effort', 'Retry on failure', 'Only predict after an answer', 'Prediction prompt',
    // The four numeric budgets moved into this section and follow the switch.
    'Max output tokens', 'Max context characters', 'Max messages', 'Max suggestion characters']) {
    assert.ok(controls.has(label), label + ' renders');
    assert.equal(controls.get(label).disabled, true, label + ' is locked while Max mode is off');
  }
  // The timeout is not a Max mode budget, so it stays editable outside it.
  assert.equal(controls.get('Timeout (ms)').disabled, false, 'the timeout stays editable');
});

function longConversation(turns) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: 'user', text: '第' + turn + '轮：帮我修改 src/client.js 里的预测调度逻辑' });
    messages.push({
      role: 'assistant',
      text: ('## 修改说明\n```js\n' + 'function schedule(){ /* retry */ }\n'.repeat(60) + '```\n\n已完成。').slice(0, 4000),
    });
  }
  return messages;
}

test('smart packing keeps the opening request that the old packing loses', () => {
  const client = loadClient(makeStorage());
  const messages = longConversation(6);

  const old = client.__test.packConversation(messages, 7000, 24);
  const smart = client.__test.packConversationSmart(messages, 7000, 24);

  // The old packing spends the whole budget on recent answers and drops the
  // first request entirely.
  assert.ok(!old.some((message) => message.text.startsWith('第0轮')));
  // The new one reserves it, so the predictor still knows the goal.
  assert.ok(smart.some((message) => message.text.startsWith('第0轮')));
  assert.equal(smart[0].role, 'user');
  assert.ok(smart.reduce((total, message) => total + message.text.length, 0) <= 7000);
});

test('smart packing keeps the final answer and the request that produced it', () => {
  const client = loadClient(makeStorage());
  const messages = [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: 'x'.repeat(500) },
    { role: 'user', text: 'the uploader retries forever, fix it' },
    { role: 'assistant', text: 'y'.repeat(8000) },
  ];
  const smart = client.__test.packConversationSmart(messages, 4000, 24);
  assert.ok(smart.some((message) => message.text === 'the uploader retries forever, fix it'));
  const last = smart[smart.length - 1];
  assert.equal(last.role, 'assistant');
  assert.ok(last.text.endsWith('y'.repeat(50)), 'the answer keeps its tail');
  assert.ok(smart.reduce((total, message) => total + message.text.length, 0) <= 4000);
});

test('smart packing obeys the message cap', () => {
  const client = loadClient(makeStorage());
  const messages = longConversation(20);
  const smart = client.__test.packConversationSmart(messages, 50000, 5);
  assert.ok(smart.length <= 5);
});

test('Max mode reads the budgets from the settings page', () => {
  const client = loadClient(makeStorage());
  const { contextCharsForSettings, maxMessagesForSettings } = client.__test;
  // Max mode on: the settings page values apply verbatim.
  assert.equal(contextCharsForSettings({ maxContextChars: 32000 }, true), 32000);
  assert.equal(maxMessagesForSettings({ maxMessages: 64 }, true), 64);
  assert.equal(contextCharsForSettings({ maxContextChars: 12000 }, true), 12000);
  // Max mode off: the hardcoded 0.5.x budgets apply and the settings are not read.
  assert.equal(contextCharsForSettings({ maxContextChars: 32000 }, false), 7000);
  assert.equal(maxMessagesForSettings({ maxMessages: 64 }, false), 24);
  // A failed settings read (nothing to read) falls back the same way.
  assert.equal(contextCharsForSettings(undefined, true), 7000);
  assert.equal(maxMessagesForSettings(null, true), 24);
});

test('readConversation passes the Max mode budgets to the packing', () => {
  const client = loadClient(makeStorage());
  const entries = longConversation(6).map((message, index) => ({
    type: 'event',
    event: message.role === 'user'
      ? { type: 'user/message', seq: index, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: message.text }] } }
      : {
        type: 'assistant/message',
        seq: index,
        surfaceOp: 'append',
        data: { message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: message.text }] } },
      },
  }));
  const sessions = {
    binding() {
      return { eventSource: { getSnapshot() { return { entries }; } } };
    },
  };

  // Max mode off: the 0.5.x constants stay, and the opening round is dropped.
  const off = client.__test.readConversation(sessions, 'session-1');
  assert.ok(!off.messages.some((message) => message.text.startsWith('第0轮')));
  assert.ok(off.messages.reduce((total, message) => total + message.text.length, 0) <= 7000);

  // Max mode on with untouched budgets: the wider budget keeps every round.
  const on = client.__test.readConversation(sessions, 'session-1', { maxMode: true, smartPack: true });
  assert.ok(on.messages.some((message) => message.text.startsWith('第0轮')));
});

// ---------------------------------------------------------------------------
// Tool activity summary (Max mode `includeToolActivity`). The helpers are
// module-private, so they come out of the bundle through the same test hook
// pattern the rest of this file uses.
// ---------------------------------------------------------------------------

function toolEvent(type, seq, data) {
  return { type: 'event', event: { type, seq, data } };
}

function activityEntries(calls, results) {
  const entries = [toolEvent('turn/start', 1, {})];
  for (const call of calls) {
    entries.push(toolEvent('tool/call', call.seq, { callId: call.callId, name: call.name, arguments: JSON.stringify(call.args) }));
    if (call.result !== undefined) {
      entries.push(toolEvent('tool/result', call.seq + 1, {
        callId: call.callId,
        message: { role: 'tool', toolCallId: call.callId, isError: call.result === 'error', content: [{ type: 'text', text: 'ok' }] },
      }));
    }
  }
  entries.push(toolEvent('assistant/message', 99, { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }));
  return entries;
}

test('summarises a turn as file edits and recent commands', () => {
  const client = loadClient(makeStorage());
  const entries = activityEntries([
    { seq: 2, callId: 'a', name: 'bash', args: { command: 'go test ./...' }, result: 'ok' },
    { seq: 4, callId: 'b', name: 'read', args: { path: 'src/client.js' } },
    { seq: 6, callId: 'c', name: 'edit', args: { path: 'src/client.js' } },
    { seq: 8, callId: 'd', name: 'edit', args: { path: 'src/index.js' }, result: 'error' },
  ]);
  const summary = client.__test.toolActivitySummary(entries, 1200);
  assert.match(summary, /edit src\/client\.js/u);
  assert.match(summary, /edit src\/index\.js \[failed\]/u);
  assert.match(summary, /bash: go test \.\/\.\.\./u);
  assert.match(summary, /- read src\/client\.js/u);
});

test('collapses repeated commands and keeps the most recent ones', () => {
  const client = loadClient(makeStorage());
  const calls = [];
  for (let index = 0; index < 9; index += 1) {
    calls.push({ seq: 10 + index * 2, callId: 'c' + index, name: 'bash', args: { command: 'echo ' + index } });
  }
  const summary = client.__test.toolActivitySummary(activityEntries(calls), 5000);
  assert.match(summary, /5 earlier calls/u);
  assert.match(summary, /echo 8/u);
  assert.doesNotMatch(summary, /echo 0/u, 'only the most recent commands stay');
});

test('a summary cut to the budget ends on a line boundary', () => {
  const client = loadClient(makeStorage());
  const calls = [];
  for (let index = 0; index < 12; index += 1) {
    calls.push({ seq: 10 + index * 2, callId: 'c' + index, name: 'bash', args: { command: 'command number ' + index } });
  }
  const summary = client.__test.toolActivitySummary(activityEntries(calls), 120);
  assert.ok(summary.length <= 130);
  assert.match(summary, /- …$/u, 'a truncation marker closes the block');
  // Every line but the marker is a complete entry.
  for (const line of summary.split('\n')) {
    if (line === '- …') continue;
    assert.match(line, /^- (bash: |bash: \d+ earlier calls)/u);
  }
});

test('malformed tool arguments fall back to the tool name', () => {
  const client = loadClient(makeStorage());
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, data: {} } },
    { type: 'event', event: { type: 'tool/call', seq: 2, data: { callId: 'x', name: 'bash', arguments: '{not json' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 9, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } },
  ];
  assert.match(client.__test.toolActivitySummary(entries, 1200), /bash/u);
});

test('no tool calls means no summary block', () => {
  const client = loadClient(makeStorage());
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, data: {} } },
    { type: 'event', event: { type: 'assistant/message', seq: 9, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } },
  ];
  assert.equal(client.__test.toolActivitySummary(entries, 1200), '');
});

test('an absolute tool path is shortened to match how the transcript names it', () => {
  const client = loadClient(makeStorage());
  const entries = activityEntries([
    { seq: 2, callId: 'a', name: 'edit', args: { path: '/Users/ming/go/src/athand/native/internal/overlay/overlay_darwin.m' } },
    { seq: 4, callId: 'b', name: 'edit', args: { path: 'src/client.js' } },
  ]);
  const summary = client.__test.toolActivitySummary(entries, 1200);
  assert.match(summary, /edit …\/overlay\/overlay_darwin\.m/u);
  assert.doesNotMatch(summary, /\/Users\/ming/u);
  assert.match(summary, /edit src\/client\.js/u, 'relative paths are untouched');
});
