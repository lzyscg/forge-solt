/**
 * M7 完成判据：连续完成 10 个章节任务，无人工干预数据库或文件（§12.2）。
 *
 * 真实链路需要 DeepSeek key；这里用 FakeProvider 证明**引擎侧**的稳定性：
 * 同一进程、同一 db 顺序跑 10 个任务，全部 completed，无残留 running/created，
 * 队列位次跑完清零——即不存在状态泄漏或「越跑越脏」。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import {
  createEngineHarness,
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  type EngineHarness,
} from '../fixtures/engine.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: EngineHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

function oneChapterTurns() {
  return [
    { submitStructure: VALID_STRUCTURE },
    { submitContent: { slotId: 'outline', content: outlineText() } },
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
    { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
    { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
  ];
}

describe('M7：连续 10 个任务，无人工干预', () => {
  it('顺序跑 10 个任务全部 completed，无残留 running', async () => {
    const provider = new FakeProvider({ turns: Array.from({ length: 10 }, () => oneChapterTurns()).flat() });
    harness = createEngineHarness({ provider });

    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await harness.snapshots.createTask({
        templateId: 'zhihu-chapter',
        name: `第${String(i + 1)}章`,
        input: INPUT,
      });
      await harness.lifecycle.start(created.task.id);
      ids.push(created.task.id);
    }

    for (const id of ids) {
      expect(harness.uow.repositories.tasks.getOrThrow(id).status).toBe('completed');
    }

    // 全库不允许有任何 running/created 的 execution（无永久卡死）
    const leftover = ids.flatMap((id) =>
      harness!.uow.repositories.executions
        .listByTask(id)
        .filter((e) => e.status === 'running' || e.status === 'created'),
    );
    expect(leftover).toEqual([]);

    // 队列跑完清零
    for (const id of ids) expect(harness.engine.positionOf(id)).toBeNull();
  }, 30_000);
});
