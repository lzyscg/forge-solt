/**
 * M7 性能/规模判据（§12.2）：大任务的 trace 分页正常、详情获取在合理时延内。
 *
 * 真实「50 槽位首屏 <1s」是 UI 指标且需真实 Provider；这里在引擎/HTTP 层证明
 * 规模下（fixture 模板 maxSlots=32，取满）trace 分页（limit/nextAfter）正确、
 * 跨页 sequence 严格递增、任务详情响应在 1s 内。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';
import { sceneText } from '../fixtures/engine.ts';

const SCENE_COUNT = 31; // +1 容器 = 32 = maxSlots

let harness: ApiHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function wideStructure() {
  const sceneIds = Array.from({ length: SCENE_COUNT }, (_, i) => `scene_${String(i + 1).padStart(2, '0')}`);
  return {
    sceneIds,
    structure: {
      rootSlotId: 'chapter',
      slots: [
        { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '', dependsOn: [] },
        ...sceneIds.map((id, i) => ({ id, type: 'scene', parentId: 'chapter', order: i, instruction: `〔M7〕${id}`, dependsOn: [] })),
      ],
    },
  };
}

describe('M7：32 槽位规模 + trace 分页', () => {
  it('trace 分页 limit/nextAfter 正确，跨页 sequence 递增', async () => {
    const { sceneIds, structure } = wideStructure();
    const provider = new FakeProvider({
      turns: [
        { submitStructure: structure },
        ...sceneIds.map((id) => ({ submitContent: { slotId: id, content: sceneText(id) } })),
      ],
    });
    harness = createApiHarness({ provider });

    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '规模章',
      input: { chapter_packet: 'M7 规模测试。' },
    });
    await harness.lifecycle.start(created.task.id);
    const taskId = created.task.id;
    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');

    const repoCount = harness.uow.repositories.traces.listByTask(taskId, { limit: 100_000 }).length;
    expect(repoCount).toBeGreaterThan(20); // 确保超过单页

    let after: number | undefined;
    let total = 0;
    let pages = 0;
    let prevSeq = -1;
    for (;;) {
      const url = `/api/tasks/${taskId}/traces?limit=20${after !== undefined ? `&after=${String(after)}` : ''}`;
      const res = await harness.server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: { sequence: number }[]; nextAfter: number | null };
      expect(body.events.length).toBeLessThanOrEqual(20);
      for (const e of body.events) {
        expect(e.sequence).toBeGreaterThan(prevSeq);
        prevSeq = e.sequence;
      }
      total += body.events.length;
      pages += 1;
      if (body.nextAfter === null) break;
      after = body.nextAfter;
    }
    expect(pages).toBeGreaterThan(1);
    expect(total).toBe(repoCount);
  }, 30_000);

  it('任务详情（含 32 槽位）响应 < 1s', async () => {
    const { sceneIds, structure } = wideStructure();
    const provider = new FakeProvider({
      turns: [
        { submitStructure: structure },
        ...sceneIds.map((id) => ({ submitContent: { slotId: id, content: sceneText(id) } })),
      ],
    });
    harness = createApiHarness({ provider });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '时延章',
      input: { chapter_packet: 'M7 时延测试。' },
    });
    await harness.lifecycle.start(created.task.id);

    const startAt = Date.now();
    const res = await harness.server.inject({ method: 'GET', url: `/api/tasks/${created.task.id}` });
    const elapsed = Date.now() - startAt;
    expect(res.statusCode).toBe(200);
    const body = res.json() as { slots: unknown[] };
    expect(body.slots).toHaveLength(32);
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);
});
