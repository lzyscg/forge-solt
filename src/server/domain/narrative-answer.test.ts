import { describe, expect, it } from 'vitest';

import { compileNarrativePlan } from './narrative-plan.ts';
import {
  compileNarrativeAnswer,
  compileNarrativeAnswerV3,
  NarrativeAnswerV3Schema,
  prepareNarrativeAnswerContract,
  serializeNarrativePlanMarkdown,
} from './narrative-answer.ts';

const source = [
  '01、开端', '甲看见门。',
  '02', '甲乙争执很多很多。',
  '03. 发现', '甲发现旧信。',
  '04', '乙否认。',
  '05', '甲追问来龙去脉。',
  '06', '乙终于承认。',
  '07', '两人作出选择。',
  '08、结局', '甲离开旧城很久很久。',
].join('\n');

function answer() {
  const priorities = ['P1', 'bridge', 'P0', 'P1', 'bridge', 'P0', 'P1', 'P0'] as const;
  return {
    units: priorities.map((priority, index) => ({
      sourceSectionRef: `source-section-${String(index + 1).padStart(2, '0')}`,
      title: `第${index + 1}节`,
      change: { from: `状态${index}`, to: `状态${index + 1}` },
      priority,
      mode: index === 1 ? 'fast-summary' as const : 'conflict-scene' as const,
      capacity: {
        dialogueTurns: index === 1 ? 0 : 2,
        actionFeedbackLoops: 1,
        cognitionTurns: index === 2 ? 1 : 0,
        aftermathBeats: index === 7 ? 1 : 0,
      },
      cast: index === 1 ? [] : ['甲', '乙'],
      objective: `目标${index + 1}`,
      conflict: `冲突${index + 1}`,
      endState: `结束${index + 1}`,
      informationControl: index === 2 ? '暂不揭示旧信来源' : null,
    })),
  };
}

const storyBudget = { minHan: 800, targetHan: 1000, maxHan: 1200 };

describe('narrative-plan/v3 business answer', () => {
  it('derives change and legacy fields from initialState, intent, resistance and outcome', () => {
    const prepared = prepareNarrativeAnswerContract(source);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const priorities = ['P1', 'bridge', 'P0', 'P1', 'bridge', 'P0', 'P1', 'P0'] as const;
    const semantic = {
      initialState: '初始状态',
      units: priorities.map((priority, index) => ({
        sourceSectionRef: `source-section-${String(index + 1).padStart(2, '0')}`,
        title: `变化${index + 1}`,
        priority,
        mode: index === 1 ? 'fast-summary' as const : 'conflict-scene' as const,
        capacity: { dialogueTurns: 1, actionFeedbackLoops: 1, cognitionTurns: 0, aftermathBeats: 0 },
        cast: ['甲'],
        intent: `意图${index + 1}`,
        resistance: `阻力${index + 1}`,
        outcome: `结果${index + 1}`,
        informationControl: null,
      })),
    };

    expect(NarrativeAnswerV3Schema.safeParse(semantic).success).toBe(true);
    const result = compileNarrativeAnswerV3({ contract: prepared, answer: semantic, storyBudget });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units[0]).toMatchObject({
      change: { from: '初始状态', to: '结果1' },
      objective: '意图1',
      conflict: '阻力1',
      endState: '结果1',
    });
    expect(result.plan.units[1]).toMatchObject({
      change: { from: '结果1', to: '结果2' },
      objective: '意图2',
      conflict: '阻力2',
      endState: '结果2',
    });
  });
});

describe('narrative-plan/v2 business answer', () => {
  it('prepares stable source refs while preserving source tokens and deriving expansion', () => {
    const prepared = prepareNarrativeAnswerContract(source);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.sections.map((section) => ({
      ref: section.ref,
      token: section.sourceToken,
      order: section.order,
      expansion: section.expansion,
    }))).toEqual([
      { ref: 'source-section-01', token: '01', order: 1, expansion: 'light' },
      { ref: 'source-section-02', token: '02', order: 2, expansion: 'detailed' },
      { ref: 'source-section-03', token: '03', order: 3, expansion: 'light' },
      { ref: 'source-section-04', token: '04', order: 4, expansion: 'light' },
      { ref: 'source-section-05', token: '05', order: 5, expansion: 'detailed' },
      { ref: 'source-section-06', token: '06', order: 6, expansion: 'light' },
      { ref: 'source-section-07', token: '07', order: 7, expansion: 'detailed' },
      { ref: 'source-section-08', token: '08', order: 8, expansion: 'detailed' },
    ]);
  });

  it('assigns unit and priority IDs and compiles a plan without model-owned protocol fields', () => {
    const prepared = prepareNarrativeAnswerContract(source);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = compileNarrativeAnswer({ contract: prepared, answer: answer(), storyBudget });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units.map((unit) => ({
      unitId: unit.unitId,
      order: unit.order,
      priorityId: unit.priorityId,
      expansion: unit.expansion,
    }))).toEqual([
      { unitId: 'unit_01', order: 1, priorityId: 'P001', expansion: 'light' },
      { unitId: 'unit_02', order: 2, priorityId: null, expansion: 'detailed' },
      { unitId: 'unit_03', order: 3, priorityId: 'P002', expansion: 'light' },
      { unitId: 'unit_04', order: 4, priorityId: 'P003', expansion: 'light' },
      { unitId: 'unit_05', order: 5, priorityId: null, expansion: 'detailed' },
      { unitId: 'unit_06', order: 6, priorityId: 'P004', expansion: 'light' },
      { unitId: 'unit_07', order: 7, priorityId: 'P005', expansion: 'detailed' },
      { unitId: 'unit_08', order: 8, priorityId: 'P006', expansion: 'detailed' },
    ]);
    expect(result.plan.units.reduce((sum, unit) => sum + unit.budget.targetHan, 0)).toBe(1000);
  });

  it('rejects missing, duplicate, unknown refs and capacity overflow without a partial artifact', () => {
    const prepared = prepareNarrativeAnswerContract(source);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const malformed = answer();
    malformed.units[0]!.sourceSectionRef = 'source-section-02';
    malformed.units[3]!.sourceSectionRef = 'source-section-99';
    malformed.units[2]!.capacity.dialogueTurns = 9;

    const result = compileNarrativeAnswer({ contract: prepared, answer: malformed, storyBudget });

    expect(result).toEqual({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ rule: 'SOURCE_SECTION_REF_DUPLICATE' }),
        expect.objectContaining({ rule: 'SOURCE_SECTION_REF_UNKNOWN' }),
        expect.objectContaining({ rule: 'SOURCE_SECTION_REF_MISSING' }),
        expect.objectContaining({ rule: 'CAPACITY_EXCEEDED' }),
      ]),
    });
    expect(result).not.toHaveProperty('plan');
  });

  it('fails closed when the source has no eligible numbered section structure', () => {
    expect(prepareNarrativeAnswerContract('没有编号的普通正文。')).toEqual({
      ok: false,
      reason: 'SOURCE_SECTIONS_UNAVAILABLE',
    });
  });

  it('serializes a compatibility view that round-trips through the legacy compiler', () => {
    const prepared = prepareNarrativeAnswerContract(source);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const compiled = compileNarrativeAnswer({ contract: prepared, answer: answer(), storyBudget });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const markdown = serializeNarrativePlanMarkdown(compiled.plan, prepared);
    expect(markdown.startsWith('01. 第1节')).toBe(true);
    expect(markdown).toContain('重点：P1 P001');
    expect(markdown).toContain('容量：对白轮次 2；动作反馈闭环 1；认知转折 0；事后余波 0');

    expect(compileNarrativePlan({ outlineMarkdown: markdown, storyBudget })).toEqual({
      ok: true,
      plan: compiled.plan,
    });
  });
});
