/**
 * 「这个槽位该由哪条审核绑定管」——唯一的判定点。
 *
 * R2 只有一种审核：按槽位类型绑定（`reviewSlotByType.<type>`），审的是那个槽位
 * 自己的正文。R5 加了第二种：结构审核（`reviewStructure`），审的是**根容器底下
 * 那棵树**——每个内容槽位的 instruction 写清楚了没有。
 *
 * 两种审核共用 R2 的整条流水线（调度枚举判据 → 逐条一次 execution → 引文闸门 →
 * 结算），差别只在这一个函数：绑定从哪儿取。因此它必须只有一份实现。
 * 四个调用点（调度器、引擎的两处、任务读模型）里任何一处自己写
 * `reviewSlotByType[slot.type]`，结构审核在那条路径上就会静默变成「没绑定」，
 * 而「没绑定审核」是 D-27 明文允许的合法状态——不会报错，只是不审。
 */

import type { Slot } from '@server/domain/types.ts';
import type { CompiledBinding, CompiledTemplate } from './template-loader.ts';

/**
 * 根容器 = `parentId === null` 且不承载内容。
 *
 * 结构校验规则 2 保证一棵树里这样的槽位**有且只有一个**（根唯一且必须是容器），
 * 所以这个判据在合法结构上不会同时命中两个槽位。
 * 中间层的容器（`parentId !== null`）不走结构审核：它们不是一棵树，
 * 而 `reviewStructure` 的返修动作是「整棵树重来」。
 */
export function isStructureRoot(slot: Pick<Slot, 'parentId' | 'contentBearing'>): boolean {
  return slot.parentId === null && !slot.contentBearing;
}

/** 该槽位的审核绑定；没有绑定即返回 null（D-27：不绑定是合法默认） */
export function reviewBindingOf(compiled: CompiledTemplate, slot: Slot): CompiledBinding | null {
  if (isStructureRoot(slot)) return compiled.bindings.reviewStructure;
  return compiled.bindings.reviewSlotByType[slot.type] ?? null;
}
