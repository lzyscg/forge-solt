/**
 * §5.5 事务边界清单 —— 八条边界，每条一个成功用例 + 一个回滚用例。
 *
 * 回滚用例的写法是统一的：先拍一张全库快照，再在事务中途抛错，
 * 然后断言全库与快照**逐字节相同**。只断言「主表没写进去」是不够的——
 * M2 要防的正是「主表回滚了但 trace 留下了」这种半截状态。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import type { UnitOfWork } from '@server/infrastructure/uow.ts';
import { createTestEnv, dumpAll, seedRunningAssignment, seedTask, type TestEnv } from '../fixtures/db.ts';

let env: TestEnv;

const fresh = (): TestEnv => {
  env = createTestEnv();
  return env;
};

afterEach(() => env?.close());

/** 事务中途抛出的哨兵错误：与业务错误区分开，免得测试把真 bug 当成预期回滚 */
class Boom extends Error {}

/** 跑一个注定回滚的事务，返回「全库在事务前后是否完全一致」 */
function expectRollback(e: TestEnv, body: (uow: UnitOfWork) => void): void {
  const before = dumpAll(e.db);
  expect(() =>
    e.uow.run((uow) => {
      body(uow);
      throw new Boom('中途失败');
    }),
  ).toThrow(Boom);
  expect(dumpAll(e.db)).toEqual(before);
}

describe('§5.5 边界 1：创建 Task', () => {
  it('快照 + Skill 快照 × n + 任务在一个事务内落库', () => {
    const e = fresh();
    e.uow.run((uow) => {
      uow.snapshots.insert({
        id: 'snap-1',
        taskId: 'task-1',
        templateId: 'tpl',
        templateVersion: '1.0.0',
        compiledJson: '{"a":1}',
        snapshotHash: 'h',
      });
      uow.snapshots.insertSkills([
        {
          taskId: 'task-1',
          skillId: 'scene-writing',
          skillVersion: '1.0.0',
          contentMarkdown: '# 场景写作',
          sectionIndexJson: '{"S1":0}',
          contentHash: 'c1',
        },
        {
          taskId: 'task-1',
          skillId: 'structure',
          skillVersion: '2.0.0',
          contentMarkdown: '# 结构',
          sectionIndexJson: '{}',
          contentHash: 'c2',
        },
      ]);
      uow.tasks.insert({
        id: 'task-1',
        name: '第一章',
        snapshotId: 'snap-1',
        input: { theme: '雨夜' },
        status: 'ready',
        phase: 'structure',
      });
    });

    const task = e.uow.repositories.tasks.getOrThrow('task-1');
    expect(task.input).toEqual({ theme: '雨夜' });
    expect(task.activeExecutionId).toBeNull();
    expect(e.uow.repositories.snapshots.listSkills('task-1')).toHaveLength(2);
    // AC-002 快照隔离的读路径：任务只认库里这份，磁盘上的 SKILL.md 之后怎么改都无关
    expect(e.uow.repositories.snapshots.getSkill('task-1', 'scene-writing')?.contentMarkdown).toBe(
      '# 场景写作',
    );
  });

  it('回滚：任务插入前抛错，快照与 Skill 快照都不留', () => {
    const e = fresh();
    expectRollback(e, (uow) => {
      uow.snapshots.insert({
        id: 'snap-1',
        taskId: 'task-1',
        templateId: 'tpl',
        templateVersion: '1.0.0',
        compiledJson: '{}',
        snapshotHash: 'h',
      });
      uow.snapshots.insertSkills([
        {
          taskId: 'task-1',
          skillId: 's',
          skillVersion: '1',
          contentMarkdown: '#',
          sectionIndexJson: '{}',
          contentHash: 'c',
        },
      ]);
    });
    expect(e.uow.repositories.snapshots.getByTask('task-1')).toBeNull();
  });
});

describe('§5.5 边界 2：创建 Assignment', () => {
  it('INSERT execution + tasks.active_execution_id + slot→running + trace × 2', () => {
    const e = fresh();
    seedTask(e);

    const events = e.uow.run((uow) => {
      uow.executions.insert({
        id: 'exec-1',
        taskId: 'task-1',
        operation: 'fill_slot',
        targetSlotId: 'scene_01',
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        tokenHash: 'th',
        contextJson: '{"x":1}',
        contextHash: 'ch',
        promptHash: 'ph',
        modelAlias: 'draft',
        provider: 'deepseek',
        model: 'deepseek-chat',
        attemptNumber: 1,
      });
      uow.executions.markRunning('exec-1');
      uow.tasks.update('task-1', { activeExecutionId: 'exec-1' });
      uow.slots.markRunning('task-1', 'scene_01');
      return [
        uow.traces.insert({
          taskId: 'task-1',
          executionId: 'exec-1',
          actor: 'system',
          kind: 'assignment_created',
          title: '已创建工作分配',
          summary: 'scene_01',
        }),
        uow.traces.insert({
          taskId: 'task-1',
          executionId: 'exec-1',
          actor: 'agent',
          kind: 'assignment_started',
          title: '开始工作',
          summary: '',
        }),
      ];
    });

    expect(e.uow.repositories.tasks.getOrThrow('task-1').activeExecutionId).toBe('exec-1');
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').status).toBe('running');
    expect(e.uow.repositories.executions.getOrThrow('exec-1').status).toBe('running');
    // sequence 由 TraceRepo 在同一事务内分配，必须是严格递增的 1、2
    expect(events.map((ev) => ev.sequence)).toEqual([1, 2]);
  });

  it('回滚：trace 写完后抛错，execution / task / slot / trace 全部不留', () => {
    const e = fresh();
    seedTask(e);
    expectRollback(e, (uow) => {
      uow.executions.insert({
        id: 'exec-1',
        taskId: 'task-1',
        operation: 'fill_slot',
        targetSlotId: 'scene_01',
        agentId: 'writer',
        skillId: 's',
        skillVersion: '1',
        tokenHash: 'th',
        contextJson: '{}',
        contextHash: 'ch',
        promptHash: 'ph',
        modelAlias: 'draft',
        provider: 'p',
        model: 'm',
        attemptNumber: 1,
      });
      uow.tasks.update('task-1', { activeExecutionId: 'exec-1' });
      uow.slots.markRunning('task-1', 'scene_01');
      uow.traces.insert({
        taskId: 'task-1',
        executionId: 'exec-1',
        actor: 'system',
        kind: 'assignment_created',
        title: 't',
        summary: '',
      });
    });
  });
});

describe('§5.5 边界 3：提交 Structure', () => {
  const structureSlots = (taskId: string) => [
    {
      taskId,
      slotId: 'scene_01',
      type: 'scene',
      parentId: 'chapter',
      sortOrder: 0,
      instruction: '开场',
      dependsOn: [],
      contentBearing: true,
      includeInArtifact: true,
    },
    // 子槽位排在父槽位**之前**：D-18 的延迟外键让插入顺序不再是约束，
    // 这条顺序是故意反着写的，用来证明那件事。
    {
      taskId,
      slotId: 'chapter',
      type: 'container',
      parentId: null,
      sortOrder: 0,
      instruction: '整章',
      dependsOn: [],
      contentBearing: false,
      includeInArtifact: true,
    },
  ];

  const seedStructurePhase = (e: TestEnv) => {
    e.uow.run((uow) => {
      uow.snapshots.insert({
        id: 'snap-1',
        taskId: 'task-1',
        templateId: 'tpl',
        templateVersion: '1',
        compiledJson: '{}',
        snapshotHash: 'h',
      });
      uow.tasks.insert({
        id: 'task-1',
        name: 'T',
        snapshotId: 'snap-1',
        input: {},
        status: 'running',
        phase: 'structure',
      });
      uow.executions.insert({
        id: 'exec-s',
        taskId: 'task-1',
        operation: 'create_structure',
        targetSlotId: null,
        agentId: 'architect',
        skillId: 'structure',
        skillVersion: '1',
        tokenHash: 'th',
        contextJson: '{}',
        contextHash: 'ch',
        promptHash: 'ph',
        modelAlias: 'draft',
        provider: 'p',
        model: 'm',
        attemptNumber: 1,
      });
      uow.executions.markRunning('exec-s');
      uow.tasks.update('task-1', { activeExecutionId: 'exec-s' });
    });
  };

  it('INSERT slots × n（子先于父）+ execution 收尾 + phase→slots + trace', () => {
    const e = fresh();
    seedStructurePhase(e);

    e.uow.run((uow) => {
      uow.slots.insertMany(structureSlots('task-1'));
      uow.executions.markSucceeded('exec-s');
      uow.tasks.completeStructurePhase({ taskId: 'task-1', executionId: 'exec-s' });
      uow.traces.insert({
        taskId: 'task-1',
        executionId: 'exec-s',
        actor: 'system',
        kind: 'slot_state_changed',
        title: '结构已创建',
        summary: '2 个槽位',
      });
    });

    const task = e.uow.repositories.tasks.getOrThrow('task-1');
    expect(task.phase).toBe('slots');
    expect(task.activeExecutionId).toBeNull();
    expect(e.uow.repositories.slots.listByTask('task-1')).toHaveLength(2);
  });

  it('迟到的结构提交被拒：活动执行已变更 → EXECUTION_STALE 且槽位一个都没插进去', () => {
    const e = fresh();
    seedStructurePhase(e);
    // 模拟 stop：清掉 activeExecutionId
    e.uow.run((uow) => uow.tasks.update('task-1', { activeExecutionId: null, status: 'stopped' }));

    const before = dumpAll(e.db);
    expect(() =>
      e.uow.run((uow) => {
        uow.slots.insertMany(structureSlots('task-1'));
        uow.tasks.completeStructurePhase({ taskId: 'task-1', executionId: 'exec-s' });
      }),
    ).toThrow(ForgeError);
    expect(dumpAll(e.db)).toEqual(before);
  });

  it('回滚：槽位插入后抛错，一棵结构树都不留', () => {
    const e = fresh();
    seedStructurePhase(e);
    expectRollback(e, (uow) => {
      uow.slots.insertMany(structureSlots('task-1'));
      uow.tasks.completeStructurePhase({ taskId: 'task-1', executionId: 'exec-s' });
    });
  });
});

describe('§5.5 边界 4：提交 Slot Content（D-10）', () => {
  const producer = {
    agentId: 'writer',
    skillId: 'scene-writing',
    skillVersion: '1.0.0',
    executionId: 'exec-1',
  };

  it('条件 UPDATE 命中 + execution 收尾 + task 清活动执行 + trace', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');

    e.uow.run((uow) => {
      uow.slots.commitContent({
        taskId: 'task-1',
        slotId: 'scene_01',
        content: '雨点打在铁皮上。',
        producer,
        tokenHash,
      });
      uow.executions.markSucceeded('exec-1', { inputTokens: 120, outputTokens: 340 });
      uow.tasks.update('task-1', { activeExecutionId: null });
      uow.traces.insert({
        taskId: 'task-1',
        executionId: 'exec-1',
        actor: 'system',
        kind: 'assignment_completed',
        title: '槽位完成',
        summary: 'scene_01',
      });
    });

    const slot = e.uow.repositories.slots.getOrThrow('task-1', 'scene_01');
    expect(slot.status).toBe('completed');
    expect(slot.contentText).toBe('雨点打在铁皮上。');
    // 四个 producer_* 列装配成一个对象：Domain 只承认「全有」或「全无」（AC-009）
    expect(slot.producer).toEqual(producer);
    expect(e.uow.repositories.executions.getOrThrow('exec-1').outputTokens).toBe(340);
  });

  it('回滚：提交成功但后续抛错，槽位内容与 trace 都不留', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    expectRollback(e, (uow) => {
      uow.slots.commitContent({
        taskId: 'task-1',
        slotId: 'scene_01',
        content: '正文',
        producer,
        tokenHash,
      });
      uow.executions.markSucceeded('exec-1');
      uow.traces.insert({
        taskId: 'task-1',
        executionId: 'exec-1',
        actor: 'system',
        kind: 'assignment_completed',
        title: 't',
        summary: '',
      });
    });
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').contentText).toBeNull();
  });

  it('用 A 槽位的 execution 提交 B 槽位：被 e.target_slot_id = slots.slot_id 挡下', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    // 把 scene_02 也搬到 running，排除「因为 B 不是 running 才失败」这个混淆因素
    e.uow.run((uow) => uow.slots.markRunning('task-1', 'scene_02'));

    expect(() =>
      e.uow.run((uow) =>
        uow.slots.commitContent({
          taskId: 'task-1',
          slotId: 'scene_02',
          content: '串槽了',
          producer,
          tokenHash,
        }),
      ),
    ).toThrow(/目标槽位是 scene_01/);
  });
});

describe('§5.5 边界 5：Stop', () => {
  it('execution→cancelled + slot running→pending + task→stopped + trace', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01');

    e.uow.run((uow) => {
      const task = uow.tasks.getOrThrow('task-1');
      const exec = task.activeExecutionId === null ? null : uow.executions.getOrThrow(task.activeExecutionId);
      if (exec !== null) {
        uow.executions.markCancelled(exec.id, 'USER_STOP');
        if (exec.targetSlotId !== null) uow.slots.resetToPending('task-1', exec.targetSlotId);
      }
      uow.tasks.update('task-1', { status: 'stopped', activeExecutionId: null });
      uow.traces.insert({
        taskId: 'task-1',
        executionId: 'exec-1',
        actor: 'system',
        kind: 'assignment_cancelled',
        title: '已停止',
        summary: '旧 Execution 已取消',
      });
    });

    expect(e.uow.repositories.executions.getOrThrow('exec-1').status).toBe('cancelled');
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').status).toBe('pending');
    const task = e.uow.repositories.tasks.getOrThrow('task-1');
    expect(task.status).toBe('stopped');
    expect(task.activeExecutionId).toBeNull();
  });

  it('Stop 不碰已完成的槽位（FR-LIFE-004：已完成 Slot 永不重新生成）', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    e.uow.run((uow) =>
      uow.slots.commitContent({
        taskId: 'task-1',
        slotId: 'scene_01',
        content: '已完成的正文',
        producer: { agentId: 'w', skillId: 's', skillVersion: '1', executionId: 'exec-1' },
        tokenHash,
      }),
    );

    // resetToPending 的 WHERE 里钉死了 status = 'running'
    expect(e.uow.run((uow) => uow.slots.resetToPending('task-1', 'scene_01'))).toBe(0);
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').contentText).toBe('已完成的正文');
  });

  it('回滚：stop 事务中途抛错，execution 仍是 running、槽位仍是 running', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01');
    expectRollback(e, (uow) => {
      uow.executions.markCancelled('exec-1', 'USER_STOP');
      uow.slots.resetToPending('task-1', 'scene_01');
      uow.tasks.update('task-1', { status: 'stopped', activeExecutionId: null });
    });
    expect(e.uow.repositories.executions.getOrThrow('exec-1').status).toBe('running');
  });
});

describe('§5.5 边界 6：完成 Artifact', () => {
  it('INSERT artifact + task(phase=done, status=completed, artifact_id) + trace', () => {
    const e = fresh();
    seedTask(e);

    e.uow.run((uow) => {
      uow.artifacts.insert({
        id: 'art-1',
        taskId: 'task-1',
        fileName: 'chapter-01.md',
        mediaType: 'text/markdown',
        content: '# 第一章\n\n雨夜。',
        checksum: 'sha256:x',
      });
      uow.tasks.update('task-1', { phase: 'done', status: 'completed', artifactId: 'art-1' });
      uow.traces.insert({
        taskId: 'task-1',
        executionId: null,
        actor: 'system',
        kind: 'artifact_created',
        title: '产物已生成',
        summary: 'chapter-01.md',
      });
    });

    const artifact = e.uow.repositories.artifacts.getByTaskOrThrow('task-1');
    expect(artifact.content).toBe('# 第一章\n\n雨夜。');
    // 中文正文的字节数与字符数不等，byteSize 必须按 UTF-8 字节算
    expect(artifact.byteSize).toBe(Buffer.byteLength('# 第一章\n\n雨夜。', 'utf8'));
    expect(artifact.byteSize).not.toBe('# 第一章\n\n雨夜。'.length);
    expect(e.uow.repositories.tasks.getOrThrow('task-1').status).toBe('completed');
  });

  it('回滚：产物写入后抛错，任务不会停在 completed 而产物却没有', () => {
    const e = fresh();
    seedTask(e);
    expectRollback(e, (uow) => {
      uow.artifacts.insert({
        id: 'art-1',
        taskId: 'task-1',
        fileName: 'a.md',
        mediaType: 'text/markdown',
        content: 'x',
        checksum: 'c',
      });
      uow.tasks.update('task-1', { phase: 'done', status: 'completed', artifactId: 'art-1' });
    });
    expect(e.uow.repositories.artifacts.getByTask('task-1')).toBeNull();
  });
});

describe('§5.5 边界 7：重置失败 Slot', () => {
  it('failed→pending 且清 error，completed 不动，task→running', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    e.uow.run((uow) => {
      uow.slots.commitContent({
        taskId: 'task-1',
        slotId: 'scene_01',
        content: '保留我',
        producer: { agentId: 'w', skillId: 's', skillVersion: '1', executionId: 'exec-1' },
        tokenHash,
      });
      uow.slots.markFailed('task-1', 'scene_02', 'PROVIDER_TIMEOUT', '120 秒超时');
      uow.tasks.update('task-1', { status: 'failed', errorCode: 'PROVIDER_TIMEOUT' });
    });

    const reset = e.uow.run((uow) => {
      const n = uow.slots.resetFailedToPending('task-1');
      uow.tasks.update('task-1', { status: 'running', errorCode: null, errorMessage: null });
      return n;
    });

    expect(reset).toBe(1);
    const scene02 = e.uow.repositories.slots.getOrThrow('task-1', 'scene_02');
    expect(scene02.status).toBe('pending');
    expect(scene02.errorCode).toBeNull();
    // 已完成的槽位内容原封不动——这是 AC-012 的核心承诺
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').contentText).toBe('保留我');
    expect(e.uow.repositories.tasks.getOrThrow('task-1').errorCode).toBeNull();
  });

  it('回滚：重置后抛错，失败槽位仍是 failed 且保留错误信息', () => {
    const e = fresh();
    seedTask(e);
    e.uow.run((uow) => uow.slots.markFailed('task-1', 'scene_02', 'PROVIDER_ERROR', '模型报错'));
    expectRollback(e, (uow) => {
      uow.slots.resetFailedToPending('task-1');
      uow.tasks.update('task-1', { status: 'running', errorCode: null });
    });
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_02').errorMessage).toBe('模型报错');
  });
});

describe('§5.5 边界 8：启动恢复（§8.6）', () => {
  const recover = (e: TestEnv, fail = false): void => {
    e.uow.run((uow) => {
      for (const task of uow.tasks.findByStatus('running')) {
        const exec =
          task.activeExecutionId === null ? null : uow.executions.get(task.activeExecutionId);
        if (exec !== null && (exec.status === 'running' || exec.status === 'created')) {
          uow.executions.markCancelled(exec.id, 'SERVICE_RESTART');
          if (exec.targetSlotId !== null) uow.slots.resetToPending(task.id, exec.targetSlotId);
        }
        uow.tasks.update(task.id, { status: 'stopped', activeExecutionId: null });
        uow.traces.insert({
          taskId: task.id,
          executionId: null,
          actor: 'system',
          kind: 'task_state_changed',
          title: '服务重启，任务已暂停',
          summary: '未完成的执行已取消，已完成的槽位内容保留。',
        });
      }
      if (fail) throw new Boom('恢复中途崩溃');
    });
  };

  it('running 任务全部转 stopped，孤儿 execution 被取消，running 槽位回 pending', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01');

    recover(e);

    expect(e.uow.repositories.tasks.getOrThrow('task-1').status).toBe('stopped');
    expect(e.uow.repositories.executions.getOrThrow('exec-1').status).toBe('cancelled');
    expect(e.uow.repositories.slots.getOrThrow('task-1', 'scene_01').status).toBe('pending');
    // 恢复完成后不该再有孤儿
    expect(e.uow.repositories.executions.findOrphans()).toEqual([]);
  });

  it('findOrphans 只认「execution 未终态但 task 已非 running」', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01');
    // task 已经不是 running 了，但 execution 还挂在 running —— 正是崩溃后的典型残留
    e.uow.run((uow) => uow.tasks.update('task-1', { status: 'stopped' }));
    expect(e.uow.repositories.executions.findOrphans().map((x) => x.id)).toEqual(['exec-1']);
  });

  it('回滚：恢复过程中途崩溃，不会留下「一半任务已恢复」的中间态', () => {
    const e = fresh();
    seedTask(e, 'task-1');
    seedTask(e, 'task-2');
    seedRunningAssignment(e, 'task-1', 'scene_01', 'exec-1');
    seedRunningAssignment(e, 'task-2', 'scene_01', 'exec-2');

    const before = dumpAll(e.db);
    expect(() => recover(e, true)).toThrow(Boom);
    expect(dumpAll(e.db)).toEqual(before);
    expect(e.uow.repositories.tasks.getOrThrow('task-1').status).toBe('running');
    expect(e.uow.repositories.tasks.getOrThrow('task-2').status).toBe('running');
  });
});
