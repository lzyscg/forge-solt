/**
 * 提交服务（文档 §5.5「提交 Slot Content」+ D-05 + D-10 + §8.4 + D-19）。
 *
 * 这是 Agent 唯一的写入口在系统侧的落点。**Agent 不写库、不设状态、不宣布完成**——
 * 它只把一段文本交过来，此后发生的一切都在本文件里。
 *
 * ## D-10 的条件 UPDATE 由仓储独占
 *
 * 本层**不重复实现**任何一条 token / 目标槽位 / 活动执行的校验判据。
 * 那条 SQL 的正确性由 `SlotRepo.commitContent` 独自负责；一旦泄漏到编排层，
 * 就会有第二个地方尝试「我自己也判断一下 execution 还新鲜吗」，
 * 而那个判断必然是「读 → 判 → 写」——正是 D-10 花了整整一条决议来禁止的东西。
 *
 * 本层出示的只有两样东西：`sha256(明文 token)` 与目标槽位 ID，其余交给 WHERE 子句。
 *
 * ## D-05：确定性校验在提交前，且只有确定性校验
 *
 * 字数区间与 `forbidPattern` 是**系统强制**的（违反即拒绝提交并计入重试）；
 * `guidance` 是写作要求，只进上下文，系统不判。
 * 这条边界不能模糊：让用户以为「结尾状态可被承接」会被系统校验，是一种承诺欺骗。
 *
 * 校验发生在事务**之外**——它是纯计算，且失败路径根本不写槽位内容。
 *
 * ## §8.4 的可观测性写在第二个事务里（M3-B 修正）
 *
 * §8.4 的示例把 `markStale` + `late_result_rejected` trace 放在
 * `changes !== 1` 的分支里、与被拒的 UPDATE 同一个事务，然后 `throw`。
 * 那样写这两条记录会被同一次 throw 一起回滚掉，可观测性等于零。
 * 正确做法是：让提交事务干净地整体回滚（「迟到结果被拒时不修改任何状态」由此天然成立），
 * 再**另开一个事务**补记归因。文档 §8.4 已相应修订。
 *
 * ## D-19：失败原因的成文责任在本层
 *
 * 写进 `slots.error_message` / `tasks.error_message` 的每一句都必须是
 * 可直接展示的完整中文。派生层（附录 B）只取用，不解析不拼装。
 */

import type { ErrorCode } from '@shared/errors.ts';
import { ForgeError } from '@shared/errors.ts';
import { sha256Hex } from '@server/domain/canonical.ts';
import type { Slot, SlotProducer } from '@server/domain/types.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { CompiledSlotValidation } from './template-loader.ts';
import type { SnapshotService } from './snapshot-service.ts';
import type { TraceService } from './trace-service.ts';

// ---------------------------------------------------------------------------
// D-05 确定性校验
// ---------------------------------------------------------------------------

/**
 * 字数按 **Unicode 码点** 计。
 *
 * 与 `domain/presentation.ts` 的 `countChars` 同一口径：模板作者写
 * 「1200 – 1800 字」时想的是人眼能数出来的字，不是 UTF-16 长度。
 * 两处不一致的表现是「界面显示 1500 字，系统说不够 1200」。
 */
function countChars(text: string): number {
  return [...text].length;
}

/**
 * 跑一遍确定性校验，返回**全部**不通过的原因（已成文中文）。
 *
 * 不短路的理由与 D-13 相同：一次说清所有问题，模型才有可能一轮改对。
 * 重试配额只有两三次，「字数不够」改完再告诉他「还有小标题」是纯粹的浪费。
 */
export function validateSlotContent(
  content: string,
  validation: CompiledSlotValidation,
): string[] {
  const reasons: string[] = [];
  const trimmed = content.trim();

  // FR-SLOT-004 第 2 条：去空白后非空。放在最前——空内容后面每条都会跟着报，
  // 但那些都是同一件事的回声，先说清楚根因。
  if (trimmed === '') {
    reasons.push('提交的正文为空（去掉首尾空白后没有任何内容）');
    return reasons;
  }

  const chars = countChars(trimmed);
  const { minChars, maxChars } = validation;
  if (minChars !== null && chars < minChars) {
    reasons.push(`正文只有 ${chars} 字，低于本槽位要求的最少 ${minChars} 字`);
  }
  if (maxChars !== null && chars > maxChars) {
    reasons.push(`正文有 ${chars} 字，超过本槽位允许的最多 ${maxChars} 字`);
  }

  const { forbidPattern } = validation;
  if (forbidPattern !== null) {
    // 正则的语法与灾难性回溯风险已在模板编译期由 `regex-budget` 把关（D-05），
    // 因此这里直接构造使用，不再加超时保护——加了也只是重复一道已经过了的闸门。
    const pattern = new RegExp(forbidPattern, validation.forbidPatternFlags ?? '');
    if (pattern.test(trimmed)) {
      reasons.push(
        validation.forbidPatternMessage ?? '正文命中了本槽位禁止出现的格式（forbidPattern）',
      );
    }
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export interface SubmitSlotContentInput {
  taskId: string;
  /** D-09：AgentAssignment.id === execution.id */
  executionId: string;
  /**
   * §8.1 的**明文** Execution Token。本层只用它算 sha256 交给 D-10 的 WHERE，
   * 之后立刻丢弃：不落库、不进 trace、不进日志。
   */
  token: string;
  slotId: string;
  content: string;
  /** 四件套捆成一个对象（AC-009）：类型上不存在「只有 agentId」这种半截 producer */
  producer: Omit<SlotProducer, 'executionId'>;
  /** Provider 报的用量，没有就传 null */
  usage?: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface SlotContentAccepted {
  ok: true;
  slot: Slot;
}

export interface SlotContentRejected {
  ok: false;
  /** 全部不通过的原因，已成文中文。原样进重试上下文（§7.4） */
  reasons: readonly string[];
  /** 合成后的一句话，写 trace 与 `lastFailureReason` 都用它 */
  reason: string;
}

export type SubmitSlotContentResult = SlotContentAccepted | SlotContentRejected;

export interface FailSlotInput {
  taskId: string;
  slotId: string;
  executionId: string;
  errorCode: ErrorCode;
  /**
   * 已成文的完整中文（D-19），例如「120 秒超时」。
   * 由持有超时配置与失败详情的一方（Runtime）写好交过来，本层只负责落库。
   */
  reason: string;
  /** true = 重试配额已耗尽，任务随之置 failed；false = 还能再试，任务保持 running */
  exhausted: boolean;
}

/**
 * 提交服务。
 *
 * 刻意**没有**一个把 `complete_assignment` 两种 kind 合起来分派的 `submit()`：
 * 结构提交只需要 proposal，槽位提交还需要冻结绑定里的 producer 三件套，
 * 合成一个入口就得让 producer 变成可选参数——而「slot_content 忘了传 producer」
 * 会一路走到 AC-009 的 CHECK 才炸。工具层要的那个单一入口是一层适配，
 * 由接线方（M3-C）按 Runtime 自己声明的 port 写，不在这里预判。
 */
export interface CompletionService {
  /** §5.5「提交 Slot Content」。D-10 的条件 UPDATE 由 SlotRepo 执行 */
  submitSlotContent(input: SubmitSlotContentInput): SubmitSlotContentResult;

  /**
   * 一次执行以失败收敛（超时 / Provider 报错 / 未提交 …）。
   *
   * 放在本文件而不是 lifecycle：它与「提交」是同一条边界的两个出口，
   * 共用「execution 收尾 + 让出 active_execution_id + 槽位归位」这套动作，
   * 拆开两处写必然有一处忘记让出 active_execution_id，表现为任务再也调度不动。
   */
  failSlot(input: FailSlotInput): void;

  /**
   * 重试配额耗尽，但本次 execution **已经被提交路径收敛过**（M3-C 补，§5.5 新增边界）。
   *
   * 与 `failSlot({ exhausted: true })` 的分工严格按「execution 收没收尾」划：
   * 确定性校验没过时，`submitSlotContent` 当场就把 execution 标了 failed、
   * 槽位放回 pending、活动执行也让了出来。此时若再走 `failSlot`，
   * `executions.markFailed` 会把那条已经写好的失败记录连同 `finished_at` 重写一遍，
   * 而 `resetToPending` 又会把一个已经是 pending 的槽位再刷一次 `updated_at`——
   * 两个都是无声的、只在事后排查时才发现被抹掉的信息。
   *
   * 因此本方法**完全不碰 executions**，只落任务级失败与槽位失败标记。
   */
  markSlotExhausted(input: ExhaustSlotInput): void;
}

export interface ExhaustSlotInput {
  taskId: string;
  slotId: string;
  errorCode: ErrorCode;
  /** 已成文的完整中文（D-19），直接进 `slots.error_message` 与 `tasks.error_message` */
  reason: string;
}

export interface CompletionServiceOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  snapshots: SnapshotService;
  traces: TraceService;
}

// ---------------------------------------------------------------------------

function joinReasons(reasons: readonly string[]): string {
  return reasons.length === 1 ? (reasons[0] ?? '') : `内容校验未通过：${reasons.join('；')}`;
}

export function createCompletionService(options: CompletionServiceOptions): CompletionService {
  const { uow, snapshots, traces } = options;

  /**
   * §8.4：提交被 D-10 拒掉之后的归因。
   *
   * 单独一个事务，因为提交事务已经整体回滚了（这正是我们要的：迟到结果不修改任何状态）。
   * `markStale` 只在 execution 还没收敛时才打——若它已经是 `cancelled`
   * （用户 stop 的正常路径），覆盖成 `stale` 会把「谁取消的」这个信息抹掉，
   * 而那恰恰是排查时最想知道的一件事。
   */
  const recordLateRejection = (
    taskId: string,
    executionId: string,
    slotId: string,
    reason: string,
  ): void => {
    traces.runWithTraces((repos, trace) => {
      const execution = repos.executions.get(executionId);
      if (execution !== null && (execution.status === 'created' || execution.status === 'running')) {
        repos.executions.markStale(executionId, reason);
      }
      trace.record({
        taskId,
        executionId,
        actor: 'system',
        kind: 'late_result_rejected',
        title: '迟到结果已拒绝',
        summary: `Execution ${executionId} 对槽位 ${slotId} 的提交未被保存：${reason}`,
        payload: { slotId, executionStatus: execution?.status ?? null },
      });
    });
  };

  const service: CompletionService = {
    submitSlotContent(input) {
      // --- 事务外：读快照、跑确定性校验。两者都不写库 ---
      const snapshot = snapshots.readSnapshot(input.taskId);
      const slot = uow.repositories.slots.getOrThrow(input.taskId, input.slotId);
      const slotType = snapshot.compiled.slotTypes.find((type) => type.id === slot.type);
      if (slotType === undefined) {
        // 结构提交时槽位类型必然解析得出（规则 11）。到这里说明快照与结构对不上，
        // 继续生产会产出一份无法说明来源的内容。
        throw new ForgeError(
          'SLOT_CONTENT_INVALID',
          `槽位 ${input.slotId} 的类型 ${slot.type} 不在冻结快照的槽位类型中`,
          `slot:${input.slotId}`,
        );
      }

      const reasons = validateSlotContent(input.content, slotType.validation);
      if (reasons.length > 0) {
        const reason = joinReasons(reasons);
        // D-20：被拒**只写 trace**，不收敛 execution、不让出 active_execution_id、
        // 也不把槽位放回 pending——这一次 Assignment 还活着。
        //
        // 这里曾经把三件事都做了，后果是模型照着「字数不足」的提示补写、
        // 在同一轮对话里重新提交时，D-10 的 WHERE 发现活动执行没了 → EXECUTION_STALE。
        // 一次本该在会话内几百 token 就修好的问题，被迫升级成一整个 attempt。
        // 何时收尾由 ProductionEngine 决定（`failSlot` / `markSlotExhausted`）。
        traces.runWithTraces((repos, trace) => {
          void repos;
          trace.record({
            taskId: input.taskId,
            executionId: input.executionId,
            actor: 'system',
            kind: 'validation_failed',
            title: '内容校验未通过',
            summary: reason,
            payload: { slotId: input.slotId, reasons: [...reasons] },
          });
        });
        return { ok: false, reasons, reason };
      }

      // --- 事务内：D-10 的条件 UPDATE + execution 收尾 + task 让出活动执行 + trace ---
      const producer: SlotProducer = { ...input.producer, executionId: input.executionId };
      const tokenHash = sha256Hex(input.token);

      try {
        const committed = traces.runWithTraces((repos, trace) => {
          // 目标槽位一致性先在这里判一次，只为拿到**准确的错误码**：
          // D-10 的 WHERE 同样挡得住串槽提交，但它给出的是 EXECUTION_STALE，
          // 而附录 A 为这种情况准备的是 SLOT_TARGET_MISMATCH。
          // 判定权仍在 WHERE 子句——这里判过之后并不跳过它。
          const execution = repos.executions.getOrThrow(input.executionId);
          if (execution.targetSlotId !== input.slotId) {
            throw new ForgeError(
              'SLOT_TARGET_MISMATCH',
              `本次工作的目标槽位是 ${execution.targetSlotId ?? '（整棵结构）'}，` +
                `不能提交 ${input.slotId} 的内容`,
              `slot:${input.slotId}`,
            );
          }

          repos.slots.commitContent({
            taskId: input.taskId,
            slotId: input.slotId,
            content: input.content,
            producer,
            tokenHash,
          });
          repos.executions.markSucceeded(input.executionId, {
            inputTokens: input.usage?.inputTokens ?? null,
            outputTokens: input.usage?.outputTokens ?? null,
          });
          repos.tasks.update(input.taskId, { activeExecutionId: null });

          const stored = repos.slots.getOrThrow(input.taskId, input.slotId);
          // §8.8 的断言：AC-009 由 DDL 的 CHECK 兜底，但那条 CHECK 只在写入时生效，
          // 这里再确认一次是为了让「已完成但没有正文」在最早的时刻炸掉，
          // 而不是等到组装出一份缺段的产物才被用户发现。
          if (stored.contentText === null) {
            throw new ForgeError(
              'SLOT_CONTENT_INVALID',
              `槽位 ${input.slotId} 已标记完成但没有正文（违反 AC-009）`,
              `slot:${input.slotId}`,
            );
          }

          trace.record({
            taskId: input.taskId,
            executionId: input.executionId,
            actor: 'system',
            kind: 'validation_passed',
            title: '内容校验通过',
            summary: `${countChars(input.content)} 字`,
            payload: { slotId: input.slotId, chars: countChars(input.content) },
          });
          trace.record({
            taskId: input.taskId,
            executionId: input.executionId,
            actor: 'system',
            kind: 'assignment_completed',
            title: '槽位已完成',
            summary: `${input.slotId} 已保存`,
            payload: {
              slotId: input.slotId,
              agentId: producer.agentId,
              skillId: producer.skillId,
              skillVersion: producer.skillVersion,
            },
          });
          return stored;
        });

        return { ok: true, slot: committed };
      } catch (error) {
        if (error instanceof ForgeError && error.code === 'EXECUTION_STALE') {
          // 提交事务已整体回滚（AC-011：迟到结果不修改任何状态）。
          // 归因另开事务补记，否则它会被同一次 throw 一起回滚（见文件头 §8.4 修正）。
          recordLateRejection(input.taskId, input.executionId, input.slotId, error.message);
        }
        throw error;
      }
    },

    failSlot(input) {
      traces.runWithTraces((repos, trace) => {
        repos.executions.markFailed(input.executionId, input.errorCode, input.reason);
        if (input.exhausted) {
          repos.slots.markFailed(input.taskId, input.slotId, input.errorCode, input.reason);
          repos.tasks.update(input.taskId, {
            status: 'failed',
            phase: 'slots',
            activeExecutionId: null,
            errorCode: input.errorCode,
            // D-19：写进库的就是要显示的那句话
            errorMessage: `${input.slotId}：${input.reason}`,
          });
        } else {
          // 还有配额：槽位回 pending 等下一次 attempt，任务保持 running。
          // 不写 slots.error_*，否则 `resetFailedToPending` 之外还要有人负责清它。
          repos.slots.resetToPending(input.taskId, input.slotId);
          repos.tasks.update(input.taskId, { activeExecutionId: null });
        }
        trace.record({
          taskId: input.taskId,
          executionId: input.executionId,
          actor: 'system',
          kind: 'assignment_failed',
          title: input.exhausted ? '槽位生产失败' : '本次尝试失败，将重试',
          summary: `${input.slotId}：${input.reason}`,
          payload: { slotId: input.slotId, errorCode: input.errorCode, exhausted: input.exhausted },
        });
      });
    },

    markSlotExhausted(input) {
      traces.runWithTraces((repos, trace) => {
        // `slots.markFailed` 没有前置状态守卫，pending 与 running 都能标失败——
        // 本方法进来时槽位是 pending（被拒路径已经放回去了），这是刻意依赖的行为。
        repos.slots.markFailed(input.taskId, input.slotId, input.errorCode, input.reason);
        repos.tasks.update(input.taskId, {
          status: 'failed',
          phase: 'slots',
          activeExecutionId: null,
          errorCode: input.errorCode,
          // D-19：写进库的就是要显示的那句话
          errorMessage: `${input.slotId}：${input.reason}`,
        });
        trace.record({
          taskId: input.taskId,
          // 本条不绑 execution：耗尽是**跨多次 execution** 的结论，
          // 挂在最后一次上会让 UI 把它显示成「这一次失败了」，而它说的是「不再试了」
          executionId: null,
          actor: 'system',
          kind: 'assignment_failed',
          title: '槽位生产失败',
          summary: `${input.slotId}：${input.reason}`,
          payload: { slotId: input.slotId, errorCode: input.errorCode, exhausted: true },
        });
      });
    },
  };

  return service;
}
