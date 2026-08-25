/**
 * `structure-validation.ts` 的单测（文档 §11.1：Domain 层要求 100% 分支覆盖）。
 *
 * 组织方式：19 条规则每条一对用例——一个失败、一个通过，测试名带规则编号，
 * 这样某条规则被误删时，报错信息直接指向文档表格的行号。
 * 另外三组用例守的是**行为约定**而非单条规则：不短路、校验顺序、通过后的产出形状。
 */

import { describe, expect, it } from 'vitest';

import type { SlotProposal } from '@shared/tools.ts';

import {
  validateConcreteStructure,
  type StructureProposal,
  type StructureRuleId,
  type StructureValidationResult,
  type StructureValidationTemplate,
  type StructureViolation,
} from './structure-validation.ts';

// ---------------------------------------------------------------- 夹具

const TEMPLATE: StructureValidationTemplate = {
  slotTypes: [
    { id: 'chapter', contentBearing: false },
    // D-16：容器 + includeInArtifact=false，整节工作区一次性排除
    { id: 'working_notes', contentBearing: false, includeInArtifact: false },
    { id: 'section', contentBearing: false },
    { id: 'title', contentBearing: true },
    { id: 'scene', contentBearing: true },
    // D-16 的「工作槽位」：产出内容、可被 dependsOn，但不进产物
    { id: 'chapter_outline', contentBearing: true, includeInArtifact: false },
  ],
  limits: { maxSlots: 8, maxStructureDepth: 3 },
};

function sp(over: Partial<SlotProposal> & { id: string }): SlotProposal {
  return {
    type: 'scene',
    parentId: 'chapter',
    order: 0,
    instruction: '写这个场景',
    dependsOn: [],
    ...over,
  };
}

const ROOT = sp({ id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '' });

/** 全部 19 条规则都通过的基线结构。每个失败用例都在它上面做最小改动 */
function baselineSlots(): SlotProposal[] {
  return [
    ROOT,
    sp({ id: 'title', type: 'title', order: 0, instruction: '写标题' }),
    sp({ id: 'scene_01', order: 1 }),
    sp({ id: 'scene_02', order: 2, dependsOn: ['scene_01'] }),
  ];
}

function proposal(slots: SlotProposal[], rootSlotId = 'chapter'): StructureProposal {
  return { rootSlotId, slots };
}

function violationsOf(result: StructureValidationResult): StructureViolation[] {
  if (result.ok) throw new Error('期望校验失败，实际通过了');
  return result.violations;
}

function rulesOf(result: StructureValidationResult): StructureRuleId[] {
  return violationsOf(result).map((v) => v.rule);
}

function run(slots: SlotProposal[], rootSlotId = 'chapter'): StructureValidationResult {
  return validateConcreteStructure(proposal(slots, rootSlotId), TEMPLATE);
}

/** 通过用例的统一断言：这条规则没被触发（其余违规不关它的事） */
function expectRuleAbsent(result: StructureValidationResult, rule: StructureRuleId): void {
  const fired = result.ok ? [] : result.violations.map((v) => v.rule);
  expect(fired).not.toContain(rule);
}

// ---------------------------------------------------------------- 逐条规则

describe('结构校验：19 条规则', () => {
  it('规则 1：槽位数为 0 → EMPTY_STRUCTURE', () => {
    const result = run([]);
    expect(rulesOf(result)).toEqual(['EMPTY_STRUCTURE']);
  });

  it('规则 1（通过）：非空结构不报 EMPTY_STRUCTURE', () => {
    expectRuleAbsent(run(baselineSlots()), 'EMPTY_STRUCTURE');
  });

  it('规则 2：槽位数超过 maxSlots → TOO_MANY_SLOTS', () => {
    const slots = [ROOT];
    for (let i = 0; i < 9; i += 1) slots.push(sp({ id: `scene_1${i}`, order: i + 1 }));
    const result = run(slots);
    expect(rulesOf(result)).toContain('TOO_MANY_SLOTS');
    const violation = violationsOf(result).find((v) => v.rule === 'TOO_MANY_SLOTS');
    // hint 必须同时给出「现状、上限、怎么改」三件事（D-13）
    expect(violation?.agentHint).toContain('10');
    expect(violation?.agentHint).toContain('8');
    expect(violation?.agentHint).toContain('合并');
  });

  it('规则 2（通过）：恰好等于上限不算超限', () => {
    const slots = [ROOT];
    for (let i = 0; i < 7; i += 1) slots.push(sp({ id: `scene_2${i}`, order: i + 1 }));
    expect(slots).toHaveLength(8);
    expectRuleAbsent(run(slots), 'TOO_MANY_SLOTS');
  });

  it('规则 3：ID 重复 → DUPLICATE_SLOT_ID', () => {
    const slots = [...baselineSlots(), sp({ id: 'scene_01', order: 3 })];
    const result = run(slots);
    expect(rulesOf(result)).toContain('DUPLICATE_SLOT_ID');
    const violation = violationsOf(result).find((v) => v.rule === 'DUPLICATE_SLOT_ID');
    expect(violation?.slotIds).toEqual(['scene_01']);
    expect(violation?.message).toContain('2 次');
  });

  it('规则 3（通过）：ID 各不相同', () => {
    expectRuleAbsent(run(baselineSlots()), 'DUPLICATE_SLOT_ID');
  });

  it('规则 4：ID 含非法字符 → INVALID_SLOT_ID', () => {
    // 正常路径由 Zod 拦截，这里模拟绕过解析层直接调用 Domain 的场景
    const slots = [...baselineSlots(), sp({ id: 'Scene-03', order: 3 })];
    const result = run(slots);
    expect(rulesOf(result)).toContain('INVALID_SLOT_ID');
  });

  it('规则 4（通过）：合法 ID 不报 INVALID_SLOT_ID', () => {
    expectRuleAbsent(run(baselineSlots()), 'INVALID_SLOT_ID');
  });

  it('规则 5：多个 parentId 为 null 的槽位 → MULTIPLE_ROOTS', () => {
    const slots = [...baselineSlots(), sp({ id: 'appendix', type: 'chapter', parentId: null, order: 1 })];
    const result = run(slots);
    expect(rulesOf(result)).toContain('MULTIPLE_ROOTS');
    const violation = violationsOf(result).find((v) => v.rule === 'MULTIPLE_ROOTS');
    expect(violation?.slotIds).toEqual(['chapter', 'appendix']);
  });

  it('规则 5（通过）：只有一个根', () => {
    expectRuleAbsent(run(baselineSlots()), 'MULTIPLE_ROOTS');
  });

  it('规则 6：没有任何 parentId 为 null 的槽位 → NO_ROOT', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'chapter' ? { ...s, parentId: 'title' } : s,
    );
    const result = run(slots);
    expect(rulesOf(result)).toContain('NO_ROOT');
  });

  it('规则 6（通过）：存在根槽位', () => {
    expectRuleAbsent(run(baselineSlots()), 'NO_ROOT');
  });

  it('规则 7：parentId 指向不存在的槽位 → PARENT_NOT_FOUND', () => {
    const slots = [...baselineSlots(), sp({ id: 'scene_09', parentId: 'chapter_x', order: 3 })];
    const result = run(slots);
    expect(rulesOf(result)).toContain('PARENT_NOT_FOUND');
    const violation = violationsOf(result).find((v) => v.rule === 'PARENT_NOT_FOUND');
    expect(violation?.slotIds).toEqual(['scene_09']);
    expect(violation?.message).toContain('chapter_x');
  });

  it('规则 7（通过）：所有 parentId 都能解析', () => {
    expectRuleAbsent(run(baselineSlots()), 'PARENT_NOT_FOUND');
  });

  it('规则 8：父子成环 → PARENT_CYCLE', () => {
    const slots = [
      ...baselineSlots(),
      sp({ id: 'node_a', parentId: 'node_b', order: 3 }),
      sp({ id: 'node_b', parentId: 'node_a', order: 4 }),
    ];
    const result = run(slots);
    expect(rulesOf(result)).toContain('PARENT_CYCLE');
    const violation = violationsOf(result).find((v) => v.rule === 'PARENT_CYCLE');
    expect(violation?.slotIds).toEqual(['node_a', 'node_b']);
  });

  it('规则 8（通过）：树形父子关系', () => {
    expectRuleAbsent(run(baselineSlots()), 'PARENT_CYCLE');
  });

  it('规则 9：层级超过 maxStructureDepth → DEPTH_EXCEEDED', () => {
    const slots = [
      ROOT,
      sp({ id: 'sec_a', type: 'section', parentId: 'chapter', order: 0, instruction: '' }),
      sp({ id: 'sec_b', type: 'section', parentId: 'sec_a', order: 0, instruction: '' }),
      sp({ id: 'scene_deep', parentId: 'sec_b', order: 0 }),
    ];
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DEPTH_EXCEEDED');
    expect(violation?.slotIds).toEqual(['scene_deep']);
    // 文案是 1 基的「第 4 层」，内部 depth 是 0 基的 3
    expect(violation?.message).toContain('第 4 层');
  });

  it('规则 9（通过）：恰好等于深度上限', () => {
    const slots = [
      ROOT,
      sp({ id: 'sec_a', type: 'section', parentId: 'chapter', order: 0, instruction: '' }),
      sp({ id: 'scene_ok', parentId: 'sec_a', order: 0 }),
    ];
    expectRuleAbsent(run(slots), 'DEPTH_EXCEEDED');
  });

  it('规则 10：同一父节点下 order 重复 → DUPLICATE_ORDER', () => {
    const slots = baselineSlots().map((s) => (s.id === 'scene_02' ? { ...s, order: 1 } : s));
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DUPLICATE_ORDER');
    expect(violation?.slotIds).toEqual(['scene_01', 'scene_02']);
    expect(violation?.message).toContain('chapter');
  });

  it('规则 10：根层级（parentId=null）的 order 冲突用「根层级」称呼，而不是空引号', () => {
    // 分组键是 parentId，根层级的 parentId 是 null——直接把它塞进文案会得到「」，
    // Agent 读到一个空名字根本不知道该改哪一层。多根本身由规则 5 另报，两条互不替代。
    const slots = [
      ROOT,
      sp({ id: 'appendix', type: 'chapter', parentId: null, order: 0, instruction: '' }),
      sp({ id: 'scene_01', order: 1 }),
    ];
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DUPLICATE_ORDER');
    expect(violation?.slotIds).toEqual(['chapter', 'appendix']);
    expect(violation?.message).toContain('「根层级」');
    expect(rulesOf(result)).toContain('MULTIPLE_ROOTS');
  });

  it('规则 10（通过）：不同父节点下 order 可以相同', () => {
    const slots = [
      ROOT,
      sp({ id: 'sec_a', type: 'section', parentId: 'chapter', order: 0, instruction: '' }),
      sp({ id: 'scene_x', parentId: 'sec_a', order: 0 }),
      sp({ id: 'scene_y', parentId: 'chapter', order: 1 }),
    ];
    expectRuleAbsent(run(slots), 'DUPLICATE_ORDER');
  });

  it('规则 11：type 不在模板范围 → UNKNOWN_SLOT_TYPE', () => {
    const slots = [...baselineSlots(), sp({ id: 'summary_01', type: 'summary', order: 3 })];
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'UNKNOWN_SLOT_TYPE');
    expect(violation?.slotIds).toEqual(['summary_01']);
    // hint 必须把可选项列全，否则模型只能盲猜（D-13）
    expect(violation?.agentHint).toContain('scene');
    expect(violation?.agentHint).toContain('chapter_outline');
  });

  it('规则 11（通过）：全部使用模板声明的类型', () => {
    expectRuleAbsent(run(baselineSlots()), 'UNKNOWN_SLOT_TYPE');
  });

  it('规则 12：根是内容承载类型 → ROOT_MUST_BE_CONTAINER', () => {
    const slots = [
      sp({ id: 'title', type: 'title', parentId: null, order: 0, instruction: '写标题' }),
      sp({ id: 'scene_01', parentId: 'title', order: 1 }),
    ];
    const result = run(slots, 'title');
    const violation = violationsOf(result).find((v) => v.rule === 'ROOT_MUST_BE_CONTAINER');
    expect(violation?.slotIds).toEqual(['title']);
    expect(violation?.agentHint).toContain('chapter');
  });

  it('规则 12（通过）：根是容器类型', () => {
    expectRuleAbsent(run(baselineSlots()), 'ROOT_MUST_BE_CONTAINER');
  });

  it('规则 13：内容槽位 instruction 为空白 → MISSING_INSTRUCTION', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'scene_02' ? { ...s, instruction: '   ' } : s,
    );
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'MISSING_INSTRUCTION');
    expect(violation?.slotIds).toEqual(['scene_02']);
  });

  it('规则 13（通过）：容器槽位不要求 instruction', () => {
    // 基线里的 chapter 就是 instruction 为空的容器
    expectRuleAbsent(run(baselineSlots()), 'MISSING_INSTRUCTION');
  });

  it('规则 14：dependsOn 引用不存在的槽位 → DEPENDENCY_NOT_FOUND', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'scene_02' ? { ...s, dependsOn: ['scene_00'] } : s,
    );
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DEPENDENCY_NOT_FOUND');
    expect(violation?.slotIds).toEqual(['scene_02']);
    expect(violation?.message).toContain('scene_00');
  });

  it('规则 14（通过）：dependsOn 全部可解析', () => {
    expectRuleAbsent(run(baselineSlots()), 'DEPENDENCY_NOT_FOUND');
  });

  it('规则 15：dependsOn 含自身 → SELF_DEPENDENCY', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'scene_02' ? { ...s, dependsOn: ['scene_01', 'scene_02'] } : s,
    );
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'SELF_DEPENDENCY');
    expect(violation?.slotIds).toEqual(['scene_02']);
  });

  it('规则 15（通过）：不依赖自身', () => {
    expectRuleAbsent(run(baselineSlots()), 'SELF_DEPENDENCY');
  });

  it('规则 16：依赖成环 → DEPENDENCY_CYCLE', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'scene_01' ? { ...s, dependsOn: ['scene_02'] } : s,
    );
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DEPENDENCY_CYCLE');
    expect(violation?.slotIds).toEqual(['scene_01', 'scene_02']);
    expect(violation?.message).toContain('→');
  });

  it('规则 16（通过）：链式依赖不成环', () => {
    const slots = [
      ...baselineSlots(),
      sp({ id: 'scene_03', order: 3, dependsOn: ['scene_02'] }),
    ];
    expectRuleAbsent(run(slots), 'DEPENDENCY_CYCLE');
  });

  it('规则 17：dependsOn 引用容器槽位 → DEPENDENCY_ON_CONTAINER', () => {
    const slots = baselineSlots().map((s) =>
      s.id === 'scene_02' ? { ...s, dependsOn: ['chapter'] } : s,
    );
    const result = run(slots);
    const violation = violationsOf(result).find((v) => v.rule === 'DEPENDENCY_ON_CONTAINER');
    expect(violation?.slotIds).toEqual(['scene_02', 'chapter']);
    expect(violation?.agentHint).toContain('contentBearing');
  });

  it('规则 17（通过）：可以依赖工作槽位（contentBearing=true 且不进产物，D-16）', () => {
    const slots = [
      ROOT,
      sp({ id: 'outline', type: 'chapter_outline', order: 0, instruction: '列出三个场景的目标' }),
      sp({ id: 'scene_01', order: 1, dependsOn: ['outline'] }),
    ];
    expectRuleAbsent(run(slots), 'DEPENDENCY_ON_CONTAINER');
  });

  it('规则 18：全是容器槽位 → NO_CONTENT_SLOT', () => {
    const slots = [
      ROOT,
      sp({ id: 'notes', type: 'working_notes', parentId: 'chapter', order: 0, instruction: '' }),
    ];
    const result = run(slots);
    expect(rulesOf(result)).toContain('NO_CONTENT_SLOT');
  });

  it('规则 18（通过）：存在至少一个内容槽位', () => {
    expectRuleAbsent(run(baselineSlots()), 'NO_CONTENT_SLOT');
  });

  it('规则 19：rootSlotId 在 slots 中不存在 → NO_ROOT', () => {
    const result = run(baselineSlots(), 'chapter_x');
    const violation = violationsOf(result).find((v) => v.slotIds.includes('chapter_x'));
    expect(violation?.rule).toBe('NO_ROOT');
    expect(violation?.message).toContain('不存在');
  });

  it('规则 19：rootSlotId 指向的槽位 parentId 不为 null → NO_ROOT', () => {
    const result = run(baselineSlots(), 'scene_01');
    const violation = violationsOf(result).find((v) => v.slotIds.includes('scene_01'));
    expect(violation?.rule).toBe('NO_ROOT');
    expect(violation?.message).toContain('parentId');
  });

  it('规则 19（通过）：rootSlotId 与事实上的根一致', () => {
    expectRuleAbsent(run(baselineSlots()), 'NO_ROOT');
  });
});

// ---------------------------------------------------------------- 行为约定

describe('结构校验：不短路（D-13）', () => {
  it('一次返回全部违规，而不是只报第一条', () => {
    const slots = [
      ROOT,
      sp({ id: 'bad_type', type: 'summary', order: 0 }),
      sp({ id: 'scene_01', order: 1, instruction: '' }),
      sp({ id: 'scene_02', order: 1, dependsOn: ['scene_02'] }),
      sp({ id: 'scene_03', order: 3, parentId: 'ghost' }),
    ];
    const fired = rulesOf(run(slots));

    expect(fired).toContain('UNKNOWN_SLOT_TYPE');
    expect(fired).toContain('MISSING_INSTRUCTION');
    expect(fired).toContain('SELF_DEPENDENCY');
    expect(fired).toContain('DUPLICATE_ORDER');
    expect(fired).toContain('PARENT_NOT_FOUND');
    expect(fired.length).toBeGreaterThanOrEqual(5);
  });

  it('每条违规的三段式字段都非空（agentHint 是重试通过率的唯一杠杆）', () => {
    const slots = [sp({ id: 'lonely', type: 'summary', parentId: 'ghost', order: 0, instruction: '' })];
    for (const violation of violationsOf(run(slots, 'lonely'))) {
      expect(violation.message.length).toBeGreaterThan(0);
      expect(violation.agentHint.length).toBeGreaterThan(10);
      expect(Array.isArray(violation.slotIds)).toBe(true);
    }
  });
});

describe('结构校验：校验顺序（§6.1）', () => {
  it('存在悬空 parentId 时，报 PARENT_NOT_FOUND 而不是误报 PARENT_CYCLE', () => {
    const slots = [
      ROOT,
      sp({ id: 'scene_01', order: 1 }),
      // 悬空引用
      sp({ id: 'orphan', parentId: 'ghost', order: 2 }),
      // 同时存在一个真实的父子环——引用没修干净之前不该报它
      sp({ id: 'node_a', parentId: 'node_b', order: 3 }),
      sp({ id: 'node_b', parentId: 'node_a', order: 4 }),
    ];
    const fired = rulesOf(run(slots));
    expect(fired).toContain('PARENT_NOT_FOUND');
    expect(fired).not.toContain('PARENT_CYCLE');
    expect(fired).not.toContain('DEPTH_EXCEEDED');
  });

  it('存在悬空 dependsOn 时，报 DEPENDENCY_NOT_FOUND 而不是误报 DEPENDENCY_CYCLE', () => {
    const slots = [
      ROOT,
      sp({ id: 'scene_01', order: 1, dependsOn: ['scene_02'] }),
      sp({ id: 'scene_02', order: 2, dependsOn: ['scene_01'] }),
      sp({ id: 'scene_03', order: 3, dependsOn: ['scene_missing'] }),
    ];
    const fired = rulesOf(run(slots));
    expect(fired).toContain('DEPENDENCY_NOT_FOUND');
    expect(fired).not.toContain('DEPENDENCY_CYCLE');
  });

  it('引用完整性违规排在图性质与语义违规之前', () => {
    const slots = [
      ROOT,
      sp({ id: 'scene_01', parentId: 'ghost', order: 1, instruction: '' }),
    ];
    const fired = rulesOf(run(slots));
    expect(fired.indexOf('PARENT_NOT_FOUND')).toBeLessThan(fired.indexOf('MISSING_INSTRUCTION'));
  });

  it('多根时跳过父子图算法，只报 MULTIPLE_ROOTS', () => {
    const slots = [
      ROOT,
      sp({ id: 'appendix', type: 'chapter', parentId: null, order: 1 }),
      sp({ id: 'scene_01', parentId: 'appendix', order: 0 }),
    ];
    const fired = rulesOf(run(slots));
    expect(fired).toContain('MULTIPLE_ROOTS');
    expect(fired).not.toContain('PARENT_CYCLE');
    expect(fired).not.toContain('DEPTH_EXCEEDED');
  });
});

describe('结构校验：模板本身有缺陷时的兜底文案', () => {
  it('模板没有容器类型时，规则 12 的 hint 指向模板作者而不是让 Agent 白改', () => {
    const template: StructureValidationTemplate = {
      slotTypes: [{ id: 'scene', contentBearing: true }],
      limits: { maxSlots: 8, maxStructureDepth: 3 },
    };
    const result = validateConcreteStructure(
      proposal([sp({ id: 'scene_01', parentId: null, order: 0 })], 'scene_01'),
      template,
    );
    const violation = violationsOf(result).find((v) => v.rule === 'ROOT_MUST_BE_CONTAINER');
    expect(violation?.agentHint).toContain('模板作者');
  });

  it('模板没有内容类型时，规则 18 的 hint 同样指向模板作者', () => {
    const template: StructureValidationTemplate = {
      slotTypes: [{ id: 'chapter', contentBearing: false }],
      limits: { maxSlots: 8, maxStructureDepth: 3 },
    };
    const result = validateConcreteStructure(proposal([ROOT]), template);
    const violation = violationsOf(result).find((v) => v.rule === 'NO_CONTENT_SLOT');
    expect(violation?.agentHint).toContain('模板作者');
  });
});

describe('结构校验：通过后的产出', () => {
  it('合法结构返回 ok 与规范化槽位', () => {
    const result = run(baselineSlots());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.map((s) => s.slotId)).toEqual(['chapter', 'title', 'scene_01', 'scene_02']);
  });

  it('产出按文档序：同级先比 order，再比 slotId', () => {
    const slots = [
      ROOT,
      sp({ id: 'scene_z', order: 2 }),
      sp({ id: 'scene_a', order: 1 }),
      sp({ id: 'sec', type: 'section', parentId: 'chapter', order: 0, instruction: '' }),
      sp({ id: 'scene_in_sec', parentId: 'sec', order: 0 }),
    ];
    const result = run(slots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.map((s) => s.slotId)).toEqual([
      'chapter',
      'sec',
      'scene_in_sec',
      'scene_a',
      'scene_z',
    ]);
  });

  it('contentBearing / includeInArtifact / depth 从模板解析而来（D-16 默认 true）', () => {
    const slots = [
      ROOT,
      sp({ id: 'outline', type: 'chapter_outline', order: 0, instruction: '列出场景规划' }),
      sp({ id: 'notes', type: 'working_notes', parentId: 'chapter', order: 1, instruction: '' }),
      sp({ id: 'scene_01', parentId: 'notes', order: 0, dependsOn: ['outline'] }),
    ];
    const result = run(slots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.slots.map((s) => [s.slotId, s]));

    expect(byId.get('chapter')?.contentBearing).toBe(false);
    expect(byId.get('chapter')?.includeInArtifact).toBe(true); // 容器默认必须是 true
    expect(byId.get('chapter')?.depth).toBe(0); // 0 基
    expect(byId.get('outline')?.contentBearing).toBe(true);
    expect(byId.get('outline')?.includeInArtifact).toBe(false); // 工作槽位
    expect(byId.get('notes')?.includeInArtifact).toBe(false); // 子树整体排除
    expect(byId.get('scene_01')?.depth).toBe(2);
  });

  it('dependsOn 去重后落库，避免同一依赖被读两遍', () => {
    const slots = [
      ROOT,
      sp({ id: 'scene_01', order: 0 }),
      sp({ id: 'scene_02', order: 1, dependsOn: ['scene_01', 'scene_01'] }),
    ];
    const result = run(slots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.find((s) => s.slotId === 'scene_02')?.dependsOn).toEqual(['scene_01']);
  });

  it('确定性：打乱输入顺序不改变产出（REQ NFR-006）', () => {
    const a = run(baselineSlots());
    const b = run([...baselineSlots()].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('确定性：同一份非法输入两次得到逐字相同的违规列表', () => {
    const build = (): SlotProposal[] => [
      ROOT,
      sp({ id: 'x1', type: 'summary', order: 0, instruction: '' }),
      sp({ id: 'x2', parentId: 'ghost', order: 0 }),
    ];
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });
});

// ---------------------------------------------------------------- 轻量 property test

/**
 * §12.2 M1 完成判据之一：「随机生成的合法槽位树 100 次全部通过校验」。
 *
 * 逐条规则的用例守的是「该拒的拒了」，这一组守的是**反面**——19 条规则叠在一起
 * 有没有把本该合法的结构也误伤掉。误伤比漏放更难发现：漏放会在下游炸出脏数据，
 * 而误伤只表现为「Structure Agent 通过率莫名偏低」，很容易被归咎于模型。
 *
 * PRNG 用固定种子的 xorshift 而不是 `Math.random()`：CI 上偶发失败却无法复现的测试，
 * 比没有测试更糟——它会被人加 `skip`。种子固定意味着任何失败都能原样重跑。
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** 在 TEMPLATE 的限制内随机长一棵**必然合法**的树 */
function randomValidStructure(rng: () => number): StructureProposal {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

  const slots: SlotProposal[] = [ROOT];
  // 可作父节点的容器，连同它们各自的深度（根 depth=0，上限 maxStructureDepth=3 → 最深 2）
  const containers: Array<{ id: string; depth: number }> = [{ id: 'chapter', depth: 0 }];
  const contentIds: string[] = [];
  // 每个父节点各自的 order 计数器——规则 10 只要求**同父**内唯一
  const nextOrder = new Map<string, number>([['chapter', 0]]);

  const total = 2 + Math.floor(rng() * (TEMPLATE.limits.maxSlots - 2)); // 含根，2..8
  for (let i = 1; i < total; i += 1) {
    // 只在还能再深一层的容器里挑父节点，保证不会撞 DEPTH_EXCEEDED
    const eligible = containers.filter((c) => c.depth + 1 < TEMPLATE.limits.maxStructureDepth);
    const parent = pick(eligible);
    const order = nextOrder.get(parent.id) ?? 0;
    nextOrder.set(parent.id, order + 1);

    // 末位强制放一个内容槽位，兜住规则 18（至少一个内容槽）
    const asContainer = i < total - 1 && contentIds.length > 0 && rng() < 0.3;
    const type = asContainer
      ? pick(['section', 'working_notes'] as const)
      : pick(['scene', 'title', 'chapter_outline'] as const);
    const id = `s${i}`;

    // 只依赖**已经生成的**内容槽位：天然无环，也天然不指向容器
    const deps =
      !asContainer && contentIds.length > 0 && rng() < 0.5 ? [pick(contentIds)] : [];

    slots.push({ id, type, parentId: parent.id, order, instruction: `写 ${id}`, dependsOn: deps });
    if (asContainer) containers.push({ id, depth: parent.depth + 1 });
    else contentIds.push(id);
  }

  return proposal(slots);
}

describe('property：随机生成的合法结构必须全部通过（M1 完成判据）', () => {
  it('100 棵随机合法树无一被误判', () => {
    const rng = makeRng(20260821);
    for (let i = 0; i < 100; i += 1) {
      const input = randomValidStructure(rng);
      const result = validateConcreteStructure(input, TEMPLATE);
      if (!result.ok) {
        // 失败时把结构和违规一起打进断言消息，否则只知道「第 37 棵挂了」毫无用处
        expect.fail(
          `第 ${i} 棵被误判：\n` +
            `${JSON.stringify(input, null, 2)}\n` +
            `违规：${JSON.stringify(result.violations, null, 2)}`,
        );
      }
      // 顺带守住产出形状：校验通过就必须给出与输入等量的规范化槽位
      expect(result.slots).toHaveLength(input.slots.length);
    }
  });
});
