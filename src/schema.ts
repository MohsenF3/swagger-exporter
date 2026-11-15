import { object, type ObjectValue } from './contract.ts';

export const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function resolveSchema(value: unknown, references: ObjectValue, seen = new Set<string>()): unknown {
  if (!object(value)) return value;
  if (typeof value.$ref === 'string' && !seen.has(value.$ref) && Object.hasOwn(references, value.$ref) && seen.size < 40) {
    const target = resolveSchema(references[value.$ref], references, new Set(seen).add(value.$ref));
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
    if (object(target) && Object.keys(siblings).every(key => !(key in target) || JSON.stringify(siblings[key]) === JSON.stringify(target[key]))) return { ...target, ...siblings };
    if (!Object.keys(siblings).length) return target;
    return value;
  }
  // ponytail: only flatten a single compatible allOf wrapper; keep intersections/unions explicit until a semantic resolver is needed.
  if (Array.isArray(value.allOf) && value.allOf.length === 1 && seen.size < 40) {
    const target = resolveSchema(value.allOf[0], references, new Set(seen).add(`allOf:${seen.size}`));
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'allOf'));
    if (object(target) && Object.keys(siblings).every(key => !(key in target) || JSON.stringify(siblings[key]) === JSON.stringify(target[key]))) return { ...target, ...siblings };
  }
  return value;
}

export function schemaType(value: unknown, references: ObjectValue, depth = 0): string {
  if (depth > 8) return '…';
  const resolved = resolveSchema(value, references);
  if (typeof resolved === 'boolean') return resolved ? 'Any value' : 'No value allowed';
  const schema = object(resolved) ? resolved : {};
  const types = Array.isArray(schema.type) ? stringList(schema.type) : typeof schema.type === 'string' ? [schema.type] : [];
  let base = types.map(type => type === 'array' ? `array<${schemaType(schema.items, references, depth + 1)}>` : type).join(' or ');
  if (!base) base = schema.$ref ? `Reference: ${schema.$ref}` : schema.properties ? 'object' : schema.items ? `array<${schemaType(schema.items, references, depth + 1)}>` : ['oneOf', 'anyOf', 'allOf'].find(key => key in schema) ?? 'Not specified';
  return schema.nullable === true && !types.includes('null') ? `${base} or null` : base;
}

export function schemaDetails(value: unknown, references: ObjectValue): string {
  const resolved = resolveSchema(value, references);
  if (!object(resolved)) return '—';
  const schema = resolved;
  const details: string[] = [];
  if (schema.minLength !== undefined && schema.minLength === schema.maxLength) details.push(`Exactly ${schema.minLength} characters when string`);
  else if (schema.minLength !== undefined || schema.maxLength !== undefined) details.push(`${schema.minLength ?? 0}–${schema.maxLength ?? 'unbounded'} characters when string`);
  for (const [key, label] of [['minimum', 'Minimum'], ['maximum', 'Maximum'], ['exclusiveMinimum', 'Exclusive minimum'], ['exclusiveMaximum', 'Exclusive maximum'], ['minItems', 'Minimum items'], ['maxItems', 'Maximum items'], ['minProperties', 'Minimum properties'], ['maxProperties', 'Maximum properties'], ['multipleOf', 'Multiple of'], ['format', 'Format'], ['pattern', 'Pattern'], ['default', 'Default'], ['example', 'Example'], ['const', 'Constant']] as const) {
    if (Object.hasOwn(schema, key)) details.push(`${label}: ${JSON.stringify(schema[key])}`);
  }
  if (Array.isArray(schema.enum)) details.push(`Enum: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
  if (schema.uniqueItems) details.push('Unique items');
  if (schema.deprecated) details.push('Deprecated');
  const handled = new Set(['type', 'nullable', 'description', 'title', 'properties', 'required', 'readOnly', 'writeOnly', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'multipleOf', 'format', 'pattern', 'default', 'example', 'const', 'enum', 'uniqueItems', 'deprecated']);
  // Objects/arrays are rendered as child tables. Keep other schema semantics visible as structured details.
  if (schema.items !== undefined) {
    const item = resolveSchema(schema.items, references);
    if (object(item) && !object(item.properties)) details.push(`Items: ${JSON.stringify(item)}`);
    else if (!object(item)) details.push(`Items: ${JSON.stringify(item)}`);
    handled.add('items');
  }
  const extras = Object.fromEntries(Object.entries(schema).filter(([key]) => !handled.has(key)));
  if (Object.keys(extras).length) details.push(JSON.stringify(extras));
  return details.join('; ') || '—';
}

export function schemaSample(value: unknown, references: ObjectValue, direction: 'request' | 'response'): unknown {
  let nodes = 0;
  function generate(raw: unknown, seen: Set<string>, depth: number): unknown {
    if (++nodes > 2000 || depth > 12 || raw === false) return undefined;
    if (object(raw) && typeof raw.$ref === 'string') {
      if (seen.has(raw.$ref)) return undefined;
      seen = new Set(seen).add(raw.$ref);
    }
    const resolved = resolveSchema(raw, references);
    if (!object(resolved)) return undefined;
    const schema = resolved;
    if ((direction === 'request' && schema.readOnly) || (direction === 'response' && schema.writeOnly)) return undefined;
    if (Object.hasOwn(schema, 'example')) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    // Unknown constraints must not silently become fabricated complete samples.
    const allowed = new Set(['type', 'nullable', 'title', 'description', 'readOnly', 'writeOnly', 'deprecated', 'default', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'format', 'example', 'examples', '$schema', '$id', '$comment', 'xml', 'externalDocs', 'discriminator']);
    if (Object.keys(schema).some(key => !allowed.has(key) && !key.startsWith('x-'))) return undefined;
    const t = Array.isArray(schema.type) ? schema.type.find(v => v !== 'null') : schema.type;
    let candidate: unknown;
    if (Object.hasOwn(schema, 'const')) candidate = schema.const;
    else if (Array.isArray(schema.enum) && schema.enum.length) candidate = schema.enum.find(v => {
      if (typeof v === 'number') return (typeof schema.minimum !== 'number' || v >= schema.minimum) && (typeof schema.maximum !== 'number' || v <= schema.maximum);
      if (typeof v === 'string') return (typeof schema.minLength !== 'number' || v.length >= schema.minLength) && (typeof schema.maxLength !== 'number' || v.length <= schema.maxLength);
      return true;
    });
    else if (t === 'object' || schema.properties) {
      const properties = object(schema.properties) ? schema.properties : {};
      if (stringList(schema.required).some(name => !Object.hasOwn(properties, name))) return undefined;
      const result: ObjectValue = Object.create(null);
      for (const [name, field] of Object.entries(object(schema.properties) ? schema.properties : {})) {
        const childSchema = resolveSchema(field, references);
        if (object(childSchema) && ((direction === 'request' && childSchema.readOnly) || (direction === 'response' && childSchema.writeOnly))) continue;
        const child = generate(field, seen, depth + 1);
        if (child === undefined) { if (stringList(schema.required).includes(name)) return undefined; }
        else result[name] = child;
      }
      const count = Object.keys(result).length;
      if (typeof schema.minProperties === 'number' && count < schema.minProperties || typeof schema.maxProperties === 'number' && count > schema.maxProperties) return undefined;
      candidate = result;
    } else if (t === 'array' || schema.items) {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const max = typeof schema.maxItems === 'number' ? schema.maxItems : 10;
      if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < min || min > 10 || max < 0) return undefined;
      const length = max === 0 ? 0 : Math.max(1, min);
      const values: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const child = generate(schema.items, seen, depth + 1);
        if (child === undefined) return undefined;
        values.push(child);
      }
      if (schema.uniqueItems && new Set(values.map(v => JSON.stringify(v))).size !== values.length) return undefined;
      candidate = values;
    } else if (t === 'string') {
      const formats: Record<string, string> = { uuid: '00000000-0000-4000-8000-000000000000', uri: 'https://example.com/resource', 'uri-reference': '/resource', email: 'user@example.com', date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z', hostname: 'example.com', ipv4: '192.0.2.1', ipv6: '2001:db8::1' };
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
      const max = typeof schema.maxLength === 'number' ? schema.maxLength : 100;
      if (!Number.isInteger(min) || min < 0 || min > 100 || max < min || max < 0) return undefined;
      if (schema.format) {
        if (typeof schema.format !== 'string' || !Object.hasOwn(formats, schema.format)) return undefined;
        candidate = formats[schema.format];
        if ((candidate as string).length < min || (candidate as string).length > max) return undefined;
      } else candidate = 'string'.slice(0, max).padEnd(min, 'x');
    } else if (t === 'integer' || t === 'number') {
      if (schema.format && !['int32', 'int64', 'float', 'double'].includes(String(schema.format))) return undefined;
      const minimum = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.maximum === 'number' ? Math.min(0, schema.maximum) : 0;
      candidate = t === 'integer' ? Math.ceil(minimum) : minimum;
      if (typeof schema.maximum === 'number' && (candidate as number) > schema.maximum) return undefined;
    } else if (t === 'boolean') candidate = true;
    else if (t === 'null') candidate = null;
    return candidate;
  }
  return generate(value, new Set(), 0);
}
