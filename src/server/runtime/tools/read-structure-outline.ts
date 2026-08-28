/**
 * `read_structure_outline`：读取结构概要（§7.4）。
 *
 * 两条设计决定：
 *
 * 1. **`create_structure` 时直接拒绝**（§7.5）。结构还不存在，返回空树只会让模型
 *    以为「已经有一棵空结构了」，然后开始想怎么往里加节点。
 * 2. **树形字符文本而非 JSON**（§7.4）。模型对缩进树的空间理解优于嵌套 JSON，
 *    且 token 更省。概要**不含正文**——正文属于 `read_slot`，那里有依赖白名单。
 *
 * ## 为什么带上 instruction
 *
 * 结构 Agent 写在 `instruction` 里的，就是这个槽位「要完成什么」——发生什么、
 * 建立什么、停在哪里（见 `chapter-structure-design/SKILL.md` S2）。
 * 它是**规划**不是正文，因此不受 `read_slot` 那条依赖白名单的约束：
 * 让场景二看见场景三的**计划**没有任何问题，让它看见场景三的**正文**才有问题
 * （那会让它去衔接一段还不存在、或将来会被改写的文字）。
 *
 * 早先这里只渲染 slotId / 状态 / 依赖，横向视野全靠一个独立的「章节骨架」槽位
 * 挂成每个场景的依赖来提供。那份骨架与 instruction 的内容高度重复
 * （实测：结构 Agent 已经把逐场的目标/冲突/出场人物写进了 instruction），
 * 于是同一件事被生成了两遍、审了两遍、又在每次填槽时被注入了两遍。
 * 把 instruction 渲染进来之后，那个槽位就没有存在的理由了。
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
      // instruction 另起一行、再缩进一级：它是成段的中文，跟在标记后面会把
      // 那一行撑到几百字符，树形结构靠列对齐传达的层级就全毁了。
      // 容器槽位不产出内容，它的 instruction 对下游没有可执行含义，不渲染。
      if (slot.contentBearing && slot.instruction.trim() !== '') {
        lines.push(`${indent}    目标：${collapseLines(slot.instruction)}`);
      }
      // 缩进用两个全角空格宽度的半角空格：树形结构靠列对齐传达层级，
      // 用 └─ 之类的连线字符在等宽字体外的环境下反而更乱
      walk(slot.slotId, `${indent}  `);
    }
  };
  walk(null, '');
  return lines.join('\n');
}

/**
 * 把 instruction 里的换行折成单行。
 *
 * 结构 Agent 可以在 instruction 里写多行（实测有写成分行清单的）。原样渲染会让
 * 后续行顶到最左边，读起来像是树的下一个节点——缩进树的层级信息就被它破坏了。
 */
function collapseLines(instruction: string): string {
  return instruction.replace(/\s*\n\s*/g, ' ').trim();
}
