/**
 * R0 审核返修数据模型的集成测试。
 *
 * 覆盖范围（§2.5 完成判据）：
 * 1. 全新库跑完迁移后的 schema 完整性（slot_reviews 存在、新列存在、新枚举值允许、
 *    foreign_key_check 无输出、5 个索引都在）。
 * 2. 带数据的重建：先只跑 001/002 插入真实行，再跑 003，断言原有行逐字保留、
 *    revision_round 全为 0、foreign_key_check 无输出、新 UNIQUE 生效、
 *    tasks.active_execution_id 逐位恢复（混合一个非 NULL 与一个 NULL）。
 * 3. 新 UNIQUE 允许跨 operation 并存，同 operation 同 attempt 重复仍被拒。
 * 4. commitContentForReview 把 running 槽位置为 reviewing 并写内容与 producer。
 * 5. markForRevision：reviewing→pending、revision_round+1、内容与 producer 原样保留；
 *    对非 reviewing 槽位返回 0；resetToPending 对 reviewing 也返回 0。
 * 6. clearReview：exhausted=false 保持 0；exhausted=true 置 1。
 * 7. slot_reviews 的 insert / listByRound 往返；verdict CHECK 拒非法值。
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPragmas, type ForgeDb } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { buildRepositories } from '@server/infrastructure/database/repositories/index.ts';
import type { Clock } from '@server/infrastructure/database/repositories/index.ts';
import { ForgeError } from '@shared/errors.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 开一个内存库并跑完全部迁移。 */
function freshMigratedDb(): ForgeDb {
  const db = new Database(':memory:') as ForgeDb;
  applyPragmas(db);
  runMigrations(db);
  cleanups.push(() => db.close());
  return db;
}

const fixedClock: Clock = (() => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
})();

// ---------------------------------------------------------------------------
// 1. 全新库 schema 完整性
// ---------------------------------------------------------------------------

describe('R0：全新库迁移后 schema 完整', () => {
  it('slot_reviews 表存在且有全部列', () => {
    const db = freshMigratedDb();
    const cols = db.prepare('PRAGMA table_info(slot_reviews)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'task_id',
        'slot_id',
        'round',
        'criterion_id',
        'execution_id',
        'verdict',
        'findings_json',
        'created_at',
      ]),
    );
  });

  it('slots 有 revision_round 与 review_exhausted 列', () => {
    const db = freshMigratedDb();
    const cols = db.prepare('PRAGMA table_info(slots)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('revision_round');
    expect(names).toContain('review_exhausted');
  });

  it("slots.status 允许 'reviewing'", () => {
    const db = freshMigratedDb();
    // task_snapshots ↔ tasks 构成环，DEFERRABLE INITIALLY DEFERRED 只在事务内生效
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'fill_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'succeeded', '2026-01-01T00:00:00.000Z');
        INSERT INTO slots (task_id, slot_id, type, sort_order, instruction, content_bearing, include_in_artifact, status, revision_round, review_exhausted, content_text, producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id, error_code, error_message, created_at, updated_at)
          VALUES ('task-1', 's1', 'scene', 0, '写', 1, 1, 'reviewing', 0, 0, '正文', 'a', 'sk', '1', 'e1', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
    })();
    const row = db.prepare("SELECT status FROM slots WHERE task_id = 'task-1' AND slot_id = 's1'").get() as {
      status: string;
    };
    expect(row.status).toBe('reviewing');
  });

  it("executions.operation 允许 'review_slot'", () => {
    const db = freshMigratedDb();
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
      `);
    })();
    const row = db.prepare("SELECT operation FROM executions WHERE id = 'e1'").get() as {
      operation: string;
    };
    expect(row.operation).toBe('review_slot');
  });

  it('PRAGMA foreign_key_check 无输出', () => {
    const db = freshMigratedDb();
    const rows = db.prepare('PRAGMA foreign_key_check').all();
    expect(rows).toEqual([]);
  });

  it('5 个索引都在（查 sqlite_master）', () => {
    const db = freshMigratedDb();
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_slots_task_status',
        'idx_slots_task_parent',
        'idx_exec_task_created',
        'idx_exec_target',
        'idx_executions_status',
        'idx_slot_reviews_slot',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 带数据的重建（关键：不能只测空表）
// ---------------------------------------------------------------------------

describe('R0：带数据的重建', () => {
  /**
   * 用一个临时目录只放 001/002，跑迁移后插入真实行（含 completed 内容槽、
   * 有 producer 的 execution、父子槽位），再用默认 migrations/ 目录跑一次让它只应用 003。
   */
  function buildDbWith001002(): { db: ForgeDb; dir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-r0-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // 只拷 001 和 002 进临时目录
    copyFileSync(path.resolve('migrations/001_initial.sql'), path.join(dir, '001_initial.sql'));
    copyFileSync(path.resolve('migrations/002_indexes.sql'), path.join(dir, '002_indexes.sql'));

    const db = new Database(':memory:') as ForgeDb;
    applyPragmas(db);
    // 用临时目录跑，只应用 001 + 002
    runMigrations(db, dir);
    return { db, dir };
  }

  it('原有行逐字保留、revision_round 全为 0、foreign_key_check 无输出、active_execution_id 逐位恢复', () => {
    const { db } = buildDbWith001002();
    cleanups.push(() => db.close());

    // 插入真实数据：task + 快照 + 父子槽位 + 有 producer 的 completed 内容槽 + execution。
    // 再补一个 active_execution_id 为 NULL 的 task-2，迁移的置 NULL→恢复逻辑必须逐位还原两种情况。
    // task_snapshots ↔ tasks 构成环，必须在一个事务内
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1.0.0', '{}', 'hash', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, active_execution_id, artifact_id, error_code, error_message, created_at, updated_at)
          VALUES ('task-1', '测试章', 'snap-1', '{}', 'running', 'slots', 'exec-1', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-2', 'task-2', 'tpl', '1.0.0', '{}', 'hash2', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, active_execution_id, artifact_id, error_code, error_message, created_at, updated_at)
          VALUES ('task-2', '停止的任务', 'snap-2', '{}', 'stopped', 'slots', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, input_tokens, output_tokens, error_code, error_message, started_at, finished_at, created_at)
          VALUES ('exec-1', 'task-1', 'fill_slot', 'scene_01', 'writer', 'scene-skill', '1.0.0', 'tok', '{}', 'ctx', 'prm', 'draft', 'deepseek', 'deepseek-chat', 1, 'succeeded', 100, 200, NULL, NULL, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO slots (task_id, slot_id, type, parent_id, sort_order, instruction, depends_on_json, content_bearing, include_in_artifact, status, content_text, producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id, error_code, error_message, created_at, updated_at)
          VALUES
            ('task-1', 'chapter', 'container', NULL, 0, '整章', '[]', 0, 1, 'completed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ('task-1', 'scene_01', 'scene', 'chapter', 0, '第一场', '[]', 1, 1, 'completed', '第一场正文', 'writer', 'scene-skill', '1.0.0', 'exec-1', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
      `);
    })();

    // 迁移前的原始数据快照，用于迁移后逐字比对
    const beforeSlots = db.prepare('SELECT * FROM slots ORDER BY slot_id').all();
    const beforeExecs = db.prepare('SELECT * FROM executions ORDER BY id').all();
    const beforeTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();

    // 现在用默认 migrations/ 目录跑——001/002 已应用且 checksum 一致，只应用 003
    runMigrations(db); // 默认目录 ./migrations

    // 原有行逐字保留（不含新列）
    const afterSlots = db.prepare('SELECT * FROM slots ORDER BY slot_id').all() as Record<string, unknown>[];
    const afterExecs = db.prepare('SELECT * FROM executions ORDER BY id').all() as Record<string, unknown>[];
    const afterTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, unknown>[];

    // 验证 executions 完全一致（无新增列）
    expect(afterExecs).toEqual(beforeExecs);

    // tasks 逐字一致——迁移恰好把 active_execution_id 置 NULL 再恢复，
    // foreign_key_check 兜不住这种漂移（NULL 也合法），必须逐位断言
    expect(afterTasks).toEqual(beforeTasks);
    const t1 = afterTasks.find((t) => t.id === 'task-1');
    const t2 = afterTasks.find((t) => t.id === 'task-2');
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1?.active_execution_id).toBe('exec-1'); // 非 NULL 的恢复原值
    expect(t2?.active_execution_id).toBeNull(); // 原本就是 NULL 的保持 NULL

    // slots 的旧列完全一致
    for (let i = 0; i < beforeSlots.length; i++) {
      const before = beforeSlots[i] as Record<string, unknown>;
      const after = afterSlots[i];
      for (const key of Object.keys(before)) {
        expect(after![key]).toEqual(before[key]);
      }
    }

    // revision_round 全为 0
    const rounds = afterSlots.map((r) => r.revision_round);
    expect(rounds).toEqual([0, 0]);

    // review_exhausted 全为 0
    const exhausted = afterSlots.map((r) => r.review_exhausted);
    expect(exhausted).toEqual([0, 0]);

    // foreign_key_check 无输出
    const fkRows = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkRows).toEqual([]);
  });

  it('新 UNIQUE 生效：同 operation 同 attempt 重复被拒', () => {
    const { db } = buildDbWith001002();
    cleanups.push(() => db.close());
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
    })();
    runMigrations(db);

    // 先插一条 fill_slot attempt 1
    db.exec(`
      INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
        VALUES ('e1', 'task-1', 'fill_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
    `);
    // 再插同 operation 同 attempt 1 → 拒
    expect(() =>
      db
        .prepare(
          `INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
            VALUES ('e2', 'task-1', 'fill_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

// ---------------------------------------------------------------------------
// 3. 新 UNIQUE 允许跨 operation 并存
// ---------------------------------------------------------------------------

describe('R0：新 UNIQUE 允许跨 operation 并存', () => {
  it('同一槽位的 fill_slot attempt 1 与 review_slot attempt 1 可并存', () => {
    const db = freshMigratedDb();
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'fill_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
      `);
    })();
    // review_slot attempt 1 on same slot → 可以并存
    expect(() =>
      db
        .prepare(
          `INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
            VALUES ('e2', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();

    // 两条都在
    const rows = db
      .prepare("SELECT operation FROM executions WHERE task_id = 'task-1' AND target_slot_id = 's1' ORDER BY operation")
      .all() as Array<{ operation: string }>;
    expect(rows.map((r) => r.operation)).toEqual(['fill_slot', 'review_slot']);
  });

  it('同 operation 同 attempt 重复仍被拒', () => {
    const db = freshMigratedDb();
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
      `);
    })();
    expect(() =>
      db
        .prepare(
          `INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
            VALUES ('e2', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

// ---------------------------------------------------------------------------
// 辅助：为仓储测试准备 task + slot + running execution
// ---------------------------------------------------------------------------

function seedTaskAndRunningSlot(db: ForgeDb, slotId = 'scene_01'): { executionId: string; tokenHash: string } {
  const repos = buildRepositories(db, fixedClock);
  const executionId = 'exec-1';
  const tokenHash = 'hash-of-exec-1';
  // 快照 + task + 槽位 + execution，全部在一个事务里（task_snapshots ↔ tasks 构成环）
  db.transaction(() => {
    repos.snapshots.insert({
      id: 'snap-1',
      taskId: 'task-1',
      templateId: 'tpl',
      templateVersion: '1.0.0',
      compiledJson: '{}',
      snapshotHash: 'h',
    });
    repos.tasks.insert({
      id: 'task-1',
      name: 'T',
      snapshotId: 'snap-1',
      input: {},
      status: 'running',
      phase: 'slots',
    });
    repos.slots.insertMany([
      {
        taskId: 'task-1',
        slotId,
        type: 'scene',
        parentId: null,
        sortOrder: 0,
        instruction: '写场景',
        dependsOn: [],
        contentBearing: true,
        includeInArtifact: true,
      },
    ]);
    repos.executions.insert({
      id: executionId,
      taskId: 'task-1',
      operation: 'fill_slot',
      targetSlotId: slotId,
      agentId: 'writer',
      skillId: 'scene-writing',
      skillVersion: '1.0.0',
      tokenHash,
      contextJson: '{}',
      contextHash: 'ch',
      promptHash: 'ph',
      modelAlias: 'draft',
      provider: 'deepseek',
      model: 'deepseek-chat',
      attemptNumber: 1,
    });
    repos.executions.markRunning(executionId);
    repos.tasks.update('task-1', { activeExecutionId: executionId, status: 'running' });
    repos.slots.markRunning('task-1', slotId);
  })();
  return { executionId, tokenHash };
}

// ---------------------------------------------------------------------------
// 4. commitContentForReview
// ---------------------------------------------------------------------------

describe('R0：commitContentForReview', () => {
  it('把 running 槽位置为 reviewing 并写内容与 producer', () => {
    const db = freshMigratedDb();
    const { executionId, tokenHash } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    repos.slots.commitContentForReview({
      taskId: 'task-1',
      slotId: 'scene_01',
      content: '第一场正文',
      producer: {
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        executionId,
      },
      tokenHash,
    });

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('reviewing');
    expect(slot.contentText).toBe('第一场正文');
    expect(slot.producer).not.toBeNull();
    expect(slot.producer!.executionId).toBe(executionId);
    expect(slot.revisionRound).toBe(0);
    expect(slot.reviewExhausted).toBe(false);
  });

  it('迟到结果（token 不匹配）被拒，抛 EXECUTION_STALE', () => {
    const db = freshMigratedDb();
    const { executionId } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    let thrown: unknown;
    try {
      repos.slots.commitContentForReview({
        taskId: 'task-1',
        slotId: 'scene_01',
        content: '迟到',
        producer: {
          agentId: 'writer',
          skillId: 'scene-writing',
          skillVersion: '1.0.0',
          executionId,
        },
        tokenHash: 'wrong-token',
      });
      expect.unreachable('应当抛错');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForgeError);
    expect((thrown as ForgeError).code).toBe('EXECUTION_STALE');

    // 槽位仍在 running，内容没写
    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('running');
    expect(slot.contentText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. markForRevision
// ---------------------------------------------------------------------------

describe('R0：markForRevision', () => {
  it('reviewing→pending、revision_round+1、内容与 producer 原样保留', () => {
    const db = freshMigratedDb();
    const { executionId, tokenHash } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    // 先提交到 reviewing
    repos.slots.commitContentForReview({
      taskId: 'task-1',
      slotId: 'scene_01',
      content: '第一稿正文',
      producer: {
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        executionId,
      },
      tokenHash,
    });

    // markForRevision
    const changes = repos.slots.markForRevision('task-1', 'scene_01');
    expect(changes).toBe(1);

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('pending');
    expect(slot.revisionRound).toBe(1);
    // 内容与 producer 原样保留
    expect(slot.contentText).toBe('第一稿正文');
    expect(slot.producer).not.toBeNull();
    expect(slot.producer!.executionId).toBe(executionId);
  });

  it('对非 reviewing 槽位（如 running）返回 0 行不改', () => {
    const db = freshMigratedDb();
    seedTaskAndRunningSlot(db); // slot 处于 running
    const repos = buildRepositories(db, fixedClock);

    const changes = repos.slots.markForRevision('task-1', 'scene_01');
    expect(changes).toBe(0);

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('running');
    expect(slot.revisionRound).toBe(0);
  });

  it('resetToPending 对 reviewing 槽位返回 0（两条路径没被合并）', () => {
    const db = freshMigratedDb();
    const { executionId, tokenHash } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    repos.slots.commitContentForReview({
      taskId: 'task-1',
      slotId: 'scene_01',
      content: '正文',
      producer: {
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        executionId,
      },
      tokenHash,
    });

    // resetToPending 只回滚 running，对 reviewing 返回 0
    const changes = repos.slots.resetToPending('task-1', 'scene_01');
    expect(changes).toBe(0);

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('reviewing');
  });
});

// ---------------------------------------------------------------------------
// 6. clearReview
// ---------------------------------------------------------------------------

describe('R0：clearReview', () => {
  it('exhausted=false → review_exhausted 保持 0', () => {
    const db = freshMigratedDb();
    const { executionId, tokenHash } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    repos.slots.commitContentForReview({
      taskId: 'task-1',
      slotId: 'scene_01',
      content: '正文',
      producer: {
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        executionId,
      },
      tokenHash,
    });

    const changes = repos.slots.clearReview('task-1', 'scene_01', false);
    expect(changes).toBe(1);

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('completed');
    expect(slot.reviewExhausted).toBe(false);
  });

  it('exhausted=true → review_exhausted 置 1', () => {
    const db = freshMigratedDb();
    const { executionId, tokenHash } = seedTaskAndRunningSlot(db);
    const repos = buildRepositories(db, fixedClock);

    repos.slots.commitContentForReview({
      taskId: 'task-1',
      slotId: 'scene_01',
      content: '正文',
      producer: {
        agentId: 'writer',
        skillId: 'scene-writing',
        skillVersion: '1.0.0',
        executionId,
      },
      tokenHash,
    });

    const changes = repos.slots.clearReview('task-1', 'scene_01', true);
    expect(changes).toBe(1);

    const slot = repos.slots.get('task-1', 'scene_01')!;
    expect(slot.status).toBe('completed');
    expect(slot.reviewExhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. slot_reviews 往返
// ---------------------------------------------------------------------------

describe('R0：slot_reviews 仓储往返', () => {
  it('insert 后 listByRound 能读回', () => {
    const db = freshMigratedDb();
    // 先建 task + execution（slot_reviews 有外键指向两表）
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO slots (task_id, slot_id, type, sort_order, instruction, content_bearing, include_in_artifact, status, revision_round, review_exhausted, content_text, producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id, error_code, error_message, created_at, updated_at)
          VALUES ('task-1', 's1', 'scene', 0, '写', 1, 1, 'reviewing', 0, 0, '正文', 'a', 'sk', '1', 'e1', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
      `);
    })();

    const repos = buildRepositories(db, fixedClock);
    repos.slotReviews.insert({
      taskId: 'task-1',
      slotId: 's1',
      round: 0,
      criterionId: 'S1',
      executionId: 'e1',
      verdict: 'revise',
      findingsJson: '[{"quote":"x","problem":"y"}]',
    });
    repos.slotReviews.insert({
      taskId: 'task-1',
      slotId: 's1',
      round: 0,
      criterionId: 'S2',
      executionId: 'e1',
      verdict: 'no_finding',
      findingsJson: '[]',
    });

    const rows = repos.slotReviews.listByRound('task-1', 's1', 0);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.criterionId).toBe('S1');
    expect(rows[0]!.verdict).toBe('revise');
    expect(rows[0]!.findingsJson).toBe('[{"quote":"x","problem":"y"}]');
    expect(rows[1]!.criterionId).toBe('S2');
    expect(rows[1]!.verdict).toBe('no_finding');
  });

  it('verdict CHECK 拒非法值', () => {
    const db = freshMigratedDb();
    db.transaction(() => {
      db.exec(`
        INSERT INTO task_snapshots (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
          VALUES ('snap-1', 'task-1', 'tpl', '1', '{}', 'h', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, name, snapshot_id, input_json, status, phase, created_at, updated_at)
          VALUES ('task-1', 'T', 'snap-1', '{}', 'running', 'slots', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO slots (task_id, slot_id, type, sort_order, instruction, content_bearing, include_in_artifact, status, revision_round, review_exhausted, content_text, producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id, error_code, error_message, created_at, updated_at)
          VALUES ('task-1', 's1', 'scene', 0, '写', 1, 1, 'reviewing', 0, 0, '正文', 'a', 'sk', '1', 'e1', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO executions (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version, token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model, attempt_number, status, created_at)
          VALUES ('e1', 'task-1', 'review_slot', 's1', 'a', 'sk', '1', 'th', '{}', 'ch', 'ph', 'alias', 'p', 'm', 1, 'created', '2026-01-01T00:00:00.000Z');
      `);
    })();
    expect(() =>
      db
        .prepare(
          `INSERT INTO slot_reviews (task_id, slot_id, round, criterion_id, execution_id, verdict, findings_json, created_at)
            VALUES ('task-1', 's1', 0, 'S1', 'e1', 'approved', '[]', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});
