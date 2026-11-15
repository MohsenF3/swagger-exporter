import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaSample, schemaType, resolveSchema } from '../src/schema.ts';
import { documentation, exportContract } from '../src/documentation.ts';
import { validateDocument, operations, extract } from '../src/contract.ts';

const references = {
  '#/User': { type: 'object', properties: {
    id: { type: 'string', format: 'uuid', readOnly: true },
    name: { type: 'string', maxLength: 10 },
    level: { allOf: [{ $ref: '#/Level' }], minimum: 0, maximum: 32767 },
    secret: { type: 'string', writeOnly: true },
  }, required: ['id', 'name', 'level', 'secret'] },
  '#/Level': { type: 'integer', enum: [1, 2, 3], description: '1 - Basic; 2 - Plus; 3 - Premium' },
};
const paginated = { type: 'object', properties: {
  count: { type: 'integer', example: 123 },
  next: { type: ['string', 'null'], format: 'uri', example: 'https://example.com/?offset=10&limit=10' },
  results: { type: 'array', items: { $ref: '#/User' } },
}, required: ['count', 'results'] };

test('generates paginated response with property examples, arrays, UUIDs, enum wrappers, and access rules', () => {
  const result = schemaSample(paginated, references, 'response') as { count: number; next: string; results: Record<string, unknown>[] };
  assert.equal(result.count, 123);
  assert.equal(result.next, 'https://example.com/?offset=10&limit=10');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].level, 1);
  assert.match(String(result.results[0].id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.results[0].secret, undefined);
  const request = schemaSample({ $ref: '#/User' }, references, 'request') as Record<string, unknown>;
  assert.equal(request.id, undefined);
  assert.equal(request.secret, 'string');
});

test('nested readable tables show typed arrays, enum labels, access flags, and clean descriptions', () => {
  const schemas = Object.fromEntries(Object.entries(references).map(([key, value]) => [key.slice(2), value]));
  const text = JSON.stringify({ openapi: '3.1.0', info: { title: 'Test', version: '1' }, paths: { '/users': { get: {
    parameters: [{ name: 'level', in: 'query', description: 'Filter levels', style: 'form', explode: false, schema: { type: 'array', items: { type: 'integer' } } }],
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: paginated } } } },
  } } }, components: { schemas } }).replaceAll('#/User', '#/components/schemas/User').replaceAll('#/Level', '#/components/schemas/Level');
  const document = validateDocument(JSON.parse(text));
  const contract = extract(document, operations(document)[0]);
  const output = exportContract(contract, { generatedExamples: true });
  for (const expected of ['array&lt;integer&gt;', 'array&lt;object&gt;', 'schema.results\\[\\]', 'Enum: 1, 2, 3', '1 - Basic', 'Read-only', 'Write-only', 'Filter levels', 'Comma-separated', '123', 'generated example']) assert.ok(output.includes(expected), expected);
  const blocks = documentation(contract);
  assert.ok(blocks.some(block => block.text?.includes('Property-level examples')));
  assert.ok(blocks.find(block => block.heading === 'Parameters')?.columns?.includes('Description'));
});

test('unknown, recursive, conflicting and constrained schemas do not fabricate complete samples', () => {
  assert.equal(schemaSample({ type: 'string', pattern: '^x$' }, {}, 'response'), undefined);
  assert.equal(schemaSample({ type: 'string', format: 'custom' }, {}, 'response'), undefined);
  assert.equal(schemaSample({ type: 'array', items: { type: 'integer' }, minItems: 2, uniqueItems: true }, {}, 'response'), undefined);
  assert.equal(schemaSample({ type: 'object', required: ['missing'] }, {}, 'response'), undefined);
  assert.equal(schemaSample({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, {}, 'response'), undefined);
  const cycle = { '#/Node': { type: 'object', properties: { next: { $ref: '#/Node' } }, required: ['next'] } };
  assert.equal(schemaSample({ $ref: '#/Node' }, cycle, 'response'), undefined);
  const conflict = { allOf: [{ type: 'integer' }], type: 'string' };
  assert.deepEqual(resolveSchema(conflict, {}), conflict);
  assert.equal(schemaSample(conflict, {}, 'response'), undefined);
  assert.equal(schemaType({ type: ['array', 'null'], items: { type: 'string' } }, {}), 'array<string> or null');
  assert.deepEqual(schemaSample({ type: 'array', maxItems: 0, items: { type: 'string' } }, {}, 'response'), []);
});
