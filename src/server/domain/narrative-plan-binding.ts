import type { CompiledNarrativePlan } from './narrative-plan.ts';
import { compareCodePoints } from './canonical.ts';

export interface NarrativeBindingSlot {
  slotId: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
}

export interface BoundNarrativeSlot {
  slotId: string;
  narrativeUnitId: string;
}

export type NarrativePlanBindingResult =
  | { ok: true; bindings: BoundNarrativeSlot[] }
  | { ok: false; message: string; slotIds: string[] };

export function bindNarrativeUnitsToSections(input: {
  slots: readonly NarrativeBindingSlot[];
  plan: CompiledNarrativePlan;
  sectionSlotType: string;
}): NarrativePlanBindingResult {
  const sections = documentOrdered(input.slots).filter((slot) => slot.type === input.sectionSlotType);
  if (sections.length !== input.plan.units.length) {
    return {
      ok: false,
      message: `NarrativePlan 有 ${input.plan.units.length} 个 unit，但结构包含 ${sections.length} 个 ${input.sectionSlotType} 槽位`,
      slotIds: sections.map((slot) => slot.slotId),
    };
  }

  const unitIds = new Set<string>();
  for (const unit of input.plan.units) {
    if (unitIds.has(unit.unitId)) {
      return {
        ok: false,
        message: `NarrativePlan 的 unitId ${unit.unitId} 重复`,
        slotIds: [],
      };
    }
    unitIds.add(unit.unitId);
  }

  return {
    ok: true,
    bindings: sections.map((slot, index) => ({
      slotId: slot.slotId,
      narrativeUnitId: input.plan.units[index]!.unitId,
    })),
  };
}

function documentOrdered<T extends NarrativeBindingSlot>(slots: readonly T[]): T[] {
  const byId = new Map(slots.map((slot) => [slot.slotId, slot]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const slot of slots) {
    if (slot.parentId === null || !byId.has(slot.parentId)) {
      roots.push(slot);
      continue;
    }
    const bucket = children.get(slot.parentId) ?? [];
    bucket.push(slot);
    children.set(slot.parentId, bucket);
  }
  const compare = (left: T, right: T): number =>
    left.sortOrder - right.sortOrder || compareCodePoints(left.slotId, right.slotId);
  roots.sort(compare);
  for (const bucket of children.values()) bucket.sort(compare);

  const ordered: T[] = [];
  const visited = new Set<string>();
  const visit = (slot: T): void => {
    if (visited.has(slot.slotId)) return;
    visited.add(slot.slotId);
    ordered.push(slot);
    for (const child of children.get(slot.slotId) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const unreachable = slots
    .filter((slot) => !visited.has(slot.slotId))
    .sort((left, right) => compareCodePoints(left.slotId, right.slotId));
  for (const slot of unreachable) visit(slot);
  return ordered;
}
