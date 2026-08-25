/**
 * 每条结构校验规则至少一个失败夹具（Q-05 / §11.2）。
 *
 * 这组测试的价值不在于「跑绿」，而在于**它会在夹具失效时变红**：
 * 若某个夹具因为 domain 改动而不再触发目标规则，这里立刻报出是哪一条。
 * 断言写成「至少包含目标规则」而不是「只有目标规则」，理由见夹具文件头。
 */

import { describe, expect, it } from 'vitest';
import { validateConcreteStructure } from '@server/domain/structure-validation.ts';
import type { StructureRuleId } from '@server/domain/structure-validation.ts';
import { SlotProposalSchema } from '@shared/tools.ts';
import {
  FIXTURE_TEMPLATE,
  INVALID_STRUCTURES,
  INVALID_STRUCTURE_RULE_IDS,
  VALID_STRUCTURE,
} from './invalid-structures.ts';

const rulesOf = (id: StructureRuleId): StructureRuleId[] => {
  const result = validateConcreteStructure(INVALID_STRUCTURES[id], FIXTURE_TEMPLATE);
  return result.ok ? [] : result.violations.map((v) => v.rule);
};

describe('非法结构夹具', () => {
  it('参照结构是合法的——证明这组断言不是恒为失败', () => {
    const result = validateConcreteStructure(VALID_STRUCTURE, FIXTURE_TEMPLATE);
    expect(result.ok).toBe(true);
  });

  it('夹具表覆盖全部 StructureRuleId（18 个取值 / 19 条规则，D-19）', () => {
    expect(INVALID_STRUCTURE_RULE_IDS).toHaveLength(18);
  });

  for (const ruleId of INVALID_STRUCTURE_RULE_IDS) {
    it(`${ruleId} 夹具触发 ${ruleId}`, () => {
      expect(rulesOf(ruleId)).toContain(ruleId);
    });
  }

  it('NO_ROOT 夹具同时覆盖第 6 条与第 19 条（同码两义）', () => {
    const result = validateConcreteStructure(INVALID_STRUCTURES.NO_ROOT, FIXTURE_TEMPLATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const noRoot = result.violations.filter((v) => v.rule === 'NO_ROOT');
    // 两条分别是「没有 parentId 为 null 的槽位」与「声明的 rootSlotId 不是根」
    expect(noRoot).toHaveLength(2);
    expect(new Set(noRoot.map((v) => v.message)).size).toBe(2);
  });

  it('INVALID_SLOT_ID 夹具在 Zod 解析层就被拦下（规则 4 的正常路径，§3.4）', () => {
    const bad = INVALID_STRUCTURES.INVALID_SLOT_ID.slots.find((s) => s.id === 'Scene-01');
    expect(bad).toBeDefined();
    expect(SlotProposalSchema.safeParse(bad).success).toBe(false);
    // 而合法夹具能过——否则上一条断言可能只是因为 schema 恒拒
    expect(SlotProposalSchema.safeParse(VALID_STRUCTURE.slots[0]).success).toBe(true);
  });

  it('TOO_MANY_SLOTS 夹具确实超出模板上限', () => {
    expect(INVALID_STRUCTURES.TOO_MANY_SLOTS.slots.length).toBeGreaterThan(FIXTURE_TEMPLATE.limits.maxSlots);
  });
});
