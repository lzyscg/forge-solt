/**
 * M5-D：SSE（文档 §9.4）。
 *
 * M5 的完成判据点名四件事：**连接、收 trace、断线后 `Last-Event-ID` 补发、心跳、
 * 任务终态后不推 delta**。这四条都在下面，且分两个层次验：
 *
 * - **Hub 层**（假客户端）：事件语义、补发游标、去重、退订。
 *   假客户端只是一个 `write` 收集器，所以能同步断言，不必与网络赛跑。
 * - **HTTP 层**（真监听 + 真 fetch）：响应头、hijack 之后的生命周期、断开清理。
 *   这一层不能用 `app.inject()`——它会等响应结束，而 SSE 的响应永远不结束。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SseDeltaEventSchema, SseStateEventSchema } from '@shared/contracts.ts';
import { TraceEventSchema } from '@shared/trace.ts';
import { PublicErrorSchema } from '@shared/errors.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import type { SseClient } from '@server/infrastructure/sse-hub.ts';
import {
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
} from '../fixtures/engine.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: ApiHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
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

// ---------------------------------------------------------------------------
// 一个只收集字符串的假客户端 + 一个极小的 SSE 帧解析器
// ---------------------------------------------------------------------------

interface Frame {
  id: number | null;
  event: string | null;
  data: string | null;
  comment: string | null;
}

class Collector implements SseClient {
  readonly chunks: string[] = [];
  /** 置为 true 后 `write` 抛错，用来模拟对端已经走了 */
  broken = false;

  write(chunk: string): void {
    if (this.broken) throw new Error('EPIPE');
    this.chunks.push(chunk);
  }

  get frames(): Frame[] {
    return parseFrames(this.chunks.join(''));
  }

  eventsOf(name: string): Frame[] {
    return this.frames.filter((f) => f.event === name);
  }
}

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const frame: Frame = { id: null, event: null, data: null, comment: null };
      for (const line of block.split('\n')) {
        if (line.startsWith(': ')) frame.comment = line.slice(2);
        else if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      return frame;
    });
}

function open(options: Parameters<typeof createApiHarness>[0] = {}): ApiHarness {
  harness = createApiHarness(options);
  return harness;
}

async function seedCompletedTask(h: ApiHarness, name = '第一章'): Promise<string> {
  const created = await h.forge.snapshots.createTask({
    templateId: 'zhihu-chapter',
    name,
    input: INPUT,
  });
  await h.forge.lifecycle.start(created.task.id);
  return created.task.id;
}

async function seedReadyTask(h: ApiHarness, name = '第一章'): Promise<string> {
  const created = await h.forge.snapshots.createTask({
    templateId: 'zhihu-chapter',
    name,
    input: INPUT,
  });
  return created.task.id;
}

// ===========================================================================
// Hub 层
// ===========================================================================

describe('SseHub：事件语义', () => {
  it('trace 带 id（= sequence），delta 不带 —— 只有前者可补发', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);

    const event = h.forge.traces.emit({
      taskId,
      executionId: null,
      actor: 'system',
      kind: 'task_state_changed',
      title: '测试事件',
      summary: '一条轨迹',
      payload: null,
    });
    h.forge.sse.publishDelta(taskId, { executionId: 'exec-1', text: '她戴上耳机，' });

    const trace = client.eventsOf('trace')[0];
    expect(trace?.id).toBe(event.sequence);
    expect(TraceEventSchema.parse(JSON.parse(trace?.data ?? '{}')).title).toBe('测试事件');

    const delta = client.eventsOf('delta')[0];
    // delta 是瞬时消息，正文的权威来源是 public_output_chunk。
    // 给它一个 id 会让重连时同一段正文被补发一次，产物区出现重复
    expect(delta?.id).toBeNull();
    expect(SseDeltaEventSchema.parse(JSON.parse(delta?.data ?? '{}')).text).toBe('她戴上耳机，');
  });

  it('state 只做失效通知：三个字段，不带完整状态', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);

    const state = client.eventsOf('state')[0];
    expect(state).toBeDefined();
    const parsed = SseStateEventSchema.parse(JSON.parse(state?.data ?? '{}'));
    expect(parsed).toEqual({ taskStatus: 'ready', phase: 'structure', activeSlotId: null });
    // 带上完整状态会让前端长出两套状态推导逻辑，两者必然打架
    expect(Object.keys(JSON.parse(state?.data ?? '{}') as object)).toHaveLength(3);
  });

  it('state 变了才推：连着十条不改变状态的 trace 只换来一条 state', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);
    const afterSubscribe = client.eventsOf('state').length;

    for (let i = 0; i < 10; i += 1) {
      h.forge.traces.emit({
        taskId,
        executionId: null,
        actor: 'agent',
        kind: 'work_plan',
        title: `第 ${String(i)} 条`,
        summary: '不改变任务状态',
        payload: null,
      });
    }

    expect(client.eventsOf('trace')).toHaveLength(10);
    // 每条 trace 都推一次 state 会让前端对着同一个状态反复 refetch，
    // 一次三千字的生成期间能刷出几十次无谓的请求
    expect(client.eventsOf('state')).toHaveLength(afterSubscribe);
  });

  it('订阅时立刻给一次状态校准 —— 下一条 trace 可能是几十秒之后的事', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);
    expect(client.eventsOf('state')).toHaveLength(1);
  });
});

describe('SseHub：断线补发', () => {
  it('after 游标是排他的，只补发 sequence 更大的那些', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await seedCompletedTask(h);

    const all = h.forge.uow.repositories.traces.listByTask(taskId);
    expect(all.length).toBeGreaterThan(5);
    const cursor = all[2]?.sequence ?? 0;

    const client = new Collector();
    h.forge.sse.subscribe(taskId, client, { after: cursor });

    const replayed = client.eventsOf('trace');
    expect(replayed).toHaveLength(all.length - 3);
    expect(replayed[0]?.id).toBe(all[3]?.sequence);
    // 补发的每一条都带 id，否则前端下一次重连的游标会退回去
    expect(replayed.every((f) => f.id !== null)).toBe(true);
  });

  it('补发不截断：超过一页（200 条）也要全部发完', async () => {
    // 这条守的是补发循环的翻页。少了它，第 201 条之后的轨迹会**静默消失**——
    // 前端看到的是一条完整、连续、但缺了后半段的时间线，没有任何报错。
    const h = open();
    const taskId = await seedReadyTask(h);
    for (let i = 0; i < 450; i += 1) {
      h.forge.traces.emit({
        taskId,
        executionId: null,
        actor: 'agent',
        kind: 'work_plan',
        title: `第 ${String(i)} 条`,
        summary: '批量',
        payload: null,
      });
    }

    const client = new Collector();
    h.forge.sse.subscribe(taskId, client, { after: 0 });
    expect(client.eventsOf('trace')).toHaveLength(450);
  });

  it('不传 after 就不补发 —— 首次连接不该被几百条历史淹掉', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await seedCompletedTask(h);

    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);
    expect(client.eventsOf('trace')).toHaveLength(0);
  });
});

describe('SseHub：终态与心跳', () => {
  it('任务进入终态后不再推 delta，但连接还开着（§9.4）', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await seedCompletedTask(h);

    const client = new Collector();
    h.forge.sse.subscribe(taskId, client, { after: 0 });
    expect(h.forge.sse.subscriberCount(taskId)).toBe(1);

    h.forge.sse.publishDelta(taskId, { executionId: 'late', text: '迟到的正文' });

    // 迟到的 delta 属于一次已经收尾的执行（AC-011）。推给前端会让产物区
    // 在任务显示「已完成」之后继续长出文字
    expect(client.eventsOf('delta')).toHaveLength(0);
    // 但连接保持——用户可能还在看这个任务
    expect(h.forge.sse.subscriberCount(taskId)).toBe(1);
  });

  it('运行中的任务照常推 delta', async () => {
    // 反面对照。没有它，上一条用「Hub 根本不推 delta」也能通过
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);

    h.forge.sse.publishDelta(taskId, { executionId: 'exec-1', text: '正在写' });
    expect(client.eventsOf('delta')).toHaveLength(1);
  });

  it('心跳是注释行，不是事件', async () => {
    // 用数组而不是 `let beat`：后者会被 TS 窄化成 null（它看不出回调被调过），
    // 于是 `beat?.()` 变成一个永远不会执行的表达式，测试静默通过
    const beats: Array<() => void> = [];
    const h = open({
      startHeartbeat: (fn) => {
        beats.push(fn);
        return () => beats.splice(0, beats.length);
      },
    });
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    h.forge.sse.subscribe(taskId, client);

    const beat = beats[0];
    expect(beat, '心跳定时器必须已经起了').toBeDefined();
    beat?.();
    beat?.();

    const comments = client.frames.filter((f) => f.comment === 'heartbeat');
    expect(comments).toHaveLength(2);
    // 注释行没有 event 也没有 data——前端的 onmessage 不该被它触发
    expect(comments.every((f) => f.event === null && f.data === null)).toBe(true);
  });

  it('心跳用的是 §9.4 规定的 15 秒', async () => {
    let interval = 0;
    const h = open({
      startHeartbeat: (_fn, intervalMs) => {
        interval = intervalMs;
        return () => undefined;
      },
    });
    await seedReadyTask(h);
    expect(interval).toBe(15_000);
  });
});

describe('SseHub：连接生命周期', () => {
  it('新订阅者的 state 基线只写给它自己，不广播给老连接', async () => {
    // 前端收到 state 就 `invalidateQueries` 全量重拉一次详情。广播的话，
    // 开着三个标签页时，任意一个刷新或自动重连（UX §18.11 说这是常态）
    // 都会让另外几个白打一次请求；反复重连就是「重连次数 × 在线标签数」的重拉风暴。
    const h = open();
    const taskId = await seedReadyTask(h);
    const first = new Collector();
    h.forge.sse.subscribe(taskId, first);
    expect(first.eventsOf('state')).toHaveLength(1);

    const second = new Collector();
    h.forge.sse.subscribe(taskId, second);
    expect(second.eventsOf('state'), '新连接要拿到自己的基线').toHaveLength(1);
    expect(first.eventsOf('state'), '老连接一条都不该多收').toHaveLength(1);
  });

  it('close() 之后不再接客：连接立刻被 end 掉，也不进订阅表', async () => {
    // 放进来的话，这条连接既收不到心跳（定时器已停）也永远不会被 end，
    // 而 Fastify 的 server.close() 正在等所有连接结束——优雅关闭挂到超时。
    // 触发窗口是真实存在的：preClose 跑在「关闭 HTTP server」之前，
    // 此时已经进入 handler 的 GET /stream 照样会走到 subscribe。
    const h = open();
    const taskId = await seedReadyTask(h);
    h.forge.sse.close();

    let ended = false;
    const late: SseClient = {
      write: () => undefined,
      end: () => {
        ended = true;
      },
    };
    const unsubscribe = h.forge.sse.subscribe(taskId, late);

    expect(ended, '迟到的连接必须被主动 end').toBe(true);
    expect(h.forge.sse.subscriberCount(taskId)).toBe(0);
    expect(() => {
      unsubscribe();
    }, '退订函数仍要可调用').not.toThrow();
  });

  it('补发中途抛出时把自己摘干净，不留下永久泄漏的订阅', async () => {
    // subscribe 里 `set.add` 已经执行、而调用方还没拿到 unsubscribe，
    // 这中间抛出的话订阅就永远留在表里了——`reply.hijack()` 之后
    // setErrorHandler 也已经没有 reply 可写
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();

    expect(() =>
      // 不存在的任务：readTraces 走 listTraces，会抛 TASK_NOT_FOUND
      h.forge.sse.subscribe('task-does-not-exist', client, { after: 0 }),
    ).toThrow();
    expect(h.forge.sse.subscriberCount('task-does-not-exist')).toBe(0);
    void taskId;
  });


  it('退订之后不再收到任何东西', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const client = new Collector();
    const unsubscribe = h.forge.sse.subscribe(taskId, client);
    unsubscribe();

    const before = client.chunks.length;
    h.forge.sse.publishDelta(taskId, { executionId: 'x', text: '不该收到' });
    h.forge.traces.emit({
      taskId,
      executionId: null,
      actor: 'system',
      kind: 'task_state_changed',
      title: '不该收到',
      summary: '',
      payload: null,
    });

    expect(client.chunks).toHaveLength(before);
    expect(h.forge.sse.subscriberCount(taskId)).toBe(0);
  });

  it('write 抛错的客户端被就地清掉，不影响同一任务上的其他订阅者', async () => {
    const h = open();
    const taskId = await seedReadyTask(h);
    const dead = new Collector();
    const alive = new Collector();
    h.forge.sse.subscribe(taskId, dead);
    h.forge.sse.subscribe(taskId, alive);

    dead.broken = true;
    h.forge.sse.publishDelta(taskId, { executionId: 'x', text: '第一条' });

    // 这条验的是 **Hub 的契约**（写失败即视为断连），不是真实 socket 的行为：
    // `http.ServerResponse.write()` 在底层 socket 已销毁时是**静默返回 false**、
    // 不抛异常的，所以生产里这段 catch 基本不会被触发。
    // 真正清理死连接的是 stream.ts 上挂的 close / error 监听器
    // （由本文件「断开后订阅者被清理」那条覆盖）——别以为这里有第二道网。
    expect(h.forge.sse.subscriberCount(taskId)).toBe(1);
    expect(alive.eventsOf('delta')).toHaveLength(1);
  });
});

// ===========================================================================
// HTTP 层：真监听 + 真 fetch
// ===========================================================================

describe('GET /api/tasks/:id/stream', () => {
  /** 起一个真端口。`inject()` 会等响应结束，而 SSE 的响应永远不结束 */
  async function listen(h: ApiHarness): Promise<string> {
    await h.server.listen({ port: 0, host: '127.0.0.1' });
    const address = h.server.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /**
   * 累积式读流。
   *
   * 两点是踩过坑才写成这样的：
   *
   * 1. **reader 必须复用。** 每次 `body.getReader()` 都会锁住流，
   *    第二次调用直接抛 `ReadableStream is locked`。
   * 2. **超时必须 race 进去。** `reader.read()` 在没有新数据时会一直挂着，
   *    只在两次 read 之间查 deadline 是查不到的——流不结束就永远读不完，
   *    表现为测试挂到 vitest 自己的超时，报错指向框架而不是断言。
   */
  class SseStream {
    readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
    readonly #decoder = new TextDecoder();
    text = '';

    constructor(body: ReadableStream<Uint8Array>) {
      this.#reader = body.getReader();
    }

    async until(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(this.text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          this.#reader.read(),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), remaining);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (result === 'timeout') break;
        if (result.done) break;
        this.text += this.#decoder.decode(result.value, { stream: true });
      }
      if (predicate(this.text)) return this.text;
      throw new Error(`等待超时，已收到：${JSON.stringify(this.text.slice(0, 600))}`);
    }

    async close(): Promise<void> {
      await this.#reader.cancel().catch(() => undefined);
    }
  }

  it('连接返回 text/event-stream，并立刻吐出第一个字节', async () => {
    const h = open();
    const base = await listen(h);
    const taskId = await seedReadyTask(h);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // no-transform：代理一旦压缩就会引入缓冲，流式光标当场变成一卡一卡的
    expect(response.headers.get('cache-control')).toContain('no-transform');

    // 有些客户端与代理要收到第一个字节才认为连接建立，
    // 而下一条真事件可能是几十秒后的事
    const stream = new SseStream(response.body as ReadableStream<Uint8Array>);
    expect(await stream.until((t) => t.includes(': connected'))).toContain(': connected');
    await stream.close();
    controller.abort();
  });

  it('实时收到 trace，且断开后订阅者被清理', async () => {
    const h = open();
    const base = await listen(h);
    const taskId = await seedReadyTask(h);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      signal: controller.signal,
    });
    const stream = new SseStream(response.body as ReadableStream<Uint8Array>);
    await stream.until((t) => t.includes(': connected'));

    h.forge.traces.emit({
      taskId,
      executionId: null,
      actor: 'system',
      kind: 'task_state_changed',
      title: '来自 HTTP 的一条',
      summary: '',
      payload: null,
    });
    expect(await stream.until((t) => t.includes('event: trace'))).toContain('来自 HTTP 的一条');

    controller.abort();
    await stream.close();
    // 断开后必须退订。漏掉的话，每一次刷新页面都会在 Hub 里留下一个
    // 永远不会被写成功的连接，而心跳会一直对着它们空转。
    // 给足余量：底层 socket 的 close 事件不保证在 abort 之后立刻到
    const deadline = Date.now() + 5000;
    while (h.forge.sse.subscriberCount(taskId) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.forge.sse.subscriberCount(taskId)).toBe(0);
  });

  it('Last-Event-ID 优先于 ?after= —— 否则每次重连都从头重放一遍', async () => {
    const h = open({ provider: happyPathProvider() });
    const base = await listen(h);
    const taskId = await seedCompletedTask(h);
    const all = h.forge.uow.repositories.traces.listByTask(taskId);
    const lastId = all[all.length - 2]?.sequence ?? 0;

    // 浏览器 EventSource 重连时会原样重发同一个 URL（连同当初那个 after），
    // 同时带上 Last-Event-ID。query 若赢，断线越多重复越多
    const controller = new AbortController();
    const response = await fetch(`${base}/api/tasks/${taskId}/stream?after=0`, {
      headers: { 'Last-Event-ID': String(lastId) },
      signal: controller.signal,
    });
    const stream = new SseStream(response.body as ReadableStream<Uint8Array>);
    const text = await stream.until((t) => t.includes('event: state'));
    await stream.close();
    controller.abort();

    const ids = parseFrames(text)
      .filter((f) => f.event === 'trace')
      .map((f) => f.id);
    // after=0 会补发全部；Last-Event-ID 只补最后一条
    expect(ids).toEqual([all[all.length - 1]?.sequence]);
  });

  it('不带 ?after 的首次连接不补发历史 —— 否则时间线里每条事件出现两次', async () => {
    // 前端打开工作台时会先 `GET /api/tasks/:id/traces` 拉一次历史，
    // 再连 SSE 收增量。首连若把历史全量重放一遍（实测一章 295 条），
    // 每条事件就会在时间线里出现两次，而 §9.4 只对 delta 说了「断线就丢」，
    // 没有要求前端按 sequence 去重。
    const h = open({ provider: happyPathProvider() });
    const base = await listen(h);
    const taskId = await seedCompletedTask(h);
    const total = h.forge.uow.repositories.traces.listByTask(taskId).length;
    expect(total).toBeGreaterThan(5);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      signal: controller.signal,
    });
    const stream = new SseStream(response.body as ReadableStream<Uint8Array>);
    // 等到 state 基线到达，说明补发那一段（如果有的话）已经走完了
    const text = await stream.until((t) => t.includes('event: state'));
    await stream.close();
    controller.abort();

    expect(parseFrames(text).filter((f) => f.event === 'trace')).toHaveLength(0);
  });

  it('任务不存在 → 404 JSON，而不是一条永远没有事件的流', async () => {
    const h = open();
    const base = await listen(h);

    const response = await fetch(`${base}/api/tasks/nope/stream`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(PublicErrorSchema.parse(await response.json()).code).toBe('TASK_NOT_FOUND');
  });

  it('?after 非法 → 400，且在 hijack 之前就报出来', async () => {
    const h = open();
    const base = await listen(h);
    const taskId = await seedReadyTask(h);

    // hijack 之后再抛错，setErrorHandler 已经没有 reply 可写了，
    // 客户端会收到一个空连接——既不是 400 也不是流
    const response = await fetch(`${base}/api/tasks/${taskId}/stream?after=abc`);
    expect(response.status).toBe(400);
    expect(PublicErrorSchema.parse(await response.json()).location).toBe('query:after');
  });
});
