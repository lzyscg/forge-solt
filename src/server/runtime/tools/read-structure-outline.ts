/**
 * `read_structure_outline`：读取结构概要（§7.4）。
 *
 * 两条设计决定：
 *
 * 1. **`create_structure` 时直接拒绝**（§7.5）。结构还不存在，返回空树只会让模型
 *    以为「已经有一棵空结构了」，然后开始想怎么往里加节点。
 * 2. **树形字符文本而非 JSON**（§7.4）。模型对缩进树的空间理解优于嵌套 JSON，
 *    且 token 更省。概要**不含正文**——正文属于 `read_slot`，那里有依赖白名单。
 */

import { ForgeError } from '@shared/errors.ts';
import type { OutlineSlot } from '../ports.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

const STATUS_LABEL: Record<OutlineSlot['status'], string> = {
  pending: '等待',
  running: '进行中',
  reviewing: '审核中',
  completed: '已完成',
  failed: '失败',
};

export function createReadStructureOutline(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'read_structure_outline',
    '读取当前任务的结构概要（槽位树、类型、状态、依赖），不含任何正文。',
    async () => {
      ctx.gate.assertOpen('read_structure_outline');
      if (ctx.operation === 'create_structure') {
        throw new ForgeError(
          'TOOL_NOT_ALLOWED',
          '当前工作是创建结构，此时结构尚不存在，read_structure_outline 不可用。' +
            '请直接依据任务输入与可用槽位类型设计结构。',
        );
      }
      const slots = await ctx.structure.readOutline(ctx.taskId);
      return renderOutline(slots, ctx.targetSlotId);
    },
  );
}

/** 导出供测试直接验证渲染，不必绕一圈 Provider */
export function renderOutline(slots: readonly OutlineSlot[], currentSlotId: string | null): string {
  if (slots.length === 0) return '【结构概要】（空）';

  const childrenOf = new Map<string | null, OutlineSlot[]>();
  for (const slot of slots) {
    const bucket = childrenOf.get(slot.parentId);
    if (bucket === undefined) childrenOf.set(slot.parentId, [slot]);
    else bucket.push(slot);
  }
  for (const bucket of childrenOf.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  const lines: string[] = ['【结构概要】'];
  const walk = (parentId: string | null, indent: string): void => {
    for (const slot of childrenOf.get(parentId) ?? []) {
      const marks: string[] = [];
      marks.push(slot.contentBearing ? `[${STATUS_LABEL[slot.status]}]` : '[容器]');
      if (slot.slotId === currentSlotId) marks.push('← 当前槽位');
      if (slot.dependsOn.length > 0) marks.push(`依赖: ${slot.dependsOn.join(', ')}`);
      lines.push(`${indent}${slot.slotId}  ${marks.join('  ')}`);
      // 缩进用两个全角空格宽度的半角空格：树形结构靠列对齐传达层级，
      // 用 └─ 之类的连线字符在等宽字体外的环境下反而更乱
      walk(slot.slotId, `${indent}  `);
    }
  };
  walk(null, '');
  return lines.join('\n');
}
