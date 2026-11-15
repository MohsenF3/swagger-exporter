import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { openWorkspace, receiveWorkspace } from '../src/delivery.ts';
import { MAX_BYTES, parseSpec } from '../src/contract.ts';

type Updated = (id: number, info: chrome.tabs.OnUpdatedInfo) => void;
type Message = (message: unknown, sender: chrome.runtime.MessageSender, respond: (reply: { received: boolean }) => void) => void;
function fakeBrowser() {
  const updates = new Set<Updated>();
  const messages = new Set<Message>();
  const created: unknown[] = [];
  const activated: number[] = [];
  let calls = 0;
  const fake = {
    send: async (_message: unknown): Promise<unknown> => ({ received: true }),
    tabs: {
      create: async (options: unknown) => { created.push(options); return { id: 7 }; },
      getCurrent: async (): Promise<{ id?: number }> => ({ id: 7 }),
      update: async (id: number) => { activated.push(id); },
      onUpdated: { addListener: (fn: Updated) => updates.add(fn), removeListener: (fn: Updated) => updates.delete(fn) },
    },
    runtime: {
      id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`,
      sendMessage: async (message: unknown) => { calls++; return fake.send(message); },
      onMessage: { addListener: (fn: Message) => messages.add(fn), removeListener: (fn: Message) => messages.delete(fn) },
    },
  };
  return { fake, browser: fake as unknown as typeof chrome, updates, messages, created, activated, calls: () => calls,
    ready: (id = 7) => { for (const listener of updates) listener(id, { status: 'complete' }); },
  };
}

test('delivery waits for readiness, targets workspace, activates after acknowledgement and cleans up', async () => {
  const f = fakeBrowser();
  f.fake.send = async message => {
    assert.deepEqual(message, { type: 'import-spec', targetTab: 7, text: '{}', hash: '#/x', source: 'Swagger' });
    if (f.calls() === 1) throw new Error('No receiver');
    return { received: true };
  };
  const delivery = openWorkspace('{}', '#/x', 'Swagger', f.browser);
  await setImmediate();
  assert.equal(f.updates.size, 1);
  assert.deepEqual(f.activated, []);
  f.ready(8);
  assert.equal(f.calls(), 1);
  f.ready();
  f.ready();
  await delivery;
  assert.deepEqual(f.activated, [7]);
  assert.equal(f.updates.size, 0);
  assert.deepEqual(f.created, [{ url: 'chrome-extension://extension/workspace.html', active: false }]);
});

test('readiness during in-flight send triggers retry without parallel delivery', async () => {
  const f = fakeBrowser();
  let release!: (reply: unknown) => void;
  f.fake.send = async () => f.calls() === 1 ? new Promise(resolve => { release = resolve; }) : { received: true };
  const delivery = openWorkspace('{}', '', '', f.browser);
  await setImmediate();
  f.ready();
  assert.equal(f.calls(), 1);
  release(undefined);
  await delivery;
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.activated, [7]);
  assert.equal(f.updates.size, 0);
});

test('rejection and timeout remove listeners; late acknowledgement cannot activate tab', async context => {
  const rejected = fakeBrowser();
  rejected.fake.send = async () => ({ received: false });
  await assert.rejects(openWorkspace('{}', '', '', rejected.browser), /Specification import failed/);
  assert.equal(rejected.updates.size, 0);
  assert.deepEqual(rejected.activated, []);

  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeBrowser();
  let release!: (reply: unknown) => void;
  f.fake.send = () => new Promise(resolve => { release = resolve; });
  const delivery = openWorkspace('{}', '', '', f.browser);
  const failed = assert.rejects(delivery, /Workspace transfer failed/);
  await setImmediate();
  context.mock.timers.tick(8000);
  await failed;
  assert.equal(f.updates.size, 0);
  release({ received: true });
  await setImmediate();
  assert.deepEqual(f.activated, []);
});

test('activation failure reports received specification and removes lifecycle listeners', async () => {
  const f = fakeBrowser();
  f.fake.tabs.update = async () => { throw new Error('Tab closed'); };
  await assert.rejects(openWorkspace('{}', '', '', f.browser), /received specification but could not activate/);
  assert.equal(f.updates.size, 0);
  assert.equal(f.calls(), 1);
});

test('receiver without current tab rejects messages without acknowledgement', async () => {
  const f = fakeBrowser();
  f.fake.tabs.getCurrent = async () => ({});
  const stop = await receiveWorkspace(() => assert.fail('Unexpected import'), () => assert.fail('Unexpected error'), f.browser);
  for (const listener of f.messages) listener(
    { type: 'import-spec', text: '{}', hash: '' },
    { id: 'extension', url: f.fake.runtime.getURL('popup.html') },
    () => assert.fail('Unexpected acknowledgement'),
  );
  stop();
});

test('file-import workspace opens without delivery or listeners', async () => {
  const f = fakeBrowser();
  await openWorkspace(undefined, '', '', f.browser);
  assert.deepEqual(f.created, [{ url: 'chrome-extension://extension/workspace.html', active: true }]);
  assert.equal(f.calls(), 0);
  assert.equal(f.updates.size, 0);
});

test('sender and receiver deliver through validated loading together', async () => {
  const f = fakeBrowser();
  const text = JSON.stringify({ openapi: '3.1.0', info: { title: 'Delivery', version: '1' }, paths: { '/x': { get: { responses: { '200': { description: 'OK' } } } } } });
  const loaded: unknown[] = [];
  const stop = await receiveWorkspace(value => loaded.push(parseSpec(value)), () => assert.fail('Import failed'), f.browser);
  f.fake.send = async message => {
    let reply: unknown;
    for (const listener of f.messages) listener(message, { id: 'extension', url: f.fake.runtime.getURL('popup.html') }, value => { reply = value; });
    return reply;
  };
  await openWorkspace(text, '', '', f.browser);
  assert.equal(loaded.length, 1);
  assert.deepEqual(f.activated, [7]);
  assert.equal(f.updates.size, 0);
  stop();
});

test('receiver validates sender, target and bounds; acknowledges only validated loading', async () => {
  const f = fakeBrowser();
  const loaded: string[][] = [];
  const errors: unknown[] = [];
  const stop = await receiveWorkspace((...args) => {
    if (args[0] === 'invalid') throw new Error('Invalid specification');
    loaded.push(args);
  }, error => errors.push(error), f.browser);
  const sender = { id: 'extension', url: f.fake.runtime.getURL('popup.html') };
  const message = { type: 'import-spec', targetTab: 7, text: '{}', hash: '#/x', source: 's'.repeat(101) };
  const replies: { received: boolean }[] = [];
  const receive = (input: unknown, from = sender) => {
    for (const listener of f.messages) listener(input, from, reply => replies.push(reply));
  };
  receive(message, { ...sender, id: 'other' });
  receive(message, { ...sender, url: f.fake.runtime.getURL('workspace.html') });
  for (const input of [null, { ...message, type: 'other' }, { ...message, targetTab: 8 }, { ...message, text: 4 }, { ...message, text: 'x'.repeat(MAX_BYTES + 1) }, { ...message, hash: 4 }, { ...message, hash: 'x'.repeat(8193) }]) receive(input);
  assert.deepEqual(loaded, []);
  assert.deepEqual(replies, []);
  receive(message);
  assert.deepEqual(loaded, [['{}', '#/x', 's'.repeat(100)]]);
  receive({ ...message, text: 'invalid' });
  assert.equal(errors.length, 1);
  assert.deepEqual(replies, [{ received: true }, { received: false }]);
  stop();
  assert.equal(f.messages.size, 0);
});
