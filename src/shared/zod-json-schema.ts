import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

/** Convert the Zod subset used by provider tools into deterministic JSON Schema. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const out = convert(schema);
  const description = schema.description;
  if (description !== undefined && out['description'] === undefined) {
    out['description'] = description;
  }
  return out;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) return convert(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema._def.innerType as z.ZodTypeAny);
    inner['default'] = schema._def.defaultValue();
    return inner;
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema.unwrap() as z.ZodTypeAny);
    const type = inner['type'];
    inner['type'] = typeof type === 'string' ? [type, 'null'] : type;
    return inner;
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: JsonSchema = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      if (field === undefined) continue;
      properties[key] = toJsonSchema(field);
      if (!field.isOptional()) required.push(key);
    }
    const out: JsonSchema = { type: 'object', properties };
    if (required.length > 0) out['required'] = required;
    out['additionalProperties'] = false;
    return out;
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as z.ZodTypeAny[];
    return { type: 'object', anyOf: options.map((option) => toJsonSchema(option)) };
  }

  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: 'array', items: toJsonSchema(schema.element as z.ZodTypeAny) };
    const def = schema._def;
    if (def.minLength !== null) out['minItems'] = def.minLength.value;
    if (def.maxLength !== null) out['maxItems'] = def.maxLength.value;
    return out;
  }

  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };

  if (schema instanceof z.ZodLiteral) {
    const value = schema.value as unknown;
    return { type: typeof value === 'string' ? 'string' : typeof value, const: value };
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out['minLength'] = check.value;
      else if (check.kind === 'max') out['maxLength'] = check.value;
      else if (check.kind === 'regex') out['pattern'] = check.regex.source;
    }
    return out;
  }

  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: 'number' };
    for (const check of schema._def.checks) {
      if (check.kind === 'int') out['type'] = 'integer';
      else if (check.kind === 'min') out['minimum'] = check.value;
      else if (check.kind === 'max') out['maximum'] = check.value;
    }
    return out;
  }

  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };

  throw new Error(
    `zod-json-schema: 未覆盖的 Zod 构造 ${schema.constructor.name}。` +
      '新增 schema 时请补转换分支，不要静默退化成空 schema。',
  );
}
