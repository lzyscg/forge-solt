import { describe, expect, it } from 'vitest';
import { sourceShingleHits } from '../../../bench/imitation-audit.ts';

describe('I0 public summary privacy', () => {
  it('14 字逐字片段命中时能被识别，空白不能绕过', () => {
    const source = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳';
    expect(sourceShingleHits(source, '前缀 甲乙丙丁戊己庚辛壬癸子丑寅卯 后缀')).toEqual([
      '甲乙丙丁戊己庚辛壬癸子丑寅卯',
    ]);
    expect(sourceShingleHits(source, '甲 乙 丙 丁 戊 己 庚 辛 壬 癸 子 丑 寅 卯')).toEqual([
      '甲乙丙丁戊己庚辛壬癸子丑寅卯',
    ]);
  });

  it('聚合 JSON 不命中时为空', () => {
    expect(sourceShingleHits('甲'.repeat(20), '{"sourceHash":"abc","han":20}')).toEqual([]);
  });
});
