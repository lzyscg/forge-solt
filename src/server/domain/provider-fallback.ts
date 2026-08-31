/**
 * 降级链的挑档逻辑（D-66 / D-67 / D-69）。
 *
 * 纯函数、零 IO、不读时钟——耗尽状态与当前时刻都由调用方查好了传进来。
 * 这样「链上有三档、第一档耗尽了、于是选第二档、而第二档是付费档所以要告警」
 * 这一串判断可以完全用表驱动测试覆盖，不需要起数据库、不需要真把额度烧完。
 *
 * 它**不决定**什么算耗尽（那是 D-68，在 runtime 层），只消费那个结论。
 */

import type { ModelAliasChain, ModelAliasEntry } from '@server/application/provider-config.ts';
import { ForgeError } from '@shared/errors.ts';

export interface FallbackPick {
  /** 选中的那一档 */
  readonly chosen: ModelAliasEntry;
  /** 它在链上的位置，0 是首选。>0 即发生了降级 */
  readonly tier: number;
  /** 被跳过的档，按链上顺序。用于 D-70 的轨迹 */
  readonly skipped: readonly { provider: string; model: string; reason: 'exhausted' }[];
  /** 选中的是按量付费档（D-69）。调用方据此决定要不要重重告警 */
  readonly paid: boolean;
}

/**
 * 沿链选出第一个未耗尽的档。
 *
 * **全都耗尽时不返回 null，而是返回最后一档。** 这是刻意的：
 * 链的最后一档按约定是「不会耗尽」的那个（按量付费）。如果连它都被标记成耗尽，
 * 那多半是判定误伤，而不是真的哪儿都跑不了了。此时宁可去试一次、
 * 让真实的错误暴露出来，也不要抛一个「无可用 Provider」——
 * 后者会把一个可能只是误判的状态，变成一堵查不出原因的墙。
 *
 * 这与 D-26「任务永不因审核卡死」是同一种取舍：机制不该成为新的卡死点。
 */
export function pickProvider(
  chain: ModelAliasChain,
  isExhausted: (providerId: string) => boolean,
): FallbackPick {
  if (chain.length === 0) {
    throw new ForgeError('MODEL_ALIAS_UNRESOLVED', '降级链为空，无法挑档', 'provider-fallback');
  }

  const skipped: { provider: string; model: string; reason: 'exhausted' }[] = [];

  for (let tier = 0; tier < chain.length; tier += 1) {
    const entry = chain[tier];
    if (entry === undefined) continue;
    if (!isExhausted(entry.provider)) {
      return { chosen: entry, tier, skipped, paid: entry.paid === true };
    }
    skipped.push({ provider: entry.provider, model: entry.model, reason: 'exhausted' });
  }

  // 全都标了耗尽 —— 退回最后一档硬试一次（见上方注释）
  const last = chain[chain.length - 1];
  if (last === undefined) {
    throw new ForgeError('MODEL_ALIAS_UNRESOLVED', '降级链为空，无法挑档', 'provider-fallback');
  }
  return {
    chosen: last,
    tier: chain.length - 1,
    // 最后一档自己不算「被跳过」——它被选中了
    skipped: skipped.slice(0, -1),
    paid: last.paid === true,
  };
}

/**
 * 把挑档结果写成人话，进轨迹（D-70）。
 *
 * 措辞受 D-30 约束：不许含糊成「已切换 Provider」。
 * 尤其是付费档那一句必须写明**这是按量付费的**——第 3 档永不耗尽，
 * 意味着一旦滑下去，系统会无限期、无提示地持续花钱而表面上一切正常。
 * 这正是最该有信号的一类状态。
 */
export function describePick(alias: string, pick: FallbackPick): string {
  const target = `${pick.chosen.provider} / ${pick.chosen.model}`;
  if (pick.tier === 0) {
    return `别名「${alias}」用首选档 ${target}`;
  }
  const skippedText = pick.skipped.map((s) => s.provider).join('、');
  const base =
    `别名「${alias}」降级到第 ${pick.tier + 1} 档 ${target}` +
    `（跳过已耗尽的：${skippedText || '（无）'}）`;
  return pick.paid
    ? `${base}。⚠️ 这一档是**按量付费**的，从现在起本任务的调用会产生实际费用`
    : base;
}
