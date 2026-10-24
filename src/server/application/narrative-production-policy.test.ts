import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenTaskSnapshot } from './snapshot-service.ts';
import {
  deriveMaxTokens,
  resolveSlotProductionPolicy,
} from './narrative-production-policy.ts';
import { createAppEnv, seedNewTask, startStructureAssignment, VALID_PROPOSAL, type AppEnv } from '../../../tests/fixtures/app.ts';

let env: AppEnv;
let snapshot: FrozenTaskSnapshot;

beforeEach(async () => {
  env = await createAppEnv();
  const taskId = await seedNewTask(env);
  const { executionId } = startStructureAssignment(env, taskId);
  env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
  snapshot = env.snapshots.readSnapshot(taskId);
});

afterEach(async () => {
  await env.cleanup();
});

function slot(slotId: string) {
  return env.uow.repositories.slots.getOrThrow(snapshot.taskId, slotId);
}

function slotType(id: string) {
  const found = snapshot.compiled.slotTypes.find((type) => type.id === id);
  if (found === undefined) throw new Error(`夹具缺少 slot type ${id}`);
  return found;
}

function withValidation(validation: NonNullable<FrozenTaskSnapshot['compiled']['output']['validation']>): FrozenTaskSnapshot {
  return {
    ...snapshot,
    compiled: {
      ...snapshot.compiled,
      output: { ...snapshot.compiled.output, validation },
    },
  };
}

function planSnapshot(): FrozenTaskSnapshot {
  const unit = {
    unitId: 'unit_01',
    order: 1,
    title: '雨夜对峙',
    change: { from: '互相试探', to: '证据公开' },
    priority: 'P0' as const,
    priorityId: 'P001',
    expansion: 'detailed' as const,
    mode: 'conflict-scene' as const,
    capacity: { dialogueTurns: 4, actionFeedbackLoops: 2, cognitionTurns: 1, aftermathBeats: 1 },
    cast: ['甲', '乙'],
    objective: '公开证据',
    conflict: '对方阻止',
    endState: '证据被看见',
    informationControl: null,
    weight: 1,
    budget: { minHan: 900, targetHan: 1200, maxHan: 1500 },
  };
  return {
    ...withValidation({
      slotCounts: {},
      outlineCount: { inputField: 'chapter_packet', slotType: 'scene' },
      storyHan: { min: 900, target: 1200, max: 1500, slotType: 'scene' },
      narrativePlan: { inputField: 'chapter_packet', slotType: 'scene' },
    }),
    narrativePlan: {
      version: 1,
      weightProfile: 'i0-three-mode-v1',
      storyBudget: { minHan: 900, targetHan: 1200, maxHan: 1500 },
      units: [unit],
    },
    narrativePlanHash: 'plan-hash',
  };
}

describe('resolveSlotProductionPolicy', () => {
  it('旧模板沿用静态限制且不虚构 Han 目标', () => {
    const scene = slot('scene_01');
    expect(resolveSlotProductionPolicy({
      snapshot,
      targetSlot: scene,
      allSlots: env.uow.repositories.slots.listByTask(snapshot.taskId),
      slotType: slotType('scene'),
    })).toEqual({
      version: 1,
      source: 'legacy',
      han: null,
      narrativeUnit: null,
      runtimeMaxTokens: 16_384,
    });
  });

  it('旧 storyHan 均分结果同时决定校验区间与 token 上限', () => {
    const frozen = withValidation({
      slotCounts: {},
      outlineCount: null,
      storyHan: { min: 1000, max: 2000, slotType: 'scene' },
      narrativePlan: null,
    });
    const scene = slot('scene_01');
    expect(resolveSlotProductionPolicy({
      snapshot: frozen,
      targetSlot: scene,
      allSlots: env.uow.repositories.slots.listByTask(snapshot.taskId),
      slotType: slotType('scene'),
    })).toEqual({
      version: 1,
      source: 'legacy',
      han: { minHan: 1000, targetHan: null, maxHan: 1960 },
      narrativeUnit: null,
      runtimeMaxTokens: 4944,
    });
  });

  it('plan section 只从冻结 unit 与持久化绑定解析完整策略', () => {
    const frozen = planSnapshot();
    const scene = { ...slot('scene_01'), narrativeUnitId: 'unit_01' };
    expect(resolveSlotProductionPolicy({
      snapshot: frozen,
      targetSlot: scene,
      allSlots: [scene],
      slotType: slotType('scene'),
    })).toEqual({
      version: 1,
      source: 'plan',
      han: { minHan: 900, targetHan: 1200, maxHan: 1500 },
      narrativeUnit: {
        unitId: 'unit_01',
        order: 1,
        priority: 'P0',
        priorityId: 'P001',
        expansion: 'detailed',
        mode: 'conflict-scene',
        capacity: { dialogueTurns: 4, actionFeedbackLoops: 2, cognitionTurns: 1, aftermathBeats: 1 },
      },
      runtimeMaxTokens: 4096,
    });
  });

  it('plan section 缺少或伪造绑定时失败关闭，不回退均分', () => {
    const frozen = planSnapshot();
    const scene = slot('scene_01');
    expect(() => resolveSlotProductionPolicy({
      snapshot: frozen,
      targetSlot: scene,
      allSlots: [scene],
      slotType: slotType('scene'),
    })).toThrow(/缺少 Narrative Unit 绑定/);
    expect(() => resolveSlotProductionPolicy({
      snapshot: frozen,
      targetSlot: { ...scene, narrativeUnitId: 'unit_missing' },
      allSlots: [scene],
      slotType: slotType('scene'),
    })).toThrow(/不在冻结计划中/);
  });

  it('计划与声明只存在一边时按存储损坏失败关闭', () => {
    const scene = slot('scene_01');
    expect(() => resolveSlotProductionPolicy({
      snapshot: { ...snapshot, narrativePlan: planSnapshot().narrativePlan ?? null },
      targetSlot: scene,
      allSlots: [scene],
      slotType: slotType('scene'),
    })).toThrow(/NarrativePlan 与冻结模板声明不一致/);
  });
});

describe('deriveMaxTokens', () => {
  it('保留 floor、ceiling 与无槽位默认值', () => {
    expect(deriveMaxTokens(null)).toBe(16_384);
    expect(deriveMaxTokens(slotType('title'))).toBe(4096);
    expect(deriveMaxTokens(slotType('scene'), 20_000)).toBe(16_384);
  });
});
