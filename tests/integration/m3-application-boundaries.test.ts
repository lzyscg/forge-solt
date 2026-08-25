/**
 * M3-B：Application 服务层的 §5.5 事务边界。
 *
 * 每条边界一个成功用例 + 一个回滚用例。回滚用例统一用 `dumpAll` 做**全库逐字节**断言
 * ——只断言「主表没写进去」是不够的，M2 起就在防「主表回滚了但 trace 留下了」。
 *
 * 另有一条 M3 特有的断言贯穿全文：**回滚时 `published` 必须一条都不增长**。
 * §5.5 要求 trace 写在事务内、SSE 推在提交之后；若哪天有人把 publish 挪进事务，
 * 库里回滚干净而 UI 上却多出一个从未发生的事件，只有这条断言抓得住。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { TaskDetailSchema } from '@shared/contracts.ts';
import { sha256Hex } from '@server/domain/canonical.ts';
import { computeArtifactChecksum } from '@server/domain/assembly.ts';
import { dumpAll } from '../fixtures/db.ts';
import {
  createAppEnv,
  fakeContext,
  seedNewTask,
  startSlotAssignment,
  startStructureAssignment,
  VALID_PROPOSAL,
  type AppEnv,
} from '../fixtures/app.ts';

let env: AppEnv;
let taskId: string;

beforeEach(async () => {
  env = await createAppEnv();
  taskId = await seedNewTask(env);
});

afterEach(async () => {
  await env.cleanup();
});

/** 断言某个动作既没改库、也没推出任何 SSE 事件 */
function expectNoTrace(action: () => void): unknown {
  const before = dumpAll(env.db);
  const publishedBefore = env.published.length;
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(dumpAll(env.db)).toEqual(before);
  expect(env.published.length).toBe(publishedBefore);
  return thrown;
}

const LONG_OUTLINE = '场景一：雨夜对峙，目标是逼出真相；冲突在于对方拒绝承认。'.repeat(6);
const SCENE_TEXT = '雨点砸在铁皮棚顶上，像有人在上面不停地敲。她把伞收了，水顺着伞骨往下淌。'.repeat(12);

// ---------------------------------------------------------------------------

describe('创建 Assignment（§5.5 边界 2 / D-09 / §8.1）', () => {
  it('execution + task.active_execution_id + slot→running + trace 在一个事务内', () => {
    startStructureAssignment(env, taskId);
    const { executions, tasks, traces } = env.uow.repositories;

    const execution = executions.getOrThrow('exec-1');
    expect(execution.status).toBe('running');
    expect(execution.startedAt).not.toBeNull();
    expect(tasks.getOrThrow(taskId).activeExecutionId).toBe('exec-1');
    // M4 补正：创建事务只写 `assignment_created`。`assignment_started` 归 Runtime，
    // 「开始」必须意味着模型真的开始工作了（别名解析失败时它不该出现）。见 §8.5。
    expect(traces.listByTask(taskId).map((t) => t.kind)).toEqual(['assignment_created']);
    // §5.5：trace 在事务内写、事务外推。两者都必须发生，且数量一致
    expect(env.published.map((t) => t.kind)).toEqual(['assignment_created']);
  });


  it('D-09：AgentAssignment.id 就是 execution.id，不另外生成', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    expect(env.uow.repositories.executions.getOrThrow(executionId).id).toBe(executionId);
  });

  it('§8.1：明文 Token 不落库，库里只有它的 sha256', () => {
    const { executionId, token } = startStructureAssignment(env, taskId);
    expect(env.uow.repositories.executions.getOrThrow(executionId).tokenHash).toBe(sha256Hex(token));

    // 全库扫一遍：明文 token 不该出现在任何一列里（trace payload 也算）
    const dump = JSON.stringify(dumpAll(env.db));
    expect(token.length).toBeGreaterThan(0);
    expect(dump).not.toContain(token);
  });

  it('回滚：任务已有活动执行时整条边界不落地', () => {
    startStructureAssignment(env, taskId);
    const thrown = expectNoTrace(() =>
      env.assignments.create({
        taskId,
        operation: 'create_structure',
        targetSlotId: null,
        binding: {
          agentId: 'structure_designer',
          skillId: 'chapter-structure-design',
          skillVersion: '1.0.0',
          modelAlias: 'structure',
        },
        resolved: { provider: 'p', model: 'm' },
        context: fakeContext('second'),
        attemptNumber: 2,
      }),
    );
    expect(thrown).toBeInstanceOf(ForgeError);
    expect((thrown as ForgeError).code).toBe('TASK_STATE_INVALID');
  });

  it('回滚：任务不是 running 时不建 execution', () => {
    // 任务停在 ready：还没启动就不该有 Assignment
    const thrown = expectNoTrace(() =>
      env.assignments.create({
        taskId,
        operation: 'create_structure',
        targetSlotId: null,
        binding: {
          agentId: 'structure_designer',
          skillId: 'chapter-structure-design',
          skillVersion: '1.0.0',
          modelAlias: 'structure',
        },
        resolved: { provider: 'p', model: 'm' },
        context: fakeContext('early'),
        attemptNumber: 1,
      }),
    );
    expect((thrown as ForgeError).code).toBe('TASK_STATE_INVALID');
  });
});

// ---------------------------------------------------------------------------

describe('提交 Structure（§5.5 边界 3 / D-13）', () => {
  it('通过：n 个槽位 + execution 收尾 + phase→slots + trace，一个事务内', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    const result = env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });

    expect(result.ok).toBe(true);
    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.phase).toBe('slots');
    expect(task.activeExecutionId).toBeNull();
    expect(env.uow.repositories.slots.listByTask(taskId).map((s) => s.slotId).sort()).toEqual([
      'chapter',
      'outline',
      'scene_01',
      'title',
    ]);
    expect(env.uow.repositories.executions.getOrThrow(executionId).status).toBe('succeeded');
    // D-16：工作槽位的 includeInArtifact 来自模板，Agent 无权声明
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'outline').includeInArtifact).toBe(false);
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'scene_01').includeInArtifact).toBe(true);
  });

  it('未通过：数据库里一个槽位都不留，且一次给全部违规（D-13）', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    const result = env.structures.submit({
      taskId,
      executionId,
      proposal: {
        rootSlotId: 'chapter',
        slots: [
          { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '', dependsOn: [] },
          // 三个独立错误：依赖容器 / 未知类型 / 内容槽 instruction 为空
          { id: 'scene_a', type: 'scene', parentId: 'chapter', order: 0, instruction: '写点什么', dependsOn: ['chapter'] },
          { id: 'scene_b', type: 'nope', parentId: 'chapter', order: 1, instruction: '也写点', dependsOn: [] },
          { id: 'scene_c', type: 'scene', parentId: 'chapter', order: 2, instruction: '   ', dependsOn: [] },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');

    // 逐条点名，而不是断言 length > 1——后者在只报出一条错误码时也能过
    expect(result.violations.map((v) => v.rule).sort()).toEqual([
      'DEPENDENCY_ON_CONTAINER',
      'MISSING_INSTRUCTION',
      'UNKNOWN_SLOT_TYPE',
    ]);
    // 三段式必须原样保留：agentHint 是重试路径的全部价值
    for (const violation of result.violations) {
      expect(violation.agentHint.length).toBeGreaterThan(violation.message.length / 2);
    }

    expect(env.uow.repositories.slots.listByTask(taskId)).toEqual([]);

    // D-20：被拒**不收敛 execution、不让出活动执行位**——这一次 Assignment 还活着。
    // 模型拿到三段式违规后可以在同一轮对话里改好重提；收尾由 ProductionEngine 决定。
    // 早先这里断言的是 failed + activeExecutionId 为 null，那个行为会让模型改对之后
    // 重新提交时撞上 EXECUTION_STALE——一个本该被接受的正确结构被系统自己判成迟到结果。
    expect(env.uow.repositories.executions.getOrThrow(executionId).status).toBe('running');
    expect(env.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId).toBe(executionId);
    expect(env.published.at(-1)?.kind).toBe('validation_failed');
  });

  it('回滚：活动执行已变更（stop 插进来）→ EXECUTION_STALE 且槽位一个都没插进去', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    // 模拟 stop 事务插在「模型返回」与「提交」之间
    env.uow.run((uow) => uow.tasks.update(taskId, { activeExecutionId: null, status: 'running' }));

    const thrown = expectNoTrace(() =>
      env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL }),
    );
    expect((thrown as ForgeError).code).toBe('EXECUTION_STALE');
  });

  it('markExhausted 写出可直接展示的完整中文（D-19）', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    const result = env.structures.submit({
      taskId,
      executionId,
      proposal: { rootSlotId: 'chapter', slots: [] },
    });
    if (result.ok) throw new Error('unreachable');
    env.structures.markExhausted({
      taskId,
      violations: result.violations,
      attempts: 3,
      lastReason: '不该被用到',
    });

    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('STRUCTURE_RETRY_EXHAUSTED');
    // 派生层原样展示这句话，因此它必须自成一句、不含占位符、不需要再拼装
    expect(task.errorMessage).toBe(
      '结构校验未通过：结构提案不包含任何槽位。；已用尽 3 次尝试，任务停在创建结构阶段',
    );
    // 有违规时报违规，lastReason 让位——违规是更有用的信息
    expect(task.errorMessage).not.toContain('不该被用到');
  });

  it('没有违规时（超时 / 缺配置）报真实原因，不谎称「未通过确定性校验」', () => {
    // 这一条守的是一次真实事故：CLI 因为少配了一个环境变量而失败，
    // 界面上显示的却是「结构提案未通过确定性校验」——排查方向被直接引向 Skill 文案，
    // 而真正的原因连一条线索都不留。violations 为空时必须说实话。
    env.structures.markExhausted({
      taskId,
      violations: [],
      attempts: 2,
      lastReason: '模型别名「structure」无法解析：环境变量 DEEPSEEK_API_KEY 未设置',
    });

    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.errorMessage).toContain('DEEPSEEK_API_KEY');
    expect(task.errorMessage).not.toContain('未通过确定性校验');
  });
});

// ---------------------------------------------------------------------------

describe('提交 Slot Content（§5.5 边界 4 / D-10 / §8.4）', () => {
  const seedStructure = (): void => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
  };

  it('通过：条件 UPDATE 命中 + execution 收尾 + task 让出活动执行 + trace', () => {
    seedStructure();
    const { executionId, token } = startSlotAssignment(env, taskId, 'outline');

    const result = env.completions.submitSlotContent({
      taskId,
      executionId,
      token,
      slotId: 'outline',
      content: LONG_OUTLINE,
      producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
      usage: { inputTokens: 120, outputTokens: 340 },
    });

    expect(result.ok).toBe(true);
    const slot = env.uow.repositories.slots.getOrThrow(taskId, 'outline');
    expect(slot.status).toBe('completed');
    expect(slot.contentText).toBe(LONG_OUTLINE);
    expect(slot.producer).toEqual({
      agentId: 'chapter_writer',
      skillId: 'outline-writing',
      skillVersion: '1.0.0',
      executionId,
    });
    expect(env.uow.repositories.executions.getOrThrow(executionId).outputTokens).toBe(340);
    expect(env.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId).toBeNull();
  });

  it('D-05：字数不足被拒，槽位回 pending 且正文一个字都不留', () => {
    seedStructure();
    const { executionId, token } = startSlotAssignment(env, taskId, 'outline');

    const result = env.completions.submitSlotContent({
      taskId,
      executionId,
      token,
      slotId: 'outline',
      content: '太短了',
      producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasons).toEqual(['正文只有 3 字，低于本槽位要求的最少 100 字']);

    // D-20：被拒**不动任何状态**，只写一条 validation_failed trace。
    // 槽位仍在 running、execution 仍是活动执行——模型可以在同一轮对话里补写重提，
    // 那条路径只花几百 token；早先的实现会把它升级成一整个 attempt，
    // 而且模型改好后重新提交还会撞上 EXECUTION_STALE。
    const slot = env.uow.repositories.slots.getOrThrow(taskId, 'outline');
    expect(slot.status).toBe('running');
    // 正文一个字都不留：被拒的内容绝不能落库
    expect(slot.contentText).toBeNull();
    expect(env.uow.repositories.executions.getOrThrow(executionId).status).toBe('running');
    expect(env.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId).toBe(executionId);
    expect(env.published.at(-1)?.kind).toBe('validation_failed');
  });

  it('D-05：forbidPattern 命中时用模板给的中文提示，不是正则源码', () => {
    seedStructure();
    const { executionId, token } = startSlotAssignment(env, taskId, 'scene_01');
    const result = env.completions.submitSlotContent({
      taskId,
      executionId,
      token,
      slotId: 'scene_01',
      content: `## 小标题\n\n${SCENE_TEXT}`,
      producer: { agentId: 'chapter_writer', skillId: 'scene-writing', skillVersion: '1.0.0' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasons).toEqual(['场景正文不得包含 Markdown 小标题']);
  });

  it('提交错误的 slotId：报 SLOT_TARGET_MISMATCH 且全库不变', () => {
    seedStructure();
    const { executionId, token } = startSlotAssignment(env, taskId, 'outline');

    const thrown = expectNoTrace(() =>
      env.completions.submitSlotContent({
        taskId,
        executionId,
        token,
        slotId: 'title',
        content: '雨夜的对峙',
        producer: { agentId: 'chapter_writer', skillId: 'title-writing', skillVersion: '1.0.0' },
      }),
    );
    expect((thrown as ForgeError).code).toBe('SLOT_TARGET_MISMATCH');
  });

  it('§8.4 停止后的迟到结果：被拒、不改任何状态，但归因写在第二个事务里', () => {
    seedStructure();
    const { executionId, token } = startSlotAssignment(env, taskId, 'outline');

    // stop：execution 取消、槽位回 pending、任务让出活动执行（§8.3 的事务）
    env.uow.run((uow) => {
      uow.executions.markCancelled(executionId, 'USER_STOP');
      uow.slots.resetToPending(taskId, 'outline');
      uow.tasks.update(taskId, { status: 'stopped', activeExecutionId: null });
    });

    expect(() =>
      env.completions.submitSlotContent({
        taskId,
        executionId,
        token,
        slotId: 'outline',
        content: LONG_OUTLINE,
        producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
      }),
    ).toThrow(ForgeError);

    // AC-011：迟到结果不修改任何状态
    const slot = env.uow.repositories.slots.getOrThrow(taskId, 'outline');
    expect(slot.status).toBe('pending');
    expect(slot.contentText).toBeNull();
    // 已经是 cancelled 的执行不被改写成 stale——「谁取消的」是排查时最想知道的事
    expect(env.uow.repositories.executions.getOrThrow(executionId).status).toBe('cancelled');
    // 但归因必须留下来：若 §8.4 的示例照抄（与被拒的 UPDATE 同事务），这条会一起回滚掉
    const rejected = env.uow.repositories.traces
      .listByTask(taskId)
      .filter((t) => t.kind === 'late_result_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.summary).toContain('outline');
    expect(env.published.at(-1)?.kind).toBe('late_result_rejected');
  });

  it('§8.4 token 不匹配：execution 仍在跑，因此被盖上 stale', () => {
    seedStructure();
    const { executionId } = startSlotAssignment(env, taskId, 'outline');

    expect(() =>
      env.completions.submitSlotContent({
        taskId,
        executionId,
        token: '伪造的-token',
        slotId: 'outline',
        content: LONG_OUTLINE,
        producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
      }),
    ).toThrow(/EXECUTION|提交被拒绝|未被保存|Token/i);

    expect(env.uow.repositories.executions.getOrThrow(executionId).status).toBe('stale');
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'outline').contentText).toBeNull();
  });

  it('failSlot：配额未尽时槽位回 pending；耗尽时任务 failed 且原因成文（D-19）', () => {
    seedStructure();
    const first = startSlotAssignment(env, taskId, 'outline');
    env.completions.failSlot({
      taskId,
      slotId: 'outline',
      executionId: first.executionId,
      errorCode: 'PROVIDER_TIMEOUT',
      reason: '120 秒超时',
      exhausted: false,
    });
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'outline').status).toBe('pending');
    expect(env.uow.repositories.tasks.getOrThrow(taskId).status).toBe('running');

    const second = startSlotAssignment(env, taskId, 'outline');
    env.completions.failSlot({
      taskId,
      slotId: 'outline',
      executionId: second.executionId,
      errorCode: 'PROVIDER_TIMEOUT',
      reason: '120 秒超时',
      exhausted: true,
    });
    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorMessage).toBe('outline：120 秒超时');
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'outline').status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------

describe('完成 Artifact（§5.5 边界 6 / D-16 / D-19）', () => {
  /** 把 VALID_PROPOSAL 的三个内容槽全部填满 */
  const fillAll = (): void => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
    const contents: Record<string, string> = {
      outline: LONG_OUTLINE,
      title: '雨夜的对峙',
      scene_01: SCENE_TEXT,
    };
    for (const [slotId, content] of Object.entries(contents)) {
      const assignment = startSlotAssignment(env, taskId, slotId);
      env.completions.submitSlotContent({
        taskId,
        executionId: assignment.executionId,
        token: assignment.token,
        slotId,
        content,
        producer: { agentId: 'chapter_writer', skillId: 'scene-writing', skillVersion: '1.0.0' },
      });
    }
    env.uow.run((uow) => uow.tasks.update(taskId, { phase: 'assembly' }));
  };

  it('组装 + task(phase=done,status=completed,artifact_id) + trace，一个事务内', () => {
    fillAll();
    const artifact = env.assembly.assemble(taskId);

    expect(artifact.fileName).toBe('chapter.md');
    expect(artifact.checksum).toBe(computeArtifactChecksum(artifact.content));
    // D-16：工作槽位（outline）不进正文，标题与场景进
    expect(artifact.content).toContain('雨夜的对峙');
    expect(artifact.content).not.toContain(LONG_OUTLINE);

    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('completed');
    expect(task.phase).toBe('done');
    expect(task.artifactId).toBe(artifact.id);
    expect(env.published.at(-1)?.kind).toBe('artifact_created');
  });

  it('AC-013：同一任务重复组装逐字节相同，且旧产物被替换而不是并存', () => {
    fillAll();
    const first = env.assembly.assemble(taskId);
    const second = env.assembly.assemble(taskId);
    expect(second.content).toBe(first.content);
    expect(second.checksum).toBe(first.checksum);
    expect(second.id).not.toBe(first.id);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 1 });
  });

  it('D-19：空产物被拒绝，不落 artifact，任务标 failed 且原因指向 includeInArtifact', () => {
    // 结构里只有一个工作槽位：合法结构，但装配不出任何正文
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({
      taskId,
      executionId,
      proposal: {
        rootSlotId: 'chapter',
        slots: [
          { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '整章', dependsOn: [] },
          {
            id: 'outline',
            type: 'chapter_outline',
            parentId: 'chapter',
            order: 0,
            instruction: '只写规划',
            dependsOn: [],
          },
        ],
      },
    });
    const assignment = startSlotAssignment(env, taskId, 'outline');
    env.completions.submitSlotContent({
      taskId,
      executionId: assignment.executionId,
      token: assignment.token,
      slotId: 'outline',
      content: LONG_OUTLINE,
      producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
    });

    expect(() => env.assembly.assemble(taskId)).toThrow(/组装结果为空/);
    expect(env.uow.repositories.artifacts.getByTask(taskId)).toBeNull();
    const task = env.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('ASSEMBLY_FAILED');
    expect(task.errorMessage).toContain('includeInArtifact');
    // 已完成的槽位内容保留（ASSEMBLY_FAILED 的 action 承诺了这件事）
    expect(env.uow.repositories.slots.getOrThrow(taskId, 'outline').contentText).toBe(LONG_OUTLINE);
  });

  it('§8.8：还有槽位没完成时拒绝组装，并点名是谁', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });

    expect(() => env.assembly.assemble(taskId)).toThrow(/outline、title、scene_01/);
    expect(env.uow.repositories.artifacts.getByTask(taskId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('SlotScheduler（§6.2 / FR-SCH-004）', () => {
  const seedStructure = (): void => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
  };

  it('按文档序选下一个 ready 槽位；依赖未满足的被跳过', () => {
    seedStructure();
    // outline 无依赖排第一；scene_01 依赖 outline，此刻不 ready
    const next = env.scheduler.selectNext(taskId);
    expect(next).toEqual({ kind: 'slot', slot: expect.objectContaining({ slotId: 'outline' }) });
  });

  it('有 running 槽位时不再选新的（NFR-001 的任务级投影）', () => {
    seedStructure();
    startSlotAssignment(env, taskId, 'outline');
    const next = env.scheduler.selectNext(taskId);
    expect(next.kind).toBe('running');
  });

  it('失败槽位优先于死锁判定，避免把真正的失败原因盖掉', () => {
    seedStructure();
    env.uow.run((uow) => {
      uow.slots.markRunning(taskId, 'outline');
      uow.slots.markFailed(taskId, 'outline', 'PROVIDER_TIMEOUT', '120 秒超时');
    });
    const next = env.scheduler.selectNext(taskId);
    expect(next).toEqual({ kind: 'failed', slot: expect.objectContaining({ slotId: 'outline' }) });
  });

  it('死锁：抛 DEPENDENCY_DEADLOCK 且消息点名谁在等谁（D-19）', () => {
    seedStructure();
    // 构造一份「不受今天的结构校验保护的历史数据」：绕过服务直接删掉两个槽位，
    // 于是 scene_01 的 dependsOn 悬空、永远等不到，而 title 被删掉后也没有别的 ready 槽位。
    // 这正是 detectDeadlock 存在的理由——正常路径上规则 14/16 已经把这类结构挡在门外。
    env.db.prepare("DELETE FROM slots WHERE task_id = ? AND slot_id = 'outline'").run(taskId);
    env.db.prepare("DELETE FROM slots WHERE task_id = ? AND slot_id = 'title'").run(taskId);

    let thrown: unknown;
    try {
      env.scheduler.selectNext(taskId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForgeError);
    expect((thrown as ForgeError).code).toBe('DEPENDENCY_DEADLOCK');
    expect((thrown as ForgeError).message).toBe(
      '结构存在无法满足的依赖：scene_01 在等待 outline，而这些前置槽位不会再完成',
    );
  });

  it('全部内容槽完成 → assembly', () => {
    seedStructure();
    for (const [slotId, content] of [
      ['outline', LONG_OUTLINE],
      ['title', '雨夜的对峙'],
      ['scene_01', SCENE_TEXT],
    ] as const) {
      const assignment = startSlotAssignment(env, taskId, slotId);
      env.completions.submitSlotContent({
        taskId,
        executionId: assignment.executionId,
        token: assignment.token,
        slotId,
        content,
        producer: { agentId: 'chapter_writer', skillId: 'scene-writing', skillVersion: '1.0.0' },
      });
    }
    expect(env.scheduler.selectNext(taskId)).toEqual({ kind: 'assembly' });
  });

  it('dependenciesOf 保持 dependsOn 的声明顺序，并拒绝未完成的前置', () => {
    seedStructure();
    const scene = env.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(() => env.scheduler.dependenciesOf(taskId, scene)).toThrow(/尚未完成/);

    const assignment = startSlotAssignment(env, taskId, 'outline');
    env.completions.submitSlotContent({
      taskId,
      executionId: assignment.executionId,
      token: assignment.token,
      slotId: 'outline',
      content: LONG_OUTLINE,
      producer: { agentId: 'chapter_writer', skillId: 'outline-writing', skillVersion: '1.0.0' },
    });
    expect(env.scheduler.dependenciesOf(taskId, scene)).toEqual({
      slotIds: ['outline'],
      contents: [{ slotId: 'outline', content: LONG_OUTLINE }],
    });
  });
});

// ---------------------------------------------------------------------------

describe('TaskService 投影（§3.5 / D-07 / D-14）', () => {
  it('TaskDetail 满足契约 schema，且派生字段由服务端算好', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });

    const detail = env.taskService.getTaskDetail(taskId);
    // 用契约 schema 而不是逐字段手写断言：漏掉一个必填字段时这条会红
    expect(() => TaskDetailSchema.parse(detail)).not.toThrow();

    expect(detail.templateName).toBe('知乎盐选单章结构槽生产');
    expect(detail.slots.map((s) => s.id)).toEqual(['chapter', 'outline', 'title', 'scene_01']);
    expect(detail.slots.find((s) => s.id === 'scene_01')?.depth).toBe(1);
    expect(detail.slots.find((s) => s.id === 'scene_01')?.path).toEqual(['chapter', 'scene_01']);
    expect(detail.slots.find((s) => s.id === 'scene_01')?.blockedBy).toEqual(['outline']);
    expect(detail.stepper.map((s) => s.key)).toEqual([
      'input',
      'structure',
      'slots',
      'assembly',
      'done',
    ]);
    expect(detail.stepper.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    // UX §12.3：没有活动执行时展示「计划工作」
    expect(detail.plannedAssignment).toEqual({
      agentId: 'chapter_writer',
      agentName: '章节写作 Agent',
      skillId: 'outline-writing',
      skillVersion: '1.0.0',
      operation: 'fill_slot',
      targetSlotId: 'outline',
      blockedBy: [],
    });
  });

  it('presentation 直接来自 domain 的派生函数（D-07），DTO 层不自己判断', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
    startSlotAssignment(env, taskId, 'outline');

    const detail = env.taskService.getTaskDetail(taskId);
    // 附录 B.1 第 6 行
    expect(detail.presentation).toEqual({
      tone: 'run',
      state: '正在填充 Slot',
      detail: 'outline 章节骨架生成中',
    });
    // 附录 B.2 第 3 行：等待依赖必须点名在等谁
    expect(detail.slots.find((s) => s.id === 'scene_01')?.presentation).toEqual({
      tone: 'wait',
      state: '等待依赖',
      detail: '等待 outline 定稿',
    });
    // 附录 B.2 第 1 行：容器槽位不显示字数
    expect(detail.slots.find((s) => s.id === 'chapter')?.presentation.state).toBe('容器槽位');
    expect(detail.slots.find((s) => s.id === 'chapter')?.charCount).toBeNull();
  });

  it('D-14：queuePosition 由注入的队列视图给出，缺省为 null', () => {
    const detail = env.taskService.getTaskDetail(taskId);
    expect(detail.queuePosition).toBeNull();
    expect(detail.presentation.state).toBe('待启动');
  });

  it('产物内容不进任务详情，只在显式请求时返回', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
    for (const [slotId, content] of [
      ['outline', LONG_OUTLINE],
      ['title', '雨夜的对峙'],
      ['scene_01', SCENE_TEXT],
    ] as const) {
      const assignment = startSlotAssignment(env, taskId, slotId);
      env.completions.submitSlotContent({
        taskId,
        executionId: assignment.executionId,
        token: assignment.token,
        slotId,
        content,
        producer: { agentId: 'chapter_writer', skillId: 'scene-writing', skillVersion: '1.0.0' },
      });
    }
    env.assembly.assemble(taskId);

    expect(env.taskService.getTaskDetail(taskId).artifact?.content).toBeNull();
    expect(env.taskService.getArtifact(taskId, { includeContent: true })?.content).toContain(
      '雨夜的对峙',
    );
    expect(env.taskService.getTaskDetail(taskId).stepper.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('槽位详情单独带正文，列表不带', () => {
    const { executionId } = startStructureAssignment(env, taskId);
    env.structures.submit({ taskId, executionId, proposal: VALID_PROPOSAL });
    const assignment = startSlotAssignment(env, taskId, 'title');
    env.completions.submitSlotContent({
      taskId,
      executionId: assignment.executionId,
      token: assignment.token,
      slotId: 'title',
      content: '雨夜的对峙',
      producer: { agentId: 'chapter_writer', skillId: 'title-writing', skillVersion: '1.0.0' },
    });

    expect(env.taskService.getSlotDetail(taskId, 'title').content).toBe('雨夜的对峙');
    expect(env.taskService.listSlots(taskId).find((s) => s.id === 'title')?.charCount).toBe(5);
    expect(env.taskService.listSlots(taskId).find((s) => s.id === 'title')?.producer?.agentName).toBe(
      '章节写作 Agent',
    );
  });

  it('listTraces 的 nextAfter：取满一页才给游标', () => {
    startStructureAssignment(env, taskId);
    expect(env.taskService.listTraces(taskId, { limit: 1 })).toEqual({
      events: [expect.objectContaining({ sequence: 1 })],
      nextAfter: 1,
    });
    expect(env.taskService.listTraces(taskId, { limit: 50 }).nextAfter).toBeNull();
  });
});
