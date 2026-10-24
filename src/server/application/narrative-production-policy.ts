import { ForgeError } from '@shared/errors.ts';
import type {
  NarrativeCapacity,
  NarrativeExpansion,
  NarrativeMode,
  NarrativePriority,
} from '@server/domain/narrative-plan.ts';
import { deriveEffectiveHanRange } from '@server/domain/output-validation.ts';
import type { Slot } from '@server/domain/types.ts';
import type { FrozenTaskSnapshot } from './snapshot-service.ts';
import type { CompiledSlotType } from './template-loader.ts';

const MAX_TOKENS_FLOOR = 4096;
const MAX_TOKENS_CEIL = 16384;

export interface SlotHanPolicy {
  minHan: number;
  /** Legacy storyHan did not define a target. Do not invent one during replay. */
  targetHan: number | null;
  maxHan: number;
}

export interface NarrativeUnitPolicy {
  unitId: string;
  order: number;
  priority: NarrativePriority;
  priorityId: string | null;
  expansion: NarrativeExpansion;
  mode: NarrativeMode;
  capacity: NarrativeCapacity;
}

export interface SlotProductionPolicy {
  version: 1;
  source: 'legacy' | 'plan';
  han: SlotHanPolicy | null;
  narrativeUnit: NarrativeUnitPolicy | null;
  runtimeMaxTokens: number;
}

/**
 * Derive the provider ceiling from the same maximum that submission validation uses.
 * The floor leaves room for tool-call JSON; the ceiling prevents runaway output.
 */
export function deriveMaxTokens(
  slotType: CompiledSlotType | null,
  effectiveMaxHan: number | null = null,
): number {
  const maximum = effectiveMaxHan ?? slotType?.validation.maxChars ?? null;
  if (maximum === null) return MAX_TOKENS_CEIL;
  return Math.min(MAX_TOKENS_CEIL, Math.max(MAX_TOKENS_FLOOR, maximum * 2 + 1024));
}

export function resolveSlotProductionPolicy(input: {
  snapshot: FrozenTaskSnapshot;
  targetSlot: Pick<Slot, 'slotId' | 'type' | 'narrativeUnitId'>;
  allSlots: readonly Pick<Slot, 'type' | 'narrativeUnitId'>[];
  slotType: CompiledSlotType;
}): SlotProductionPolicy {
  const { snapshot, targetSlot, allSlots, slotType } = input;
  if (targetSlot.type !== slotType.id) {
    throw storageError(
      snapshot.taskId,
      targetSlot.slotId,
      `槽位类型 ${targetSlot.type} 与生产策略类型 ${slotType.id} 不一致`,
    );
  }

  const planRule = snapshot.compiled.output.validation?.narrativePlan ?? null;
  const plan = snapshot.narrativePlan ?? null;
  if ((planRule === null) !== (plan === null)) {
    throw storageError(snapshot.taskId, targetSlot.slotId, 'NarrativePlan 与冻结模板声明不一致');
  }

  if (planRule !== null && plan !== null && targetSlot.type === planRule.slotType) {
    const unitId = targetSlot.narrativeUnitId;
    if (unitId === null) {
      throw storageError(snapshot.taskId, targetSlot.slotId, '缺少 Narrative Unit 绑定');
    }
    const matches = plan.units.filter((unit) => unit.unitId === unitId);
    if (matches.length !== 1) {
      throw storageError(
        snapshot.taskId,
        targetSlot.slotId,
        matches.length === 0
          ? `绑定的 Narrative Unit ${unitId} 不在冻结计划中`
          : `冻结计划中 Narrative Unit ${unitId} 不唯一`,
      );
    }
    const unit = matches[0]!;
    const han: SlotHanPolicy = {
      minHan: unit.budget.minHan,
      targetHan: unit.budget.targetHan,
      maxHan: unit.budget.maxHan,
    };
    return {
      version: 1,
      source: 'plan',
      han,
      narrativeUnit: {
        unitId: unit.unitId,
        order: unit.order,
        priority: unit.priority,
        priorityId: unit.priorityId,
        expansion: unit.expansion,
        mode: unit.mode,
        capacity: { ...unit.capacity },
      },
      runtimeMaxTokens: deriveMaxTokens(slotType, han.maxHan),
    };
  }

  const range = deriveEffectiveHanRange(
    targetSlot.type,
    allSlots,
    snapshot.compiled.output.validation,
    snapshot.compiled.slotTypes.map((type) => ({
      id: type.id,
      contentBearing: type.contentBearing,
      includeInArtifact: type.includeInArtifact,
      minChars: type.validation.minChars,
      maxChars: type.validation.maxChars,
    })),
  );
  const han: SlotHanPolicy | null = range === null
    ? null
    : { minHan: range.minHan, targetHan: null, maxHan: range.maxHan };
  return {
    version: 1,
    source: 'legacy',
    han,
    narrativeUnit: null,
    runtimeMaxTokens: deriveMaxTokens(slotType, han?.maxHan ?? null),
  };
}

function storageError(taskId: string, slotId: string, detail: string): ForgeError {
  return new ForgeError(
    'STORAGE_ERROR',
    `任务 ${taskId} 的槽位 ${slotId} 无法解析生产策略：${detail}`,
    `task:${taskId}/slot:${slotId}`,
    '请重建任务',
  );
}
