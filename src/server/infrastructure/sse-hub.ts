/**
 * SSE 连接中枢（文档 §9.4）。
 *
 * 实现 `TracePublisher`，所以 `trace-service` 不认识它——那一层只知道
 * 「把事件送出去」这一个能力（见那里的端口注释）。
 *
 * 四类事件，三种不同的语义：
 *
 * - **`trace`** 带 `id`（= sequence）。浏览器 `EventSource` 会在重连时自动带上
 *   `Last-Event-ID` 头，服务端据此补发。这是唯一可补发的一类。
 * - **`delta`** 不带 id。它是流式光标用的瞬时消息，断线就丢——正文的权威来源是
 *   `public_output_chunk` trace（§7.7），补发 delta 会让同一段正文出现两次。
 * - **`state`** 只做失效通知，**不带完整状态**。带上完整状态会让前端长出两套
 *   状态推导逻辑（一套来自 REST、一套来自 SSE 增量），两者必然不一致。
 * - **`: heartbeat`** 注释行，防中间代理断连。它不是事件，没有 id 也没有 data。
 *
 * ## state 事件从哪来
 *
 * 没有任何一处代码显式调用「发个 state 事件」。本 Hub 观察 trace：
 * 每收到一条 trace 就读一次权威状态，与上次推送的三元组比对，**变了才推**。
 *
 * 这样做的理由是它不可能与真实状态漂移——数据源就是数据库。
 * 反过来（在 lifecycle / engine 的每个状态迁移处补一行 `publishState`）
 * 要改十几个调用点，而漏掉任何一个的表现是「界面卡在旧状态，刷新一下才对」，
 * 那正是最难被测试抓住、也最容易被当成偶发的一类 bug。
 *
 * ## 为什么 delta 在终态之后要停
 *
 * §9.4：任务进入终态后仍保持连接（用户可能还在看），但停止推 delta。
 * 迟到的 delta 属于一次已经被取消或已经收尾的执行（AC-011 的迟到结果），
 * 推给前端会让产物区在任务显示「已完成」之后继续长出文字。
 */

import type { SseDeltaEvent, SseStateEvent } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import type { TracePublisher } from '@server/application/trace-service.ts';

/**
 * 一个订阅者。
 *
 * 只要求 `write`，不要求是 `ServerResponse`：测试因此可以塞一个收集字符串的假客户端，
 * 而不必先起一个真的 HTTP 服务器。`write` 抛错视为连接已断（见 `#send`）。
 */
export interface SseClient {
  write(chunk: string): void;
  /**
   * 主动结束这条连接。`close()` 时调用。
   *
   * 可选是为了让假客户端不必实现它，但真实现（HTTP）**必须**给：
   * Fastify 的 `server.close()` 会等所有连接结束，而 SSE 连接按定义永远不结束——
   * 不主动 end，优雅关闭就会挂到超时。
   */
  end?(): void;
}

/** 终态：这三个状态之后不再推 delta（§9.4） */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

/** §9.4：每 15 秒一次注释行 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** 补发时一次读多少条。超过就翻页继续，不截断——截断会静默丢事件 */
const REPLAY_PAGE = 200;

export interface SseHubOptions {
  /** 权威状态读取口。返回 null 表示任务已不存在 */
  readState(taskId: string): SseStateEvent | null;
  /** 断线补发的数据源。语义与 `TaskService.listTraces` 一致 */
  readTraces(taskId: string, options: { after: number; limit: number }): readonly TraceEvent[];
  heartbeatIntervalMs?: number;
  /** 注入定时器，便于测试同步触发心跳。返回取消函数 */
  startHeartbeat?: (fn: () => void, intervalMs: number) => () => void;
}

export interface SubscribeOptions {
  /**
   * 补发游标：**给了就补发** sequence 大于它的 trace，`after: 0` 即从头补。
   * 不给（`undefined`）才是「不补发」。
   *
   * 这两者必须由调用方明确区分。原先注释写的是「0 / undefined 都不补发」，
   * 与实现不符，而路由那边在 query 缺省时会**造一个 0 出来**——
   * 于是首次连接每次都全量重放（实测一章 295 条），
   * 前端同时还会 `GET /traces` 拉一次历史，时间线里每条事件出现两次。
   */
  after?: number;
}

export interface SseHub extends TracePublisher {
  /** 注册一个订阅者，返回退订函数。补发在本函数内**同步**完成，见实现注释 */
  subscribe(taskId: string, client: SseClient, options?: SubscribeOptions): () => void;
  /** 某个任务当前的订阅者数。测试与运维观测用 */
  subscriberCount(taskId: string): number;
  /** 停掉心跳并清空全部订阅。服务关闭时调用，否则定时器会吊住进程 */
  close(): void;
}

/** SSE 帧。`data` 必须是单行——JSON.stringify 不会产出裸换行，所以这里不再转义 */
function frame(event: string, data: string, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${String(id)}\n`;
  return `${idLine}event: ${event}\ndata: ${data}\n\n`;
}

function sameState(a: SseStateEvent | null, b: SseStateEvent | null): boolean {
  if (a === null || b === null) return a === b;
  return a.taskStatus === b.taskStatus && a.phase === b.phase && a.activeSlotId === b.activeSlotId;
}

export function createSseHub(options: SseHubOptions): SseHub {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

  /** taskId → 订阅者集合。Set 而不是数组：退订是按引用删，且不需要顺序 */
  const clients = new Map<string, Set<SseClient>>();
  /**
   * taskId → 最后一次**推出去过的** state。
   *
   * 它同时承担两个职责：state 事件的去重依据，以及 delta 的终态判断。
   * 合成一份而不是两份，是因为两者要是分开维护就可能不一致——
   * 那会表现为「任务已显示完成，产物区还在动」。
   */
  const lastState = new Map<string, SseStateEvent>();

  /**
   * 心跳在 Hub 构造时就起，而不是等第一个订阅者。
   *
   * 一个 `setInterval` 的成本可以忽略，而「按需启停」要处理
   * 「最后一个订阅者退订后关掉、下一个订阅者进来再开」这条竞态，
   * 换来的只是空闲时每 15 秒一次的空循环。定时器是 unref 的，不吊住进程退出。
   */
  const startTimer =
    options.startHeartbeat ??
    ((fn, intervalMs): (() => void) => {
      const timer = setInterval(fn, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    });

  /** `close()` 之后拒绝新订阅，见 `subscribe` 与 `close` */
  let closed = false;

  let heartbeatCancel: (() => void) | null = startTimer(() => {
    // 固化键集合：send 可能因为写失败而就地退订，进而删掉 map 的键
    for (const taskId of [...clients.keys()]) send(taskId, ': heartbeat\n\n');
  }, heartbeatIntervalMs);

  function send(taskId: string, chunk: string): void {
    const set = clients.get(taskId);
    if (set === undefined) return;
    for (const client of set) {
      try {
        client.write(chunk);
      } catch {
        // 写失败 = 对端已经走了。就地退订而不是让它留在集合里：
        // 一个死连接会让之后每一条事件都白走一次 try/catch，
        // 而心跳更是每 15 秒对着它抛一次异常。
        set.delete(client);
      }
    }
    if (set.size === 0) cleanup(taskId);
  }

  function cleanup(taskId: string): void {
    const set = clients.get(taskId);
    if (set !== undefined && set.size > 0) return;
    clients.delete(taskId);
    // 连一个订阅者都没有了就把状态缓存也丢掉：留着它，下一次有人订阅时
    // 会拿一份可能已经过期的三元组去比对，于是第一条 state 事件不该省却省了。
    lastState.delete(taskId);
  }

  /**
   * 读一次权威状态，与上次推过的比对；**变了才广播**一条 state。
   *
   * 新订阅者的基线不走这里（它只该写给那一个 client，见 `subscribe`）——
   * 曾经用一个 `force` 参数复用本函数，结果每来一个新连接，
   * 该任务的老连接都会收到一条内容没变的 state，进而各自全量重拉一次详情。
   */
  function syncState(taskId: string): void {
    // 没有订阅者时连读都不读。除了省一次查询，更重要的是**不要留下缓存**——
    // 每个跑过的任务留一条 state 记录是一个只涨不落的 Map，
    // 而且下一个订阅者会拿它去比对，于是该发的基线被判成「没变化」。
    if ((clients.get(taskId)?.size ?? 0) === 0) return;

    const current = options.readState(taskId);
    if (current === null) return;
    if (sameState(lastState.get(taskId) ?? null, current)) return;
    lastState.set(taskId, current);
    // state 不带 id：它不是持久事件，重连时靠前端拉一次 REST 校准（§9.4）
    send(taskId, frame('state', JSON.stringify(current)));
  }

  return {
    subscribe(taskId, client, subscribeOptions) {
      // 已经在关闭流程里就别再接客了。放进来的话，这条连接既收不到心跳
      // （定时器已停），也永远不会被 end——而 Fastify 的 `server.close()`
      // 正在等所有连接结束，优雅关闭会挂到超时。
      if (closed) {
        client.end?.();
        return () => undefined;
      }

      const set = clients.get(taskId) ?? new Set<SseClient>();
      // **先注册再补发**，而且中间一个 await 都没有。
      // 顺序反过来（先读历史再注册）会留下一个窗口：在读完与注册之间
      // 提交的 trace 既不在补发里、也不在实时流里，永久丢失。
      // 这条时序成立依赖 better-sqlite3 的同步读——异步驱动下就得改成
      // 「先注册 + 缓冲实时事件 + 补发后按 sequence 去重回放」。
      set.add(client);
      clients.set(taskId, set);

      const unsubscribe = (): void => {
        set.delete(client);
        cleanup(taskId);
      };

      try {
        let cursor = subscribeOptions?.after;
        while (cursor !== undefined) {
          const page = options.readTraces(taskId, { after: cursor, limit: REPLAY_PAGE });
          for (const event of page) {
            client.write(frame('trace', JSON.stringify(event), event.sequence));
          }
          const last = page[page.length - 1];
          // 取满一页才可能还有下一页。不翻页的话，第 201 条之后的轨迹会
          // **静默消失**——前端看到一条完整、连续、但缺了后半段的时间线
          cursor = page.length < REPLAY_PAGE || last === undefined ? undefined : last.sequence;
        }

        // 补发之后给一次状态基线：新订阅者此刻还不知道任务是什么样，
        // 而下一条 trace 可能要等几十秒（一次场景生成的时长）。
        //
        // **只写给它自己，不广播。** 走 send 的话，每来一个新连接，
        // 老连接都会收到一条内容完全没变的 state，而前端收到 state 就要
        // `invalidateQueries` 全量重拉一次详情——开着三个标签页时，
        // 任意一个刷新或自动重连都会让另外几个白打一次请求。
        const baseline = options.readState(taskId);
        if (baseline !== null) {
          lastState.set(taskId, baseline);
          client.write(frame('state', JSON.stringify(baseline)));
        }
      } catch (error) {
        // 补发中途抛出（库出错、任务恰好被删）时必须把自己摘干净再往上抛。
        // 不摘的话：client 已经在集合里了，而调用方拿不到 unsubscribe，
        // 于是这个订阅永久泄漏，`subscriberCount` 再也降不下来。
        unsubscribe();
        throw error;
      }

      return unsubscribe;
    },

    publishTrace(taskId, event) {
      send(taskId, frame('trace', JSON.stringify(event), event.sequence));
      // trace 是「有事发生了」的唯一可靠信号，状态比对挂在它后面。
      // 放在推送之后：先让客户端看到发生了什么，再告诉它去拉新状态。
      syncState(taskId);
    },

    publishDelta(taskId, event: SseDeltaEvent) {
      const state = lastState.get(taskId);
      // 终态之后停推（§9.4）。没有缓存记录时照推——那说明还没有人订阅过，
      // send 会立刻发现没有订阅者而空转，代价为零。
      if (state !== undefined && TERMINAL_STATUSES.has(state.taskStatus)) return;
      send(taskId, frame('delta', JSON.stringify(event)));
    },

    subscriberCount(taskId) {
      return clients.get(taskId)?.size ?? 0;
    },

    close() {
      closed = true;
      heartbeatCancel?.();
      heartbeatCancel = null;
      // 先把连接真的结束掉再清表：SSE 的响应永远不会自己结束，
      // 不主动 end，Fastify 的 `server.close()` 会一直等它们，优雅关闭挂到超时
      for (const set of clients.values()) {
        for (const client of set) {
          try {
            client.end?.();
          } catch {
            // 对端可能已经走了。关闭路径上不该因为一个死连接而中断其余的清理
          }
        }
      }
      clients.clear();
      lastState.clear();
    },
  };
}
