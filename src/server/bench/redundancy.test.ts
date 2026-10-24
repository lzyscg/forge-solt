import { describe, expect, it } from 'vitest';
import { combinedRedundancyMetrics, normalizeHanWindow, redundancyMetrics } from '../../../bench/redundancy.ts';

describe('redundancy metrics', () => {
  it('只取前 2000 个汉字，忽略标点和拉丁字符', () => {
    expect(normalizeHanWindow(`A甲，乙!${'丙'.repeat(2000)}`).match(/[一-鿿]/gu)?.length).toBe(2000);
    expect(normalizeHanWindow('A甲，乙!', 2)).toBe('A甲，乙');
  });

  it('不足等长窗口时返回 null，不能拿不同长度假装比较', () => {
    expect(redundancyMetrics('甲'.repeat(1999))).toBeNull();
  });

  it('多个固定 case 只在合计达到 2000 汉字时出趋势指标', () => {
    expect(combinedRedundancyMetrics(['甲'.repeat(700), '乙'.repeat(700)])).toBeNull();
    expect(combinedRedundancyMetrics(['甲'.repeat(700), '乙'.repeat(700), '丙'.repeat(700)] )?.han).toBe(2000);
  });

  it('重复文本的去重率和 gzip 比率低于变化文本', () => {
    const repeated = redundancyMetrics('天地玄黄'.repeat(500));
    const varied = redundancyMetrics(Array.from({ length: 2000 }, (_, index) => String.fromCodePoint(0x4e00 + (index % 2000))).join(''));
    expect(repeated).not.toBeNull();
    expect(varied).not.toBeNull();
    expect(repeated!.uniqueBigramRate).toBeLessThan(varied!.uniqueBigramRate);
    expect(repeated!.gzipRatio).toBeLessThan(varied!.gzipRatio);
    expect(repeated!.repeatedFourgramRate).toBeGreaterThan(varied!.repeatedFourgramRate);
  });
});
