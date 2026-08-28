/**
 * Runtime 端口的 application 侧实现（M3-C 接线层）。
 *
 * `runtime/ports.ts` 声明了四个最小端口，`application/` 各 service 独立长出了自己的
 * 形状，两边**刻意没有强行对齐**——那正是依赖倒置的代价与收益：
 * 收益是 Runtime 的集成测试不需要数据库，代价就是这个文件。
 *
 * 这里只做转接与形状搬运，**不放任何业务判断**。一旦某个适配器开始「顺便」判点什么，
 * 那条规则就同时存在于两个地方了，而分叉时更松的那一侧总是会赢。
 * 唯一的例外在 `submit()` 的分派上，理由写在那里。
 */

import type { Operation } from '@shared/contracts.ts';
import { ForgeError, type ErrorCode } from '@shared/errors.ts';
import { documentOrder } from '@server/domain/readiness.ts';
import type {
  CompletionOutcome,
  CompletionPort,
  CompletionRequest,
  OutlineSlot,
  SlotContentView,
  StructurePort,
  TracePort,
  TraceRecord,
} from '@server/runtime/ports.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { TraceService } from './trace-service.ts';
import type { CompletionService } from './completion-service.ts';
import type { StructureService } from './structure-service.ts';
import type { SnapshotService } from './snapshot-service.ts';
import { reviewBindingOf } from './review-binding.ts';

// ---------------------------------------------------------------- TracePort

/**
 * `TracePort.record` 是同步的、不返回值的；`TraceService.emit` 会自开事务并在提交后
 * 推送。两者语义一致，差别只在参数打包方式（port 把 taskId 提到第一个位置，
 * 因为 Runtime 手里 taskId 一直在，而 draft 的其余字段是每次现拼的）。
 */
export function createTracePort(traces: TraceService): TracePort {
  return {
    record(taskId: string, record: TraceRecord): void {
      traces.emit({
        taskId,
        executionId: record.executionId,
        actor: record.actor,
        kind: record.kind,
        title: record.title,
        summary: record.summary,
        payload: record.payload,
      });
    },
    bufferOutput(taskId: string, executionId: string, delta: string): void {
      traces.bufferOutput({ taskId, executionId, delta });
    },
  };
}

// ------------------------------------------------------------ StructurePort

/**
 * 顺序合同：port 要求「按文档序返回」，而文档序是树的深度优先前序，SQL 排不出来。
 * 因此这里必须过一遍 `domain/readiness.ts` 的 `documentOrder`，
 * 不能图省事直接把 `listByTask` 的结果扔出去——那是按 (parent_id, sort_order) 排的，
 * 与生产顺序不是同一个序。
 */
export function createStructurePort(uow: UnitOfWorkHandle<UnitOfWork>): StructurePort {
  const { slots } = uow.repositories;
  return {
    readOutline(taskId: string): Promise<readonly OutlineSlot[]> {
      const ordered = documentOrder(slots.listByTask(taskId));
      return Promise.resolve(
        ordered.map((slot) => ({
          slotId: slot.slotId,
          type: slot.type,
          parentId: slot.parentId,
          sortOrder: slot.sortOrder,
          instruction: slot.instruction,
          dependsOn: slot.dependsOn,
          contentBearing: slot.contentBearing,
          status: slot.status,
        })),
      );
    },
    readSlotContent(taskId: string, slotId: string): Promise<SlotContentView | null> {
      const slot = slots.get(taskId, slotId);
      if (slot === null) return Promise.resolve(null);
      return Promise.resolve({
        slotId: slot.slotId,
        type: slot.type,
        instruction: slot.instruction,
        status: slot.status,
        contentText: slot.contentText,
      });
    },
  };
}

// ----------------------------------------------------------- CompletionPort

/**
 * 一次 attempt 里，`AssignmentOutcome` **装不下**的那点东西。
 *
 * runner 的失败结果已经带了 `code` / `message` / `violations` / `noSubmission` /
 * `consumesRetry`，引擎绝大部分判断都够用。这里只补两样它拿不到的：
 *
 * - `proposalJson`：§7.4 要求重试时把上次提案的**原文**回灌，让模型做增量修正。
 *   被拒的提案根本没落库，引擎再查一次也查不到，只能在被拒的那一刻记下来。
 * - `reasons`：槽位内容校验的**逐条**原因。outcome 里只有合成后的一句话，
 *   而 §7.4 的重试块要求逐条列出。
 *
 * 曾经还有一个 `executionSettled`，用来告诉引擎「校验没过时 service 已经把 execution
 * 收尾了，你别再收一次」。D-20 之后被拒不再收敛 execution，这个字段永远为 false，
 * 于是删掉——留着一个恒定值的开关，下一个人会以为它有两种情形并去满足那个不存在的分支。
 */
export interface SubmissionRecord {
  proposalJson: string | null;
  reasons: readonly string[];
  /**
   * R2：审核 attempt 的判据 ID。
   *
   * 引擎在跑 review_slot 前把判据 ID 写进这里，CompletionPort 的 `dispatch`
   * 在收到 `review_result` 时读它——模型回传的 findings 里虽然也有 criterionId，
   * 但 verdict 为 no_finding 时 findings 为空，那时判据 ID 只能从这里拿。
   */
  criterionId: string | null;
}

export function emptySubmissionRecord(): SubmissionRecord {
  return { proposalJson: null, reasons: [], criterionId: null };
}

export interface CompletionPortOptions {
  completion: CompletionService;
  structure: StructureService;
  snapshots: SnapshotService;
  uow: UnitOfWorkHandle<UnitOfWork>;
  /** 引擎注入的可变记录格。每次 attempt 前由引擎重置 */
  record: SubmissionRecord;
}

/**
 * 按 `operation` 分派到两个 service。
 *
 * 这是本文件里唯一一处「判断」，而它不是业务规则的第二个副本：
 * `CompletionService` 刻意没有合一的 `submit()`，理由写在那个文件里——
 * 合起来就得让 `producer` 变成可选参数，而漏传它要走到 AC-009 的 CHECK 才炸。
 * 所以分派必须发生在某处，放在接线层是它最该在的地方。
 */
export function createCompletionPort(options: CompletionPortOptions): CompletionPort {
  const { completion, structure, snapshots, uow, record } = options;

  return {
    // 真故障（库炸了）原样抛出去，绝不在这里压成「校验失败」喂给模型——
    // 否则模型会认真地去「修正」一个根本不是它造成的问题，白烧一轮配额。
    submit(request: CompletionRequest): Promise<CompletionOutcome> {
      return Promise.resolve(dispatch(request));
    },
  };

  function dispatch(request: CompletionRequest): CompletionOutcome {
    if (request.payload.kind === 'structure') {
      const result = structure.submit({
        taskId: request.taskId,
        executionId: request.executionId,
        proposal: {
          rootSlotId: request.payload.rootSlotId,
          slots: request.payload.slots,
        },
      });
      if (result.ok) return { ok: true };
      record.proposalJson = result.proposalJson;
      return {
        ok: false,
        code: 'STRUCTURE_INVALID',
        message: result.reason,
        violations: result.violations,
      };
    }

    // R2：review_result 的分派。
    //
    // criterionId 从 SubmissionRecord 拿而不是从 payload 的 findings 拿：
    // verdict 为 no_finding 时 findings 为空数组，那时判据 ID 只能从引擎设置的侧信道取。
    if (request.payload.kind === 'review_result') {
      const criterionId = record.criterionId;
      if (criterionId === null) {
        // 引擎没设 criterionId 就跑了 review_slot = 内部错误
        throw new ForgeError(
          'STORAGE_ERROR',
          `审核提交缺少判据 ID：execution ${request.executionId} 对槽位 ${request.payload.slotId}`,
          `slot:${request.payload.slotId}`,
        );
      }
      completion.submitReviewResult({
        taskId: request.taskId,
        executionId: request.executionId,
        token: request.executionToken,
        slotId: request.payload.slotId,
        criterionId,
        verdict: request.payload.verdict,
        findings: request.payload.findings,
      });
      return { ok: true };
    }

    // slot_content：producer 三件套只有冻结快照知道，Runtime 不该也不能提供
    const binding = resolveSlotBinding(snapshots, uow, request.taskId, request.payload.slotId);
    // R2：该槽位类型绑定了审核 → 提交后进 reviewing 而非 completed
    const slot = uow.repositories.slots.get(request.taskId, request.payload.slotId);
    if (slot === null) {
      throw new ForgeError(
        'SLOT_NOT_FOUND',
        `任务 ${request.taskId} 里没有槽位「${request.payload.slotId}」`,
        `task:${request.taskId}/slot:${request.payload.slotId}`,
      );
    }
    const hasReviewBinding =
      reviewBindingOf(snapshots.readSnapshot(request.taskId).compiled, slot) !== null;
    const result = completion.submitSlotContent({
      taskId: request.taskId,
      executionId: request.executionId,
      token: request.executionToken,
      slotId: request.payload.slotId,
      content: request.payload.content,
      producer: binding,
      forReview: hasReviewBinding,
    });
    if (result.ok) return { ok: true };
    record.reasons = result.reasons;
    return {
      ok: false,
      code: 'SLOT_CONTENT_INVALID',
      message: result.reason,
      violations: [],
    };
  }
}

/**
 * 从冻结快照里取该槽位类型的填充绑定，用作 producer 三件套。
 *
 * 走**冻结快照**而不是磁盘上当前的模板：AC-002 要求任务跑到一半有人改了模板也不受影响，
 * 而 producer 记的正是「这段内容是谁用哪个 Skill 的哪个版本写的」——
 * 取到一份新版本号，等于在溯源信息里撒谎。
 *
 * 槽位类型本身则必须从**库里**取：槽位是运行期产物（结构提交时才存在），
 * 快照里只有类型定义，没有具体槽位。
 */
function resolveSlotBinding(
  snapshots: SnapshotService,
  uow: UnitOfWorkHandle<UnitOfWork>,
  taskId: string,
  slotId: string,
): { agentId: string; skillId: string; skillVersion: string } {
  const slot = uow.repositories.slots.get(taskId, slotId);
  if (slot === null) {
    // Runtime 侧已经用 targetSlotId 拦过一次「提交错 slotId」，
    // 走到这里说明库里真的没有——数据问题，不是模型的错
    throw new ForgeError(
      'SLOT_NOT_FOUND',
      `任务 ${taskId} 里没有槽位「${slotId}」`,
      `task:${taskId}/slot:${slotId}`,
    );
  }

  const compiled = snapshots.readSnapshot(taskId).compiled;
  const binding = compiled.bindings.fillSlotByType[slot.type];
  if (binding === undefined) {
    // 模板编译期已保证 fillSlotByType 覆盖全部 contentBearing 类型，
    // 走到这里说明快照与结构对不上——同样是数据问题，重试无济于事
    throw new ForgeError(
      'STORAGE_ERROR',
      `任务 ${taskId} 的快照里没有槽位类型「${slot.type}」的填充绑定` +
        `（已配置：${Object.keys(compiled.bindings.fillSlotByType).sort().join('、')}）`,
      `task:${taskId}/slot:${slotId}`,
    );
  }
  return {
    agentId: binding.agentId,
    skillId: binding.skillId,
    skillVersion: binding.skillVersion,
  };
}

/** 把 ForgeError 的错误码取出来，不是 ForgeError 时归为内部错误 */
export function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof ForgeError ? error.code : 'STORAGE_ERROR';
}

/**
 * 供引擎在 trace 与 `error_message` 里使用的成文原因（D-19）。
 *
 * **只有 `ForgeError` 的 message 可以直接用。** 它是我们自己写的一句中文，
 * 写的时候就知道它会被展示。非 `ForgeError` 一律退回调用方给的 `fallback`。
 *
 * 原来这里还有一行「是 Error 就用它的 message」，那是个信息泄露：
 * `task.error_message` 既进 API 响应也直接显示给用户，而一个裸 Error 的 message
 * 可能来自 sqlite（带表名和 SQL）、Node 的 fs（带绝对路径）或 fetch（带 URL）。
 * 这与 §9.3「原始错误只进日志」是同一条纪律，只是那一条守的是 HTTP 边界，
 * 这一条守的是**数据库里那一列**——写进去就晚了，后面每一次读都在泄露。
 * 它同时也违反 D-19：一句英文的 `no such table: xxx` 不是「可直接展示的完整中文」。
 *
 * 代价是原始信息会丢，所以这里把它打到 stderr。用 `console.error` 而不是 pino，
 * 是因为 application 层目前没有注入 logger——把 logger 一路传进来是 M7 加固的事，
 * 而「先别泄露，同时别把线索弄丢」现在就得成立。前缀固定，便于 grep。
 */
export const INTERNAL_REASON_LOG_PREFIX = '[internal-error]';

/**
 * 内部错误的下沉点（Q-21）。
 *
 * 默认是 `console.error`（无结构、不过 redact）。M7 加固时由组合根/入口用
 * `setInternalErrorSink` 注入一个走 pino（带 redact）的 sink，让内部错误
 * 也有结构、带 taskId 上下文、且被凭据脱敏。测试不注入时行为不变。
 */
export type InternalErrorSink = (error: unknown) => void;

let internalErrorSink: InternalErrorSink = (error) => {
  console.error(INTERNAL_REASON_LOG_PREFIX, error);
};

export function setInternalErrorSink(sink: InternalErrorSink): void {
  internalErrorSink = sink;
}

/**
 * 把一件「不该发生但也不该中断生产」的事送进同一条通道（Q-26）。
 *
 * 与 `reasonOf` 的区别：`reasonOf` 处理的是**已经导致失败**的错误，要给用户一句话；
 * 本函数处理的是**没有导致失败、但吞掉了信息**的情况——典型是流式分片被丢弃。
 * 那类问题不抛异常，于是没有任何东西会把它送到 sink，
 * 而它造成的现象（数据凭空少一块）会伪装成完全不相干的故障。
 *
 * 调用方有责任保证送进来的东西**不含凭据与模型正文**（REQ §13）。
 */
export function reportInternal(detail: unknown): void {
  internalErrorSink(detail);
}

export function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof ForgeError) return error.message;
  if (error !== undefined && error !== null) {
    internalErrorSink(error);
  }
  return fallback;
}

/** `create_structure`、 `fill_slot` 与 `review_slot` 的字面量，避免各处手写字符串 */
export const OPERATIONS = {
  structure: 'create_structure',
  fillSlot: 'fill_slot',
  reviewSlot: 'review_slot',
} as const satisfies Record<string, Operation>;
