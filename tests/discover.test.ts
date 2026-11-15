import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSwagger } from '../src/discover.ts';

test('Swagger discovery reuses loaded contract and bounds same-origin requests', async () => {
  const names = ['window', 'document', 'location', 'fetch'] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const specification = { openapi: '3.0.3', info: { title: 'Test', version: '1' }, paths: {} };
  let requests = 0;
  try {
    set('location', { href: 'https://api.test/docs/', origin: 'https://api.test', hash: '#/Products/list' });
    set('document', { scripts: [], querySelectorAll: () => [] });
    set('window', { ui: { specSelectors: { specJson: () => ({ toJS: () => specification }) } } });
    set('fetch', async () => { requests++; throw new Error('Unexpected request'); });
    const loaded = await inspectSwagger();
    assert.deepEqual(JSON.parse(loaded.text!), specification);
    assert.equal(loaded.hash, '#/Products/list');
    assert.equal(requests, 0);

    const blocked = await inspectSwagger('https://external.test/openapi.json');
    assert.match(blocked.error!, /same-origin/);
    assert.equal(requests, 0);
    const credentials = await inspectSwagger('https://user:password@api.test/openapi.json');
    assert.match(credentials.error!, /credentials/);
    assert.equal(requests, 0);

    set('window', { ui: { getConfigs: () => ({ urls: [{ url: '/one.json' }, { url: '/two.json' }] }) } });
    const multiple = await inspectSwagger();
    assert.equal(multiple.candidates.length, 2);
    assert.match(multiple.error!, /Multiple/);
    assert.equal(requests, 0);

    set('fetch', async (url: string, options: RequestInit) => {
      requests++;
      assert.equal(url, 'https://api.test/openapi.json');
      assert.equal(options.credentials, 'include');
      assert.equal(options.redirect, 'error');
      return new Response('denied', { status: 401 });
    });
    const denied = await inspectSwagger('/openapi.json');
    assert.match(denied.error!, /access denied \(401\)/);
    assert.equal(requests, 1);

    set('fetch', async () => new Response(JSON.stringify(specification)));
    assert.deepEqual(JSON.parse((await inspectSwagger('/openapi.json')).text!), specification);
  } finally {
    for (const name of names) {
      const original = originals.get(name);
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
