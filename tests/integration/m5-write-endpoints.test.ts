/**
 * M5-C：任务写端点、模板热重载、Provider 端点（文档 §9.1）。
 *
 * 本文件的重点不在「调用成功了吗」，而在两件更容易做错的事：
 *
 * 1. **写端点必须立刻返回，但校验失败必须同步可见。**
 *    这两条互相拉扯：不 await 就拿不到错误，await 就要挂几分钟。
 *    `lifecycle.dispatch()` 把两段拆开，这里逐条验它真的拆对了。
 *
 * 2. **凭据一个字节都不许出网（REQ §13）。**
 *    Provider 端点是全系统离密钥最近的地方——它就在 Registry 隔壁。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionDefaultsSchema,
  ProviderHealthSchema,
  ProviderListResponseSchema,
  TaskCommandResultSchema,
  TaskDetailSchema,
  TemplateDetailSchema,
} from '@shared/contracts.ts';
import { PublicErrorSchema } from '@shared/errors.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import {
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  waitFor,
} from '../fixtures/engine.ts';
import { createTemplateWorkspace, type TemplateWorkspace } from '../fixtures/workspace.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };
/** FakeProvider 的 fixture 环境变量值。断言「它没出网」时对着它查 */
const FAKE_KEY = 'sk-fake-not-a-real-key';

let harness: ApiHarness | null = null;
let workspace: TemplateWorkspace | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  await workspace?.cleanup();
  workspace = null;
});

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

function open(options: { provider?: FakeProvider; templatesDir?: string; skillsDir?: string } = {}): ApiHarness {
  harness = createApiHarness(options);
  return harness;
}

async function post(
  h: ApiHarness,
  url: string,
  body?: unknown,
): Promise<{ status: number; headers: Record<string, unknown>; json: unknown }> {
  const response = await h.server.inject({
    method: 'POST',
    url,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, headers: response.headers, json: response.json() };
}

// ===========================================================================
// POST /api/tasks
// ===========================================================================

describe('POST /api/tasks', () => {
  it('仅创建：201 + Location，任务停在 ready，引擎一点没动', async () => {
    const h = open();
    const response = await post(h, '/api/tasks', {
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });

    expect(response.status).toBe(201);
    const result = TaskCommandResultSchema.parse(response.json);
    expect(result.status).toBe('ready');
    expect(result.queued).toBe(false);
    expect(result.position).toBeNull();
    expect(response.headers['location']).toBe(`/api/tasks/${result.taskId}`);

    // 「仅创建」的判据是**没有开始生产**，不是「返回了 ready」——
    // 后者在引擎已经跑起来的情况下也可能短暂成立
    expect(h.forge.uow.repositories.executions.listByTask(result.taskId)).toEqual([]);
  });

  it('?start=true：同一个端点，末尾多一次 dispatch（§9.1）', async () => {
    const h = open({ provider: happyPathProvider() });
    const response = await post(h, '/api/tasks?start=true', {
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });

    expect(response.status).toBe(201);
    const result = TaskCommandResultSchema.parse(response.json);
    // 状态迁移是同步做完的，所以这时候一定已经不是 ready 了
    expect(result.status).not.toBe('ready');

    // 后台那段跑完之后才是 completed。HTTP 没有等它——这正是重点
    await h.forge.engine.drain();
    expect(h.forge.uow.repositories.tasks.getOrThrow(result.taskId).status).toBe('completed');
  });

  it('请求体缺字段 → 400 TASK_INPUT_INVALID，且点名是哪个字段', async () => {
    const h = open();
    const response = await post(h, '/api/tasks', { templateId: 'zhihu-chapter' });
    expect(response.status).toBe(400);
    const error = PublicErrorSchema.parse(response.json);
    expect(error.code).toBe('TASK_INPUT_INVALID');
    // 一句笼统的「请求体非法」只能靠猜
    expect(error.message).toContain('name');
  });

  it('D-08：draft / archived 不得用于建新任务，报的是 NOT_PUBLISHED 而不是 NOT_FOUND', async () => {
    const h = open();
    for (const templateId of ['draft-chapter', 'archived-chapter']) {
      const response = await post(h, '/api/tasks', { templateId, name: 'x', input: INPUT });
      expect(response.status).toBe(400);
      const error = PublicErrorSchema.parse(response.json);
      // 对着一个自己刚建的模板说「不存在」是最令人困惑的错误
      expect(error.code).toBe('TEMPLATE_NOT_PUBLISHED');
    }
  });

  it('?start 只认 true/false，写别的 → 400 而不是当成 false 悄悄只创建', async () => {
    const h = open();
    const body = { templateId: 'zhihu-chapter', name: '第一章', input: INPUT };
    const response = await post(h, '/api/tasks?start=yes', body);
    expect(response.status).toBe(400);
    expect(PublicErrorSchema.parse(response.json).location).toBe('query:start');
  });
});

// ===========================================================================
// 生命周期动作
// ===========================================================================

describe('POST /api/tasks/:id/{start,stop,resume,retry}', () => {
  /** 建一个 ready 任务 */
  async function ready(h: ApiHarness, name = '第一章'): Promise<string> {
    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name,
      input: INPUT,
    });
    return created.task.id;
  }

  it('start 立刻返回，不等一次生产跑完', async () => {
    // 结构那一轮挂 60 秒。若路由 await 了后台那段，这个请求要 60 秒才回，
    // 而 inject 会在测试超时之前一直卡着
    const h = open({ provider: new FakeProvider({ turns: [{ hangMs: 60_000 }] }) });
    const taskId = await ready(h);

    const startedAt = Date.now();
    const response = await post(h, `/api/tasks/${taskId}/start`);
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(TaskCommandResultSchema.parse(response.json).status).toBe('running');
    expect(elapsed, 'start 端点必须立刻返回').toBeLessThan(1000);

    // 后台确实在跑
    await waitFor(() => h.forge.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId !== null);
    h.forge.lifecycle.stop(taskId);
    await h.forge.engine.drain();
  });

  it('状态机拒绝的动作 → 409 TASK_STATE_INVALID，而不是 200 加一条未处理的 rejection', async () => {
    const h = open();
    const taskId = await ready(h);

    // ready 的任务不能 resume，也不能 retry
    for (const action of ['resume', 'retry']) {
      const response = await post(h, `/api/tasks/${taskId}/${action}`);
      expect(response.status, `${action} 应当 409`).toBe(409);
      const error = PublicErrorSchema.parse(response.json);
      expect(error.code).toBe('TASK_STATE_INVALID');
      expect(error.action).toBe('刷新页面查看最新状态');
    }

    // 被拒之后任务一动没动
    expect(h.forge.uow.repositories.tasks.getOrThrow(taskId).status).toBe('ready');
    expect(h.forge.uow.repositories.executions.listByTask(taskId)).toEqual([]);
  });

  it('任务不存在 → 404，四个动作都是', async () => {
    const h = open();
    for (const action of ['start', 'stop', 'resume', 'retry']) {
      const response = await post(h, `/api/tasks/nope/${action}`);
      expect(response.status, action).toBe(404);
      expect(PublicErrorSchema.parse(response.json).code).toBe('TASK_NOT_FOUND');
    }
  });

  it('stop → resume：已完成的槽位不重跑（AC-012）', async () => {
    const h = open({
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { hangMs: 60_000 },
          // resume 之后从 title 接着走
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });
    const taskId = await ready(h);
    await post(h, `/api/tasks/${taskId}/start`);
    await waitFor(() => h.forge.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed');

    const stopped = TaskCommandResultSchema.parse((await post(h, `/api/tasks/${taskId}/stop`)).json);
    expect(stopped.status).toBe('stopped');
    await h.forge.engine.drain();

    const outlineBefore = h.forge.uow.repositories.slots.get(taskId, 'outline')?.contentText;
    expect(TaskCommandResultSchema.parse((await post(h, `/api/tasks/${taskId}/resume`)).json).status).toBe(
      'running',
    );
    await h.forge.engine.drain();

    expect(h.forge.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
    // 已完成的那一个内容一个字没变，也没有为它再建一次 execution
    expect(h.forge.uow.repositories.slots.get(taskId, 'outline')?.contentText).toBe(outlineBefore);
    const outlineExecutions = h.forge.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.targetSlotId === 'outline');
    expect(outlineExecutions).toHaveLength(1);
  });

  it('retry 一个结构失败的任务：清空重来，且失败原因被清掉', async () => {
    const h = open({
      provider: new FakeProvider({
        turns: [
          // 用「只说话不提交」把 3 次 attempt 配额耗光（createStructure 的 maxRetries=2）。
          // 这里刻意**不用** invalidStructure：D-20 规定被拒的提交不消耗 attempt，
          // 模型可以在同一次 Assignment 内接着改，所以三次非法提交换不来一次 failed——
          // 它只会在第四个 turn 上把合法结构提交上去然后成功。
          { emitText: ['我想想。'], neverSubmit: true },
          { emitText: ['我再想想。'], neverSubmit: true },
          { emitText: ['还是没想好。'], neverSubmit: true },
          // retry 之后这次给个合法的
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });
    const taskId = await ready(h);
    await post(h, `/api/tasks/${taskId}/start`);
    await h.forge.engine.drain();
    expect(h.forge.uow.repositories.tasks.getOrThrow(taskId).status).toBe('failed');

    expect(TaskCommandResultSchema.parse((await post(h, `/api/tasks/${taskId}/retry`)).json).status).toBe(
      'running',
    );
    await h.forge.engine.drain();

    const task = h.forge.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('completed');
    // 残留的失败原因会让完成的任务在界面上带着一条旧错误
    expect(task.errorCode).toBeNull();
    expect(task.errorMessage).toBeNull();
  });

  it('D-14：第二个任务被排在队列里，而不是被 ENGINE_BUSY 顶回来', async () => {
    const h = open({ provider: new FakeProvider({ turns: [{ hangMs: 60_000 }] }) });
    const first = await ready(h, '第一章');
    const second = await ready(h, '第二章');

    await post(h, `/api/tasks/${first}/start`);
    await waitFor(() => h.forge.uow.repositories.tasks.getOrThrow(first).activeExecutionId !== null);

    const queued = TaskCommandResultSchema.parse((await post(h, `/api/tasks/${second}/start`)).json);
    // 直接返回 429 会逼用户手动轮询——那正是队列存在的理由
    expect(queued.queued).toBe(true);
    expect(queued.position).toBe(0);

    // 排队中的任务在列表里显示为「排队中」而不是「正在跑」（附录 B.1 第 2 行）
    const detail = TaskDetailSchema.parse(
      (await h.server.inject({ method: 'GET', url: `/api/tasks/${second}` })).json(),
    );
    expect(detail.queuePosition).toBe(0);
    expect(detail.presentation.state).toBe('排队中');

    h.forge.lifecycle.stop(first);
    h.forge.lifecycle.stop(second);
    await h.forge.engine.drain();
  });
});

describe('stop 与 resume 的竞态（M5 审查补正）', () => {
  it('stop 之后**紧接着** resume，任务不会卡在 running', async () => {
    /**
     * 这是本次审查抓到的最严重的一条，值得把复现条件写清楚。
     *
     * `stop` 返回时 tick 并没有立刻结束——它还要等 Provider 的流解绑、
     * 缓冲区刷盘、controller 摘除，而引擎的 `runningTaskId` 要到
     * `runPump` 的 finally 才清空。原来的 `enqueue` 判据里有一句
     * 「正在跑的就别重复入队」，落在这段窗口里的 resume 于是被静默丢弃：
     * 状态已经被同步改成 running、trace 也写了，却没有任何东西会再推它。
     *
     * 用例刻意把 stop 与 resume 压在**同一个同步块**里。分两次 await
     * （比如依次发两个 HTTP 请求）的话，中间那一步 await 恰好够 tick 收尾，
     * 窗口就错过了——最初的 HTTP 版用例就是这么假绿的。
     * 真实环境窗口更长：真 Provider 的连接拆除要走网络。
     */
    const h = open({
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { hangMs: 60_000 },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });
    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '停了马上继续',
      input: INPUT,
    });
    const taskId = created.task.id;

    await post(h, `/api/tasks/${taskId}/start`);
    await waitFor(() => h.forge.uow.repositories.slots.get(taskId, 'title')?.status === 'running');

    // 同一个同步块：中间不给事件循环任何喘息的机会
    h.forge.lifecycle.stop(taskId);
    h.forge.lifecycle.dispatch('resume', taskId);

    await h.forge.engine.drain();

    const task = h.forge.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status, '永久 running 是本系统最不能接受的状态').not.toBe('running');
    expect(task.status).toBe('completed');
    // 已完成的槽位没被重跑（AC-012）
    const outlineExecutions = h.forge.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.targetSlotId === 'outline' && e.status === 'succeeded');
    expect(outlineExecutions).toHaveLength(1);
  });

  it('resume 的 Promise 必须等**它自己那一轮**跑完才 resolve', async () => {
    /**
     * 与上一条同源，但守的是另一半。
     *
     * `enqueue` 现在允许一个正在跑的任务再次入队，于是同一个 taskId 上
     * 会同时挂着两轮的等待者。若 `runPump` 等到 finally 才去 `settlers.get`，
     * 属于第二轮的等待者会被**第一轮**的结束顺手 resolve 掉——
     * `await lifecycle.resume(id)` 返回时，resume 的工作其实一点没做。
     *
     * 断言的落点因此是「done resolve 的那一刻，任务已经跑完了」，
     * 而不是「最终会跑完」——后者加一次 drain() 也成立，等于没测。
     */
    const h = open({
      provider: new FakeProvider({
        turns: [
          { hangMs: 60_000 },
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { submitContent: { slotId: 'title', content: TITLE_TEXT } },
          { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
          { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        ],
      }),
    });
    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '两轮各自结算',
      input: INPUT,
    });
    const taskId = created.task.id;

    await post(h, `/api/tasks/${taskId}/start`);
    await waitFor(() => h.forge.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId !== null);

    // 同一个同步块：resume 的入队落在第一轮还没收尾的窗口里
    h.forge.lifecycle.stop(taskId);
    const { done } = h.forge.lifecycle.dispatch('resume', taskId);

    await done;
    // 刻意不 drain()：这里问的是「done 到底代表哪一轮结束了」
    expect(
      h.forge.uow.repositories.tasks.getOrThrow(taskId).status,
      'done resolve 时，resume 那一轮必须已经跑完',
    ).toBe('completed');
  });
});

// ===========================================================================
// 后台推进逃逸出来的异常
// ===========================================================================

describe('引擎的逃逸异常收尾（M5-C 补正）', () => {
  /**
   * 把快照的 `compiled_json` 改坏，让 `tick` 的第一行（readSnapshot）就抛。
   *
   * 直接写库是刻意的：仓储层没有、也不该有「写出一份坏 JSON」的入口，
   * 而这条用例要验的恰恰是「万一库里有了会怎样」——
   * 坏快照的真实来源是一次崩溃、一次手改数据库，或将来某个序列化改动。
   *
   * 这不是「模型出错」那条已经被处理得很好的路径，而是「引擎自己抛了」，
   * 三道防永久 running 的网（Runtime 超时 / 重试配额 / 启动恢复）里
   * 没有一道盖得住它。
   */
  function corruptSnapshot(h: ApiHarness, taskId: string): void {
    h.forge.db
      .prepare("UPDATE task_snapshots SET compiled_json = '这不是 JSON' WHERE task_id = ?")
      .run(taskId);
  }

  async function seed(h: ApiHarness, name: string): Promise<string> {
    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name,
      input: INPUT,
    });
    return created.task.id;
  }

  it('tick 抛出时任务落到 failed，而不是永远 running', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await seed(h, '快照坏掉的一章');
    corruptSnapshot(h, taskId);

    // 请求本身是成功的：状态迁移这一段没问题，抛在后台那一段
    expect((await post(h, `/api/tasks/${taskId}/start`)).status).toBe(200);
    await h.forge.engine.drain();

    const task = h.forge.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status, '永久 running 是本系统最不能接受的状态').toBe('failed');
    expect(task.activeExecutionId).toBeNull();
    // D-19：写进去的要是一句能直接显示的话
    expect(task.errorMessage).toBeTruthy();
    expect(task.errorMessage).not.toBe(task.errorCode);
  });

  it('一个任务把引擎搞挂之后，下一个任务照样能跑完', async () => {
    // 这条才是那个 catch 存在的主要理由。`pump = pump.then(runPump)` 一旦
    // 变成 rejected，后续每一次 enqueue 挂上去的 then 都不会执行——
    // 进程活着，但从此再也跑不动任何任务，且只在控制台留一条 unhandled rejection。
    const h = open({ provider: happyPathProvider() });
    const broken = await seed(h, '快照坏掉的一章');
    const healthy = await seed(h, '正常的一章');
    corruptSnapshot(h, broken);

    await post(h, `/api/tasks/${broken}/start`);
    await h.forge.engine.drain();
    expect(h.forge.uow.repositories.tasks.getOrThrow(broken).status).toBe('failed');

    await post(h, `/api/tasks/${healthy}/start`);
    await h.forge.engine.drain();
    expect(h.forge.uow.repositories.tasks.getOrThrow(healthy).status).toBe('completed');
  });

  it('非 ForgeError 的原始 message 不进 task.error_message', async () => {
    // `task.error_message` 既要出网也要显示给用户，而一个裸 Error 的 message
    // 里可能带表名、SQL、绝对路径——与 §9.3「原始错误只进日志」是同一条纪律。
    const h = open({ provider: happyPathProvider() });
    const taskId = await seed(h, '会抛裸 Error 的一章');
    // 让 readSnapshot 之后的某一步抛一个非 ForgeError
    const registry = h.forge.registry as unknown as { resolve: (alias: string) => never };
    const original = registry.resolve.bind(registry);
    registry.resolve = ((): never => {
      throw new Error('sqlite: no such table: secret_internal_table /Users/someone/private');
    }) as never;

    await post(h, `/api/tasks/${taskId}/start`);
    await h.forge.engine.drain();
    registry.resolve = original as never;

    const task = h.forge.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorMessage).not.toContain('secret_internal_table');
    expect(task.errorMessage).not.toContain('/Users/');
  });
});

describe('投影出来的 error 字段（附录 A 的 M5 审查补正）', () => {
  it('stop 之后执行记录里的 message 是中文，不是 USER_STOP 这种内部字面量', async () => {
    /**
     * `executions.error_message` 会经 `ExecutionView.error.message` 投影到 API，
     * 显示在 UX §13.5 的技术详情面板上。原先写进去的是 `'USER_STOP'`——
     * 用户在界面上看到的是一串英文常量名。
     *
     * 附录 A 的「不直接返回给用户」管的是 HTTP 错误响应体的 code，
     * 不禁止 `EXECUTION_CANCELLED` 出现在投影字段里（那是对一次已发生的执行的
     * 诊断记录，把它换成 STORAGE_ERROR 反而是撒谎）。真正的要求是 D-19：
     * **成文责任在 lifecycle 层，写进去的时候就得是一句人话。**
     */
    const h = open({ provider: new FakeProvider({ turns: [{ hangMs: 60_000 }] }) });
    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '会被停的一章',
      input: INPUT,
    });
    const taskId = created.task.id;

    await post(h, `/api/tasks/${taskId}/start`);
    await waitFor(() => h.forge.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId !== null);
    await post(h, `/api/tasks/${taskId}/stop`);
    await h.forge.engine.drain();

    const response = await h.server.inject({ method: 'GET', url: `/api/tasks/${taskId}/executions` });
    expect(response.statusCode).toBe(200);
    const cancelled = (response.json() as { status: string; error: { code: string; message: string } | null }[])
      .find((e) => e.status === 'cancelled');

    expect(cancelled, '停止之后应当有一条 cancelled 的执行记录').toBeDefined();
    // 诊断码保留——技术详情面板要的就是它
    expect(cancelled?.error?.code).toBe('EXECUTION_CANCELLED');
    // 但 message 必须是能直接上屏的中文
    expect(cancelled?.error?.message).not.toBe('USER_STOP');
    expect(cancelled?.error?.message).toContain('停止');
    expect(response.body).not.toContain('USER_STOP');
  });
});

// ===========================================================================
// POST /api/templates/:id/reload
// ===========================================================================

describe('POST /api/templates/:id/reload', () => {
  it('重扫磁盘并返回新详情；已存在的任务读的还是自己的冻结快照（AC-002）', async () => {
    workspace = await createTemplateWorkspace();
    const h = open({
      provider: happyPathProvider(),
      templatesDir: workspace.templatesDir,
      skillsDir: workspace.skillsDir,
    });

    const created = await h.forge.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '改模板之前建的一章',
      input: INPUT,
    });
    const before = TemplateDetailSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/templates/zhihu-chapter' })).json(),
    );
    expect(before.name).toBe('知乎盐选单章结构槽生产');

    await workspace.patchTemplate(
      'zhihu-chapter',
      'name: 知乎盐选单章结构槽生产',
      'name: 改过名字的模板',
    );

    // 不重载就看不到变化——目录是有缓存的
    const stale = TemplateDetailSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/templates/zhihu-chapter' })).json(),
    );
    expect(stale.name).toBe('知乎盐选单章结构槽生产');

    const reloaded = TemplateDetailSchema.parse((await post(h, '/api/templates/zhihu-chapter/reload')).json);
    expect(reloaded.name).toBe('改过名字的模板');

    // 而那个先建的任务显示的仍然是它创建时那份模板的名字：
    // 从磁盘现读会让改一次模板名把所有历史任务的显示都改掉
    const detail = TaskDetailSchema.parse(
      (await h.server.inject({ method: 'GET', url: `/api/tasks/${created.task.id}` })).json(),
    );
    expect(detail.templateName).toBe('知乎盐选单章结构槽生产');
  });

  it('重载后模板已不存在 → 404，而不是继续返回缓存里那份', async () => {
    workspace = await createTemplateWorkspace();
    const h = open({ templatesDir: workspace.templatesDir, skillsDir: workspace.skillsDir });

    // 先把它读进缓存
    expect((await h.server.inject({ method: 'GET', url: '/api/templates/draft-chapter' })).statusCode).toBe(200);
    // 改坏它：重载后它会落进 failures，不再出现在 templates 里
    await workspace.patchTemplate('draft-chapter', 'status: draft', 'status: 不存在的状态');

    const response = await post(h, '/api/templates/draft-chapter/reload');
    expect(response.status).toBe(404);
    expect(PublicErrorSchema.parse(response.json).code).toBe('TEMPLATE_NOT_FOUND');
  });
});

// ===========================================================================
// Provider 端点（D-03）
// ===========================================================================

describe('GET /api/providers', () => {
  it('只出环境变量名与「配没配」，密钥值一个字节都不出网（REQ §13）', async () => {
    const h = open();
    const response = await h.server.inject({ method: 'GET', url: '/api/providers' });
    expect(response.statusCode).toBe(200);
    const body = ProviderListResponseSchema.parse(response.json());

    const provider = body.providers[0];
    expect(provider?.apiKeyEnv).toBe('FAKE_API_KEY');
    expect(provider?.apiKeyPresent).toBe(true);

    // 断言的是**响应全文**，不是某个字段：密钥最可能的泄漏方式
    // 是随手把整个对象塞进某个 note / message 里
    expect(response.body).not.toContain(FAKE_KEY);
    expect(response.body).not.toContain('apiKey"');
  });

  it('别名映射带 usageCount，且 structure 不是 0', async () => {
    const h = open();
    const body = ProviderListResponseSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/providers' })).json(),
    );

    const byAlias = new Map(body.aliases.map((a) => [a.alias, a]));
    // 码点序，不随 YAML 书写序变
    expect(body.aliases.map((a) => a.alias)).toEqual(['main', 'structure']);
    expect(byAlias.get('main')?.model).toBe('fake-model');
    expect(byAlias.get('main')?.providerName).toBe('Fake');

    // 只数「槽位类型绑定」会让 structure 恒为 0——它只被 createStructure 引用。
    // 这一栏要回答的是「改掉它会影响到谁」，报 0 等于说「随便改」。
    // 四个 fixture 模板里有三个加载得出来，每个都有一条 createStructure。
    expect(byAlias.get('structure')?.usageCount).toBeGreaterThan(0);
    // main 被各模板的 fillSlotByType 引用，条数比 structure 多
    expect(byAlias.get('main')?.usageCount).toBeGreaterThan(
      byAlias.get('structure')?.usageCount ?? 0,
    );
  });

  it('D-04：concurrentSlots 固定 1，defaults 端点与列表里那份是同一个', async () => {
    const h = open();
    const standalone = ExecutionDefaultsSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/providers/defaults' })).json(),
    );
    const inList = ProviderListResponseSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/providers' })).json(),
    ).defaults;

    expect(standalone.concurrentSlots).toBe(1);
    // 两处给的值不一样会让「设置页显示的默认值」与「实际生效的默认值」分家
    expect(standalone).toEqual(inList);
  });
});

describe('POST /api/providers/:id/probe', () => {
  it('探测结果落到健康状态上，后续列表读到的是同一份', async () => {
    const h = open();
    const probed = ProviderHealthSchema.parse((await post(h, '/api/providers/fake/probe')).json);
    expect(probed.checkedAt).not.toBeNull();

    const listed = ProviderListResponseSchema.parse(
      (await h.server.inject({ method: 'GET', url: '/api/providers' })).json(),
    ).providers[0]?.health;
    expect(listed).toEqual(probed);
  });

  it('探测失败不许伪造 ok，且 note 里不带我们刚发出去的请求头', async () => {
    const h = open();
    const probed = ProviderHealthSchema.parse((await post(h, '/api/providers/fake/probe')).json);

    // FakeProvider 没实现 probe，那就要如实说「不支持探测」。
    // 返回一个假的 ok 会让「设置页显示正常但任务全失败」成为可能，
    // 而那正是这个页面要防的事。
    expect(probed.status).toBe('down');
    expect(probed.note).toBe('该 Provider 不支持连通性探测');
    expect(JSON.stringify(probed)).not.toContain(FAKE_KEY);
  });

  it('未知 provider → 503 PROVIDER_UNAVAILABLE', async () => {
    const h = open();
    const response = await post(h, '/api/providers/no-such-provider/probe');
    expect(response.status).toBe(503);
    expect(PublicErrorSchema.parse(response.json).code).toBe('PROVIDER_UNAVAILABLE');
  });
});
