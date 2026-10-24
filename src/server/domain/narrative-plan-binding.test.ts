import { describe, expect, it } from 'vitest';
import type { Slot } from './types.ts';
import type { CompiledNarrativePlan, CompiledNarrativeUnit } from './narrative-plan.ts';
import { bindNarrativeUnitsToSections } from './narrative-plan-binding.ts';
import { documentOrder } from './readiness.ts';

function unit(unitId: string, order: number): CompiledNarrativeUnit {
  return {
    unitId,
    order,
    title: unitId,
    change: { from: '前', to: '后' },
    priority: 'P0',
    priorityId: `P${String(order).padStart(3, '0')}`,
    expansion: 'standard',
    mode: 'custom',
    capacity: { dialogueTurns: 0, actionFeedbackLoops: 1, cognitionTurns: 0, aftermathBeats: 0 },
    cast: ['甲'],
    objective: '推进',
    conflict: '阻力',
    endState: '完成',
    informationControl: null,
    weight: 1,
    budget: { minHan: 1, targetHan: 2, maxHan: 3 },
  };
}

function plan(ids: string[]): CompiledNarrativePlan {
  return {
    version: 1,
    weightProfile: 'i0-three-mode-v1',
    storyBudget: { minHan: ids.length, targetHan: ids.length * 2, maxHan: ids.length * 3 },
    units: ids.map((id, index) => unit(id, index + 1)),
  };
}

const slots = [
  { slotId: 'section_b', type: 'section', parentId: 'group', sortOrder: 0 },
  { slotId: 'title', type: 'title', parentId: 'story', sortOrder: 0 },
  { slotId: 'section_c', type: 'section', parentId: 'story', sortOrder: 2 },
  { slotId: 'story', type: 'story', parentId: null, sortOrder: 0 },
  { slotId: 'section_a', type: 'section', parentId: 'group', sortOrder: 0 },
  { slotId: 'group', type: 'group', parentId: 'story', sortOrder: 1 },
] as const;

describe('bindNarrativeUnitsToSections', () => {
  it('按权威文档序筛出 section，并一对一绑定 unit', () => {
    expect(bindNarrativeUnitsToSections({
      slots,
      plan: plan(['unit_01', 'unit_02', 'unit_03']),
      sectionSlotType: 'section',
    })).toEqual({
      ok: true,
      bindings: [
        { slotId: 'section_a', narrativeUnitId: 'unit_01' },
        { slotId: 'section_b', narrativeUnitId: 'unit_02' },
        { slotId: 'section_c', narrativeUnitId: 'unit_03' },
      ],
    });
  });

  it('与 readiness.documentOrder 对同一棵树的顺序一致', () => {
    const domainSlots = slots.map((slot) => ({
      ...slot,
      taskId: 'task',
      instruction: slot.slotId,
      dependsOn: [],
      contentBearing: slot.type === 'section' || slot.type === 'title',
      includeInArtifact: true,
      narrativeUnitId: null,
      status: 'pending' as const,
      revisionRound: 0,
      reviewExhausted: false,
      contentText: null,
      producer: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })) satisfies Slot[];
    const expected = documentOrder(domainSlots)
      .filter((slot) => slot.type === 'section')
      .map((slot) => slot.slotId);
    const result = bindNarrativeUnitsToSections({
      slots,
      plan: plan(['unit_01', 'unit_02', 'unit_03']),
      sectionSlotType: 'section',
    });
    expect(result.ok && result.bindings.map((binding) => binding.slotId)).toEqual(expected);
  });

  it('异常环的兜底顺序也与 readiness.documentOrder 一致', () => {
    const cyclicSlots = [
      { slotId: 'section_b', type: 'section', parentId: 'section_a', sortOrder: 0 },
      { slotId: 'section_a', type: 'section', parentId: 'section_b', sortOrder: 9 },
    ] as const;
    const domainSlots = cyclicSlots.map((slot) => ({
      ...slot,
      taskId: 'task',
      instruction: slot.slotId,
      dependsOn: [],
      contentBearing: true,
      includeInArtifact: true,
      narrativeUnitId: null,
      status: 'pending' as const,
      revisionRound: 0,
      reviewExhausted: false,
      contentText: null,
      producer: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })) satisfies Slot[];
    const expected = documentOrder(domainSlots).map((slot) => slot.slotId);
    const result = bindNarrativeUnitsToSections({
      slots: cyclicSlots,
      plan: plan(['unit_01', 'unit_02']),
      sectionSlotType: 'section',
    });
    expect(result.ok && result.bindings.map((binding) => binding.slotId)).toEqual(expected);
  });

  it('slot 与 unit 数量不等时拒绝整棵结构', () => {
    expect(bindNarrativeUnitsToSections({
      slots,
      plan: plan(['unit_01', 'unit_02']),
      sectionSlotType: 'section',
    })).toEqual({
      ok: false,
      message: 'NarrativePlan 有 2 个 unit，但结构包含 3 个 section 槽位',
      slotIds: ['section_a', 'section_b', 'section_c'],
    });
  });

  it('重复 unitId 失败关闭', () => {
    expect(bindNarrativeUnitsToSections({
      slots: slots.slice(0, 4),
      plan: plan(['unit_01', 'unit_01']),
      sectionSlotType: 'section',
    })).toEqual({
      ok: false,
      message: 'NarrativePlan 的 unitId unit_01 重复',
      slotIds: [],
    });
  });
});
