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
import { sha256Hex } from '@server/domain/canonical.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import type { Slot } from '@server/domain/types.ts';
import type {
  FillSlotContextInput,
  StructureContextInput,
} from '@server/application/context-builder.ts';
import { buildContext } from '@server/application/context-builder.ts';
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
    ...overrides,
  };
}

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
