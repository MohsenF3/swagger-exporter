import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, operations, validateDocument } from '../src/contract.ts';
import { documentation, exportContract } from '../src/documentation.ts';

function login() {
  const ref = { schema: { $ref: '#/components/schemas/Login' } };
  const document = validateDocument({
    openapi: '3.1.0', info: { title: 'Tosilver', version: 'v1' },
    paths: { '/api/v1/manager/login/': { post: {
      operationId: 'login', requestBody: { required: true, content: { 'application/json': ref, 'application/x-www-form-urlencoded': ref, 'multipart/form-data': ref } },
      security: [{ ApiKeyHeaderAuth: [] }, { ApiKeyCookieAuth: [] }, {}], responses: { '200': { description: 'No response body' } },
    } } },
    components: { schemas: { Login: { type: 'object', properties: {
      username: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 1, maxLength: 100 },
      totp: { type: ['string', 'null'], minLength: 6, maxLength: 6 }, device: { type: 'string', minLength: 1, maxLength: 80 },
    }, required: ['username', 'password', 'totp', 'device'] } } },
  });
  return extract(document, operations(document)[0]);
}

test('login documentation removes duplication and resolves request schema', () => {
  const contract = login();
  const output = exportContract(contract);
  assert.ok(output.includes('## Parameters\n\nNone.'));
  assert.ok(output.includes('| totp | string or null | Yes |'));
  assert.ok(output.includes('Exactly 6 characters when string'));
  assert.ok(output.includes('Response 200\n\nNo response body'));
  assert.ok(output.includes('Anonymous access allowed by specification.'));
  assert.equal((output.match(/\| username \|/g) ?? []).length, 1);
  for (const redundant of ['## endpoint', '## pathContext', '## operation', '## securitySchemes', '## references', '```json\n{}']) assert.ok(!output.includes(redundant), redundant);
  assert.ok(!output.includes('## Request body generated example'));
  assert.ok(output.includes('application/json, application/x-www-form-urlencoded, multipart/form-data'));
  const raw = exportContract(contract, { raw: true });
  assert.ok(raw.includes('## references'));
  assert.ok(raw.includes('operationId'));
});

test('preview and Markdown share readable/raw section selection and order', () => {
  const contract = login();
  const original = JSON.stringify(contract);
  for (const options of [{}, { generatedExamples: true }, { raw: true }, { raw: true, generatedExamples: true }]) {
    const blocks = documentation(contract, options);
    const markdown = exportContract(contract, options);
    assert.deepEqual(markdown.split('\n').filter(line => line.startsWith('## ')), blocks.map(block => `## ${block.heading}`));
    if (options.raw) {
      assert.deepEqual(blocks, Object.entries(contract.data).map(([heading, json]) => ({ heading, json })));
      for (const block of blocks) assert.ok(markdown.includes(JSON.stringify(block.json, null, 2)));
    } else {
      assert.equal(blocks.some(block => block.heading === 'Request body generated example'), options.generatedExamples === true);
    }
  }
  assert.equal(exportContract(contract, { raw: true }), exportContract(contract, { raw: true, generatedExamples: true }));
  assert.equal(JSON.stringify(contract), original);
});

test('related schemas follow structured dependencies, not descriptions or table formatting', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const document = validateDocument({ openapi: '3.1.0', info: { title: 'References', version: '1' }, paths: { '/refs': { get: {
    parameters: [{ name: 'filter', in: 'query', schema: { type: 'string', 'x-rule': ref('ParameterRule') } }],
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Root') } } } },
  } } }, components: { schemas: {
    Root: { type: 'object', properties: {
      child: ref('Child'), union: { oneOf: [ref('Union')] },
      detail: { type: 'string', description: JSON.stringify(ref('Decoy')), 'x-rule': ref('Rule') },
      missing: ref('Missing'), external: { $ref: 'https://example.test/schema' },
    } },
    Child: { type: 'object', properties: { root: ref('Root') } },
    Union: { type: 'string', enum: ['x'] },
    Rule: { 'x-next': ref('Tail') }, Tail: { 'x-next': ref('Rule') },
    ParameterRule: { type: 'string' }, Decoy: { type: 'integer' }, Unused: { type: 'boolean' },
  } } });
  const contract = extract(document, operations(document)[0]);
  const names = documentation(contract).filter(block => block.heading.startsWith('Related schema: ')).map(block => block.heading);
  assert.deepEqual(new Set(names), new Set(['ParameterRule', 'Union', 'Rule', 'Tail'].map(name => `Related schema: #/components/schemas/${name}`)));
  assert.equal(names.length, new Set(names).size);
  assert.ok(contract.warnings.includes('Unresolved reference: #/components/schemas/Missing'));
  assert.ok(contract.warnings.includes('External reference not fetched: https://example.test/schema'));
});

test('generated examples are opt-in, labeled, and match simple field constraints', () => {
  const output = exportContract(login(), { generatedExamples: true });
  assert.ok(output.includes('Illustrative only; not supplied by backend.'));
  assert.ok(output.includes('"totp": "string"'));
  assert.equal((output.match(/"username": "string"/g) ?? []).length, 1);
  assert.ok(exportContract(login()).includes('| username | string | Yes |'));
});

test('parameter overrides and distinct media types retain constraints and response examples', () => {
  const document = validateDocument({ openapi: '3.0.3', info: { title: 'Test', version: '1' }, paths: { '/x': {
    parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer', default: 10 } }],
    get: { parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer', default: 20 }, style: 'form', explode: false }],
      responses: { '200': { description: 'OK', headers: { 'X-Count': { schema: { type: 'integer' } } }, content: {
        'application/json': { schema: { type: 'string' }, example: 'backend' },
        'text/plain': { schema: { type: 'string', pattern: '^x$' } },
      } } },
    },
  } } });
  const contract = extract(document, operations(document)[0]);
  const output = exportContract(contract, { generatedExamples: true });
  assert.ok(output.includes('Default: 20'));
  assert.ok(!output.includes('Default: 10'));
  assert.ok(output.includes('"explode":false'));
  assert.ok(output.includes('backend-provided'));
  assert.ok(output.includes('Safe sample generation unavailable'));
  assert.ok(output.includes('X-Count'));
});
