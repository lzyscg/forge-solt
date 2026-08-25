/**
 * M7 脱敏审计（§12.2 / REQ §13）：跑完任务后，扫描**整库所有表的所有列**与
 * 关键 API 响应，确认无 API Key 值、无 Authorization/Bearer、无隐藏推理字段。
 *
 * 用 FakeProvider 时把 `FAKE_API_KEY` 设成一个显眼的假值，审计的目标就是
 * 这个假值以及禁用字段名绝不出现在库或响应里——与真实链路的纪律同构。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { TracePayloadSchema } from '@shared/trace.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';
import { outlineText, sceneText, TITLE_TEXT, VALID_STRUCTURE } from '../fixtures/engine.ts';

const FAKE_KEY = 'sk-fake-MUST-NEVER-LEAK-12345';

let harness: ApiHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const FORBIDDEN = [FAKE_KEY, 'reasoning_content', 'authorization', 'bearer', 'password', 'secret'];

function assertClean(blob: string, where: string): void {
  const lower = blob.toLowerCase();
  for (const marker of FORBIDDEN) {
    expect(lower.includes(marker.toLowerCase()), `${where} 泄露了 ${marker}`).toBe(false);
  }
}

describe('M7：脱敏审计', () => {
  it('整库 + API 响应无凭据/隐藏推理', async () => {
    harness = createApiHarness({
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
      env: { FAKE_API_KEY: FAKE_KEY },
    });

    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '审计章',
      input: { chapter_packet: '审计。' },
    });
    await harness.lifecycle.start(created.task.id);
    const taskId = created.task.id;

    // ---- 整库扫描 ----
    const tables = harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = harness.db.prepare(`SELECT * FROM ${name}`).all();
      assertClean(JSON.stringify(rows), `表 ${name}`);
    }

    // ---- API 响应扫描 ----
    for (const url of [
      `/api/tasks/${taskId}`,
      `/api/tasks/${taskId}/traces?limit=500`,
      `/api/tasks/${taskId}/executions`,
      `/api/tasks/${taskId}/artifact`,
      '/api/providers',
    ]) {
      const res = await harness.server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      assertClean(res.body, `GET ${url}`);
    }
  });

  it('trace payload 黑名单在契约层拦截隐藏推理键', () => {
    expect(() => TracePayloadSchema.parse({ reasoning_content: 'x' })).toThrow();
    expect(() => TracePayloadSchema.parse({ nested: { API_KEY: 'x' } })).toThrow();
    expect(() => TracePayloadSchema.parse({ safe: 'ok' })).not.toThrow();
  });
});
