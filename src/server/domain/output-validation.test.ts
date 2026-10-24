import { describe, expect, it } from 'vitest';
import {
  countHan,
  countNumberedOutlineSections,
  deriveEffectiveHanRange,
  fingerprintStory,
  validateArtifactOutput,
  validateOutputStructure,
  type OutputValidationSpec,
  type StaticSlotLimits,
} from './output-validation.ts';

const types: StaticSlotLimits[] = [
  { id: 'story', contentBearing: false, includeInArtifact: true, minChars: null, maxChars: null },
  { id: 'title', contentBearing: true, includeInArtifact: true, minChars: 4, maxChars: 40 },
  { id: 'section', contentBearing: true, includeInArtifact: true, minChars: 250, maxChars: 1100 },
];

const validation: OutputValidationSpec = {
  slotCounts: { title: { min: 1, max: 1 }, section: { min: 8, max: 30 } },
  outlineCount: { inputField: 'outline_blueprint', slotType: 'section' },
  storyHan: { min: 7876, max: 15850, slotType: 'section' },
};

const slots = (sections: number) => [
  { id: 'story', type: 'story' },
  { id: 'title', type: 'title' },
  ...Array.from({ length: sections }, (_, index) => ({ id: `section_${index + 1}`, type: 'section' })),
];

const outline = (sections: number) =>
  Array.from({ length: sections }, (_, index) => `${index + 1}. 第 ${index + 1} 节\n目标：推进`).join('\n');

describe('output validation', () => {
  it('汉字计数逐字复用 S0 的 [一-鿿] 口径，不把扩展 A 计入', () => {
    expect(countHan('㐀我说：「hello，世界 123。」')).toBe(4);
  });

  it('大纲编号只认带标题的 N./N．/N、 行', () => {
    expect(countNumberedOutlineSections('1. 第一节\n2．第二节\n3、 第三节\n4\n目标：不是标题')).toBe(3);
  });

  it.each([
    [8, 985, 1100],
    [25, 316, 632],
    [30, 263, 527],
  ])('%i 个 section 从整篇预算推导动态汉字区间', (count, minHan, maxHan) => {
    expect(deriveEffectiveHanRange('section', slots(count), validation, types)).toEqual({ minHan, maxHan });
  });

  it('非预算槽位没有动态区间', () => {
    expect(deriveEffectiveHanRange('title', slots(25), validation, types)).toBeNull();
  });

  it('产物指纹与 S0 的人称/引号/编号/颗粒口径一致', () => {
    const result = fingerprintStory('标题\n\n1.\n\n我说：「别走。」\n\n她停下。');
    expect(result).toEqual({
      han: 9,
      sections: 1,
      person: 'third',
      quote: 'corner',
      firstPersonCount: 1,
      thirdPersonCount: 1,
      cornerQuoteCount: 2,
      doubleQuoteCount: 0,
      paragraphMedian: 3,
      sentenceMedian: 4.5,
    });
  });

  it('artifact validation 分开返回 hard errors 与无对白告警', () => {
    const rules = {
      requireFirstPerson: true,
      forbidDoubleQuoteStyle: true,
      requireNumberedSections: true,
      warnNoDialogueQuotes: true,
    };
    const noQuote = validateArtifactOutput('标题\n\n1.\n\n我推门。', validation, rules);
    expect(noQuote.errors).toContain('整篇有 5 个汉字，要求 7876–15850 个汉字');
    expect(noQuote.warnings).toEqual(['整篇没有对白引号']);

    const doubleQuote = validateArtifactOutput('标题\n\n1.\n\n她说：“走。”', null, rules);
    expect(doubleQuote.errors).toEqual([
      '整篇判定为第三人称（我 0 次，他/她 1 次）',
      '整篇使用双引号风格（直角引号 0 个，双引号 2 个）',
    ]);
  });

  it('无编号只触发编号硬拒，不把无对白升级成硬拒', () => {
    const result = validateArtifactOutput('我说：「走。」', null, {
      requireFirstPerson: true,
      forbidDoubleQuoteStyle: true,
      requireNumberedSections: true,
      warnNoDialogueQuotes: true,
    });
    expect(result.errors).toEqual(['整篇没有编号小节']);
    expect(result.warnings).toEqual([]);
  });

  it('section 数与 outline 一致且预算可行时通过', () => {
    expect(validateOutputStructure(slots(25), { outline_blueprint: outline(25) }, validation, types)).toEqual([]);
  });

  it('一次返回数量、outline 对账与预算不可行问题', () => {
    const impossibleTypes = types.map((type) =>
      type.id === 'section' ? { ...type, minChars: 900, maxChars: 1100 } : type,
    );
    const result = validateOutputStructure(
      [{ id: 'story', type: 'story' }, { id: 'title_a', type: 'title' }, { id: 'title_b', type: 'title' }, ...slots(7).slice(2)],
      { outline_blueprint: outline(8) },
      validation,
      impossibleTypes,
    );
    expect(result.map((item) => item.rule)).toEqual([
      'OUTPUT_SLOT_COUNT',
      'OUTPUT_SLOT_COUNT',
      'OUTPUT_OUTLINE_COUNT',
      'OUTPUT_BUDGET_IMPOSSIBLE',
    ]);
  });
});
