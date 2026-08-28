/**
 * 「这次审核到底在审哪段文字」——唯一的判定点。
 *
 * 这段文字有两个消费者，而它们必须拿到**逐字相同**的一份：
 *
 * 1. `context-builder` 把它作为【待审正文】写进 prompt；
 * 2. `completion-service.submitReviewResult` 拿它跑 D-11 的引文闸门
 *    （`verifyFindings`：finding 的引文对不上待审文本就丢弃）。
 *
 * 两边各算各的会产生一类特别难查的故障：模型引的每一句都真实出自它看到的文本，
 * 闸门却因为多了一个空格或少了一行而全部判为「引文不成立」，
 * 于是 verdict 被降级为 `discarded`——**对下游等同于「未检出问题」**（D-25）。
 * 表现是「审核一直说没问题」，而真实情况是审核结果被系统自己吞了。
 * 所以两个调用点必须调同一个函数。
 */

import type { Slot } from '@server/domain/types.ts';
import { documentOrder } from '@server/domain/readiness.ts';
import { renderOutline } from '@server/runtime/tools/index.ts';
import { isStructureRoot } from './review-binding.ts';

/**
 * 被审文本。
 *
 * - 内容槽位：它自己的正文（`commitContentForReview` 刚写进去的那一份）。
 * - 根容器（结构审核）：整棵树的结构概要，含每个内容槽位的 instruction。
 *   与 `read_structure_outline` 工具渲染的是同一个函数、同一份文本——
 *   结构 Agent 返修时用那个工具看到的、和审核 Agent 审的，必须是同一棵树的同一种写法。
 *
 * `currentSlotId` 传 null：`← 当前槽位` 这个标记是给填槽的模型指位置用的，
 * 结构审核审的是整棵树，没有哪一个是「当前」。
 */
export function contentUnderReviewOf(slot: Slot, slots: readonly Slot[]): string {
  if (!isStructureRoot(slot)) return slot.contentText ?? '';
  return renderOutline(
    documentOrder(slots).map((item) => ({
      slotId: item.slotId,
      type: item.type,
      parentId: item.parentId,
      sortOrder: item.sortOrder,
      instruction: item.instruction,
      dependsOn: item.dependsOn,
      contentBearing: item.contentBearing,
      status: item.status,
    })),
    null,
  );
}
