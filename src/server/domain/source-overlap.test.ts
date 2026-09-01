import { describe, expect, it } from 'vitest';
import { SOURCE_SHINGLE_CHARS, sourceContainment } from './source-overlap.ts';

describe('sourceContainment', () => {
  it('逐字照抄接近 1，前置不同样板仍能认出', () => {
    const body = '雨夜里来客推开诊室的门，把那只旧药瓶放在医生面前。'.repeat(10);
    expect(sourceContainment(body, body)).toBe(1);
    expect(sourceContainment(`新标题\n${body}`, body)).toBeGreaterThan(0.9);
  });

  it('无关文本是 0', () => {
    expect(sourceContainment('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳', '春夏秋冬风雨雷电江河湖海山川草木')).toBe(0);
  });

  it('短于 shingle 长度按 0', () => {
    expect(SOURCE_SHINGLE_CHARS).toBe(14);
    expect(sourceContainment('太短', '太短')).toBe(0);
  });
});
