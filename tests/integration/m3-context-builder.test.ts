/**
 * ContextBuilder —— §7.4 的渲染与 D-12 的两个 hash。
 *
 * 这里的断言全部围绕一个问题：**contextHash 与 promptHash 分别在什么时候变？**
 * 合并成一个 hash 的系统在这些用例上会同时变或同时不变，因此每一条都能证伪。
 *
 * 用真快照（真 template.yaml + 真 SKILL.md 冻结进库再读回来）而不是手写对象：
 * 「注入了哪些 section」这件事只有走完整条冻结-读回链路才测得准。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@server/domain/canonical.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import type { Slot } from '@server/domain/types.ts';
import type {
  FillSlotContextInput,
  ReviewSlotContextInput,
  StructureContextInput,
} from '@server/application/context-builder.ts';
import {
  buildContext,
  parseReplayInput,
  rebuildContextFromReplay,
  serializeReplayInput,
} from '@server/application/context-builder.ts';
import { prepareNarrativeAnswerContract } from '@server/domain/narrative-answer.ts';
import type { FrozenTaskSnapshot } from '@server/application/snapshot-service.ts';
import { createAppEnv, seedNewTask, startStructureAssignment, VALID_PROPOSAL, type AppEnv } from '../fixtures/app.ts';

let env: AppEnv;
let taskId: string;
let snapshot: FrozenTaskSnapshot;

beforeEach(async () => {
  env = await createAppEnv();
  taskId = await seedNewTask(env);
  const { executionId } = startStructureAssignment(env, taskId);
  env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
  snapshot = env.snapshots.readSnapshot(taskId);
});

afterEach(async () => {
  await env.cleanup();
});

function agent(id: string) {
  const found = snapshot.compiled.agents.find((a) => a.id === id);
  if (found === undefined) throw new Error(`夹具缺少 agent ${id}`);
  return found;
}

function skill(id: string) {
  const found = snapshot.skills[id];
  if (found === undefined) throw new Error(`夹具缺少 skill ${id}`);
  return found;
}

function slotType(id: string) {
  const found = snapshot.compiled.slotTypes.find((t) => t.id === id);
  if (found === undefined) throw new Error(`夹具缺少 slotType ${id}`);
  return found;
}

const structureInput = (overrides: Partial<StructureContextInput> = {}): StructureContextInput => ({
  operation: 'create_structure',
  snapshot,
  agent: agent('structure_designer'),
  skill: skill('chapter-structure-design'),
  attemptNumber: 1,
  maxAttempts: 3,
  retry: null,
  review: null,
  ...overrides,
});

const VIOLATIONS: StructureViolation[] = [
  {
    rule: 'DEPENDENCY_ON_CONTAINER',
    message: '槽位「scene_02」依赖「chapter」，但 chapter 是容器槽位。',
    agentHint: '请改为引用 chapter 之下具体的内容槽位，或删除该依赖。',
    slotIds: ['scene_02', 'chapter'],
  },
  {
    rule: 'DUPLICATE_ORDER',
    message: '「chapter」下的「scene_01」和「opening」的 order 都是 1。',
    agentHint: '请按你希望的阅读顺序给这些槽位分配互不相同的 order（如 0、1、2）。',
    slotIds: ['scene_01', 'opening'],
  },
];

function fillSlotInput(overrides: Partial<FillSlotContextInput> = {}): FillSlotContextInput {
  const slots = env.uow.repositories.slots.listByTask(taskId);
  const target = slots.find((s) => s.slotId === 'scene_01');
  if (target === undefined) throw new Error('夹具缺少 scene_01');
  return {
    operation: 'fill_slot',
    snapshot,
    agent: agent('chapter_writer'),
    skill: skill('scene-writing'),
    attemptNumber: 1,
    maxAttempts: 2,
    slots,
    targetSlot: target,
    slotType: slotType('scene'),
    dependencies: [{ slotId: 'outline', content: '场景一：雨夜对峙' }],
    retry: null,
    revision: null,
    ...overrides,
  };
}

function reviewSlotInput(overrides: Partial<ReviewSlotContextInput> = {}): ReviewSlotContextInput {
  const fill = fillSlotInput();
  return {
    operation: 'review_slot',
    snapshot,
    agent: agent('chapter_writer'),
    skill: skill('scene-writing'),
    attemptNumber: 1,
    maxAttempts: 2,
    slots: fill.slots,
    targetSlot: fill.targetSlot,
    slotType: fill.slotType,
    dependencies: fill.dependencies,
    criterionId: fill.skill.requiredSections[0] ?? 'S1',
    contentUnderReview: '待审正文逐字内容',
    ...overrides,
  };
}

function planPolicy() {
  return {
    version: 1 as const,
    source: 'plan' as const,
    han: { minHan: 900, targetHan: 1200, maxHan: 1500 },
    narrativeUnit: {
      unitId: 'unit_01',
      order: 1,
      priority: 'P0' as const,
      priorityId: 'P001',
      expansion: 'detailed' as const,
      mode: 'conflict-scene' as const,
      capacity: { dialogueTurns: 4, actionFeedbackLoops: 2, cognitionTurns: 1, aftermathBeats: 1 },
    },
    runtimeMaxTokens: 4096,
  };
}

function answerContractFillInput(privateSource: string): FillSlotContextInput {
  const prepared = prepareNarrativeAnswerContract(privateSource);
  if (!prepared.ok) throw new Error('测试私有原文必须可准备');
  const base = fillSlotInput();
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      compiled: {
        ...base.snapshot.compiled,
        inputFields: [
          ...base.snapshot.compiled.inputFields,
          {
            id: 'source_text',
            label: '私有原文',
            type: 'textarea',
            required: true,
            visibility: 'system',
            toolReadable: true,
            hint: null,
          },
        ],
        slotTypes: base.snapshot.compiled.slotTypes.map((item) =>
          item.id === base.slotType.id
            ? {
                ...item,
                answerContract: {
                  kind: 'narrative-plan' as const,
                  version: 2 as const,
                  sourceField: 'source_text',
                  sourceSegmentation: 'preserve-numbered-sections' as const,
                  expansionPolicy: 'source-length-quantiles-v1' as const,
                  storyBudget: { minHan: 800, targetHan: 1000, maxHan: 1200 },
                },
              }
            : item,
        ),
      },
    },
    slotType: {
      ...base.slotType,
      answerContract: {
        kind: 'narrative-plan',
        version: 2,
        sourceField: 'source_text',
        sourceSegmentation: 'preserve-numbered-sections',
        expansionPolicy: 'source-length-quantiles-v1',
        storyBudget: { minHan: 800, targetHan: 1000, maxHan: 1200 },
      },
    },
  };
}

const PRIVATE_NUMBERED_SOURCE = [
  '01、隐私标题甲', '甲推进一步。',
  '02、隐私标题乙', '乙推进两步。',
  '03、隐私标题丙', '丙发现线索。',
  '04、隐私标题丁', '丁否认事实。',
  '05、隐私标题戊', '戊继续追问。',
  '06、隐私标题己', '己承认真相。',
  '07、隐私标题庚', '庚作出选择。',
  '08、隐私标题辛', '辛结束旧事。',
].join('\n');

function expectReplayRebuildsExactly(input: StructureContextInput | FillSlotContextInput | ReviewSlotContextInput): void {
  const live = buildContext(input);
  const replay = serializeReplayInput(input);
  const rebuilt = rebuildContextFromReplay(replay.replayInputJson, replay.replayInputHash, input.skill);
  expect(rebuilt).toEqual(live);
}

describe('ReplayInput provenance', () => {
  it('同一 ContextBuilderInput 产出稳定 canonical JSON 与 hash', () => {
    const a = serializeReplayInput(fillSlotInput());
    const b = serializeReplayInput(fillSlotInput());
    expect(a).toEqual(b);
    expect(a.replayInputHash).toBe(sha256Hex(a.replayInputJson));
    expect(parseReplayInput(a.replayInputJson, a.replayInputHash).version).toBe(1);
  });

  it('新 Replay 只序列化冻结模板声明的 agent 输入字段', () => {
    const systemField = {
      id: 'source_text',
      label: '私有原文',
      type: 'textarea' as const,
      required: true,
      visibility: 'system' as const,
      toolReadable: true,
      hint: null,
    };
    const privateSource = 'PRIVATE-SOURCE-MUST-NOT-ENTER-REPLAY';
    const dirtySnapshot: FrozenTaskSnapshot = {
      ...snapshot,
      compiled: {
        ...snapshot.compiled,
        inputFields: [...snapshot.compiled.inputFields, systemField],
      },
      input: { ...snapshot.input, source_text: privateSource },
    };

    const serialized = serializeReplayInput(fillSlotInput({ snapshot: dirtySnapshot }));
    const replay = parseReplayInput(serialized.replayInputJson, serialized.replayInputHash);

    expect(serialized.replayInputJson).not.toContain(privateSource);
    expect(replay.contextInput.snapshot.input).not.toHaveProperty('source_text');
  });

  it('hash 或 JSON 被篡改时拒绝解析', () => {
    const replay = serializeReplayInput(structureInput());
    expect(() => parseReplayInput(replay.replayInputJson, '0'.repeat(64))).toThrow(/hash 不一致/);
    const tampered = replay.replayInputJson.replace('create_structure', 'fill_slot');
    expect(() => parseReplayInput(tampered, replay.replayInputHash)).toThrow(/hash 不一致/);
  });

  it('逐字重建 create_structure retry + review', () => {
    expectReplayRebuildsExactly(
      structureInput({
        attemptNumber: 2,
        retry: {
          previousProposalJson: '{"rootSlotId":"chapter"}',
          violations: VIOLATIONS,
          noSubmission: false,
        },
        review: {
          round: 1,
          previousOutline: 'chapter\n  scene_01：雨夜对峙',
          findings: [{ criterionId: 'S1', quote: '雨夜对峙', problem: '冲突升级不清楚' }],
        },
      }),
    );
  });

  it('逐字重建 fill slots/target/deps/retry/revision', () => {
    expectReplayRebuildsExactly(
      fillSlotInput({
        attemptNumber: 2,
        retry: { noSubmission: false, reasons: ['正文长度不足'] },
        revision: {
          round: 1,
          degraded: true,
          priorRounds: [
            {
              visibleOutput: '先检查与上游的衔接。',
              readSlotIds: ['outline'],
              submittedContent: '上一稿逐字正文',
              findings: [{ criterionId: 'S1', quote: '上一稿', problem: '开头承接不足' }],
            },
          ],
        },
      }),
    );
  });

  it('新 fill replay 保留冻结 policy 与 slot binding', () => {
    const input = fillSlotInput({
      targetSlot: { ...fillSlotInput().targetSlot, narrativeUnitId: 'unit_01' },
      productionPolicy: planPolicy(),
    });
    const serialized = serializeReplayInput(input);
    const replay = parseReplayInput(serialized.replayInputJson, serialized.replayInputHash);
    if (replay.contextInput.operation !== 'fill_slot') throw new Error('预期 fill_slot replay');
    expect(replay.contextInput.targetSlot.narrativeUnitId).toBe('unit_01');
    expect(replay.contextInput.productionPolicy).toEqual(planPolicy());
    expectReplayRebuildsExactly(input);
  });

  it('旧 v1 缺少新增字段时仍解析为 null 并逐字重建', () => {
    const serialized = serializeReplayInput(fillSlotInput());
    const raw = JSON.parse(serialized.replayInputJson) as {
      contextInput: {
        snapshot: Record<string, unknown>;
        slots: Record<string, unknown>[];
        targetSlot: Record<string, unknown>;
        productionPolicy?: unknown;
      };
    };
    delete raw.contextInput.snapshot.narrativePlan;
    delete raw.contextInput.snapshot.narrativePlanHash;
    raw.contextInput.slots.forEach((item) => delete item.narrativeUnitId);
    delete raw.contextInput.targetSlot.narrativeUnitId;
    delete raw.contextInput.productionPolicy;
    const legacy = canonicalJson(raw);
    const parsed = parseReplayInput(legacy, sha256Hex(legacy));
    if (parsed.contextInput.operation !== 'fill_slot') throw new Error('预期 fill_slot replay');
    expect(parsed.contextInput.snapshot.narrativePlan).toBeNull();
    expect(parsed.contextInput.targetSlot.narrativeUnitId).toBeNull();
    expect(parsed.contextInput.productionPolicy).toBeUndefined();
  });

  it('逐字重建 review criterion/content', () => {
    expectReplayRebuildsExactly(reviewSlotInput({ criterionId: 'S1', contentUnderReview: '正文 A\n正文 B' }));
  });

  it('解析后可替换 Skill，并重建与直接 buildContext 逐字相同的上下文', () => {
    const input = fillSlotInput();
    const replacementSkill = {
      ...input.skill,
      version: '9.9.9',
      summary: `${input.skill.summary}（替换版）`,
    };
    const replay = serializeReplayInput(input);
    const rebuilt = rebuildContextFromReplay(
      replay.replayInputJson,
      replay.replayInputHash,
      replacementSkill,
    );
    expect(rebuilt).toEqual(buildContext({ ...input, skill: replacementSkill }));
    expect(rebuilt.systemText).toContain('scene-writing v9.9.9');
    expect(rebuilt.systemText).toContain('（替换版）');
  });

  it('v2 只冻结不可逆 contract provenance，并以 submit_answer 重建同一 Prompt', () => {
    const input = answerContractFillInput(PRIVATE_NUMBERED_SOURCE);
    const serialized = serializeReplayInput(input, {
      readPrivateInput: (fieldId) => fieldId === 'source_text' ? PRIVATE_NUMBERED_SOURCE : null,
    });
    const replay = parseReplayInput(serialized.replayInputJson, serialized.replayInputHash);

    expect(replay.version).toBe(2);
    if (replay.version !== 2) throw new Error('预期 Replay v2');
    expect(replay.answerContract).toMatchObject({
      kind: 'narrative-plan',
      version: 2,
      sourceField: 'source_text',
      sourceSegmentation: 'preserve-numbered-sections',
      expansionPolicy: 'source-length-quantiles-v1',
      sourceProfile: {
        sectionCount: 8,
        expansionCounts: { light: 8, standard: 0, detailed: 0 },
      },
    });
    expect(replay.answerContract.privateInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized.replayInputJson).not.toContain(PRIVATE_NUMBERED_SOURCE);
    expect(serialized.replayInputJson).not.toMatch(/隐私标题|推进一步|发现线索/);

    const rebuilt = rebuildContextFromReplay(
      serialized.replayInputJson,
      serialized.replayInputHash,
      input.skill,
      { readPrivateInput: () => PRIVATE_NUMBERED_SOURCE },
    );
    expect(rebuilt).toEqual(buildContext(input));
    expect(rebuilt.systemText).toContain('submit_answer');
    expect(rebuilt.systemText).not.toContain('complete_assignment');
    expect(rebuilt.userText).not.toContain('complete_assignment');
  });

  it('v2 返修只要求重新提交完整业务答案，不暴露 legacy 编辑清单协议', () => {
    const base = answerContractFillInput(PRIVATE_NUMBERED_SOURCE);
    const built = buildContext({
      ...base,
      revision: {
        round: 1,
        degraded: false,
        priorRounds: [{
          visibleOutput: '已分析原文分节。',
          readSlotIds: [],
          submittedContent: '系统生成的上一版兼容视图',
          findings: [{ criterionId: 'S1', quote: '上一版', problem: '因果链不足' }],
        }],
      },
    });

    expect(built.userText).toContain('重新提交一份完整业务答案');
    expect(built.userText).toContain('调用 submit_answer');
    expect(built.userText).not.toContain('slot_edits');
    expect(built.userText).not.toContain('complete_assignment');
  });

  it('v2 私有输入缺失或 hash 不匹配时失败关闭', () => {
    const input = answerContractFillInput(PRIVATE_NUMBERED_SOURCE);
    const serialized = serializeReplayInput(input, {
      readPrivateInput: () => PRIVATE_NUMBERED_SOURCE,
    });

    expect(() => rebuildContextFromReplay(
      serialized.replayInputJson,
      serialized.replayInputHash,
      input.skill,
      { readPrivateInput: () => null },
    )).toThrow(/私有输入.*缺失/);
    expect(() => rebuildContextFromReplay(
      serialized.replayInputJson,
      serialized.replayInputHash,
      input.skill,
      { readPrivateInput: () => `${PRIVATE_NUMBERED_SOURCE}篡改` },
    )).toThrow(/hash 不一致/);
  });

  it('不支持的 Replay version 给出明确错误', () => {
    const unsupported = canonicalJson({ version: 99, contextInput: {} });
    expect(() => parseReplayInput(unsupported, sha256Hex(unsupported))).toThrow(/不支持.*99/);
  });

  it('JSON 不含 token/apiKey/provider 输出或运行时解析结果', () => {
    const replay = serializeReplayInput(fillSlotInput());
    expect(replay.replayInputJson).not.toMatch(/token|api[_-]?key|authorization|bearer/i);
    expect(replay.replayInputJson).not.toContain('sk-fake-not-a-real-key');
    expect(replay.replayInputJson).not.toContain('providerOutput');
    expect(replay.replayInputJson).not.toContain('reasoning_content');
  });
});

describe('确定性（§7.4「确定性保证」/ NFR-004）', () => {
  it('同一输入两次调用逐字节相同', () => {
    const a = buildContext(structureInput());
    const b = buildContext(structureInput());
    expect(a).toEqual(b);
  });

  it('contextHash 就是落库 contextJson 的 sha256，不是另算一遍', () => {
    const built = buildContext(fillSlotInput());
    expect(built.contextHash).toBe(sha256Hex(built.contextJson));
    expect(built.promptHash).toBe(sha256Hex(`${built.systemText}\n\n${built.userText}`));
  });
});

describe('D-12：contextHash 与 promptHash 必须分离', () => {
  it('重试追加块只改 promptHash，不改 contextHash', () => {
    const first = buildContext(structureInput());
    const retry = buildContext(
      structureInput({
        attemptNumber: 2,
        retry: { previousProposalJson: '{"slots":[]}', violations: VIOLATIONS, noSubmission: false },
      }),
    );

    // 「喂进去的信息」没变——同一份快照、同一份任务输入、同一个 Skill
    expect(retry.contextHash).toBe(first.contextHash);
    // 「怎么组织的」变了——多了一整块违规反馈
    expect(retry.promptHash).not.toBe(first.promptHash);
  });

  it('生产策略进入 Prompt 与 contextHash，target 和容量变化可审计', () => {
    const policy = planPolicy();
    const before = buildContext(fillSlotInput({ productionPolicy: policy }));
    expect(before.userText).toContain('本节汉字数 900 – 1500，目标 1200');
    expect(before.userText).toContain('叙事优先级 P0 P001 · 展开 detailed · 模式 conflict-scene');
    expect(before.userText).toContain('容量上限：对白轮次 4；动作反馈闭环 2；认知转折 1；事后余波 1');

    const after = buildContext(fillSlotInput({
      productionPolicy: {
        ...policy,
        han: { ...policy.han, targetHan: 1300 },
        narrativeUnit: {
          ...policy.narrativeUnit,
          capacity: { ...policy.narrativeUnit.capacity, dialogueTurns: 5 },
        },
      },
    }));
    expect(after.contextHash).not.toBe(before.contextHash);
    expect(after.promptHash).not.toBe(before.promptHash);
  });

  it('依赖槽位的正文变了 → contextHash 变', () => {
    const before = buildContext(fillSlotInput());
    const after = buildContext(
      fillSlotInput({ dependencies: [{ slotId: 'outline', content: '改过的骨架' }] }),
    );
    expect(after.contextHash).not.toBe(before.contextHash);
  });

  it('依赖槽位的顺序变了 → contextHash 变（数组保序，不能用 Record）', () => {
    const two = [
      { slotId: 'outline', content: 'A' },
      { slotId: 'title', content: 'B' },
    ];
    const forward = buildContext(fillSlotInput({ dependencies: two }));
    const reversed = buildContext(fillSlotInput({ dependencies: [...two].reverse() }));
    expect(reversed.contextHash).not.toBe(forward.contextHash);
  });

  it('目标槽位的 instruction 变了 → contextHash 变', () => {
    const base = fillSlotInput();
    const patched: Slot = { ...base.targetSlot, instruction: '换一个目标' };
    expect(buildContext({ ...base, targetSlot: patched }).contextHash).not.toBe(
      buildContext(base).contextHash,
    );
  });

  it('结构上下文与槽位上下文的 contextHash 不可能相同', () => {
    expect(buildContext(structureInput()).contextHash).not.toBe(
      buildContext(fillSlotInput()).contextHash,
    );
  });
});

describe('Structure Context 的内容（§7.4）', () => {
  it('System Message 含平台边界四句与冻结的 Skill 必读章节', () => {
    const { systemText } = buildContext(structureInput());
    expect(systemText).toContain('你不能宣布任务完成，不能修改系统状态，不能选择自己的工作对象。');
    expect(systemText).toContain('Operation: create_structure');
    expect(systemText).toContain('chapter-structure-design v1.0.0');
    for (const sectionId of skill('chapter-structure-design').requiredSections) {
      expect(systemText).toContain(`## ${sectionId}`);
    }
  });

  it('User Message 含冻结输入、槽位类型目录与结构限制', () => {
    const { userText } = buildContext(structureInput());
    expect(userText).toContain('章节执行包：第三章：雨夜的对峙');
    expect(userText).toContain('chapter_outline（章节骨架）');
    expect(userText).toContain('最多 32 个槽位');
    expect(userText).toContain('structure_proposal_v1');
  });

  it('D-13：重试块一次列出全部违规的 agentHint，不止第一条', () => {
    const { userText } = buildContext(
      structureInput({
        attemptNumber: 2,
        retry: { previousProposalJson: '{"rootSlotId":"chapter"}', violations: VIOLATIONS, noSubmission: false },
      }),
    );
    for (const violation of VIOLATIONS) {
      expect(userText).toContain(`[${violation.rule}]`);
      expect(userText).toContain(violation.agentHint);
    }
    // 原样回灌上次提案，让模型做增量修正而不是重新设计
    expect(userText).toContain('{"rootSlotId":"chapter"}');
    expect(userText).toContain('这是第 2 次尝试，共 3 次机会。');
  });

  it('§7.6：no_submission 分支给的是「你没提交」而不是一堆违规', () => {
    const { userText } = buildContext(
      structureInput({
        attemptNumber: 2,
        retry: { previousProposalJson: null, violations: [], noSubmission: true },
      }),
    );
    expect(userText).toContain('没有调用 complete_assignment');
    expect(userText).not.toContain('系统校验发现以下问题');
  });
});

describe('Fill Slot Context 的内容（§7.4 / D-05 / FR-CTX-003）', () => {
  it('System Message 钉死目标槽位', () => {
    const { systemText } = buildContext(fillSlotInput());
    expect(systemText).toContain('目标槽位: scene_01（场景段）');
    expect(systemText).toContain('提交其他槽位的内容会被系统拒绝。');
  });

  it('结构概要是树形文本，标出当前槽位，且不含任何正文', () => {
    const { userText } = buildContext(fillSlotInput());
    expect(userText).toContain('chapter [容器]');
    expect(userText).toContain('scene_01 [← 当前槽位]');
    expect(userText).toContain('├─ ');
    // FR-CTX-003：其他槽位的正文不在上下文中，只有显式依赖的才给
    expect(userText).toContain('── outline ──');
    expect(userText).toContain('场景一：雨夜对峙');
  });

  it('D-05：guidance 是写作要求、validation 是系统校验，两者分列', () => {
    const { userText } = buildContext(fillSlotInput());
    expect(userText).toContain('【本类型的写作要求】');
    expect(userText).toContain('首段需衔接前一场景的结尾状态');
    expect(userText).toContain('字数 300 – 8000');
    expect(userText).toContain('场景正文不得包含 Markdown 小标题');
  });

  it('没有依赖时明说「没有上游可读」，不是留一段空标题', () => {
    const { userText } = buildContext(fillSlotInput({ dependencies: [] }));
    expect(userText).toContain('本槽位没有声明任何依赖');
  });

  it('重试块原样列出已成文的失败原因（D-19：本层不解析不改写）', () => {
    const { userText } = buildContext(
      fillSlotInput({
        attemptNumber: 2,
        retry: { noSubmission: false, reasons: ['正文只有 42 字，低于本槽位要求的最少 300 字'] },
      }),
    );
    expect(userText).toContain('1. 正文只有 42 字，低于本槽位要求的最少 300 字');
  });

  it('凭据与时间戳都不进上下文（REQ §13 / NFR-004）', () => {
    const built = buildContext(fillSlotInput());
    const all = `${built.systemText}\n${built.userText}\n${built.contextJson}`;
    expect(all).not.toMatch(/api[_-]?key|authorization|bearer/i);
    // 时间戳会让同一状态算出不同 hash，FR-CTX-006 的信号随之失效
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
