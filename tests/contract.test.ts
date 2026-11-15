import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, matchFragment, operations, parseSpec, pointer, validateDocument } from '../src/contract.ts';
import { exportContract } from '../src/documentation.ts';

const fixture = {
  openapi: '3.1.0', info: { title: 'Inventory', version: '1.0' },
  servers: [{ url: 'https://example.test/api' }],
  security: [{ basic: [] }],
  paths: {
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'getProduct', tags: ['Products'], summary: 'Read product',
        parameters: [{ name: 'currency', in: 'query', schema: { type: 'string', default: 'USD', enum: ['USD', 'EUR'] } }],
        responses: {
          '200': { description: 'Found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' }, example: { id: 1 } } } },
          '404': { description: 'Not found' },
        },
      },
      post: { operationId: 'updateProduct', security: [], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } }, responses: { '204': { description: 'Updated' } } },
    },
  },
  components: {
    securitySchemes: { basic: { type: 'http', scheme: 'basic' } },
    schemas: { Product: { type: 'object', properties: { id: { type: 'integer' }, parent: { $ref: '#/components/schemas/Product' } } }, Unused: { type: 'string' } },
  },
};

test('extracts complete endpoint with local references and inherited security', () => {
  const document = parseSpec(JSON.stringify(fixture));
  const items = operations(document);
  assert.equal(items.length, 2);
  const match = matchFragment(items, '#/Products/getProduct');
  assert.ok(match);
  const contract = extract(document, match);
  assert.deepEqual(contract.data.operation, fixture.paths['/products/{id}'].get);
  assert.deepEqual(contract.data.pathContext, { parameters: fixture.paths['/products/{id}'].parameters });
  assert.deepEqual({ ...(contract.data.securitySchemes as object) }, fixture.components.securitySchemes);
  assert.deepEqual({ ...(contract.data.references as object) }, { '#/components/schemas/Product': fixture.components.schemas.Product });
  const markdown = exportContract(contract);
  for (const output of [markdown]) {
    for (const required of ['currency', 'Default', 'Enum', '404', 'example', 'parent', 'Authentication schemes']) assert.ok(output.includes(required), required);
    assert.ok(!output.includes('Unused'));
  }
});

test('respects endpoint security override and does not generate examples', () => {
  const document = validateDocument(structuredClone(fixture));
  const contract = extract(document, operations(document)[1]);
  assert.deepEqual(contract.data.security, []);
  assert.equal(contract.data.securitySchemes, undefined);
  assert.deepEqual(contract.warnings, ['Examples and descriptions may contain sensitive data. Review before sharing.']);
  const markdown = exportContract(contract);
  assert.ok(markdown.includes('No complete example provided.'));
  assert.ok(!markdown.includes('Illustrative only;'));
});

test('rejects unsupported versions, invalid structure, duplicate YAML keys, cyclic aliases', () => {
  assert.throws(() => parseSpec('{broken'), /Invalid JSON/);
  assert.throws(() => parseSpec('<html>Login required</html>'), /OpenAPI/);
  assert.throws(() => validateDocument({ ...fixture, openapi: '4.0.0' }), /Supported versions/);
  assert.throws(() => validateDocument({ openapi: '3.0.3', info: {}, paths: {} }), /info.title/);
  assert.throws(() => parseSpec('openapi: 3.0.3\nopenapi: 3.1.0'), /Invalid YAML/);
  assert.throws(() => parseSpec('a: &a\n  self: *a'), /Cyclic YAML/);
  assert.throws(() => parseSpec('x'.repeat(10 * 1024 * 1024 + 1)), /10 MB/);
});

test('imports YAML and Swagger 2.0', () => {
  const document = parseSpec('swagger: "2.0"\ninfo:\n  title: Legacy\n  version: "1"\npaths:\n  /ping:\n    get:\n      responses:\n        "200":\n          description: OK\n');
  assert.equal(operations(document)[0].path, '/ping');
});

test('external and missing references produce warnings, not network calls', () => {
  const document = validateDocument(structuredClone(fixture));
  const operation = operations(document)[0];
  operation.value.requestBody = { $ref: 'https://other.test/schema.json' };
  operation.value.callbacks = { broken: { $ref: '#/missing' } };
  const contract = extract(document, operation);
  assert.ok(contract.warnings.some(w => w.startsWith('External reference not fetched')));
  assert.ok(contract.warnings.some(w => w.startsWith('Unresolved reference')));
});

test('pointer decoding, ambiguous IDs, malformed fragments, safe Markdown fencing', () => {
  assert.equal(pointer({ 'a/b': { '~key': 4 } }, '#/a~1b/~0key'), 4);
  assert.equal(pointer({}, '#/toString'), undefined);
  assert.equal(pointer({}, '#/%invalid'), undefined);
  const document = validateDocument(structuredClone(fixture));
  const items = operations(document);
  assert.equal(matchFragment(items, '#/Other/getProduct'), undefined);
  assert.equal(matchFragment([...items, items[0]], '#/Products/getProduct'), undefined);
  assert.equal(matchFragment(items, '#/%invalid'), undefined);
  items[0].value.description = '```\nmalicious fence\n```';
  assert.match(exportContract(extract(document, items[0]), { raw: true }), /````json/);
});
