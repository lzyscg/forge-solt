/**
 * Assignment 创建（文档 §5.5「创建 Assignment」+ §7.1 + D-09 + §8.1）。
 *
 * §5.5 逐字规定了这条边界的事务内容：
 *   `INSERT executions` + `UPDATE tasks.active_execution_id`
 *   + `UPDATE slots.status='running'`（fill_slot 时）+ `INSERT trace_events × 2`
 *
 * ## D-09：Assignment 不建表
 *
 * `AgentAssignment.id` 直接就是 `execution.id`，不另外生成。
 * 因此本文件返回的 `CreatedAssignment.id` 与 `execution.id` 恒等——
 * 这不是巧合，是决议本身。UX §13.5 展示「Execution ID / Assignment ID」时前端只显示一行。
 *
 * ## §8.1：明文 Token 绝不落库
 *
 * `crypto.randomUUID() + crypto.randomUUID()` 生成 72 字符的原始 token，
 * 库里只存 `sha256Hex(raw)`。原始值只出现在返回值里、只交给 Runtime 拿去提交时出示。
 * 它不进 trace（`TracePayloadSchema` 的黑名单挡不住一个叫 `token` 的键，
 * 所以这条纪律必须靠本文件自己守住）、不进 context、不进任何日志。
 *
 * Token 的失效方式不是删除，而是把 `executions.status` 改成非 running，
 * 或把 `tasks.active_execution_id` 指向别处——D-10 的 UPDATE 同时检查这两条。
 *
 * ## 为什么 execution 在创建时就置 running
 *
 * 创建事务里写 `assignment_created`（M4 前是两条，见下方与 §8.5），
 * 而 D-10 的条件 UPDATE 要求提交时 `e.status = 'running'`。
 * 若把 markRunning 留到 Runtime 真正发起模型调用时再做，就会多出一个
 * 「execution 已是活动执行、槽位已 running，但 status 还是 created」的中间态；
 * 那个窗口里到达的提交会被 D-10 拒掉，而拒绝理由是「execution 已非 running」——
 * 一个完全误导人的归因。宁可让 `started_at` 早那么几毫秒。
 */

import { randomUUID } from 'node:crypto';
import type { Operation } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import { sha256Hex } from '@server/domain/canonical.ts';
import type { Execution } from '@server/domain/types.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { BuiltAssignmentContext } from './context-builder.ts';
import type { TraceService } from './trace-service.ts';

/** 绑定信息。只取本层用得上的字段，不把整个 `CompiledBinding` 拖进签名 */
export interface AssignmentBinding {
  agentId: string;
  skillId: string;
  skillVersion: string;
  /** D-03：冻结在快照里的别名。历史任务据此可知它当时用的是哪个别名 */
  modelAlias: string;
}

/** D-03 的晚绑定结果。别名解析发生在 `ProviderRegistry`，本层只记录结论 */
export interface ResolvedModel {
  provider: string;
  model: string;
}

export interface CreateAssignmentInput {
  taskId: string;
  operation: Operation;
  /** `create_structure` 时为 null */
  targetSlotId: string | null;
  binding: AssignmentBinding;
  resolved: ResolvedModel;
  context: BuiltAssignmentContext;
  /** 从 1 起。用 `nextAttemptNumber()` 取 */
  attemptNumber: number;
}

export interface CreatedAssignment {
  /** D-09：与 `execution.id` 恒等 */
  id: string;
  execution: Execution;
  /**
   * §8.1 的明文 Execution Token。
   * **只在内存里传给 Runtime**，提交时原样出示，由 `CompletionService` 取 sha256 后
   * 交给 D-10 的 WHERE 子句核对。任何把它写进库、trace、日志或 prompt 的行为都是安全事故。
   */
  token: string;
}

export interface AssignmentService {
  /** §5.5「创建 Assignment」。整条边界在一个事务内完成，trace 在提交后才推 SSE */
  create(input: CreateAssignmentInput): CreatedAssignment;
  /** §8.7：下一次尝试的序号。`create_structure` 的 targetSlotId 传 null */
  nextAttemptNumber(taskId: string, targetSlotId: string | null): number;
}

export interface AssignmentServiceOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  traces: TraceService;
  /** 注入以便测试断言确定的 ID；生产用 randomUUID */
  newId?: () => string;
  /** 注入以便测试断言确定的 token；生产用两个 UUID 拼接（§8.1，72 字符） */
  newToken?: () => string;
}

export function createAssignmentService(options: AssignmentServiceOptions): AssignmentService {
  const { uow, traces } = options;
  const newId = options.newId ?? ((): string => randomUUID());
  const newToken = options.newToken ?? ((): string => `${randomUUID()}${randomUUID()}`);

  return {
    nextAttemptNumber(taskId, targetSlotId) {
      return uow.repositories.executions.latestAttempt(taskId, targetSlotId) + 1;
    },

    create(input) {
      const executionId = newId();
      const token = newToken();
      const tokenHash = sha256Hex(token);

      const execution = traces.runWithTraces((repos, trace) => {
        // 事务内读 + 判 + 写在这里是**安全的**：better-sqlite3 全同步，
        // 单个 SQLite 写事务内不存在调度点，D-10 反对的是跨 await 的读判写。
        const task = repos.tasks.getOrThrow(input.taskId);
        if (task.status !== 'running') {
          throw new ForgeError(
            'TASK_STATE_INVALID',
            `任务 ${input.taskId} 当前状态为 ${task.status}，不能创建新的工作分配`,
            `task:${input.taskId}`,
            '刷新页面查看最新状态',
          );
        }
        if (task.activeExecutionId !== null) {
          // NFR-001 全局串行的任务级投影：同一任务不允许两个活动执行。
          // 放行会让 D-10 的 `t.active_execution_id = e.id` 只认后来者，
          // 先来的那次执行提交时被判 stale，而它其实是合法的。
          throw new ForgeError(
            'TASK_STATE_INVALID',
            `任务 ${input.taskId} 已有正在进行的执行 ${task.activeExecutionId}`,
            `task:${input.taskId}`,
            '刷新页面查看最新状态',
          );
        }

        repos.executions.insert({
          id: executionId,
          taskId: input.taskId,
          operation: input.operation,
          targetSlotId: input.targetSlotId,
          agentId: input.binding.agentId,
          skillId: input.binding.skillId,
          skillVersion: input.binding.skillVersion,
          tokenHash,
          // 由 ContextBuilder 产出的规范化文本，与 contextHash 逐字对应（D-12）。
          // 本层不再序列化一次——那会让 hash 与落库文本变成两个独立产生的字符串。
          contextJson: input.context.contextJson,
          contextHash: input.context.contextHash,
          promptHash: input.context.promptHash,
          modelAlias: input.binding.modelAlias,
          provider: input.resolved.provider,
          model: input.resolved.model,
          attemptNumber: input.attemptNumber,
        });
        repos.executions.markRunning(executionId);
        repos.tasks.update(input.taskId, { activeExecutionId: executionId });

        if (input.operation === 'fill_slot') {
          if (input.targetSlotId === null) {
            throw new ForgeError(
              'SLOT_TARGET_MISMATCH',
              'fill_slot 的 Assignment 必须指定目标槽位',
              `task:${input.taskId}`,
            );
          }
          // pending → running 的守卫压在 SlotRepo 的 WHERE 里：
          // 只有 pending 能被调度，重复调度同一槽位会拿到 SLOT_NOT_READY 而不是静默通过。
          repos.slots.markRunning(input.taskId, input.targetSlotId);
        }

        const target =
          input.targetSlotId === null ? '整棵结构' : `槽位 ${input.targetSlotId}`;

        trace.record({
          taskId: input.taskId,
          executionId,
          actor: 'system',
          kind: 'assignment_created',
          title: '已创建工作分配',
          summary: `${input.binding.agentId} · ${input.binding.skillId} v${input.binding.skillVersion} → ${target}`,
          // 只放可公开的技术详情（UX §13.5）。token 与 apiKey 一个都不在这里，
          // 也不能在这里——payload 会原样进 API 响应与页面。
          payload: {
            operation: input.operation,
            targetSlotId: input.targetSlotId,
            attemptNumber: input.attemptNumber,
            modelAlias: input.binding.modelAlias,
            provider: input.resolved.provider,
            model: input.resolved.model,
            contextHash: input.context.contextHash,
            promptHash: input.context.promptHash,
          },
        });
        // 这里**不写** `assignment_started`（M4 补正，见 §8.5）。它归 Runtime 独有：
        // 「开始」要意味着模型真的开始工作了，而别名解析失败时 Runtime 根本走不到
        // 那一步——那种失败的时间线上应该只有「已创建」，没有「已开始」。
        // 原先两处都写，一次 assignment 会产出两条同刻的 `assignment_started`。

        // 重新读回而不是直接返回 `insert()` 的构造结果：那个对象的 status 还是
        // `created`、`startedAt` 还是 null，而此刻库里已经是 running 了。
        // 返回一个与库不一致的领域对象，调用方据此判断「这次执行开始了吗」就会判错。
        return repos.executions.getOrThrow(executionId);
      });

      return { id: executionId, execution, token };
    },
  };
}
