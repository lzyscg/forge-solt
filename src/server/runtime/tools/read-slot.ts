/**
 * `read_slot`：读取依赖槽位的正文（§7.5）。
 *
 * 权限判断**只看白名单**（`allowedDependencySlotIds`），不看模型传的参数是否「合理」，
 * 也不看目标槽位是否已完成、是否同一父节点之下。理由见 REQ FR-CTX-003：
 * 依赖声明同时是调度依据与上下文边界，任何一处按「看起来没问题」放宽，
 * 都会让「其他槽位的正文不在你的上下文中」这句话失效。
 */

import { ForgeError } from '@shared/errors.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

export function createReadSlot(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'read_slot',
    '读取本槽位显式依赖的某个槽位的正文。只能读 dependsOn 中声明过的槽位。',
    async ({ slotId }) => {
      ctx.gate.assertOpen('read_slot');
      if (!ctx.allowedDependencySlotIds.includes(slotId)) {
        throw new ForgeError(
          'TOOL_NOT_ALLOWED',
          `slot「${slotId}」不在当前槽位的依赖中。` +
            `可读取：${ctx.allowedDependencySlotIds.join(', ') || '（无）'}`,
        );
      }

      const view = await ctx.structure.readSlotContent(ctx.taskId, slotId);
      if (view === null) {
        throw new ForgeError('SLOT_NOT_FOUND', `slot「${slotId}」不存在。`);
      }
      if (view.contentText === null) {
        // 依赖在白名单里却没有正文，说明调度出了问题（依赖未完成就排到了本槽位）。
        // 报 SLOT_NOT_READY 而不是返回空串：空串会被模型当成「上文什么都没发生」，
        // 于是它照样写下去，产出一段与前文脱节的正文，而且没人会知道
        throw new ForgeError(
          'SLOT_NOT_READY',
          `slot「${slotId}」当前状态是 ${view.status}，还没有正文可读。`,
          `slot:${slotId}`,
        );
      }
      return `── ${view.slotId} ──\n${view.contentText}`;
    },
  );
}
