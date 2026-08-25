/**
 * `read_task_input`：读取冻结的任务输入（§7.4 / AC-002）。
 *
 * 数据来自快照而不是 `tasks` 表当前值——任务一旦创建，输入就是冻结的，
 * 这一点由上游保证，本工具只是不去别处找数据。
 */

import { ForgeError } from '@shared/errors.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

export function createReadTaskInput(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'read_task_input',
    '读取本次任务已冻结的输入。省略 field 返回全部字段；传 field 只返回该字段。',
    async ({ field }) => {
      ctx.gate.assertOpen('read_task_input');
      const keys = Object.keys(ctx.taskInput).sort();

      if (field === undefined) {
        if (keys.length === 0) return '【任务输入】（空）';
        return ['【任务输入】（已冻结）', ...keys.map((key) => render(key, ctx.taskInput[key]))].join('\n\n');
      }

      const value = ctx.taskInput[field];
      if (value === undefined) {
        // 报错时把可用字段列全：模型下一步就能改对，省下一次往返
        throw new ForgeError(
          'TOOL_INPUT_INVALID',
          `任务输入中没有字段「${field}」。可用字段：${keys.join(', ') || '（无）'}`,
        );
      }
      return render(field, value);
    },
  );
}

function render(key: string, value: string | undefined): string {
  return `【${key}】\n${value ?? ''}`;
}
