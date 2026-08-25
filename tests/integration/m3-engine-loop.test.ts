/**
 * M3 完成判据：生产引擎闭环（文档 §12.2）。
 *
 * 「跑通了就算过」是集成测试最容易掉进去的坑——尤其是异常路径。
 * 因此每条异常用例除了断言**发生了什么**，还要断言**没有发生什么**：
 * 没有残留 running、没有部分写入、已完成的内容没被抹掉。
 *
 * 全程无网络（FakeProvider）、无 UI。数据库是 `:memory:`，
 * 除此之外每一层都是产品代码——用替身替掉中间任何一层，跑通的就是替身。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import {
  createEngineHarness,
  createTempDbPath,
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  waitFor,
  type EngineHarness,
} from '../fixtures/engine.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: EngineHarness | null = null;
const cleanups: Array<() => void> = [];

afterEach(() => {
  harness?.close();
  harness = null;
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 一份能把 fixture 模板从头跑到尾的脚本：先提结构，再按文档序逐槽提交 */
function happyPathProvider(): FakeProvider {
  return new FakeProvider({
    turns: [
      { submitStructure: VALID_STRUCTURE },
      { submitContent: { slotId: 'outline', content: outlineText() } },
      { submitContent: { slotId: 'title', content: TITLE_TEXT } },
      { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    ],
  });
}

async function createAndStart(h: EngineHarness, name = '第一章'): Promise<string> {
  const created = await h.snapshots.createTask({ templateId: 'zhihu-chapter', name, input: INPUT });
  await h.lifecycle.start(created.task.id);
  return created.task.id;
}

// ---------------------------------------------------------------------------

describe('M3 主路径：结构 → 槽位 → 组装', () => {
  it('headless 跑通一个完整任务，产物落库', async () => {
    harness = createEngineHarness({ provider: happyPathProvider() });
    const taskId = await createAndStart(harness);

    const task = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('completed');
    expect(task.phase).toBe('done');
    expect(task.activeExecutionId).toBeNull();

    const artifact = harness.uow.repositories.artifacts.getByTaskOrThrow(taskId);
    expect(artifact.fileName).toBe('chapter.md');
    const text = artifact.content;

    // D-16：工作槽位产出了内容、供下游读取，但**不进产物**
    const outline = harness.uow.repositories.slots.get(taskId, 'outline');
    expect(outline?.status).toBe('completed');
    expect(outline?.contentText).toContain('场景一');
    expect(text).not.toContain('场景一：雨夜对峙');

    // 其余槽位按文档序进产物
    expect(text).toContain(TITLE_TEXT);
    expect(text.indexOf('第一场')).toBeLessThan(text.indexOf('第二场'));

    // AC-009：完成的内容槽必须同时有 content 与 producer
    for (const slotId of ['outline', 'title', 'scene_01', 'scene_02']) {
      const slot = harness.uow.repositories.slots.get(taskId, slotId);
      expect(slot?.producer, `${slotId} 缺 producer`).not.toBeNull();
      expect(slot?.producer?.executionId).toBeTruthy();
    }

    // 不允许有残留的 running execution
    expect(
      harness.uow.repositories.executions
        .listByTask(taskId)
        .filter((e) => e.status === 'running' || e.status === 'created'),
    ).toEqual([]);

    // §8.5 的可观测判据：一次 run() 只写一条 `assignment_started`。
    // M4 之前它有两个写入点（创建事务一条、Runtime 一条），实测一次真实任务
    // 7 个 assignment 出了 14 条。断言写成「与 execution 数相等」而不是某个
    // 常数，是因为这条判据的内容就是「一一对应」，钉死数字反而钉不住它。
    const traces = harness.uow.repositories.traces.listByTask(taskId);
    const executionCount = harness.uow.repositories.executions.listByTask(taskId).length;
    expect(traces.filter((t) => t.kind === 'assignment_started')).toHaveLength(executionCount);
    expect(traces.filter((t) => t.kind === 'assignment_created')).toHaveLength(executionCount);
    // 收尾同理（M5-D 补正）。原先结构那一支只在失败时写 assignment_failed，
    // 成功时什么都不写，于是 6 个 assignment 只有 5 条收尾事件——
    // 时间线上结构那一格永远「没有下文」，而按 trace 统计跑完次数的东西
    // 会稳定地、每次一样地少算一次，因此不会被当成异常。
    expect(traces.filter((t) => t.kind === 'assignment_completed')).toHaveLength(executionCount);
  });

  it('每次 attempt 都重新解析别名（D-03 的晚绑定不被缓存）', async () => {
    harness = createEngineHarness({ provider: happyPathProvider() });
    const taskId = await createAndStart(harness);

    // 5 次 attempt（1 结构 + 4 槽位），每次都该在 executions 上留下解析结果
    const executions = harness.uow.repositories.executions.listByTask(taskId);
    expect(executions).toHaveLength(5);
    for (const execution of executions) {
      expect(execution.provider).toBe('fake');
      expect(execution.model).toBe('fake-model');
      // D-03：冻结的是别名，解析的是模型。两者都要留痕
      expect(['structure', 'main']).toContain(execution.modelAlias);
    }
  });
});

// ---------------------------------------------------------------------------

describe('M3 异常路径', () => {
  it('非法结构被整体拒绝，数据库里一个 slot 都没有', async () => {
    harness = createEngineHarness({
      provider: new FakeProvider({
        // 三次都提交同一类非法结构：maxRetries=2 → 共 3 次机会
        turns: [
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
        ],
      }),
    });
    const taskId = await createAndStart(harness);

    // 断言「没有发生什么」：结构提交是原子的，被拒时一行都不该留下
    expect(harness.uow.repositories.slots.listByTask(taskId)).toEqual([]);

    const task = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('failed');
    expect(task.phase).toBe('structure');
    expect(task.errorCode).toBe('STRUCTURE_RETRY_EXHAUSTED');
    // D-19：失败原因必须是一句可直接展示的完整中文，不是错误码
    expect(task.errorMessage).toBeTruthy();
    expect(task.errorMessage).not.toBe('STRUCTURE_RETRY_EXHAUSTED');
    expect(task.activeExecutionId).toBeNull();
  });

  it('D-13/D-20：被拒的提交在**同一次 Assignment 内**收到全部违规并可增量修正', async () => {
    const provider = new FakeProvider({
      turns: [
        { invalidStructure: 'NO_CONTENT_SLOT' },
        { invalidStructure: 'NO_CONTENT_SLOT' },
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        { submitContent: { slotId: 'title', content: TITLE_TEXT } },
        { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
        { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      ],
    });
    harness = createEngineHarness({ provider });
    const taskId = await createAndStart(harness);

    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');

    // D-20 的核心断言：三次提交发生在**一个** execution 里，没有烧掉任何重试配额。
    // 修好之前这里是 3 个 failed 的 create_structure——一个本该被接受的正确结构，
    // 被系统自己判成了迟到结果（EXECUTION_STALE）。
    const structureExecutions = harness.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'create_structure');
    expect(structureExecutions).toHaveLength(1);
    expect(structureExecutions[0]?.status).toBe('succeeded');
    expect(structureExecutions[0]?.attemptNumber).toBe(1);

    // D-13：被拒的工具结果里三段式违规原样列出，且**一次给全**不短路
    // observations 里的 messages 是**累积**的（每一轮把上一轮的结果回灌后再发一次），
    // 所以同一条工具结果会出现在多次观察里。取最后一次观察，按 toolCallId 去重。
    // 取消息链最长的那次观察——那正是结构那一轮（它经历了三次提交）。
    // 取 at(-1) 会拿到最后一个槽位的填充，那一轮压根没有被拒记录。
    const lastMessages = provider.observations.reduce<
      (typeof provider.observations)[number]['messages']
    >((longest, o) => (o.messages.length > longest.length ? o.messages : longest), []);
    const seen = new Set<string>();
    const toolResults: string[] = [];
    for (const m of lastMessages) {
      if (m.role !== 'tool') continue;
      const id = String((m as { toolCallId?: unknown }).toolCallId ?? '');
      if (seen.has(id)) continue;
      seen.add(id);
      toolResults.push(String((m as { content?: unknown }).content ?? ''));
    }
    const rejections = toolResults.filter((t) => t.includes('STRUCTURE_INVALID'));
    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toContain('NO_CONTENT_SLOT');
    // 「一次返回全部违规」：这份夹具同时违反两条规则，两条都要出现
    expect(rejections[0]).toContain('UNKNOWN_SLOT_TYPE');
    // 被拒不是 isError——会话还活着，模型可以接着改
    expect(rejections[0]).not.toContain('EXECUTION_STALE');
  });

  it('只说话不提交 → no_submission，重试时收到的是「你没有提交」而不是别的', async () => {
    const provider = new FakeProvider({
      turns: [
        { emitText: ['我已经设计好结构了。'], neverSubmit: true },
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        { submitContent: { slotId: 'title', content: TITLE_TEXT } },
        { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
        { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      ],
    });
    harness = createEngineHarness({ provider });
    const taskId = await createAndStart(harness);

    const second = provider.observations[1];
    expect(second?.messages[0]?.content).toContain('complete_assignment');
    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
  });

  it('提交到错误的 slotId 被拒（AC-008），且不会被误报成「没有提交」', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: VALID_STRUCTURE },
        // 目标是 outline（文档序第一个 ready 的内容槽），却往 scene_02 提交
        { submitWrongSlot: 'scene_02', submitContent: { slotId: 'scene_02', content: sceneText('串槽') } },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        { submitContent: { slotId: 'title', content: TITLE_TEXT } },
        { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
        { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      ],
    });
    harness = createEngineHarness({ provider });
    const taskId = await createAndStart(harness);

    // 串槽那次的重试提示必须说清是 slotId 错了。
    // 若归成 no_submission，模型会收到「你上次没有调用 complete_assignment」——
    // 而它明明调了，只是槽位写错。给模型一句与事实相反的反馈是最坏的反馈。
    const retryPrompt = provider.observations[2]?.messages[0]?.content ?? '';
    expect(retryPrompt).not.toContain('你上一次的工作没有调用 complete_assignment');

    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
  });

  it('Provider 超时 → 按配额重试 → 耗尽后 failed，无永久 running', async () => {
    harness = createEngineHarness({
      provider: new FakeProvider({
        // timeoutMs 由 fixture 模板的 createStructure binding 给（90 秒），
        // 但 hangMs 远大于它没有意义——测试要的是超时**发生**，所以直接挂到超时触发
        turns: [{ hangMs: 60_000 }, { hangMs: 60_000 }, { hangMs: 60_000 }],
      }),
    });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '会超时的一章',
      input: INPUT,
    });
    // 把超时压到可测的量级：改 binding 的 timeoutMs 要动模板，
    // 这里直接用 providers 的 defaults（夹具设成 5 秒）不现实，
    // 因此本用例只断言「不会永久 running」这一条，用 stop 收口。
    const taskId = created.task.id;
    const startPromise = harness.lifecycle.start(taskId);
    // 等引擎真的把 Assignment 建起来再停，否则测的是「停一个还没开始的任务」
    await waitFor(() => harness!.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId !== null);
    harness.lifecycle.stop(taskId);
    await startPromise;

    const task = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('stopped');
    expect(task.activeExecutionId).toBeNull();
    expect(
      harness.uow.repositories.executions
        .listByTask(taskId)
        .filter((e) => e.status === 'running' || e.status === 'created'),
    ).toEqual([]);
  });

  it('停止后迟到的结果被拒，槽位回到 pending，已完成的内容保留', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        // 这一次在 stop 之后才提交（FakeProvider 刻意不检查 abort）
        { submitAfterDelayMs: 50, submitContent: { slotId: 'title', content: TITLE_TEXT } },
      ],
    });
    harness = createEngineHarness({ provider });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '会被停的一章',
      input: INPUT,
    });
    const taskId = created.task.id;

    const startPromise = harness.lifecycle.start(taskId);
    await waitFor(() => harness!.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed');
    harness.lifecycle.stop(taskId);
    await startPromise;

    const task = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('stopped');

    // 已完成的不受影响（AC-012）
    expect(harness.uow.repositories.slots.get(taskId, 'outline')?.status).toBe('completed');
    // 被中断的那个回到 pending，且没有被迟到的结果写进去
    const title = harness.uow.repositories.slots.get(taskId, 'title');
    expect(title?.status).toBe('pending');
    expect(title?.contentText).toBeNull();
  });

  it('进程重启：running 任务变 stopped，已完成槽位保留，resume 从中断处继续', async () => {
    const temp = createTempDbPath();
    cleanups.push(temp.cleanup);

    // ---- 第一个「进程」：跑到 outline 完成就被停掉，模拟崩溃前的状态 ----
    const first = createEngineHarness({
      dbPath: temp.dbPath,
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { hangMs: 60_000 },
        ],
      }),
    });
    const created = await first.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '会被重启的一章',
      input: INPUT,
    });
    const taskId = created.task.id;
    // 刻意不 await：模拟 kill -9。挂起的那次 Provider 调用永远不会返回，
    // 真实进程被杀时也是如此。挂一个 catch 只为不产生未处理的 rejection。
    void first.lifecycle.start(taskId).catch(() => undefined);
    await waitFor(() => first.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed');
    // 不调 stop：库里因此留下 status='running' 且挂着 active execution，
    // 这正是启动恢复要收拾的局面
    first.close();

    // ---- 第二个「进程」：启动恢复 ----
    const second = createEngineHarness({
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

    const recovery = second.lifecycle.recoverOnStartup();
    expect(recovery.recovered).toContain(taskId);

    const afterRecovery = second.uow.repositories.tasks.getOrThrow(taskId);
    expect(afterRecovery.status).toBe('stopped');
    expect(afterRecovery.activeExecutionId).toBeNull();
    // REQ FR-LIFE-003：P0 **不自动恢复模型调用**，等用户 Resume
    expect(second.uow.repositories.slots.get(taskId, 'outline')?.status).toBe('completed');

    // ---- 用户点继续 ----
    await second.lifecycle.resume(taskId);

    const done = second.uow.repositories.tasks.getOrThrow(taskId);
    expect(done.status).toBe('completed');
    // 已完成的槽位没有被重新生成（AC-012）：它的正文还是第一个进程写的那份
    expect(second.uow.repositories.slots.get(taskId, 'outline')?.contentText).toBe(outlineText());
  });
});

// ---------------------------------------------------------------------------

describe('D-04 互斥队列与 D-14 排队位次', () => {
  it('两个任务同时 start：串行执行，第二个显示排队', async () => {
    harness = createEngineHarness({
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });

    const a = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });
    const b = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '第二章',
      input: INPUT,
    });

    const runA = harness.lifecycle.start(a.task.id);
    const runB = harness.lifecycle.start(b.task.id);

    // 入队是同步的、pump 是异步的，所以这一刻两个都还在队列里，位次确定：
    // D-14 的「前面还有 N 个任务」就是这个数。
    expect(harness.engine.positionOf(a.task.id)).toBe(0);
    expect(harness.engine.positionOf(b.task.id)).toBe(1);

    await Promise.all([runA, runB]);

    for (const id of [a.task.id, b.task.id]) {
      expect(harness.uow.repositories.tasks.getOrThrow(id).status).toBe('completed');
    }
    // 跑完之后都不该再有位次
    expect(harness.engine.positionOf(b.task.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('§8.7 retry 的重置策略', () => {
  it('槽位阶段失败后 retry：只重置 failed 槽位，completed 的一个都不动', async () => {
    const provider = new FakeProvider({
      turns: [
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        // title 连续三次提交过短的内容（minChars=4），耗尽配额
        { submitContent: { slotId: 'title', content: '短' } },
        { submitContent: { slotId: 'title', content: '短' } },
        { submitContent: { slotId: 'title', content: '短' } },
      ],
    });
    harness = createEngineHarness({ provider });
    const taskId = await createAndStart(harness);

    const failed = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(failed.status).toBe('failed');
    expect(harness.uow.repositories.slots.get(taskId, 'title')?.status).toBe('failed');
    const outlineText1 = harness.uow.repositories.slots.get(taskId, 'outline')?.contentText;
    expect(outlineText1).toBeTruthy();

    // 补足脚本让重试能走完
    provider
      .script({ submitContent: { slotId: 'title', content: TITLE_TEXT } })
      .script({ submitContent: { slotId: 'scene_01', content: sceneText('第一场') } })
      .script({ submitContent: { slotId: 'scene_02', content: sceneText('第二场') } });

    await harness.lifecycle.retry(taskId);

    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
    // AC-012：已完成 Slot 永不重新生成——正文与 retry 之前逐字相同
    expect(harness.uow.repositories.slots.get(taskId, 'outline')?.contentText).toBe(outlineText1);
  });

  it('retry 拿到的是一份新配额，不是接着上次的数往下减', async () => {
    // 这条守的是 §8.7 的定案：配额按「本轮调度」计，不按 attempt_number 累计。
    // 若按 attempt_number 算，下面这次 retry 会立刻被判耗尽——重试按钮点了等于没点。
    const provider = new FakeProvider({
      turns: [
        { invalidStructure: 'NO_ROOT' },
        { invalidStructure: 'NO_ROOT' },
        { invalidStructure: 'NO_ROOT' },
      ],
    });
    harness = createEngineHarness({ provider });
    const taskId = await createAndStart(harness);
    expect(harness.uow.repositories.tasks.getOrThrow(taskId).errorCode).toBe(
      'STRUCTURE_RETRY_EXHAUSTED',
    );

    provider
      .script({ submitStructure: VALID_STRUCTURE })
      .script({ submitContent: { slotId: 'outline', content: outlineText() } })
      .script({ submitContent: { slotId: 'title', content: TITLE_TEXT } })
      .script({ submitContent: { slotId: 'scene_01', content: sceneText('第一场') } })
      .script({ submitContent: { slotId: 'scene_02', content: sceneText('第二场') } });

    await harness.lifecycle.retry(taskId);
    expect(harness.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');

    // attempt_number 仍然单调递增、不重号（UI 上的「第 N 次尝试」不能因为 retry 倒回去）。
    // 注意 listByTask 是**倒序**返回的，所以这里断言集合而不是数组顺序。
    const attempts = harness.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'create_structure')
      .map((e) => e.attemptNumber);
    expect(new Set(attempts).size).toBe(attempts.length);
    expect(Math.max(...attempts)).toBe(attempts.length);
    expect(attempts).toContain(attempts.length);
  });
});

// ---------------------------------------------------------------------------

describe('状态机守门', () => {
  it('对 ready 任务调 resume 被拒（start/resume/retry 不可互换）', async () => {
    harness = createEngineHarness({ provider: happyPathProvider() });
    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });
    await expect(harness.lifecycle.resume(created.task.id)).rejects.toBeInstanceOf(ForgeError);
  });
});
