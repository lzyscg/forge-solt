/**
 * 工具定义的统一形状。
 *
 * 关键约束：参数 schema **只能**来自 `@shared/tools.ts` 的 `ToolSchemas`
 * （§3.4 的「同一份定义两用」）。`defineTool` 是唯一的构造入口，它按工具名
 * 自动取那份 schema——于是「顺手在这里另写一个 z.object」在类型层就写不出来。
 *
 * 参数解析发生在 `invoke` 里而不是分发器里，理由是解析失败要产出**这个工具**的
 * 参数说明（可用字段、格式），而分发器只认识工具名。
 */

import type { z } from 'zod';
import { ForgeError } from '@shared/errors.ts';
import { ToolSchemas } from '@shared/tools.ts';
import type { ToolInput, ToolName } from '@shared/tools.ts';
import { toJsonSchema } from '../provider/tool-schema.ts';

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** JSON Schema，从 Zod 派生（见 provider/tool-schema.ts） */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * 执行一次调用。入参是**未经校验的模型输出**。
   * 返回值是给模型看的 tool_result 文本；失败一律抛 `ForgeError`，
   * 由分发器转成错误结果（D-11 / D-18 的实现陷阱）。
   */
  readonly invoke: (rawArgs: unknown) => Promise<string>;
}

export function defineTool<N extends ToolName>(
  name: N,
  description: string,
  run: (input: ToolInput<N>) => Promise<string>,
): ToolDefinition {
  const schema = ToolSchemas[name] as z.ZodType<ToolInput<N>>;
  return {
    name,
    description,
    parameters: toJsonSchema(schema),
    invoke: async (rawArgs: unknown): Promise<string> => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        // 把 Zod 的 issue 逐条铺开给模型：只说「参数非法」它只能瞎猜，
        // 而它下一次调用就是我们的重试配额
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
          .join('；');
        throw new ForgeError('TOOL_INPUT_INVALID', `${name} 的参数不合法：${detail}`);
      }
      return await run(parsed.data);
    },
  };
}
