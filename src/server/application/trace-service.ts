/**
 * Trace 服务（文档 §7.7 + §5.5 表下「Trace 写入在事务内还是事务外」那一段）。
 *
 * 本文件是整个 Application 层唯一允许写 `trace_events` 的地方，
 * 也是唯一允许把 trace 推给 SSE 的地方。两件事被刻意绑在一起，见下。
 *
 * ## 为什么 insert 与 publish 必须分成两段
 *
 * §5.5 的结论是：**trace 写在事务内，SSE 推送在事务提交之后**。
 * 理由不是性能，是诚实性——事务回滚而 trace 已经发出去，UI 会显示一个从未发生的
 * 事件（「旧 Execution 已取消」而实际上没取消），用户据此做的判断全是错的。
 *
 * 直接后果是：调用形态必须是「事务内 insert → run() 返回 → 事务外 publish」。
 * 这条时序如果靠调用点自觉维持，迟早有一处写成事务内 publish 而不会有任何报错。
 * 因此本服务不提供裸露的 insert，只提供 `runWithTraces`：
 * 待发布队列是 **调用作用域内的局部变量**，`uow.run()` 抛错就永远走不到发布那一行。
 * 「提交之后才推」于是成了控制流的结构性事实，而不是一条注释。
 *
 * ## 为什么 payload 必须经过 TraceRepo
 *
 * `TracePayloadSchema` 带 REQ §13 的递归键名黑名单（api_key / authorization /
 * reasoning / thinking …），而它挂在 `TraceRepo.insert` 的**唯一写入口**上。
 * 本服务因此只转发 payload 对象，绝不自己拼 JSON 字符串再落库——
 * 拼 JSON 就等于绕开脱敏，一次疏漏就是密钥或模型隐藏推理上屏。
 *
 * ## §7.7 输出缓冲：SSE 推 delta，数据库存 chunk
 *
 * text delta 不逐 token 持久化。前端的流式光标靠 delta 驱动（瞬时消息、不带 sequence、
 * 断线不补发），断线重连后靠 `public_output_chunk` trace 补读（带 sequence）。
 * 两套体系不能合并：逐 token 落库会让一次三千字的生成产生上千行 trace，
 * 而只推不落库则断线之后正文永久丢失。
 *
 * **本服务只接收「可公开输出」**。模型的隐藏推理（reasoning / thinking）绝不能
 * 进入 `bufferOutput` —— 那道过滤在 ProviderAdapter 里（它才分得清两种 delta），
 * 本层无从判断。`TracePayloadSchema` 的黑名单是最后一道网，不是第一道。
 */

import type { SseDeltaEvent } from '@shared/contracts.ts';
import type { TraceActor, TraceEvent, TraceKind, TracePayload } from '@shared/trace.ts';
import type { NotPromise } from '@server/infrastructure/database/db.ts';
import type { InsertTraceInput } from '@server/infrastructure/database/repositories/index.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/**
 * SSE 推送口。
 *
 * 声明成接口而不是直接 import `infrastructure/sse-hub`：本层只需要「把事件送出去」
 * 这一个能力，而 SseHub 还负责连接管理、心跳、断线补发。把整个 Hub 拖进来会让
 * trace-service 的单测必须先造一个 HTTP 连接池。
 *
 * 缺省实现是「什么都不做」——CLI（§12 M3 的 `run-task.ts`）没有前端连接，
 * 也不该因此拿不到 trace 落库能力。
 */
export interface TracePublisher {
  publishTrace(taskId: string, event: TraceEvent): void;
  publishDelta(taskId: string, event: SseDeltaEvent): void;
}

/** 一条待写入的事件。刻意不含 `sequence` 与 `id`：序号由 TraceRepo 在事务内分配 */
export interface TraceDraft {
  taskId: string;
  executionId: string | null;
  actor: TraceActor;
  kind: TraceKind;
  title: string;
  summary: string;
  /** 展开区。写入前由 `TracePayloadSchema` 过脱敏黑名单（见文件头） */
  payload?: TracePayload | null;
}

/**
 * 事务内的写入句柄。
 *
 * 只在 `runWithTraces` 的回调期间有效：它把事件同时写进库和调用作用域的待发布队列。
 * 拿到这个对象的代码无法自己 publish——那是 `runWithTraces` 返回之后才发生的事。
 */
export interface TraceRecorder {
  record(draft: TraceDraft): TraceEvent;
}

/**
 * 延迟刷盘的调度口。
 *
 * 抽出来是为了让测试能同步触发 250ms 的定时刷盘，而不必引入假时钟或真的等 250 毫秒
 * （后者会让测试变慢且偶发失败）。返回值是取消函数。
 */
export interface FlushScheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

const defaultScheduler: FlushScheduler = {
  schedule(fn, delayMs) {
    const timer = setTimeout(fn, delayMs);
    // 不让一个尚未刷盘的缓冲区吊住进程退出：CLI 跑完就该退出，
    // 而刷盘本身会在 flushAll() 里被显式完成。
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

const noopPublisher: TracePublisher = {
  publishTrace() {
    /* CLI 与单测没有 SSE 订阅者 */
  },
  publishDelta() {
    /* 同上 */
  },
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface TraceServiceOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  publisher?: TracePublisher;
  /** §7.7：缓冲区达到该字符数立即落一条 chunk。默认 1024 */
  maxChunkChars?: number;
  /** §7.7：距上一次 push 超过该毫秒数则刷盘。默认 250 */
  flushIntervalMs?: number;
  scheduler?: FlushScheduler;
}

export interface BufferOutputInput {
  taskId: string;
  executionId: string;
  delta: string;
}

export interface TraceService {
  /**
   * §5.5 的两段式入口，也是本服务的主 API。
   *
   * 回调在**一个 SQLite 事务内**同步执行；回调期间 `trace.record()` 写入的每条事件
   * 都排进一个局部队列，只有事务提交成功（`uow.run` 正常返回）才会被推给 SSE。
   * 回调抛错 → 事务整体回滚 → 一条都不推。
   */
  runWithTraces<T>(fn: (uow: UnitOfWork, trace: TraceRecorder) => NotPromise<T>): T;

  /**
   * 写一条独立事件（自开事务，提交后推送）。
   *
   * 供 Runtime 在工具循环里记录 `report_work` / `tool_call_*` / `provider_retry`
   * 这类不与任何业务写入绑在一起的事件。**不要**用它在别的事务中途插一条——
   * 那会开一个嵌套事务并把「提交后才推」的时序打散。
   */
  emit(draft: TraceDraft): TraceEvent;

  /**
   * §7.7：收到一段可公开输出。实时推 SSE delta，同时累积到缓冲区。
   *
   * 缓冲区满 `maxChunkChars` 立即刷盘；否则安排一次 `flushIntervalMs` 后的延迟刷盘。
   */
  bufferOutput(input: BufferOutputInput): void;

  /** 把某次执行的缓冲区落成一条 `public_output_chunk`。缓冲区空时什么都不做 */
  flushOutput(executionId: string): void;

  /**
   * 丢弃缓冲区且不落库。
   *
   * 用于 D-11 的闸门关闭之后：提交已经发生，此后到达的 delta 一律丢弃，
   * 既不写 trace 也不推 SSE。若改用 flushOutput，产物区会多出一段
   * 「提交之后模型还在说的话」，而那段话没有任何东西保存了它。
   */
  discardOutput(executionId: string): void;

  /** 刷掉全部缓冲区。进程退出与一次 Assignment 收敛时调用，避免尾巴丢失 */
  flushAll(): void;
}

interface OutputBuffer {
  taskId: string;
  text: string;
  cancel: (() => void) | null;
}

function toInsertInput(draft: TraceDraft): InsertTraceInput {
  // 显式构造而不是 `{ ...draft }`：`exactOptionalPropertyTypes` 下
  // 展开一个「可选且可为 undefined」的键会把 undefined 带进 InsertTraceInput，
  // 而仓储对 `payload: undefined` 与「没有 payload」的处理必须是同一件事。
  return {
    taskId: draft.taskId,
    executionId: draft.executionId,
    actor: draft.actor,
    kind: draft.kind,
    title: draft.title,
    summary: draft.summary,
    payload: draft.payload ?? null,
  };
}

/** chunk 的 summary 用截断预览：summary 是「一句话正文」，整段正文放 payload.text */
const SUMMARY_PREVIEW_CHARS = 40;

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = [...flat];
  if (points.length <= SUMMARY_PREVIEW_CHARS) return flat;
  return `${points.slice(0, SUMMARY_PREVIEW_CHARS).join('')}…`;
}

export function createTraceService(options: TraceServiceOptions): TraceService {
  const { uow } = options;
  const publisher = options.publisher ?? noopPublisher;
  const maxChunkChars = options.maxChunkChars ?? 1024;
  const flushIntervalMs = options.flushIntervalMs ?? 250;
  const scheduler = options.scheduler ?? defaultScheduler;

  /** 按 executionId 索引。同一时刻全局只有一个 Assignment 在跑（NFR-001），但收敛顺序不保证 */
  const buffers = new Map<string, OutputBuffer>();

  const service: TraceService = {
    runWithTraces<T>(fn: (repos: UnitOfWork, trace: TraceRecorder) => NotPromise<T>): T {
      // 局部队列：`uow.run` 抛错时这个数组随栈帧一起消失，不存在「上次事务失败留下的
      // 事件在下次成功时被一起推出去」这种串味。
      const pending: TraceEvent[] = [];

      const result = uow.run((repos) =>
        fn(repos, {
          record(draft) {
            const event = repos.traces.insert(toInsertInput(draft));
            pending.push(event);
            return event;
          },
        }),
      );

      // 只有事务提交成功才走到这里（§5.5）。
      for (const event of pending) publisher.publishTrace(event.taskId, event);
      return result;
    },

    emit(draft) {
      return service.runWithTraces((_repos, trace) => trace.record(draft));
    },

    bufferOutput({ taskId, executionId, delta }) {
      if (delta === '') return;

      // 先推 SSE 再累积：delta 是给流式光标用的，晚一步就是可见的卡顿。
      // 它不带 sequence、不落库，断线重连时前端丢弃全部 delta 改用 chunk 补读（§7.7）。
      publisher.publishDelta(taskId, { executionId, text: delta });

      const existing = buffers.get(executionId);
      const buffer: OutputBuffer = existing ?? { taskId, text: '', cancel: null };
      buffer.text += delta;
      buffers.set(executionId, buffer);

      if (buffer.text.length >= maxChunkChars) {
        service.flushOutput(executionId);
        return;
      }
      // 已经排过队就不重排：定时器的语义是「距第一次累积起 N 毫秒内必落盘」，
      // 每次 push 都重置会让持续输出的流永远等不到那一次刷盘。
      buffer.cancel ??= scheduler.schedule(() => {
        service.flushOutput(executionId);
      }, flushIntervalMs);
    },

    flushOutput(executionId) {
      const buffer = buffers.get(executionId);
      if (buffer === undefined) return;
      buffers.delete(executionId);
      buffer.cancel?.();
      if (buffer.text === '') return;

      service.emit({
        taskId: buffer.taskId,
        executionId,
        actor: 'agent',
        kind: 'public_output_chunk',
        title: '公开输出',
        summary: previewOf(buffer.text),
        // 整段正文只能放这里：summary 是「一句话正文」，而断线重连要靠 chunk
        // 逐段还原产物区。键名 `text` 不在 REQ §13 的黑名单上，
        // 但 payload 仍会过 TracePayloadSchema——这条 chunk 的内容若混进了
        // 模型隐藏推理，那是 ProviderAdapter 的过滤失守，不是这里能补救的。
        payload: { text: buffer.text, chars: buffer.text.length },
      });
    },

    discardOutput(executionId) {
      const buffer = buffers.get(executionId);
      if (buffer === undefined) return;
      buffers.delete(executionId);
      buffer.cancel?.();
    },

    flushAll() {
      // 先固化键集合：flushOutput 会改 buffers，边迭代边删是未定义行为的温床
      for (const executionId of [...buffers.keys()]) service.flushOutput(executionId);
    },
  };

  return service;
}
