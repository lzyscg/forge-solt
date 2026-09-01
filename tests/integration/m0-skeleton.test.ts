import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { ERROR_CODES, ERROR_HTTP_STATUS, ForgeError } from '@shared/errors.ts';
import { TraceEventSchema } from '@shared/trace.ts';
import { createApiHarness } from '../fixtures/api.ts';

const TMP_DB = './data/test-m0.sqlite';
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${TMP_DB}${suffix}`, { force: true });
  }
});

function freshDb() {
  const db = openDatabase(TMP_DB);
  cleanup.push(() => db.close());
  const result = runMigrations(db);
  return { db, result };
}

describe('M0 骨架自证', () => {
  it('迁移可执行且幂等', () => {
    const { db, result } = freshDb();
    expect(result.applied.length).toBeGreaterThan(0);

    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.total).toBe(result.total);
  });

  it('006 迁移为已有 executions 表增加 nullable ReplayInput 两列，旧行保持 NULL', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-migration-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '001_initial.sql',
      '002_indexes.sql',
      '003_review.sql',
      '004_review_unique.sql',
      '005_provider_fallback.sql',
    ]) {
      writeFileSync(path.join(dir, name), readFileSync(path.join('migrations', name), 'utf8'));
    }

    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    runMigrations(db, dir);
    // A deliberately parentless historical execution is enough to test ALTER TABLE preservation.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO executions
        (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
         token_hash, context_json, context_hash, prompt_hash, model_alias, provider, model,
         attempt_number, status, created_at)
       VALUES ('legacy', 'task', 'create_structure', NULL, 'agent', 'skill', '1.0.0',
               'token-hash', '{}', 'context-hash', 'prompt-hash', 'alias', 'provider', 'model',
               1, 'created', '2026-01-01T00:00:00.000Z')`,
    ).run();

    writeFileSync(
      path.join(dir, '006_execution_replay_input.sql'),
      readFileSync('migrations/006_execution_replay_input.sql', 'utf8'),
    );
    const result = runMigrations(db, dir);
    expect(result.applied).toEqual(['006_execution_replay_input.sql']);
    const columns = db.prepare('PRAGMA table_info(executions)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((c) => c.name === 'replay_input_json')?.notnull).toBe(0);
    expect(columns.find((c) => c.name === 'replay_input_hash')?.notnull).toBe(0);
    expect(
      db.prepare("SELECT replay_input_json, replay_input_hash FROM executions WHERE id = 'legacy'").get(),
    ).toEqual({ replay_input_json: null, replay_input_hash: null });
  });

  it('foreign_keys 必须是 ON —— 延迟外键在 OFF 时静默失效', () => {
    // 这不是性能开关，是 D-18 的正确性前提。关掉它，D-10 的完整性地基就没了，
    // 而且不会有任何报错告诉你。
    const { db } = freshDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('契约层：每个错误码都配了 HTTP 状态码', () => {
    // Record<ErrorCode, number> 的完备性在编译期已经保证，这里守住运行时：
    // 防止有人用 as 断言绕过去。
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code], `${code} 缺 HTTP 映射`).toBeTypeOf('number');
    }
  });

  it('契约层：ForgeError 对外投影不携带 cause', () => {
    const err = new ForgeError('TASK_NOT_FOUND', '任务不存在', null, null, new Error('内部细节'));
    expect(JSON.stringify(err.toPublic())).not.toContain('内部细节');
  });

  it('契约层：trace payload 拒绝携带凭据', () => {
    const base = {
      id: 't1',
      taskId: 'task1',
      executionId: null,
      sequence: 1,
      actor: 'system',
      kind: 'task_state_changed',
      title: '任务启动',
      summary: '',
      createdAt: new Date().toISOString(),
    };

    expect(TraceEventSchema.safeParse({ ...base, payload: { slotId: 'scene_01' } }).success).toBe(true);
    // 事故通常藏在嵌套的 provider 原始响应里，所以黑名单必须是递归的
    expect(TraceEventSchema.safeParse({ ...base, payload: { provider: { apiKey: 'sk-live' } } }).success).toBe(
      false,
    );
  });

  it('/api/health 能自证数据库已就绪', async () => {
    const harness = createApiHarness();
    cleanup.push(() => void harness.close());

    const res = await harness.server.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', migrations: harness.forge.migrationCount });
    // 「迁移数」为 0 也能让上一行通过，那等于什么都没自证
    expect(harness.forge.migrationCount).toBeGreaterThan(0);
  });
});
