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

function loadClient(storage) {
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
    console,
    fetch: async () => {
      throw new Error('not used');
    },
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
  return bundle.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('unexpected module: ' + name);
  });
}

test('the client half loads and registers the composer overlay', () => {
  const client = loadClient(makeStorage());

  assert.equal(typeof client.apply, 'function');
  const registrations = [];
  const ctx = {
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
