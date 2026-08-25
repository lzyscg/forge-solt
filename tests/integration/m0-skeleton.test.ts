import { describe, expect, it, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
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
