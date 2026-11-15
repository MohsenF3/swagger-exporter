import { object, type Contract, type ObjectValue } from './contract.ts';
import { resolveSchema, schemaDetails, schemaSample, schemaType, stringList as strings } from './schema.ts';

export type Block = { heading: string; text?: string; json?: unknown; columns?: string[]; rows?: string[][] };
export type ExportOptions = { raw?: boolean; generatedExamples?: boolean };
const describe = (value: unknown): string => typeof value === 'string' ? value : '';

export function documentation(contract: Contract, options: ExportOptions = {}): Block[] {
  if (options.raw) return Object.entries(contract.data).map(([heading, json]) => ({ heading, json }));
  const data = contract.data;
  const op = contract.operation.value;
  const path = object(data.pathContext) ? data.pathContext : {};
  const references = object(data.references) ? data.references : {};
  const blocks: Block[] = [];
  const nestedRefs = new Set<string>();
  const displayedRefs = new Set<string>();
  function collect(node: unknown): void {
    if (!node || typeof node !== 'object' || nestedRefs.size >= 2000) return;
    if (object(node) && typeof node.$ref === 'string') nestedRefs.add(node.$ref);
    Object.values(node).forEach(collect);
  }
  function resolve(value: unknown, seen = new Set<string>()): unknown {
    if (!object(value) || typeof value.$ref !== 'string' || seen.has(value.$ref) || !Object.hasOwn(references, value.$ref)) return value;
    seen.add(value.$ref);
    const target = resolve(references[value.$ref], seen);
    return object(target) ? { ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) } : value;
  }
  const resolvedObject = (value: unknown): ObjectValue => { const result = resolve(value); return object(result) ? result : {}; };
  const type = (value: unknown) => schemaType(value, references);
  function schemaBlock(heading: string, value: unknown): void {
    let fields = 0;
    function render(label: string, raw: unknown, seen: Set<string>, depth: number): void {
      if (++fields > 500 || depth > 10) { blocks.push({ heading: label, text: 'Schema display limit reached. Use raw contract for full details.' }); return; }
      if (object(raw) && typeof raw.$ref === 'string') {
        if (seen.has(raw.$ref)) { blocks.push({ heading: label, text: `Recursive reference: ${raw.$ref}` }); return; }
        seen = new Set(seen).add(raw.$ref);
      }
      const resolved = resolveSchema(raw, references);
      collect(resolved);
      if (object(raw) && typeof raw.$ref === 'string' && resolved !== raw && (!object(resolved) || !resolved.$ref)) displayedRefs.add(raw.$ref);
      if (!object(resolved)) { blocks.push({ heading: label, json: resolved }); return; }
      if (resolved.items && !resolved.properties) {
        blocks.push({ heading: label, text: `${type(resolved)}; ${schemaDetails(resolved, references)}` });
        render(`${label}[]`, resolved.items, seen, depth + 1); return;
      }
      if (!object(resolved.properties) || ['allOf', 'oneOf', 'anyOf', '$ref'].some(key => key in resolved)) { blocks.push({ heading: label, json: resolved }); return; }
      const required = strings(resolved.required);
      const children: { name: string; value: unknown }[] = [];
      const rows: string[][] = [];
      for (const [name, field] of Object.entries(resolved.properties)) {
        if (++fields > 500) { blocks.push({ heading: `${label} remaining fields`, text: 'Schema display limit reached. Use raw contract for full details.' }); break; }
        const child = resolveSchema(field, references);
        const schema = object(child) ? child : {};
        const description = describe(schema.description);
        rows.push([name, type(field), required.includes(name) ? 'Yes' : 'No', schema.readOnly ? 'Read-only' : schema.writeOnly ? 'Write-only' : '—', schemaDetails(field, references), description || '—']);
        if (object(schema.properties) || schema.items || ['allOf', 'oneOf', 'anyOf', '$ref'].some(key => key in schema)) children.push({ name, value: field });
      }
      blocks.push({ heading: label, columns: ['Field', 'Type', 'Required', 'Access', 'Constraints / details', 'Description'], rows });
      const details = Object.fromEntries(Object.entries(resolved).filter(([key]) => !['type', 'properties', 'required'].includes(key)));
      if (Object.keys(details).length) blocks.push({ heading: `${label} rules`, json: details });
      for (const child of children) render(`${label}.${child.name}`, child.value, seen, depth + 1);
    }
    render(heading, value, new Set(), 0);
  }
  function content(heading: string, raw: unknown, direction: 'request' | 'response'): void {
    if (!object(raw) || !Object.keys(raw).length) return;
    const groups = new Map<string, { types: string[]; media: ObjectValue }>();
    for (const [name, value] of Object.entries(raw)) {
      const media = resolvedObject(value);
      const key = JSON.stringify(media);
      const group = groups.get(key);
      if (group) group.types.push(name); else groups.set(key, { types: [name], media });
    }
    for (const { types, media } of groups.values()) {
      const label = groups.size > 1 ? `${heading} (${types.join(', ')})` : heading;
      blocks.push({ heading: `${label} content types`, text: types.join(', ') });
      if (media.schema !== undefined) schemaBlock(`${label} schema`, media.schema);
      if (Object.hasOwn(media, 'example')) blocks.push({ heading: `${label} example (backend-provided)`, json: media.example });
      else if (object(media.examples) && Object.keys(media.examples).length) {
        for (const [name, example] of Object.entries(media.examples)) blocks.push({ heading: `${label} example: ${name} (backend-provided)`, json: resolve(example) });
      } else if (Object.hasOwn(resolvedObject(media.schema), 'example')) {
        blocks.push({ heading: `${label} example (backend-provided)`, json: resolvedObject(media.schema).example });
      } else if (options.generatedExamples && media.schema !== undefined) {
        const generated = schemaSample(media.schema, references, direction);
        blocks.push(generated === undefined ? { heading: `${label} example`, text: 'Not provided. Safe sample generation unavailable for this schema.' } : { heading: `${label} generated example`, text: 'Illustrative only; not supplied by backend. Not a validated request or response.', json: generated });
      } else blocks.push({ heading: `${label} example`, text: 'No complete example provided. Property-level examples, if present, appear in schema details. Enable generated examples to assemble an illustrative sample.' });
      const extras = Object.fromEntries(Object.entries(media).filter(([key]) => !['schema', 'example', 'examples'].includes(key)));
      if (Object.keys(extras).length) blocks.push({ heading: `${label} encoding / details`, json: extras });
    }
  }
  const info = object(data.info) ? data.info : {};
  blocks.push({ heading: 'API', text: [describe(info.title), describe(info.version), `OpenAPI ${data.openapi ?? data.swagger}`].filter(Boolean).join(' · ') });
  if (op.description) blocks.push({ heading: 'Description', text: describe(op.description) });
  const servers = op.servers ?? path.servers ?? data.servers;
  if (servers !== undefined) blocks.push({ heading: 'Servers', json: servers });
  else if (data.host || data.basePath) blocks.push({ heading: 'Server', json: { host: data.host, basePath: data.basePath, schemes: data.schemes } });

  const parameters = new Map<string, ObjectValue>();
  const unresolved: unknown[] = [];
  for (const raw of [...(Array.isArray(path.parameters) ? path.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    const parameter = resolvedObject(raw);
    if (parameter.$ref) unresolved.push(parameter);
    else parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const regular = [...parameters.values()].filter(p => !['body', 'formData'].includes(String(p.in)));
  if (!regular.length && !unresolved.length) blocks.push({ heading: 'Parameters', text: 'None.' });
  else {
    blocks.push({ heading: 'Parameters', columns: ['Name', 'Location', 'Type', 'Required', 'Description', 'Constraints / serialization'], rows: regular.map(p => {
      const schema = p.schema ?? p;
      collect(resolveSchema(schema, references));
      const details = Object.fromEntries(Object.entries(p).filter(([key]) => !['name', 'in', 'required', 'description', 'schema', 'type', 'items', 'default', 'enum'].includes(key)));
      const serialization = object(details) && details.style === 'form' && details.explode === false ? 'Comma-separated (style: form; explode: false). ' : '';
      return [String(p.name ?? 'Unknown'), String(p.in ?? 'Unknown'), type(schema), p.required === true || p.in === 'path' ? 'Yes' : 'No', describe(p.description) || '—', `${schemaDetails(schema, references)}${Object.keys(details).length ? `; ${serialization}${JSON.stringify(details)}` : ''}`];
    }) });
    if (unresolved.length) blocks.push({ heading: 'Unresolved parameters', json: unresolved });
  }
  if (op.requestBody !== undefined) {
    const body = resolvedObject(op.requestBody);
    blocks.push({ heading: 'Request body', text: `${body.required === true ? 'Required.' : 'Optional.'}${body.description ? ` ${body.description}` : ''}` });
    if (body.$ref) blocks.push({ heading: 'Request body reference', json: body });
    content('Request body', body.content, 'request');
  } else {
    const bodies = [...parameters.values()].filter(p => ['body', 'formData'].includes(String(p.in)));
    if (!bodies.length) blocks.push({ heading: 'Request body', text: 'None documented.' });
    for (const body of bodies) {
      blocks.push({ heading: `Request body: ${body.name}`, text: body.required ? 'Required.' : 'Optional.' });
      content('Request body', Object.fromEntries((strings(op.consumes ?? data.consumes).length ? strings(op.consumes ?? data.consumes) : ['Content type not specified']).map(t => [t, { schema: body.schema ?? body }])), 'request');
    }
  }
  const responses = resolvedObject(op.responses);
  if (!Object.keys(responses).length) blocks.push({ heading: 'Responses', text: 'Not provided.' });
  for (const [code, raw] of Object.entries(responses)) {
    const response = resolvedObject(raw);
    blocks.push({ heading: `Response ${code}`, text: describe(response.description) || 'No description provided.' });
    if (response.$ref) blocks.push({ heading: `Response ${code} reference`, json: response });
    if (response.headers) blocks.push({ heading: `Response ${code} headers`, json: response.headers });
    if (response.links) blocks.push({ heading: `Response ${code} links`, json: response.links });
    if (response.content) content(`Response ${code}`, response.content, 'response');
    else if (response.schema) {
      content(`Response ${code}`, Object.fromEntries((strings(op.produces ?? data.produces).length ? strings(op.produces ?? data.produces) : ['Content type not specified']).map(t => [t, { schema: response.schema, ...(object(response.examples) && Object.hasOwn(response.examples, t) ? { example: response.examples[t] } : {}) }])), 'response');
    }
  }
  const requirements = Array.isArray(data.security) ? data.security : [];
  const schemes = object(data.securitySchemes) ? data.securitySchemes : {};
  const auth = requirements.map(requirement => {
    if (!object(requirement)) return 'Invalid security requirement; inspect raw contract.';
    const entries = Object.entries(requirement);
    if (!entries.length) return 'Anonymous access allowed by specification.';
    return entries.map(([name, scopes]) => `${name}${strings(scopes).length ? ` (scopes: ${strings(scopes).join(', ')})` : ''}${Object.hasOwn(schemes, name) ? '' : ' (definition unavailable)'}`).join(' AND ');
  });
  blocks.push({ heading: 'Authentication', text: auth.length ? auth.join('\nOR\n') : 'No authentication required by specification.' });
  if (Object.keys(schemes).length) blocks.push({ heading: 'Authentication schemes', json: schemes });
  const extraOperation = Object.fromEntries(Object.entries(op).filter(([key]) => !['operationId', 'tags', 'summary', 'description', 'parameters', 'requestBody', 'responses', 'security', 'servers', 'consumes', 'produces'].includes(key)));
  if (Object.keys(extraOperation).length) blocks.push({ heading: 'Additional operation details', json: extraOperation });
  if (path.description || path.summary) blocks.push({ heading: 'Path description', text: [describe(path.summary), describe(path.description)].filter(Boolean).join('\n') });
  // Structured values carry dependencies; table wording never determines retention.
  for (const block of blocks) collect(block.json);
  for (const ref of nestedRefs) {
    if (displayedRefs.has(ref) || !Object.hasOwn(references, ref)) continue;
    blocks.push({ heading: `Related schema: ${ref}`, json: references[ref] });
    collect(references[ref]);
  }
  return blocks;
}

function codeFence(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)));
  return `${fence}json\n${text}\n${fence}`;
}
const cell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n]+/g, ' ');
const line = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1');

export function exportContract(contract: Contract, options: ExportOptions = {}): string {
  const sections = documentation(contract, options).map(block => {
    const chunks = [`## ${line(block.heading)}`];
    if (block.text) chunks.push(block.text.split('\n').map(line).join('\n'));
    if (block.columns) chunks.push([`| ${block.columns.map(cell).join(' | ')} |`, `| ${block.columns.map(() => '---').join(' | ')} |`, ...(block.rows ?? []).map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n'));
    if (block.json !== undefined) chunks.push(codeFence(block.json));
    return chunks.join('\n\n');
  });
  return [`# ${line(contract.title)}`, ...contract.warnings.map(w => `> ${line(w)}`), ...sections].join('\n\n') + '\n';
}
