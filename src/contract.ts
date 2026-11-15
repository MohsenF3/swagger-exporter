import { parseDocument } from 'yaml';

export type ObjectValue = Record<string, unknown>;
export type Operation = { method: string; path: string; id: string; summary: string; tags: string[]; value: ObjectValue; item: ObjectValue };
export type Contract = { title: string; operation: Operation; data: ObjectValue; warnings: string[] };
export const MAX_BYTES = 10 * 1024 * 1024;
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
export const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateDocument(value: unknown): ObjectValue {
  let nodes = 0;
  const seen = new WeakSet<object>();
  function visit(node: unknown, depth: number): void {
    if (++nodes > 200_000 || depth > 80) throw new Error('Document exceeds structure limits. Import a smaller specification.');
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) throw new Error('Cyclic YAML aliases are not supported. Use OpenAPI $ref references instead.');
    seen.add(node);
    for (const child of Object.values(node)) visit(child, depth + 1);
    seen.delete(node);
  }
  visit(value, 0);
  if (!object(value)) throw new Error('Expected an OpenAPI object.');
  if (!(typeof value.openapi === 'string' && /^3\.(0|1)\./.test(value.openapi)) && value.swagger !== '2.0') {
    throw new Error('Supported versions: OpenAPI 3.0, OpenAPI 3.1, and Swagger 2.0.');
  }
  if (!object(value.info) || typeof value.info.title !== 'string' || typeof value.info.version !== 'string' || !object(value.paths)) {
    throw new Error('Specification needs info.title, info.version, and a paths object.');
  }
  return value;
}

export function parseSpec(text: string): ObjectValue {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Specification exceeds 10 MB limit.');
  let value: unknown;
  if (/^\s*[\[{]/.test(text)) {
    try { value = JSON.parse(text); } catch { throw new Error('Invalid JSON specification.'); }
  } else {
    const parsed = parseDocument(text, { uniqueKeys: true, schema: 'core' });
    if (parsed.errors.length) throw new Error(`Invalid YAML: ${parsed.errors[0].message}`);
    value = parsed.toJS({ maxAliasCount: 30 });
  }
  return validateDocument(value);
}

export function pointer(document: ObjectValue, ref: string): unknown {
  if (ref === '#') return document;
  if (!ref.startsWith('#/')) return undefined;
  let parts: string[];
  try { parts = decodeURIComponent(ref.slice(2)).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')); }
  catch { return undefined; }
  let node: unknown = document;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = (node as ObjectValue)[part];
  }
  return node;
}

export function operations(document: ObjectValue): Operation[] {
  const result: Operation[] = [];
  for (const [path, raw] of Object.entries(document.paths as ObjectValue)) {
    if (!path.startsWith('/') || !object(raw)) continue;
    const resolved = typeof raw.$ref === 'string' ? pointer(document, raw.$ref) : raw;
    if (!object(resolved)) continue;
    const item = { ...resolved, ...raw };
    for (const [method, value] of Object.entries(item)) {
      if (!methods.has(method) || !object(value)) continue;
      result.push({ method: method.toUpperCase(), path, id: typeof value.operationId === 'string' ? value.operationId : '', summary: typeof value.summary === 'string' ? value.summary : '', tags: Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === 'string') : [], value, item });
    }
  }
  return result;
}

export function matchFragment(items: Operation[], hash: string): Operation | undefined {
  let pieces: string[];
  try { pieces = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent); } catch { return; }
  const id = pieces.at(-1);
  if (!id) return;
  const matches = items.filter(item => item.id === id && (pieces.length < 2 || item.tags.includes(pieces.at(-2)!)));
  return matches.length === 1 ? matches[0] : undefined;
}

function pick(source: ObjectValue, keys: string[]): ObjectValue {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}

export function extract(document: ObjectValue, operation: Operation): Contract {
  const warnings = new Set<string>(['Examples and descriptions may contain sensitive data. Review before sharing.']);
  const data: ObjectValue = {
    ...pick(document, ['openapi', 'swagger', 'info', 'jsonSchemaDialect', 'servers', 'host', 'basePath', 'schemes', 'consumes', 'produces', 'externalDocs']),
    endpoint: { method: operation.method, path: operation.path },
    pathContext: pick(operation.item, ['summary', 'description', 'parameters', 'servers', '$ref']),
    operation: operation.value,
    security: operation.value.security ?? document.security ?? [],
  };
  if (operation.item.$ref) warnings.add('Referenced path item retained with its resolved fields; review sibling semantics.');
  const requirements = data.security;
  const schemes = object(document.components) && object(document.components.securitySchemes) ? document.components.securitySchemes : object(document.securityDefinitions) ? document.securityDefinitions : {};
  const names = Array.isArray(requirements) ? requirements.flatMap(item => object(item) ? Object.keys(item) : []) : [];
  const selected: ObjectValue = Object.create(null);
  for (const name of names) {
    if (Object.hasOwn(schemes, name)) selected[name] = schemes[name];
    else warnings.add(`Security scheme not found: ${name}`);
  }
  if (names.length) data.securitySchemes = selected;
  const references: ObjectValue = Object.create(null);
  const visited = new Set<string>();
  let walked = 0;
  function walk(node: unknown, depth = 0): void {
    if (++walked > 200_000 || depth > 100) throw new Error('Endpoint exceeds reference traversal limits.');
    if (!node || typeof node !== 'object') return;
    if (object(node) && typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!visited.has(ref)) {
        visited.add(ref);
        if (visited.size > 2000) throw new Error('Endpoint exceeds 2,000-reference limit.');
        if (!ref.startsWith('#')) warnings.add(`External reference not fetched: ${ref}`);
        else {
          const target = pointer(document, ref);
          if (target === undefined) warnings.add(`Unresolved reference: ${ref}`);
          else { references[ref] = target; walk(target, depth + 1); }
        }
      }
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  }
  walk(data);
  data.references = references;
  if (!object(operation.value.responses) || !Object.keys(operation.value.responses).length) warnings.add('Responses: Not provided.');
  return { title: `${operation.method} ${operation.path}`, operation, data, warnings: [...warnings] };
}
