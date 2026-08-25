/**
 * Zod → JSON Schema（供 Provider 的 function calling 使用）。
 *
 * **为什么自己写而不是装 `zod-to-json-schema`**：D-15 的依赖清单是封闭的，
 * 而这里要覆盖的输入只有 `@shared/tools.ts` 里那 6 个**已冻结**的 schema——
 * 用到的构造一共八种。为了八种构造引一个通用库，换来的是一整套我们不需要的
 * `$ref` / `definitions` 生成逻辑（那套东西在 function calling 里反而常出兼容问题）。
 *
 * **为什么不手写一份 JSON Schema 常量**：那就是「另造一份 schema」。
 * 工具参数只有一份权威定义（§3.4 开头已经说明双重身份的理由），
 * 手写副本迟早与 Zod 那份漂移，而漂移的表现是模型按 A 产出、系统按 B 校验。
 *
 * 遇到未覆盖的构造**直接抛错**，不静默降级成 `{}`：一个空 schema 会让模型
 * 完全失去参数形状的指引，而症状要到「模型总是传错参数」才浮现。
 */

import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const out = convert(schema);
  const description = schema.description;
  if (description !== undefined && out['description'] === undefined) {
    out['description'] = description;
  }
  return out;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  // 包装类先剥壳。`default` 的默认值一并带出去，模型据此知道「不传等于什么」
  if (schema instanceof z.ZodOptional) return convert(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema._def.innerType as z.ZodTypeAny);
    inner['default'] = schema._def.defaultValue();
    return inner;
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema.unwrap() as z.ZodTypeAny);
    const type = inner['type'];
    // JSON Schema 的可空表达成类型数组，而不是 `anyOf: [T, null]`——
    // 后者在若干 Provider 的 function calling 校验器里会被拒
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
    // additionalProperties: false 是刻意的——模型多塞字段时，让 Zod 与 Provider
    // 侧的校验给出一致的反馈，而不是一边默许一边报错
    out['additionalProperties'] = false;
    return out;
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as z.ZodTypeAny[];
    // `type: 'object'` 不是为了迁就某一家 Provider 而加的冗余信息：判别联合的
    // 每个分支按定义都是 object，根类型**就是** object，只写 anyOf 是漏了。
    // 漏的代价是 DeepSeek 直接 400（`got 'type: null'`），而 FakeProvider
    // 不校验 schema，所以这一处在 M3 全绿的情况下依然是坏的。见 §3.4 的 M4 补正。
    return { type: 'object', anyOf: options.map((option) => toJsonSchema(option)) };
  }

  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: 'array', items: toJsonSchema(schema.element as z.ZodTypeAny) };
    const def = schema._def;
    if (def.minLength !== null) out['minItems'] = def.minLength.value;
    if (def.maxLength !== null) out['maxItems'] = def.maxLength.value;
    return out;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(schema.options as string[])] };
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema.value as unknown;
    return { type: typeof value === 'string' ? 'string' : typeof value, const: value };
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out['minLength'] = check.value;
      else if (check.kind === 'max') out['maxLength'] = check.value;
      // 正则原样带出：`SlotProposalSchema.id` 的 ID 规则是模型最容易违反的一条，
      // 写进 schema 比只写在 instruction 里更可能被遵守
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
    `tool-schema: 未覆盖的 Zod 构造 ${schema.constructor.name}。` +
      '新增工具参数时请在此补一条分支，不要让它静默退化成空 schema。',
  );
}
