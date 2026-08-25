/**
 * Assignment 执行器（§7.1 的那一层：解析 provider → 建工具集 → 跑循环 → 收敛）。
 *
 * 它是 Runtime 与 application 的唯一接触面：上面是 `AssignmentService`（建 Execution、
 * 写状态），下面是工具循环。本文件**不写数据库**——收敛结果作为返回值交出去，
 * 由调用方在事务里落库。这样 Runtime 的全部行为都能用内存假实现测出来（§11.1）。
 *
 * 两套配额必须分清（D-04）：
 *
 *   PROVIDER_RATE_LIMITED  → `rateLimitBackoff` 配额，**同一个 Execution 内**退避重发，
 *                            不递增 attemptNumber、不新建 Execution，写 `provider_retry` trace
 *   PROVIDER_TIMEOUT /
 *   PROVIDER_ERROR /
 *   校验失败 / 未提交       → `maxRetries` 配额，由调用方新建下一个 Execution
 *
 * 这条区别的实现保证是结构性的：退避循环整个发生在**一次 `run()` 调用内部**，
 * 它没有任何创建 Execution 的能力。`assignment_started` 每次 `run()` 只写一条，
 * 因此「退避了几次」和「跑了几个 attempt」在 trace 上永远分得开。
 */

import type { Operation } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { ErrorCode } from '@shared/errors.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import { classifyAbort, SubmittedSignal, TimeoutSignal, sleepAbortable } from './abort-reasons.ts';
import { runAgentLoop } from './agent-runtime.ts';
import type { LoopUsage, TurnRunner } from './agent-runtime.ts';
import type { CompletionPort, SkillSnapshotView, StructurePort, TracePort } from './ports.ts';
import type { ProviderRegistry, ResolvedModel } from './provider/provider-registry.ts';
import { rateLimitRetryAfterMs } from './provider/rate-limit.ts';
import { SubmissionGate } from './submission-gate.ts';
import { TraceWriter } from './trace-writer.ts';
import { buildToolset, toProviderTools } from './tools/index.ts';
import type { SubmissionRejection } from './tools/index.ts';

/** 与 `ExecutionDefaults.rateLimitBackoff` 同形（§4.2），此处不 import 以免绑死契约层 */
export interface RateLimitBackoffConfig {
  readonly strategy: 'exponential';
  readonly initialMs: number;
  readonly maxMs: number;
  /** 限流重试是独立配额，不计入 maxRetries */
  readonly maxAttempts: number;
}

export interface Assignment {
  readonly taskId: string;
  readonly executionId: string;
  /** 明文 Token（§8.1）。只透传给 CompletionPort */
  readonly executionToken: string;
  readonly operation: Operation;
  readonly targetSlotId: string | null;
  /** D-03：冻结的别名，晚绑定解析 */
  readonly modelAlias: string;
  readonly systemText: string;
  readonly userText: string;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly allowedDependencySlotIds: readonly string[];
  readonly skill: SkillSnapshotView;
  readonly taskInput: Readonly<Record<string, string>>;
  /**
   * 由调用方创建并登记进 `activeControllers`（§8.3），**不是**在这里 new。
   * stop 事务提交后要能拿到它 abort；Runtime 自己 new 一个的话，
   * lifecycle 就只能靠回调拿到句柄，而那个回调必然是异步的——
   * 而 §8.3 要求那次读取是同步的（notes Q-06 第 4 条）。
   */
  readonly controller: AbortController;
}

export interface AssignmentRunnerDeps {
  readonly registry: ProviderRegistry;
  readonly trace: TracePort;
  readonly completion: CompletionPort;
  readonly structure: StructurePort;
  readonly rateLimitBackoff: RateLimitBackoffConfig;
}

interface OutcomeBase {
  /** 晚绑定解析的结果，供调用方写入 `executions.provider` / `.model`。解析失败为 null */
  readonly provider: string | null;
  readonly model: string | null;
  readonly usage: LoopUsage | null;
  readonly toolCalls: number;
}

export type AssignmentOutcome =
  | ({ readonly kind: 'succeeded' } & OutcomeBase)
  | ({
      readonly kind: 'failed';
      readonly code: ErrorCode;
      readonly message: string;
      /** 结构校验失败时非空，供下一次 attempt 拼 D-13 反馈块 */
      readonly violations: readonly StructureViolation[];
      /** AC-014：模型压根没调 complete_assignment。调用方据此追加 §7.6 的固定文案 */
      readonly noSubmission: boolean;
      /** 是否消耗 `maxRetries` 配额（D-04） */
      readonly consumesRetry: boolean;
    } & OutcomeBase)
  | ({ readonly kind: 'cancelled'; readonly reason: 'user_stop' } & OutcomeBase);

export class AssignmentRunner {
  constructor(private readonly deps: AssignmentRunnerDeps) {}

  async run(assignment: Assignment): Promise<AssignmentOutcome> {
    const trace = new TraceWriter(this.deps.trace, assignment.taskId);
    const empty = { provider: null, model: null, usage: null, toolCalls: 0 } as const;

    let resolved: ResolvedModel;
    try {
      resolved = this.deps.registry.resolve(assignment.modelAlias);
    } catch (error) {
      // 别名解析失败不是模型的错，也不该消耗重试配额：重试一百次结果一样，
      // 修复动作是改 config/providers.yaml
      const forge = asForgeError(error, 'MODEL_ALIAS_UNRESOLVED');
      return {
        kind: 'failed',
        code: forge.code,
        message: forge.message,
        violations: [],
        noSubmission: false,
        consumesRetry: false,
        ...empty,
      };
    }

    const bound = { provider: resolved.providerId, model: resolved.model };
    trace.write({
      executionId: assignment.executionId,
      actor: 'system',
      kind: 'assignment_started',
      title: '开始执行',
      summary: `${assignment.operation}${assignment.targetSlotId === null ? '' : ` · ${assignment.targetSlotId}`}`,
      // 只记别名与解析后的模型名。apiKey 连读都没读到这里
      payload: {
        modelAlias: assignment.modelAlias,
        provider: resolved.providerId,
        model: resolved.model,
        maxToolCalls: assignment.maxToolCalls,
        timeoutMs: assignment.timeoutMs,
      },
    });

    const gate = new SubmissionGate();
    // 用 ref 而不是裸 let：赋值发生在工具闭包里，TS 的控制流分析看不到那次写入，
    // 会把后面的读取窄化成 `never`。ref 让「跨闭包的可变状态」在类型上也是显式的
    const rejectionRef: { current: SubmissionRejection | null } = { current: null };

    const tools = buildToolset({
      taskId: assignment.taskId,
      executionId: assignment.executionId,
      executionToken: assignment.executionToken,
      operation: assignment.operation,
      targetSlotId: assignment.targetSlotId,
      allowedDependencySlotIds: assignment.allowedDependencySlotIds,
      skill: assignment.skill,
      taskInput: assignment.taskInput,
      gate,
      trace,
      completion: this.deps.completion,
      structure: this.deps.structure,
      onSubmitted: () => {
        gate.close();
        // 提交成功后立刻掐掉 Provider（D-11）。reason 用 SubmittedSignal，
        // 好让收敛处能把它与超时/停止区分开
        assignment.controller.abort(new SubmittedSignal());
      },
      onRejected: (r) => {
        rejectionRef.current = r;
      },
    });

    const callProvider: TurnRunner = (turnInput) =>
      resolved.adapter.runTurn({ model: resolved.model, apiKey: resolved.apiKey, ...turnInput });

    const runTurn = this.#withRateLimitBackoff(callProvider, resolved.providerId, trace, assignment);

    // §8.2：超时靠同一个 AbortController，reason 不同而已
    const timer = setTimeout(() => {
      assignment.controller.abort(new TimeoutSignal(assignment.timeoutMs));
    }, assignment.timeoutMs);

    try {
      const result = await runAgentLoop(
        {
          executionId: assignment.executionId,
          systemText: assignment.systemText,
          userText: assignment.userText,
          maxToolCalls: assignment.maxToolCalls,
          maxTokens: assignment.maxTokens,
          signal: assignment.controller.signal,
        },
        { runTurn, tools, providerTools: toProviderTools(tools), gate, trace },
      );

      const base = { ...bound, usage: result.usage, toolCalls: result.toolCalls };

      if (result.kind === 'submitted') return { kind: 'succeeded', ...base };

      if (result.kind === 'aborted') {
        switch (classifyAbort(assignment.controller.signal.reason)) {
          case 'user_stop':
            // §8.2 第 4 条：Execution 已经在 stop 事务里标了 cancelled，此处不重复写
            return { kind: 'cancelled', reason: 'user_stop', ...base };
          case 'timeout':
            return {
              kind: 'failed',
              code: 'PROVIDER_TIMEOUT',
              message: `执行超过 ${assignment.timeoutMs}ms 未完成`,
              violations: [],
              noSubmission: false,
              consumesRetry: true,
              ...base,
            };
          case 'submitted':
          case 'unknown':
            // 中止了但闸门没关：产出没保存，也说不清是谁中止的。
            // 归为 EXECUTION_CANCELLED 且**不消耗配额**——在原因不明时消耗用户的
            // 重试次数，比多留一次机会更糟
            return {
              kind: 'failed',
              code: 'EXECUTION_CANCELLED',
              message: '执行被中止且未产出结果',
              violations: [],
              noSubmission: false,
              consumesRetry: false,
              ...base,
            };
        }
      }

      if (result.kind === 'failed') {
        return {
          kind: 'failed',
          code: result.code,
          message: result.message,
          violations: [],
          noSubmission: false,
          consumesRetry: true,
          ...base,
        };
      }

      // no_submission。**分两种，不能混为一谈**：
      // 提交过但被拒 → 报被拒的那个码与违规列表（下一次 attempt 拼 D-13 反馈块）；
      // 压根没提交   → AC-014 的 ASSIGNMENT_OUTPUT_INVALID，下一次追加 §7.6 固定文案。
      // 混成一个码会让「结构一直写错」和「模型不会用工具」在 UI 上长得一模一样
      const pending = rejectionRef.current;
      if (pending !== null) {
        return {
          kind: 'failed',
          code: pending.code,
          message: pending.message,
          violations: pending.violations,
          noSubmission: false,
          consumesRetry: true,
          ...base,
        };
      }
      return {
        kind: 'failed',
        code: 'ASSIGNMENT_OUTPUT_INVALID',
        message: 'Agent 未通过 complete_assignment 提交结果',
        violations: [],
        noSubmission: true,
        consumesRetry: true,
        ...base,
      };
    } catch (error) {
      const forge = asForgeError(error, 'PROVIDER_ERROR');
      return {
        kind: 'failed',
        code: forge.code,
        message: forge.message,
        violations: [],
        noSubmission: false,
        // 退避配额已经耗尽的限流、工具超限、Provider 异常，都是真失败：
        // 不消耗配额意味着调用方可以无限重跑，那才是真正的烧钱路径
        consumesRetry: true,
        ...bound,
        usage: null,
        toolCalls: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 限流退避（§8.5 / D-04）。
   *
   * 包在 `runTurn` 这一层而不是包住整个循环：包住循环会把已经做过的工具调用
   * 全部重放一遍（包括可能已经成功的提交）。代价是「turn 中途 429」时
   * 本轮已分发的工具调用会重复计数——实际上 429 都发生在请求发出的瞬间，
   * 这里记一笔以免将来有人以为它被证明过。
   */
  #withRateLimitBackoff(
    inner: TurnRunner,
    providerId: string,
    trace: TraceWriter,
    assignment: Assignment,
  ): TurnRunner {
    const cfg = this.deps.rateLimitBackoff;
    return async (turnInput) => {
      let delay = cfg.initialMs;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await inner(turnInput);
        } catch (error) {
          const isRateLimit = error instanceof ForgeError && error.code === 'PROVIDER_RATE_LIMITED';
          if (!isRateLimit || attempt + 1 >= cfg.maxAttempts) throw error;

          this.deps.registry.recordRateLimit(providerId);
          // Provider 明说了等多久就听它的，但不超过配置上限——
          // 一个恶意或错误的 Retry-After: 86400 不该让任务挂一整天
          const waitMs = Math.min(rateLimitRetryAfterMs(error) ?? delay, cfg.maxMs);
          trace.write({
            executionId: assignment.executionId,
            actor: 'system',
            kind: 'provider_retry',
            title: '触发限流，正在退避重试',
            summary: `${waitMs}ms 后重试（第 ${attempt + 1} 次退避，不计入重试配额）`,
            payload: { providerId, waitMs, backoffAttempt: attempt + 1, maxAttempts: cfg.maxAttempts },
          });

          await sleepAbortable(waitMs, turnInput.signal);
          if (turnInput.signal.aborted) {
            // 退避期间被 stop / 超时打断。返回 aborted 而不是继续重发，
            // 交由收敛处按 signal.reason 区分是谁中止的
            return { stopReason: 'aborted', usage: null, appendMessages: [] };
          }
          delay = Math.min(delay * 2, cfg.maxMs);
        }
      }
    };
  }
}

function asForgeError(error: unknown, fallback: ErrorCode): ForgeError {
  if (error instanceof ForgeError) return error;
  return new ForgeError(
    fallback,
    error instanceof Error ? error.message : String(error),
    null,
    null,
    error,
  );
}
