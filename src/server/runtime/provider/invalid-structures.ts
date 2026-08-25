/**
 * 非法结构夹具：**每条校验规则至少一个**（§11.2 的缺口，notes/OPEN-QUESTIONS.md Q-05）。
 *
 * 文档 §11 声称「19 条规则各有失败 fixture」，而 `FakeProviderScript.invalidStructure`
 * 原本只列了 4 种（`cycle` / `multi_root` / `bad_type` / `container_dep`）。
 * 那句话在集成层是落空的：Runtime 从来没被证明能把另外十几种违规完整地转成
 * D-13 的重试反馈。
 *
 * 这里把变体从 4 个扩到 18 个，并且**用 `Record<StructureRuleId, …>` 声明**——
 * 于是「新增一条规则却忘了加夹具」是编译错误，而不是一句没人核对的文档承诺。
 * （规则 19 条、枚举 18 个是刻意的，见 D-19：第 19 条复用 `NO_ROOT`。
 * 因此本表是 18 项，`NO_ROOT` 那项同时覆盖第 6 条与第 19 条。）
 *
 * 夹具**允许触发额外违规**——结构错误本来就常常连锁。测试断言的是
 * 「至少包含目标规则」，而不是「只有目标规则」；后者会把这些夹具变成
 * 结构校验实现细节的镜像，改一行 domain 就得改十八个夹具。
 */

import type { SlotProposal } from '@shared/tools.ts';
import type {
  StructureProposal,
  StructureRuleId,
  StructureValidationTemplate,
} from '@server/domain/structure-validation.ts';

/** 夹具专用模板。限制取小值，好让「超上限」类夹具不必写几十个槽位 */
export const FIXTURE_TEMPLATE: StructureValidationTemplate = {
  slotTypes: [
    { id: 'chapter', contentBearing: false },
    { id: 'section', contentBearing: false },
    { id: 'scene', contentBearing: true },
    { id: 'title', contentBearing: true },
  ],
  limits: { maxSlots: 8, maxStructureDepth: 3 },
};

function slot(overrides: Partial<SlotProposal> & Pick<SlotProposal, 'id'>): SlotProposal {
  return {
    type: 'scene',
    parentId: 'chapter',
    order: 0,
    instruction: `写好 ${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

const CHAPTER = slot({ id: 'chapter', type: 'chapter', parentId: null, instruction: '整章容器' });

/** 完全合法的参照结构。测试用它证明「校验器不是恒返回失败」 */
export const VALID_STRUCTURE: StructureProposal = {
  rootSlotId: 'chapter',
  slots: [
    CHAPTER,
    slot({ id: 'scene_01', order: 0 }),
    slot({ id: 'scene_02', order: 1, dependsOn: ['scene_01'] }),
  ],
};

export const INVALID_STRUCTURES: Record<StructureRuleId, StructureProposal> = {
  // 规则 1
  EMPTY_STRUCTURE: { rootSlotId: 'chapter', slots: [] },

  // 规则 2：maxSlots = 8，这里 9 个
  TOO_MANY_SLOTS: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      ...Array.from({ length: 8 }, (_unused, i) => slot({ id: `scene_${i + 1}`, order: i })),
    ],
  },

  // 规则 3
  DUPLICATE_SLOT_ID: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 0 }), slot({ id: 'scene_01', order: 1 })],
  },

  // 规则 4：正常路径由 `SlotProposalSchema` 在解析层拦下（§3.4），
  // 所以这个夹具经过 FakeProvider 时会表现为 TOOL_INPUT_INVALID 而非结构违规——
  // 这正是要被证明的行为，两条路径都得有测试
  INVALID_SLOT_ID: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'Scene-01', order: 0 })],
  },

  // 规则 6 + 规则 19（共用 NO_ROOT）：没有任何 parentId 为 null 的槽位
  NO_ROOT: {
    rootSlotId: 'chapter',
    slots: [
      slot({ id: 'chapter', type: 'chapter', parentId: 'scene_01', instruction: '整章容器' }),
      slot({ id: 'scene_01', order: 0 }),
    ],
  },

  // 规则 5
  MULTIPLE_ROOTS: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      slot({ id: 'appendix', type: 'section', parentId: null, order: 1, instruction: '附录容器' }),
      slot({ id: 'scene_01', order: 0 }),
    ],
  },

  // 规则 12：根用了内容承载类型
  ROOT_MUST_BE_CONTAINER: {
    rootSlotId: 'title',
    slots: [slot({ id: 'title', type: 'title', parentId: null, instruction: '标题' })],
  },

  // 规则 7
  PARENT_NOT_FOUND: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', parentId: 'chapter_x', order: 0 })],
  },

  // 规则 8：父子互指。刻意保持「唯一根 + 无悬空 parent」，否则闸门会跳过环检测
  PARENT_CYCLE: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      slot({ id: 'scene_01', parentId: 'scene_02', order: 0 }),
      slot({ id: 'scene_02', parentId: 'scene_01', order: 1 }),
    ],
  },

  // 规则 9：maxStructureDepth = 3，scene_01 落在第 4 层
  DEPTH_EXCEEDED: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      slot({ id: 'part_a', type: 'section', parentId: 'chapter', order: 0, instruction: '第一部分' }),
      slot({ id: 'part_b', type: 'section', parentId: 'part_a', order: 0, instruction: '第二部分' }),
      slot({ id: 'scene_01', parentId: 'part_b', order: 0 }),
    ],
  },

  // 规则 10
  DUPLICATE_ORDER: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 1 }), slot({ id: 'scene_02', order: 1 })],
  },

  // 规则 11
  UNKNOWN_SLOT_TYPE: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', type: 'summary', order: 0 })],
  },

  // 规则 13
  MISSING_INSTRUCTION: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 0, instruction: '   ' })],
  },

  // 规则 14
  DEPENDENCY_NOT_FOUND: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 0, dependsOn: ['scene_00'] })],
  },

  // 规则 15
  SELF_DEPENDENCY: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 0, dependsOn: ['scene_01'] })],
  },

  // 规则 16
  DEPENDENCY_CYCLE: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      slot({ id: 'scene_01', order: 0, dependsOn: ['scene_02'] }),
      slot({ id: 'scene_02', order: 1, dependsOn: ['scene_01'] }),
    ],
  },

  // 规则 17
  DEPENDENCY_ON_CONTAINER: {
    rootSlotId: 'chapter',
    slots: [CHAPTER, slot({ id: 'scene_01', order: 0, dependsOn: ['chapter'] })],
  },

  // 规则 18：全是容器
  NO_CONTENT_SLOT: {
    rootSlotId: 'chapter',
    slots: [
      CHAPTER,
      slot({ id: 'part_a', type: 'section', parentId: 'chapter', order: 0, instruction: '第一部分' }),
    ],
  },
};

/** 夹具键的运行时清单，供测试遍历（类型层的完备性由 `Record` 保证） */
export const INVALID_STRUCTURE_RULE_IDS = Object.keys(INVALID_STRUCTURES) as StructureRuleId[];
