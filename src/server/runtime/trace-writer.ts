/**
 * Trace 写入的唯一入口（REQ §13 / §3.3）。
 *
 * Runtime 是整个系统里**最容易泄密的一层**：它手里同时有 API Key、模型的隐藏推理、
 * 以及 Provider 的原始响应对象。这三样东西任何一样进了 trace，就会原样出现在
 * API 响应和前端页面上。
 *
 * 因此这里立一条硬规矩：**runtime 内不允许任何地方直接调 `TracePort.record`**，
 * 一律走本模块——它在写入前把 payload 过一遍 `TracePayloadSchema`
 * （含递归键名黑名单：`api_key` / `authorization` / `reasoning` / `thinking` …）。
 *
 * 校验失败时**丢弃这条 trace 并抛错**，而不是脱敏后放行：
 * 能命中黑名单说明调用点写错了，静默清洗只会让这个 bug 活到下一次有人往
 * payload 里塞一个黑名单没覆盖的字段为止。宁可在测试里炸掉。
 */

import { ForgeError } from '@shared/errors.ts';
import { TracePayloadSchema } from '@shared/trace.ts';
import type { TraceActor, TraceKind, TracePayload } from '@shared/trace.ts';
import type { TracePort, TraceRecord } from './ports.ts';

export interface TraceWriteInput {
  executionId: string | null;
  actor: TraceActor;
  kind: TraceKind;
  title: string;
  summary: string;
  payload?: Record<string, unknown> | null;
}

/**
 * 绑定到单个任务的写入器。
 *
 * 绑 taskId 而不是每次传：runtime 里每个调用点都在同一个任务上下文中，
 * 让 taskId 成为参数只会多出一个「传错任务」的可能。
 */
export class TraceWriter {
  constructor(
    private readonly port: TracePort,
    private readonly taskId: string,
  ) {}

  write(input: TraceWriteInput): void {
    const record: TraceRecord = {
      executionId: input.executionId,
      actor: input.actor,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      payload: input.payload == null ? null : sanitize(input.payload, input.kind),
    };
    this.port.record(this.taskId, record);
  }

  /** 流式正文增量。不落库，聚合成 chunk 是 TracePort 实现方的事（§7.7） */
  delta(executionId: string, text: string): void {
    this.port.bufferOutput(this.taskId, executionId, text);
  }
}

function sanitize(payload: Record<string, unknown>, kind: TraceKind): TracePayload {
  const parsed = TracePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `trace(${kind}) 的 payload 未通过脱敏校验，已拒绝写入：` +
        parsed.error.issues.map((i) => i.message).join('；'),
    );
  }
  return parsed.data;
}
