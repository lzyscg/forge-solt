/**
 * M2 的硬不变量：库层约束、D-10 的迟到结果拒绝、trace 的 sequence 合同与脱敏、
 * 以及「事务回调必须同步」的编译期拒绝。
 *
 * 这些用例和 §5.5 的边界测试是两件事：边界测试证明「正常路径写对了」，
 * 这里证明「写错的时候会被挡住」。后者才是这些约束存在的理由。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { createUow, runInTransaction } from '@server/infrastructure/uow.ts';
import { createTestEnv, dumpAll, seedRunningAssignment, seedTask, type TestEnv } from '../fixtures/db.ts';

let env: TestEnv;
const fresh = (): TestEnv => (env = createTestEnv());
afterEach(() => env?.close());

// ---------------------------------------------------------------------------
// D-18：PRAGMA 与延迟外键
// ---------------------------------------------------------------------------

describe('D-18 完整性地基', () => {
  it('foreign_keys 必须是 ON —— 关掉它，延迟外键静默失效且不报错', () => {
    const e = fresh();
    expect(e.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('悬空的 active_execution_id 在 COMMIT 时被拒（延迟到提交才校验）', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      runInTransaction(e.db, (db) => {
        // 事务内可以先写成悬空——这正是 DEFERRABLE 的用途，
        // 否则 tasks ↔ executions 的环会让「先插哪个」变成死结。
        db.prepare("UPDATE tasks SET active_execution_id = 'never-existed' WHERE id = 'task-1'").run();
      }),
    ).toThrow(/FOREIGN KEY/i);
    expect(e.uow.repositories.tasks.getOrThrow('task-1').activeExecutionId).toBeNull();
  });

  it('结构提交时子槽位可以排在父槽位之前（复合外键 DEFERRED）', () => {
    const e = fresh();
    // seedTask 的插入顺序是父在前；这里反过来单独验一遍，
    // 顺带证明 MATCH SIMPLE：parent_id IS NULL 的根槽位天然豁免。
    expect(() =>
      e.uow.run((uow) => {
        uow.snapshots.insert({
          id: 's',
          taskId: 't',
          templateId: 'tpl',
          templateVersion: '1',
          compiledJson: '{}',
          snapshotHash: 'h',
        });
        uow.tasks.insert({
          id: 't',
          name: 'T',
          snapshotId: 's',
          input: {},
          status: 'running',
          phase: 'slots',
        });
        uow.slots.insertMany([
          {
            taskId: 't',
            slotId: 'child',
            type: 'scene',
            parentId: 'root',
            sortOrder: 0,
            instruction: 'x',
            dependsOn: [],
            contentBearing: true,
            includeInArtifact: true,
          },
          {
            taskId: 't',
            slotId: 'root',
            type: 'container',
            parentId: null,
            sortOrder: 0,
            instruction: 'y',
            dependsOn: [],
            contentBearing: false,
            includeInArtifact: true,
          },
        ]);
      }),
    ).not.toThrow();
  });

  it('引用不存在父槽位的子槽位仍然在 COMMIT 时被拒', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.uow.run((uow) =>
        uow.slots.insertMany([
          {
            taskId: 'task-1',
            slotId: 'orphan',
            type: 'scene',
            parentId: '不存在的父',
            sortOrder: 9,
            instruction: 'x',
            dependsOn: [],
            contentBearing: true,
            includeInArtifact: true,
          },
        ]),
      ),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
// §5.2 的两条 CHECK
// ---------------------------------------------------------------------------

describe('§5.2 CHECK 约束', () => {
  it('AC-009：completed 的内容槽缺 producer 时被库层拒绝', () => {
    const e = fresh();
    seedTask(e);
    // 绕过仓储直接构造非法 UPDATE——仓储自己不会这么写，但库层必须独立挡住。
    // 这条 CHECK 存在的意义就是「即使应用层有 bug，也不会留下一个有正文没作者的成品槽位」。
    expect(() =>
      e.db
        .prepare(
          `UPDATE slots SET status = 'completed', content_text = '有正文没作者'
            WHERE task_id = 'task-1' AND slot_id = 'scene_01'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('AC-009：producer 只补了三列（缺 producer_execution_id）同样被拒', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.db
        .prepare(
          `UPDATE slots SET status = 'completed', content_text = 'x',
             producer_agent_id = 'w', producer_skill_id = 's', producer_skill_version = '1'
            WHERE task_id = 'task-1' AND slot_id = 'scene_01'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('容器槽位不得有正文', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.db
        .prepare(
          "UPDATE slots SET content_text = '容器不该有正文' WHERE task_id = 'task-1' AND slot_id = 'chapter'",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('容器槽位可以是 completed（它没有 content_bearing，AC-009 那条不适用）', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.db
        .prepare("UPDATE slots SET status = 'completed' WHERE task_id = 'task-1' AND slot_id = 'chapter'")
        .run(),
    ).not.toThrow();
  });

  it('executions 的 attempt 号重复被 UNIQUE 拒绝（§8.7 的基准）', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01', 'exec-1');
    expect(() =>
      e.uow.run((uow) =>
        uow.executions.insert({
          id: 'exec-dup',
          taskId: 'task-1',
          operation: 'fill_slot',
          targetSlotId: 'scene_01',
          agentId: 'w',
          skillId: 's',
          skillVersion: '1',
          tokenHash: 'th',
          contextJson: '{}',
          contextHash: 'c',
          promptHash: 'p',
          modelAlias: 'a',
          provider: 'p',
          model: 'm',
          attemptNumber: 1, // 与 exec-1 相同
        }),
      ),
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

// ---------------------------------------------------------------------------
// D-10：迟到结果
// ---------------------------------------------------------------------------

describe('D-10 迟到结果被拒', () => {
  /** 逐字抄自文档 §1 D-10 的条件 UPDATE。用它直接断言 changes 的取值。 */
  const D10_SQL = `
    UPDATE slots SET
      content_text = ?, status = 'completed',
      producer_agent_id = ?, producer_skill_id = ?,
      producer_skill_version = ?, producer_execution_id = ?,
      updated_at = ?
    WHERE task_id = ? AND slot_id = ? AND status = 'running'
      AND EXISTS (
        SELECT 1 FROM executions e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.id = ? AND e.token_hash = ?
          AND e.status = 'running'
          AND e.task_id = slots.task_id
          AND e.target_slot_id = slots.slot_id
          AND t.active_execution_id = e.id
          AND t.status = 'running'
      )`;

  const runD10 = (e: TestEnv, tokenHash: string): number =>
    runInTransaction(
      e.db,
      (db) =>
        db
          .prepare(D10_SQL)
          .run(
            '迟到的正文',
            'writer',
            'scene-writing',
            '1.0.0',
            'exec-1',
            '2026-01-01T00:00:00.000Z',
            'task-1',
            'scene_01',
            'exec-1',
            tokenHash,
          ).changes,
    );

  it('stop 之后再提交：changes === 0，且没有任何状态被改动', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');

    // Stop（§5.5 边界 5）
    e.uow.run((uow) => {
      uow.executions.markCancelled('exec-1', 'USER_STOP');
      uow.slots.resetToPending('task-1', 'scene_01');
      uow.tasks.update('task-1', { status: 'stopped', activeExecutionId: null });
    });

    const before = dumpAll(e.db);

    // ① 条件 UPDATE 本身：一行都不该命中
    expect(runD10(e, tokenHash)).toBe(0);

    // ② 走仓储：changes !== 1 → EXECUTION_STALE，并给出根因
    let caught: unknown;
    try {
      e.uow.run((uow) =>
        uow.slots.commitContent({
          taskId: 'task-1',
          slotId: 'scene_01',
          content: '迟到的正文',
          producer: {
            agentId: 'writer',
            skillId: 'scene-writing',
            skillVersion: '1.0.0',
            executionId: 'exec-1',
          },
          tokenHash,
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForgeError);
    expect((caught as ForgeError).code).toBe('EXECUTION_STALE');
    // §8.4 的可观测性要求：说清是哪一条前提不满足
    expect((caught as ForgeError).message).toMatch(/Execution 已不是 running/);

    // ③ 全库逐字节未变
    expect(dumpAll(e.db)).toEqual(before);
  });

  it('跨任务提交被拒：任务 A 的 execution 不能提交任务 B 里同名的槽位（D-19）', () => {
    // slot_id 只在任务内唯一（slots 主键是复合键 (task_id, slot_id)）。
    // 原 D-10 的 SQL 只对齐 e.target_slot_id = slots.slot_id，少了 e.task_id = slots.task_id，
    // 于是调用方一旦把 taskId 传错，A 上合法在跑的 execution 就能写进 B 的同名槽位。
    // 这条语句存在的全部意义正是「不依赖调用方传对参数」，所以这个缺口必须堵。
    const e = fresh();
    seedTask(e, 'task-1');
    seedTask(e, 'task-2');
    // 两个任务都有 scene_01；只有 task-1 上有在跑的 Assignment
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    e.uow.run((uow) => uow.slots.markRunning('task-2', 'scene_01'));

    const before = dumpAll(e.db);

    expect(() =>
      e.uow.run((uow) =>
        uow.slots.commitContent({
          taskId: 'task-2', // ← 传错的那个参数
          slotId: 'scene_01',
          content: '写进了别的任务',
          producer: {
            agentId: 'writer',
            skillId: 'scene-writing',
            skillVersion: '1.0.0',
            executionId: 'exec-1',
          },
          tokenHash,
        }),
      ),
    ).toThrow(ForgeError);

    expect(dumpAll(e.db)).toEqual(before);
  });

  it('token 不匹配：changes === 0，原因指向 token', () => {
    const e = fresh();
    seedTask(e);
    seedRunningAssignment(e, 'task-1', 'scene_01');

    expect(runD10(e, '伪造的-token-hash')).toBe(0);
    expect(() =>
      e.uow.run((uow) =>
        uow.slots.commitContent({
          taskId: 'task-1',
          slotId: 'scene_01',
          content: 'x',
          producer: { agentId: 'w', skillId: 's', skillVersion: '1', executionId: 'exec-1' },
          tokenHash: '伪造的-token-hash',
        }),
      ),
    ).toThrow(/Token 不匹配/);
  });

  it('新鲜的提交：同一条 SQL 返回 changes === 1', () => {
    const e = fresh();
    seedTask(e);
    const { tokenHash } = seedRunningAssignment(e, 'task-1', 'scene_01');
    expect(runD10(e, tokenHash)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// trace_events.sequence 合同 + 脱敏
// ---------------------------------------------------------------------------

describe('TraceRepo', () => {
  it('sequence 在事务内按任务分配，从 1 开始严格递增', () => {
    const e = fresh();
    seedTask(e, 'task-1');
    seedTask(e, 'task-2');

    const seqs = e.uow.run((uow) =>
      ['a', 'b', 'c'].map(
        (t) =>
          uow.traces.insert({
            taskId: 'task-1',
            executionId: null,
            actor: 'system',
            kind: 'work_progress',
            title: t,
            summary: '',
          }).sequence,
      ),
    );
    expect(seqs).toEqual([1, 2, 3]);

    // 序号按 task_id 分区，不是全局的
    const other = e.uow.run((uow) =>
      uow.traces.insert({
        taskId: 'task-2',
        executionId: null,
        actor: 'system',
        kind: 'work_progress',
        title: 'x',
        summary: '',
      }),
    );
    expect(other.sequence).toBe(1);
    expect(e.uow.repositories.traces.maxSequence('task-1')).toBe(3);
  });

  it('UNIQUE (task_id, sequence) 是兜底：手工重号立刻炸，而不是静默覆盖', () => {
    const e = fresh();
    seedTask(e);
    e.uow.run((uow) =>
      uow.traces.insert({
        taskId: 'task-1',
        executionId: null,
        actor: 'system',
        kind: 'work_progress',
        title: 'a',
        summary: '',
      }),
    );
    expect(() =>
      e.db
        .prepare(
          `INSERT INTO trace_events (id, task_id, execution_id, sequence, actor, kind, title, summary, payload_json, created_at)
           VALUES ('dup', 'task-1', NULL, 1, 'system', 'work_progress', 'b', '', NULL, '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('回滚的事务不占用序号，后续事件仍从 1 开始', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.uow.run((uow) => {
        uow.traces.insert({
          taskId: 'task-1',
          executionId: null,
          actor: 'system',
          kind: 'work_progress',
          title: '不会存在的事件',
          summary: '',
        });
        throw new Error('回滚');
      }),
    ).toThrow();
    // 这正是「trace 写在事务内」的目的：事务没成，UI 就不该看见这条事件（§5.5）
    expect(e.uow.repositories.traces.listByTask('task-1')).toEqual([]);
    const next = e.uow.run((uow) =>
      uow.traces.insert({
        taskId: 'task-1',
        executionId: null,
        actor: 'system',
        kind: 'work_progress',
        title: '真实事件',
        summary: '',
      }),
    );
    expect(next.sequence).toBe(1);
  });

  it('payload 携带凭据时在写入前被拒（REQ §13 递归黑名单）', () => {
    const e = fresh();
    seedTask(e);
    expect(() =>
      e.uow.run((uow) =>
        uow.traces.insert({
          taskId: 'task-1',
          executionId: null,
          actor: 'tool',
          kind: 'tool_call_completed',
          title: '调用完成',
          summary: '',
          // 事故通常藏在嵌套的 provider 原始响应里，所以黑名单是递归的
          payload: { response: { headers: { authorization: 'Bearer sk-live-xxx' } } },
        }),
      ),
    ).toThrow();
    expect(e.uow.repositories.traces.listByTask('task-1')).toEqual([]);
    // 库里连一条包含密钥的记录都不该有
    expect(JSON.stringify(dumpAll(e.db))).not.toContain('sk-live-xxx');
  });

  it('after / limit 分页可用于 SSE 断线补发（§9.4）', () => {
    const e = fresh();
    seedTask(e);
    e.uow.run((uow) => {
      for (let i = 0; i < 5; i++) {
        uow.traces.insert({
          taskId: 'task-1',
          executionId: null,
          actor: 'system',
          kind: 'work_progress',
          title: `第 ${i} 条`,
          summary: '',
        });
      }
    });
    expect(e.uow.repositories.traces.listByTask('task-1', { after: 2 }).map((x) => x.sequence)).toEqual([
      3, 4, 5,
    ]);
    expect(e.uow.repositories.traces.listByTask('task-1', { after: 0, limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §5.4 / D-10：事务回调必须同步（编译期）
// ---------------------------------------------------------------------------

describe('事务回调必须同步', () => {
  it('run(async uow => ...) 编译不过', () => {
    const e = fresh();

    // 这是 M2 的明文完成判据，也是 better-sqlite3 被选中的全部理由（D-15）：
    // async 回调会在第一个 await 点交还事件循环，而 better-sqlite3 的事务不跨微任务，
    // 事务会先于回调完成而提交——D-10 压在 WHERE 里的原子性保证随之失效。
    // NotPromise<T> 把这条约定从 code review 清单提升成编译错误。
    //
    // 真正的断言是**下面那行 @ts-expect-error 本身**：`npx tsc --noEmit` 时，
    // 若 `run(async ...)` 其实合法，TS 会因为「未使用的 @ts-expect-error」而报错。
    // 运行时的 toThrow 是第二道网（better-sqlite3 自己也拒绝返回 Promise 的回调），
    // 但它挡不住「事务已经提交了才发现是 async」——所以编译期那道才是主防线。
    expect(() =>
      // @ts-expect-error 事务回调返回 Promise 时 NotPromise<T> 解析为 never
      e.uow.run(async (uow) => {
        await Promise.resolve();
        return uow.tasks.get('task-1');
      }),
    ).toThrow(/cannot return a promise/i);

    // 同步回调正常通过
    expect(e.uow.run((uow) => uow.tasks.get('task-1'))).toBeNull();
  });

  it('runInTransaction 同样拒绝异步回调', () => {
    const e = fresh();
    expect(() =>
      // @ts-expect-error 裸事务入口用的是同一个 NotPromise 约束
      runInTransaction(e.db, async () => Promise.resolve(1)),
    ).toThrow(/cannot return a promise/i);
    expect(runInTransaction(e.db, (db) => db.pragma('foreign_keys', { simple: true }))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 列表排序：同刻并列必须有确定的破平
// ---------------------------------------------------------------------------

describe('TaskRepo 的列表排序', () => {
  /** 用一个**不走动**的时钟建三个任务，制造 updated_at 完全相同的并列 */
  function seedTiedTasks(e: TestEnv, ids: readonly string[]): void {
    const frozen = createUow(e.db, () => '2026-01-01T00:00:00.000Z');
    frozen.run((uow) => {
      for (const id of ids) {
        uow.snapshots.insert({
          id: `snap-${id}`,
          taskId: id,
          templateId: 'tpl-chapter',
          templateVersion: '1.0.0',
          compiledJson: '{"slotTypes":[]}',
          snapshotHash: 'hash-snap',
        });
        uow.tasks.insert({
          id,
          name: id,
          snapshotId: `snap-${id}`,
          input: {},
          status: 'ready',
          phase: 'structure',
        });
      }
    });
  }

  it('updated_at 相同时按 id 倒序，而不是交给 SQLite 随便排', () => {
    // `updated_at` 只到毫秒，连着建两个任务完全可能落在同一毫秒里。
    // 不破平的话，并列行的先后取决于查询计划——今天是 rowid 序，
    // 换成走 idx_tasks_status_upd 就可能是另一个序。
    // 表现是任务列表在两次刷新之间自己跳行，而数据一个字都没变。
    const e = fresh();
    // 刻意让插入序（b, a, c）与期望的输出序（c, b, a）都不一样，
    // 这样「照抄插入序」和「照抄 id 升序」两种错误实现都会被这条抓住
    seedTiedTasks(e, ['task-b', 'task-a', 'task-c']);

    expect(e.uow.repositories.tasks.listRecent(10).map((t) => t.id)).toEqual([
      'task-c',
      'task-b',
      'task-a',
    ]);
    expect(e.uow.repositories.tasks.listByTemplate('tpl-chapter', 10).map((t) => t.id)).toEqual([
      'task-c',
      'task-b',
      'task-a',
    ]);
  });

  it('listByTemplate 取的是 tasks 的列，不是 JOIN 过来的快照列', () => {
    // `SELECT *` 在 JOIN 之后会把 task_snapshots 的 id / created_at 也带出来，
    // 而它们与 tasks 同名——toDomain 读到的会是 `snap-task-a` 而不是 `task-a`。
    // 这类错不会抛异常，只会让每一行的 ID 都是错的。
    const e = fresh();
    seedTiedTasks(e, ['task-a']);
    const [task] = e.uow.repositories.tasks.listByTemplate('tpl-chapter', 10);
    expect(task?.id).toBe('task-a');
    expect(task?.snapshotId).toBe('snap-task-a');
  });
});
