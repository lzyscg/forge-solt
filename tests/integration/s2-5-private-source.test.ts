import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

let harness: ApiHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const PRIVATE_SOURCE = 'PRIVATE-SOURCE-MUST-STAY-SERVER-' + '雨夜来客把旧药瓶放在桌上。'.repeat(30);
const OUTLINE = '全篇大纲：1. 雨夜赴约；2. 药瓶摊牌；3. 医生承认隐瞒。';

const storyStructure = {
  rootSlotId: 'story',
  slots: [
    { id: 'story', type: 'story', parentId: null, order: 0, instruction: '故事容器', dependsOn: [] },
    { id: 'title', type: 'title', parentId: 'story', order: 0, instruction: '拟定标题', dependsOn: ['section_01'] },
    { id: 'section_01', type: 'section', parentId: 'story', order: 1, instruction: '来客出示药瓶，医生承认隐瞒，停在证词被录下', dependsOn: [] },
  ],
};

function safeSection(): string {
  return '她推开诊室的门，把录音笔放到灯下。医生没有去碰桌上的纸袋，只把窗帘拉严。'.repeat(9);
}

describe('S2.5 系统私有原文与防抄线', () => {
  it('私有原文只在专用表可见，Provider/context/replay/trace/API 均不含原文', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: storyStructure },
        ...Array.from({ length: 4 }, () => ({ submitReview: { slotId: 'story', verdict: 'no_finding' as const } })),
        { submitContent: { slotId: 'section_01', content: safeSection() } },
        ...Array.from({ length: 3 }, () => ({ submitReview: { slotId: 'section_01', verdict: 'no_finding' as const } })),
        { submitContent: { slotId: 'title', content: '雨夜药瓶' } },
      ],
    });
    harness = createApiHarness({
      provider,
      templatesDir: path.resolve('templates'),
      skillsDir: path.resolve('skills'),
    });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-story',
      name: '私有原文审计',
      input: { outline_blueprint: OUTLINE, source_text: PRIVATE_SOURCE },
    });
    await harness.lifecycle.start(created.task.id);
    const task = harness.uow.repositories.tasks.getOrThrow(created.task.id);
    expect(task.status, task.errorMessage ?? '无错误详情').toBe('completed');

    expect(harness.snapshots.readPrivateInput(created.task.id, 'source_text')).toBe(PRIVATE_SOURCE);
    const allowed = harness.db.prepare('SELECT content_text FROM task_private_inputs WHERE task_id = ?').all(created.task.id);
    expect(JSON.stringify(allowed)).toContain(PRIVATE_SOURCE);

    const forbiddenTables = ['tasks', 'task_snapshots', 'task_skill_snapshots', 'slots', 'executions', 'trace_events', 'artifacts', 'slot_reviews'];
    for (const table of forbiddenTables) {
      expect(JSON.stringify(harness.db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(PRIVATE_SOURCE);
    }
    expect(JSON.stringify(provider.observations)).not.toContain(PRIVATE_SOURCE);
    for (const url of [
      `/api/tasks/${created.task.id}`,
      `/api/tasks/${created.task.id}/traces?limit=500`,
      `/api/tasks/${created.task.id}/executions`,
      `/api/tasks/${created.task.id}/artifact`,
    ]) {
      const response = await harness.server.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(PRIVATE_SOURCE);
    }
  });

  it('照抄原文的 section 被生产 CompletionService 确定性拒绝', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: storyStructure },
        ...Array.from({ length: 4 }, () => ({ submitReview: { slotId: 'story', verdict: 'no_finding' as const } })),
        { submitContent: { slotId: 'section_01', content: PRIVATE_SOURCE } },
        { neverSubmit: true },
      ],
    });
    harness = createApiHarness({ provider, templatesDir: path.resolve('templates'), skillsDir: path.resolve('skills') });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-story',
      name: '防抄拒绝',
      input: { outline_blueprint: OUTLINE, source_text: PRIVATE_SOURCE },
    });
    await harness.lifecycle.start(created.task.id).catch(() => undefined);
    const failures = harness.uow.repositories.traces.listByTask(created.task.id, { limit: 500 })
      .filter((trace) => trace.kind === 'validation_failed');
    expect(failures.some((trace) => trace.summary.includes('重合度'))).toBe(true);
    expect(JSON.stringify(failures)).not.toContain(PRIVATE_SOURCE);
  });
});
