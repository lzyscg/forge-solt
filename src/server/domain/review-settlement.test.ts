import { describe, expect, it } from 'vitest';
import type { SettlementInput } from './review-settlement.ts';
import { settleReview } from './review-settlement.ts';

describe('审核结算（D-26）', () => {
  // 规则第 1 行：无 revise → complete/exhausted=false
  it('无 revise → complete, exhausted=false', () => {
    const input: SettlementInput = {
      verdicts: ['no_finding', 'no_finding'],
      revisionRound: 0,
      maxRevisionRounds: 2,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: false });
  });

  // 规则第 2 行：有 revise 且 revisionRound < maxRevisionRounds → revise
  it('有 revise 且 revisionRound < maxRevisionRounds → revise, nextRound = revisionRound + 1', () => {
    const input: SettlementInput = {
      verdicts: ['no_finding', 'revise'],
      revisionRound: 0,
      maxRevisionRounds: 2,
    };
    expect(settleReview(input)).toEqual({ action: 'revise', nextRound: 1 });
  });

  // 规则第 3 行：有 revise 且 revisionRound >= maxRevisionRounds → complete/exhausted=true
  it('有 revise 且 revisionRound >= maxRevisionRounds → complete, exhausted=true', () => {
    const input: SettlementInput = {
      verdicts: ['revise'],
      revisionRound: 2,
      maxRevisionRounds: 2,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: true });
  });

  // 规则第 4 行：verdicts 为空数组 → complete/exhausted=false（防御）
  it('verdicts 为空数组 → complete, exhausted=false（防御：无判据等于没审）', () => {
    const input: SettlementInput = {
      verdicts: [],
      revisionRound: 0,
      maxRevisionRounds: 2,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: false });
  });

  it('discarded 与 no_finding 在结算上等价（都不触发返修）', () => {
    const input: SettlementInput = {
      verdicts: ['discarded', 'no_finding'],
      revisionRound: 0,
      maxRevisionRounds: 2,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: false });
  });

  // 边界：maxRevisionRounds=0 时任何 revise 立即耗尽
  it('maxRevisionRounds=0：任何 revise 立即耗尽', () => {
    const input: SettlementInput = {
      verdicts: ['revise'],
      revisionRound: 0,
      maxRevisionRounds: 0,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: true });
  });

  it('混合 verdicts：有一条 revise 就触发返修', () => {
    const input: SettlementInput = {
      verdicts: ['no_finding', 'discarded', 'revise', 'no_finding'],
      revisionRound: 1,
      maxRevisionRounds: 3,
    };
    expect(settleReview(input)).toEqual({ action: 'revise', nextRound: 2 });
  });

  it('revisionRound 恰好等于 maxRevisionRounds 时耗尽（>= 不是 >）', () => {
    const input: SettlementInput = {
      verdicts: ['revise'],
      revisionRound: 3,
      maxRevisionRounds: 3,
    };
    expect(settleReview(input)).toEqual({ action: 'complete', exhausted: true });
  });
});
