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
const OUTLINE = Array.from({ length: 8 }, (_, index) => `${index + 1}. 第 ${index + 1} 节\n目标：推进药瓶隐瞒真相`).join('\n');

const sectionSlots = Array.from({ length: 8 }, (_, index) => ({
  id: `section_${String(index + 1).padStart(2, '0')}`,
  type: 'section',
  parentId: 'story',
  order: index + 1,
  instruction: `第 ${index + 1} 节推进证词，停在新的信息变化`,
  dependsOn: index === 0 ? [] : [`section_${String(index).padStart(2, '0')}`],
}));

const storyStructure = {
  rootSlotId: 'story',
  slots: [
    { id: 'story', type: 'story', parentId: null, order: 0, instruction: '故事容器', dependsOn: [] },
    { id: 'title', type: 'title', parentId: 'story', order: 0, instruction: '拟定标题', dependsOn: sectionSlots.map((slot) => slot.id) },
    ...sectionSlots,
  ],
};

function safeSection(index: number): string {
  return `我在第${index}间诊室记录证词` + '我'.repeat(990);
}

function outlineArtifact(): string {
  return Array.from({ length: 8 }, (_, index) => [
    `${index + 1}. 第 ${index + 1} 节`,
    `出场：记录员`,
    `目标：核对第 ${index + 1} 项事实并推进因果`,
    `冲突：现有证词与记录不一致${'但仍需逐项核实'.repeat(12)}`,
    `结束状态：第 ${index + 1} 项记录已经确认`,
  ].join('\n')).join('\n\n');
}

describe('S2.5 系统私有原文与防抄线', () => {
  it('outline Agent 只能显式点名读取私有原文，Prompt/Replay/trace/API 均不含正文', async () => {
    const provider = new FakeProvider({
      turns: [
        {
          submitStructure: {
            rootSlotId: 'outline_document',
            slots: [
              { id: 'outline_document', type: 'outline_document', parentId: null, order: 0, instruction: '大纲容器', dependsOn: [] },
              { id: 'story_outline', type: 'story_outline', parentId: 'outline_document', order: 0, instruction: '提取执行大纲', dependsOn: [] },
            ],
          },
        },
        { callTools: [{ name: 'read_task_input', args: { field: 'source_text' } }] },
        {
          emitText: [PRIVATE_SOURCE],
          callTools: [{ name: 'report_work', args: { type: 'progress', summary: PRIVATE_SOURCE } }],
        },
        { submitContent: { slotId: 'story_outline', content: outlineArtifact() } },
        { callTools: [{ name: 'read_task_input', args: { field: 'source_text' } }] },
        {
          submitReview: {
            slotId: 'story_outline',
            verdict: 'revise',
            findings: [{
              criterionId: 'S1',
              quote: '1. 第 1 节',
              problem: PRIVATE_SOURCE,
            }],
          },
        },
        ...Array.from({ length: 4 }, () => ({
          submitReview: { slotId: 'story_outline', verdict: 'no_finding' as const },
        })),
      ],
    });
    harness = createApiHarness({ provider, templatesDir: path.resolve('templates'), skillsDir: path.resolve('skills') });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-outline',
      name: '私有原文工具读取',
      input: { source_text: PRIVATE_SOURCE },
    });
    await harness.lifecycle.start(created.task.id);

    const task = harness.uow.repositories.tasks.getOrThrow(created.task.id);
    expect(task.status, task.errorMessage ?? '无错误详情').toBe('completed');
    expect(created.task.input).toEqual({});
    expect(harness.snapshots.readSnapshot(created.task.id).input).toEqual({});
    expect(harness.snapshots.readPrivateInput(created.task.id, 'source_text')).toBe(PRIVATE_SOURCE);

    const firstPrivateRead = provider.observations.findIndex((observation) =>
      JSON.stringify(observation.messages).includes(PRIVATE_SOURCE),
    );
    expect(firstPrivateRead).toBeGreaterThan(0);
    expect(JSON.stringify(provider.observations[0])).not.toContain(PRIVATE_SOURCE);

    for (const table of ['tasks', 'task_snapshots', 'task_skill_snapshots', 'slots', 'executions', 'trace_events', 'artifacts', 'slot_reviews']) {
      expect(JSON.stringify(harness.db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(PRIVATE_SOURCE);
    }
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

  it('必填私有原文缺失时首个 Provider 请求前失败关闭', async () => {
    const provider = new FakeProvider({ turns: [{ submitStructure: storyStructure }] });
    harness = createApiHarness({
      provider,
      templatesDir: path.resolve('templates'),
      skillsDir: path.resolve('skills'),
    });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-outline',
      name: '私有原文预检',
      input: { source_text: PRIVATE_SOURCE },
    });
    harness.db.prepare('DELETE FROM task_private_inputs WHERE task_id = ?').run(created.task.id);

    await harness.lifecycle.start(created.task.id).catch(() => undefined);

    expect(provider.observations).toHaveLength(0);
    const task = harness.uow.repositories.tasks.getOrThrow(created.task.id);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('STORAGE_ERROR');
  });

  it('非工具可读但参与防抄的必填原文缺失时也在首个 Provider 请求前失败', async () => {
    const provider = new FakeProvider({ turns: [{ submitStructure: storyStructure }] });
    harness = createApiHarness({
      provider,
      templatesDir: path.resolve('templates'),
      skillsDir: path.resolve('skills'),
    });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-story',
      name: '防抄原文预检',
      input: { outline_blueprint: OUTLINE, source_text: PRIVATE_SOURCE },
    });
    harness.db.prepare('DELETE FROM task_private_inputs WHERE task_id = ?').run(created.task.id);

    await harness.lifecycle.start(created.task.id).catch(() => undefined);

    expect(provider.observations).toHaveLength(0);
    const task = harness.uow.repositories.tasks.getOrThrow(created.task.id);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('STORAGE_ERROR');
  });

  it('私有原文只在专用表可见，Provider/context/replay/trace/API 均不含原文', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: storyStructure },
        ...Array.from({ length: 4 }, () => ({ submitReview: { slotId: 'story', verdict: 'no_finding' as const } })),
        ...sectionSlots.flatMap((slot, index) => [
          { submitContent: { slotId: slot.id, content: safeSection(index + 1) } },
          ...Array.from({ length: 3 }, () => ({ submitReview: { slotId: slot.id, verdict: 'no_finding' as const } })),
        ]),
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

    const warning = harness.uow.repositories.traces
      .listByTask(created.task.id, { limit: 500 })
      .find((trace) => trace.kind === 'validation_warning');
    expect(warning?.summary).toContain('没有对白引号');

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
