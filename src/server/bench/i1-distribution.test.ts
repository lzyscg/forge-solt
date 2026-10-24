import { describe, expect, it } from 'vitest';
import { compareI1Distribution } from './i1-distribution.ts';

describe('I1 distribution comparison', () => {
  it('非均分预算同时改善 share 与 rank 时明确通过', () => {
    const result = compareI1Distribution({
      sourceHan: [100, 300, 600],
      variantTargetHan: [1000, 3000, 6000],
    });

    expect(result).not.toBeNull();
    expect(result!.variant.shareAbsoluteError).toBe(0);
    expect(result!.variant.rankError).toBe(0);
    expect(result!.shareImproved).toBe(true);
    expect(result!.rankImproved).toBe(true);
  });

  it('换一组同总量但反向排序预算时两项都不能假绿', () => {
    const result = compareI1Distribution({
      sourceHan: [100, 300, 600],
      variantTargetHan: [6000, 3000, 1000],
    });

    expect(result).not.toBeNull();
    expect(result!.variant.shareAbsoluteError).toBeGreaterThan(result!.baseline.shareAbsoluteError);
    expect(result!.variant.rankError).toBeGreaterThan(result!.baseline.rankError);
    expect(result!.shareImproved).toBe(false);
    expect(result!.rankImproved).toBe(false);
  });

  it('baseline 全并列使用平均秩，不能靠 section 原顺序伪造相关性', () => {
    const result = compareI1Distribution({
      sourceHan: [100, 200, 300],
      variantTargetHan: [1, 1, 1],
    });

    expect(result).not.toBeNull();
    expect(result!.variant).toEqual(result!.baseline);
    expect(result!.shareImproved).toBe(false);
    expect(result!.rankImproved).toBe(false);
  });

  it('数量不等、空输入、零总量与非法数值均不可比较', () => {
    expect(compareI1Distribution({ sourceHan: [], variantTargetHan: [] })).toBeNull();
    expect(compareI1Distribution({ sourceHan: [1, 2], variantTargetHan: [1] })).toBeNull();
    expect(compareI1Distribution({ sourceHan: [0, 0], variantTargetHan: [1, 1] })).toBeNull();
    expect(compareI1Distribution({ sourceHan: [1, Number.NaN], variantTargetHan: [1, 1] })).toBeNull();
  });
});
