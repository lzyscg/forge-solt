/**
 * Repository 测试的共用夹具。
 *
 * §11.1 明写 Repository 测试用 `new Database(':memory:')`：内存库让每个用例拿到
 * 一个绝对干净的 schema，且不会在 ./data 下留下会被下一次运行读到的残留文件——
 * 「上一次测试留下的行」是这类测试最常见的假绿。
 *
 * 时钟是注入的固定序列而不是 `Date.now()`：时间戳因此可以直接断言，
 * 也不会出现「同一毫秒内两次写入的 updated_at 相同，排序断言随机失败」。
 */

import Database from 'better-sqlite3';
import { applyPragmas, type ForgeDb } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { createUow } from '@server/infrastructure/uow.ts';
import type { UnitOfWork } from '@server/infrastructure/uow.ts';
import type { UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { Clock } from '@server/infrastructure/database/repositories/index.ts';

export interface TestEnv {
  db: ForgeDb;
  uow: UnitOfWorkHandle<UnitOfWork>;
  /** 每次调用推进一秒，返回的 ISO 串可直接断言 */
  clock: Clock;
  close(): void;
}

export function createTestEnv(): TestEnv {
  const db = new Database(':memory:') as ForgeDb;
  // 走产品代码的同一个 PRAGMA 函数，而不是在测试里另抄一遍：
  // 抄一遍就意味着测试可以在 foreign_keys 与生产不一致的情况下全绿（D-18 的静默失效）。
  applyPragmas(db);
  runMigrations(db);

  let tick = 0;
  const clock: Clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();

  return { db, uow: createUow(db, clock), clock, close: () => db.close() };
}

/** 一份最小但合法的「已创建任务」：快照 + 任务 + 三个槽位（1 容器 + 2 内容）。 */
export function seedTask(env: TestEnv, taskId = 'task-1'): void {
  env.uow.run((uow) => {
    uow.snapshots.insert({
      id: `snap-${taskId}`,
      taskId,
      templateId: 'tpl-chapter',
      templateVersion: '1.0.0',
      compiledJson: '{"slotTypes":[]}',
      snapshotHash: 'hash-snap',
    });
    uow.tasks.insert({
      id: taskId,
      name: '第一章',
      snapshotId: `snap-${taskId}`,
      input: { theme: '雨夜' },
      status: 'running',
      phase: 'slots',
    });
    uow.slots.insertMany([
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
      {
        taskId,
        slotId: 'scene_02',
        type: 'scene',
        parentId: 'chapter',
        sortOrder: 1,
        instruction: '收束',
        dependsOn: ['scene_01'],
        contentBearing: true,
        includeInArtifact: true,
      },
    ]);
  });
}

export interface AssignmentHandles {
  executionId: string;
  tokenHash: string;
}

/** 为某个槽位建一个「已在跑」的 Assignment（execution running + slot running + task 指向它）。 */
export function seedRunningAssignment(
  env: TestEnv,
  taskId: string,
  slotId: string,
  executionId = 'exec-1',
): AssignmentHandles {
  const tokenHash = `hash-of-${executionId}`;
  env.uow.run((uow) => {
    uow.executions.insert({
      id: executionId,
      taskId,
      operation: 'fill_slot',
      targetSlotId: slotId,
      agentId: 'writer',
      skillId: 'scene-writing',
      skillVersion: '1.0.0',
      tokenHash,
      contextJson: '{"slotId":"' + slotId + '"}',
      contextHash: 'ctx-hash',
      promptHash: 'prompt-hash',
      modelAlias: 'draft',
      provider: 'deepseek',
      model: 'deepseek-chat',
      attemptNumber: 1,
    });
    uow.executions.markRunning(executionId);
    uow.tasks.update(taskId, { activeExecutionId: executionId, status: 'running' });
    uow.slots.markRunning(taskId, slotId);
  });
  return { executionId, tokenHash };
}

/** 全库快照，用于「回滚之后一行都没变」这类断言。 */
export const TABLES = [
  'task_snapshots',
  'task_skill_snapshots',
  'tasks',
  'slots',
  'executions',
  'trace_events',
  'artifacts',
] as const;

export function dumpAll(db: ForgeDb): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    out[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return out;
}
