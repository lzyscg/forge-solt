/**
 * Zod → JSON Schema 转换。
 *
 * 这层存在的意义是「工具参数只有一份权威定义」，所以测试要证明的是
 * **派生结果确实跟着 `@shared/tools.ts` 走**，而不是某个手写常量长得像。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SlotProposalSchema, ToolSchemas } from '@shared/tools.ts';
import { toJsonSchema } from './tool-schema.ts';

describe('toJsonSchema', () => {
  it('optional 字段不进 required', () => {
    const schema = toJsonSchema(ToolSchemas.read_task_input);
    expect(schema['properties']).toMatchObject({ field: { type: 'string' } });
    expect(schema['required']).toBeUndefined();
  });

  it('SlotProposal 的 ID 正则原样带进 pattern（模型最容易违反的一条）', () => {
    const schema = toJsonSchema(SlotProposalSchema);
    const id = (schema['properties'] as Record<string, Record<string, unknown>>)['id'];
    expect(id?.['pattern']).toBe(SlotProposalSchema.shape.id._def.checks.find((c) => c.kind === 'regex')?.regex.source);
    expect(String(id?.['pattern'])).toContain('a-z');
  });

  it('nullable 表达成类型数组而不是 anyOf', () => {
    const schema = toJsonSchema(SlotProposalSchema);
    const parentId = (schema['properties'] as Record<string, Record<string, unknown>>)['parentId'];
    expect(parentId?.['type']).toEqual(['string', 'null']);
  });

  it('default 带出默认值，且该字段不再必填', () => {
    const schema = toJsonSchema(SlotProposalSchema);
    expect(schema['required']).not.toContain('dependsOn');
    const dependsOn = (schema['properties'] as Record<string, Record<string, unknown>>)['dependsOn'];
    expect(dependsOn?.['type']).toBe('array');
    expect(dependsOn?.['default']).toEqual([]);
  });

  it('enum / 整数下界 / 数组下界都被保留', () => {
    const report = toJsonSchema(ToolSchemas.report_work);
    const props = report['properties'] as Record<string, Record<string, unknown>>;
    expect(props['type']?.['enum']).toEqual(['understanding', 'plan', 'decision', 'progress', 'completion']);
    expect(props['summary']?.['maxLength']).toBe(2000);

    const proposal = toJsonSchema(SlotProposalSchema);
    const order = (proposal['properties'] as Record<string, Record<string, unknown>>)['order'];
    expect(order?.['type']).toBe('integer');
    expect(order?.['minimum']).toBe(0);
  });

  it('discriminatedUnion 展开成 anyOf，三个分支都在', () => {
    const schema = toJsonSchema(ToolSchemas.complete_assignment);
    const anyOf = schema['anyOf'] as Record<string, unknown>[];
    expect(anyOf).toHaveLength(3);
    const kinds = anyOf.map(
      (branch) => ((branch['properties'] as Record<string, Record<string, unknown>>)['kind'])?.['const'],
    );
    expect(kinds).toEqual(['structure', 'slot_content', 'review_result']);
  });

  /**
   * M4 回归。DeepSeek 对 function 的 `parameters` 有一条硬要求：根必须是
   * `type: "object"`，否则整个请求 400，一个 token 都不会生成。
   *
   * 断言写成「遍历全部工具」而不是只钉 `complete_assignment`，是因为这条约束
   * 属于**工具集合**而不属于某一个工具：将来新增一个判别联合参数的工具，
   * 单点断言不会响，而症状是那个工具一上线就让所有真实请求 400。
   */
  it('每个工具的根 schema 都是 type:"object"（Provider 的硬要求）', () => {
    for (const [name, schema] of Object.entries(ToolSchemas)) {
      expect(toJsonSchema(schema)['type'], `工具 ${name} 的根 type`).toBe('object');
    }
  });

  it('未覆盖的构造直接抛错，不静默退化成空 schema', () => {
    expect(() => toJsonSchema(z.map(z.string(), z.string()))).toThrow(/未覆盖的 Zod 构造/);
  });
});
