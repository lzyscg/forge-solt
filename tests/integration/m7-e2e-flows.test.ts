/**
 * M7 E2E（§12.2）：主流程 + 停止续跑 + 重启恢复。
 *
 * 走真实 HTTP（fastify inject）+ 真实依赖图，仅 Provider 为 Fake。
 * 浏览器层的 Playwright 为剩余的实 UI E2E；此处覆盖行为级验收。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';
import { createTempDbPath, outlineText, sceneText, TITLE_TEXT, VALID_STRUCTURE, waitFor } from '../fixtures/engine.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: ApiHarness | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await harness?.close();
  harness = null;
  while (cleanups.length > 0) cleanups.pop()?.();
});

const happy = () =>
  new FakeProvider({
    turns: [
      { submitStructure: VALID_STRUCTURE },
      { submitContent: { slotId: 'outline', content: outlineText() } },
      { submitContent: { slotId: 'title', content: TITLE_TEXT } },
      { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    ],
  });

describe('M7 E2E：主流程（HTTP）', () => {
  it('create?start → completed → 产物可下载', async () => {
    harness = createApiHarness({ provider: happy() });

    const create = await harness.server.inject({
      method: 'POST',
      url: '/api/tasks?start=true',
      payload: { templateId: 'zhihu-chapter', name: 'E2E 章', input: INPUT },
    });
    expect(create.statusCode).toBe(201);
    const taskId = (create.json() as { taskId: string }).taskId;

    await waitFor(() => harness!.uow.repositories.tasks.getOrThrow(taskId).status === 'completed');

    const detail = await harness.server.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { status: string }).status).toBe('completed');

    const artifact = await harness.server.inject({ method: 'GET', url: `/api/tasks/${taskId}/artifact` });
    expect(artifact.statusCode).toBe(200);
    expect((artifact.json() as { fileName: string }).fileName).toBe('chapter.md');

    const download = await harness.server.inject({ method: 'GET', url: `/api/tasks/${taskId}/artifact/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('text/markdown');
    expect(String(download.headers['content-disposition'] ?? '')).toContain('chapter.md');
  });
});

describe('M7 E2E：停止 → 续跑（HTTP）', () => {
  it('stop 后 resume 从中断处继续，已完成不重做', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        { hangMs: 60_000 },
        { submitContent: { slotId: 'title', content: TITLE_TEXT } },
        { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
        { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      ],
    });
    harness = createApiHarness({ provider });

    const create = await harness.server.inject({
      method: 'POST',
      url: '/api/tasks?start=true',
      payload: { templateId: 'zhihu-chapter', name: '会停的章', input: INPUT },
    });
    const taskId = (create.json() as { taskId: string }).taskId;

    await waitFor(() => harness!.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed');
    const stop = await harness.server.inject({ method: 'POST', url: `/api/tasks/${taskId}/stop` });
    expect(stop.statusCode).toBe(200);
    await waitFor(() => harness!.uow.repositories.tasks.getOrThrow(taskId).status === 'stopped');

    const resume = await harness.server.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume` });
    expect(resume.statusCode).toBe(200);
    await waitFor(() => harness!.uow.repositories.tasks.getOrThrow(taskId).status === 'completed');

    // 已完成的 outline 不重做
    expect(harness.uow.repositories.slots.get(taskId, 'outline')?.contentText).toBe(outlineText());
  });
});

describe('M7 E2E：重启恢复', () => {
  it('崩溃后 running 变 stopped，resume 续跑', async () => {
    const temp = createTempDbPath();
    cleanups.push(temp.cleanup);

    const first = createApiHarness({
      dbPath: temp.dbPath,
      provider: new FakeProvider({
        turns: [{ submitStructure: VALID_STRUCTURE }, { submitContent: { slotId: 'outline', content: outlineText() } }, { hangMs: 60_000 }],
      }),
    });
    const create = await first.server.inject({
      method: 'POST',
      url: '/api/tasks?start=true',
      payload: { templateId: 'zhihu-chapter', name: '会崩的章', input: INPUT },
    });
    const taskId = (create.json() as { taskId: string }).taskId;
    await waitFor(() => first.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed');
    await first.close(); // 模拟崩溃（不 stop）

    const second = createApiHarness({
      dbPath: temp.dbPath,
      provider: new FakeProvider({
        turns: [
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });
    harness = second;

    const recovery = second.forge.lifecycle.recoverOnStartup();
    expect(recovery.recovered).toContain(taskId);
    expect(second.uow.repositories.tasks.getOrThrow(taskId).status).toBe('stopped');

    const resume = await second.server.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume` });
    expect(resume.statusCode).toBe(200);
    await waitFor(() => second.uow.repositories.tasks.getOrThrow(taskId).status === 'completed');
  });
});
