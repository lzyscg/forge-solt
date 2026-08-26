/**
 * 审核结算（D-26）。
 *
 * 本轮各判据审完后，由系统（而非模型）决定槽位的下一步：
 * 全部未检出 → 完成；有检出且预算未尽 → 返修；有检出且预算耗尽 → 按现状完成。
 *
 * 这是纯函数，零 IO，享受 domain 层 100% 分支覆盖的强制。
 * 它的输入是本轮各判据的 verdict 与 revisionRound，输出是目标状态——零 IO。
 */

/** 单条判据的审核结果 */
export type CriterionVerdict = 'no_finding' | 'revise' | 'discarded';

/** 结算输入 */
export interface SettlementInput {
  /** 本轮各判据的结果 */
  readonly verdicts: readonly CriterionVerdict[];
  /** 当前已用轮次（slots.revision_round） */
  readonly revisionRound: number;
  /** 返修上限，来自 Slot Type 定义 */
  readonly maxRevisionRounds: number;
}

/** 结算结果 */
export type Settlement =
  | { readonly action: 'complete'; readonly exhausted: false }
  | { readonly action: 'complete'; readonly exhausted: true }
  | { readonly action: 'revise'; readonly nextRound: number };

/**
 * 根据本轮 verdict 与返修预算，决定槽位是完成还是返修。
 *
 * 规则：
 * - 无任何 revise → complete, exhausted=false
 * - 有 revise 且 revisionRound < maxRevisionRounds → revise, nextRound = revisionRound + 1
 * - 有 revise 且 revisionRound >= maxRevisionRounds → complete, exhausted=true
 * - verdicts 为空数组 → complete, exhausted=false（防御：无判据等于没审）
 *
 * `discarded` 与 `no_finding` 在结算上等价（都不触发返修），
 * 但必须是两个取值——排查时含义完全不同：
 * 前者是「模型说有问题但证据不成立」，后者是「模型说没问题」。
 */
export function settleReview(input: SettlementInput): Settlement {
  const hasRevise = input.verdicts.some((v) => v === 'revise');

  if (!hasRevise) {
    return { action: 'complete', exhausted: false };
  }

  if (input.revisionRound < input.maxRevisionRounds) {
    return { action: 'revise', nextRound: input.revisionRound + 1 };
  }

  return { action: 'complete', exhausted: true };
}
