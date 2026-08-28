/**
 * 结构提交服务（文档 §5.5「提交 Structure」+ §6.1 + D-13 + D-19）。
 *
 * 一次结构提交只有三种结局，全部由本文件裁定并落库：
 *
 * 1. **通过** —— n 个槽位在**一个事务内**整体插入，execution 收尾，phase → slots。
 * 2. **未通过** —— 数据库里一个槽位都不留，违规列表原样交回给重试路径。
 * 3. **配额耗尽** —— 任务置 failed，`error_message` 写成可直接展示的完整中文。
 *
 * ## 为什么校验在事务外、写入在事务内
 *
 * `validateConcreteStructure` 是纯函数，跑得再久也不该占着一个写事务；
 * 更重要的是「未通过」这条路径根本不需要事务——它一行都不写结构。
 * 反过来，一旦通过，`INSERT slots × n` 与 `completeStructurePhase` 必须原子，
 * 否则会留下一棵「已经建好但任务还停在 structure 阶段」的孤儿结构树。
 *
 * ## 为什么不校验 Execution Token
 *
 * §5.5 的表下说明写得很清楚：结构 execution 的 `target_slot_id IS NULL`，
 * 没有槽位可串，`active_execution_id = ?` 这一条已经同时覆盖了
 * 「token 所属的执行仍是当前执行」。再加一次 token 比对，等于把 D-10 明令禁止的
 * 「读 → 判 → 写」重新引进来一次，还多一份要维护的判据。
 * 守卫全部压在 `TaskRepo.completeStructurePhase` 的 WHERE 里。
 *
 * ## D-13：违规必须整批、原样传下去
 *
 * `StructureViolation` 的三段式（rule / message / agentHint）不许在本层被压成一句话。
 * `maxExecutionRetries` 默认 2 —— Structure Agent 总共只有 3 次机会满足 19 条校验，
 * 反馈质量直接决定通过率。只报第一条会让模型陷入「改一条冒出下一条」的循环，
 * 三次机会全烧在同一棵树上。
 *
 * ## 容器槽位的 status（M3-B 发现的文档/实现分歧）
 *
 * `domain/readiness.ts` 与附录 B.2 都写着「容器槽位在结构提交后就是 completed」，
 * 但 `SlotRepo.insertMany` 把 status 硬编码为 `'pending'`，仓储层没有把容器置为
 * completed 的入口，而仓储在 M2 已冻结。核对全部读取点后确认这是**纯文案分歧**：
 * `isSlotReady` / `allContentSlotsCompleted` / `detectDeadlock` / `findInterruptionPoint`
 * 都先按 `contentBearing` 过滤，`assembly` 根本不读 status，
 * 附录 B.2 第 1 行也先按 `contentBearing` 短路。因此容器槽位落库即 pending 并永远保持
 * pending，行为与「置为 completed」完全等价。文档已相应修订（见 §5.5 表下与附录 B.2）。
 */

import type { ErrorCode } from '@shared/errors.ts';
import { ForgeError } from '@shared/errors.ts';
import { canonicalJson } from '@server/domain/canonical.ts';
import type { StructureProposal, StructureViolation, ValidatedSlot } from '@server/domain/structure-validation.ts';
import { validateConcreteStructure } from '@server/domain/structure-validation.ts';
import type { InsertSlotInput } from '@server/infrastructure/database/repositories/index.ts';
import type { SnapshotService } from './snapshot-service.ts';
import type { TraceService } from './trace-service.ts';

export interface SubmitStructureInput {
  taskId: string;
  /** D-09：AgentAssignment.id === execution.id */
  executionId: string;
  proposal: StructureProposal;
}

export interface StructureAccepted {
  ok: true;
  /** 已落库的规范化槽位，文档序 */
  slots: readonly ValidatedSlot[];
}

export interface StructureRejected {
  ok: false;
  /** 全部违规，不截断（D-13） */
  violations: readonly StructureViolation[];
  /**
   * 上次提案的规范化 JSON，供 §7.4 的重试追加块**原样回灌**。
   * 由本层给出而不是让调用方自己序列化：回灌文本与被校验的那份提案必须是同一个东西。
   */
  proposalJson: string;
  /** 已成文的中文失败原因（D-19）。写 trace 与 `task.error_message` 都用它 */
  reason: string;
}

export type SubmitStructureResult = StructureAccepted | StructureRejected;

export interface ExhaustStructureInput {
  taskId: string;
  /** 最后一次尝试的违规列表，用于成文。非校验类失败时为空 */
  violations: readonly StructureViolation[];
  attempts: number;
  /**
   * 最后一次失败的成文原因（D-19），由持有失败详情的一方给出。
   *
   * 必填是刻意的：不是每次耗尽都因为校验没过。超时、Provider 报错、
   * 模型别名解析不出来——这些情况 `violations` 是空的，而早先的实现会一律成文为
   * 「结构提案未通过确定性校验」。那是一句**与事实不符**的错误信息，
   * 它会把排查方向直接引到 Skill 文案上，而真正的原因（比如少配了一个环境变量）
   * 连一条线索都不留。
   */
  lastReason: string;
}

export interface FailStructureAttemptInput {
  taskId: string;
  executionId: string;
  errorCode: ErrorCode;
  /** 已成文的完整中文（D-19）。由持有失败详情的一方写好交过来 */
  reason: string;
}

export interface StructureService {
  /** §5.5「提交 Structure」。通过即原子落库；未通过一行都不写结构 */
  submit(input: SubmitStructureInput): SubmitStructureResult;
  /**
   * §5.5「一次尝试失败收尾」的结构侧（M3-C 补）。
   *
   * 与 `CompletionService.failSlot` 对称，只负责**收尾**：execution 收敛到 failed、
   * 把 `active_execution_id` 让出来。配额是否耗尽不在这里判——耗尽走 `markExhausted`，
   * 那条边界完全不碰 executions（此时 execution 可能已被 `submit` 的被拒路径收敛过了）。
   *
   * **调用前提**：execution 仍是 `running`。已收敛的 execution 不许再进来，
   * 否则会把一条 `cancelled`（用户停止）覆盖成 `failed`，把「谁取消的」抹掉。
   * 判据由调用方（ProductionEngine）用库里的 status 取，不按错误码猜。
   */
  failAttempt(input: FailStructureAttemptInput): void;
  /**
   * 重试配额耗尽（§8.7 / `STRUCTURE_RETRY_EXHAUSTED`）。
   *
   * 放在本文件而不是 lifecycle：D-19 规定失败原因的成文责任在持有违规列表的那一层，
   * 而只有这里同时拿着违规列表与尝试次数。
   */
  markExhausted(input: ExhaustStructureInput): void;
}

export interface StructureServiceOptions {
  snapshots: SnapshotService;
  /** 全部写入都经由它，以保证 §5.5 的「事务内 insert，提交后 publish」 */
  traces: TraceService;
}

/**
 * 成文的失败原因（D-19）。
 *
 * 必须是一句能直接贴到界面上的完整中文——附录 B.1 第 10 行把 `task.errorMessage`
 * 原样当作 detail 显示，派生层不解析也不拼装。
 * 因此这里给「首条违规 + 总条数」，而不是 `violations.length + ' 条问题'` 这种
 * 看得见数量却看不出发生了什么的写法。
 */
function composeReason(violations: readonly StructureViolation[]): string {
  const first = violations[0];
  if (first === undefined) return '结构提案未通过确定性校验';
  if (violations.length === 1) return `结构校验未通过：${first.message}`;
  return `结构校验未通过：${first.message}（共 ${violations.length} 条问题）`;
}

/**
 * 配额耗尽时的成文原因。`markExhausted` 与 `structureExhaustedError` 共用一份，防止两处文案漂移。
 *
 * 有违规就报违规（那是最有用的信息）；没有违规时报调用方给的最后一次失败原因，
 * **不要**退回「未通过确定性校验」——那句话在超时或缺配置的场景下是假的。
 */
function composeExhaustedReason(
  violations: readonly StructureViolation[],
  attempts: number,
  lastReason: string,
): string {
  const head = violations.length > 0 ? composeReason(violations) : lastReason.trim() || '结构创建失败';
  return `${head}；已用尽 ${attempts} 次尝试，任务停在创建结构阶段`;
}

/** 违规写进 trace payload 时保留三段式：UI 高亮要 slotIds，重试路径要 agentHint */
function violationsPayload(violations: readonly StructureViolation[]): Record<string, unknown> {
  return {
    count: violations.length,
    violations: violations.map((violation) => ({
      rule: violation.rule,
      message: violation.message,
      agentHint: violation.agentHint,
      slotIds: [...violation.slotIds],
    })),
  };
}

function toInsertInput(taskId: string, slot: ValidatedSlot, revisionRound: number): InsertSlotInput {
  return {
    taskId,
    slotId: slot.slotId,
    type: slot.type,
    parentId: slot.parentId,
    sortOrder: slot.sortOrder,
    instruction: slot.instruction,
    dependsOn: slot.dependsOn,
    contentBearing: slot.contentBearing,
    includeInArtifact: slot.includeInArtifact,
    revisionRound,
  };
}

export function createStructureService(options: StructureServiceOptions): StructureService {
  const { snapshots, traces } = options;

  return {
    submit(input) {
      // 事务外：读快照 + 纯函数校验。两者都可能失败，且都不该占着写事务。
      const snapshot = snapshots.readSnapshot(input.taskId);
      const result = validateConcreteStructure(input.proposal, snapshot.compiled);

      if (!result.ok) {
        const reason = composeReason(result.violations);
        // D-20：被拒**只写 trace**，不收敛 execution、不让出 active_execution_id。
        //
        // 这里曾经顺手 markFailed + 清空 active_execution_id，后果是：模型照着违规提示
        // 改好、在同一轮对话里重新提交时，D-10 的 WHERE 发现活动执行已经没了，
        // 返回 EXECUTION_STALE——一个本该被接受的正确结构，被系统自己判成了迟到结果。
        // D-11 的闸门只在**成功**时关闭，意思就是「被拒之后你还可以再试」；
        // 一次 Assignment 何时结束由 ProductionEngine 决定，不由这里。
        //
        // 结构树一行都不插——这正是「非法结构被整体拒绝，数据库无部分 slot」那条判据。
        traces.runWithTraces((repos, trace) => {
          void repos;
          trace.record({
            taskId: input.taskId,
            executionId: input.executionId,
            actor: 'system',
            kind: 'validation_failed',
            title: '结构校验未通过',
            summary: reason,
            payload: violationsPayload(result.violations),
          });
        });

        return {
          ok: false,
          violations: result.violations,
          proposalJson: canonicalJson(input.proposal),
          reason,
        };
      }

      // 事务内：只做写入。任一步抛错整体回滚，槽位一个都不留（§5.5）。
      traces.runWithTraces((repos, trace) => {
        /*
         * R5：**整棵树原子替换**，而不是「插一棵新的」。
         *
         * 结构审核检出问题时，phase 退回 structure、上一棵树**原样留着**，
         * 直到这里拿到一份通过校验的新提案才替换。留着是刻意的：
         * 返修那一轮的 prompt 要把上一版的 instruction 与审核引文回灌给模型
         * （见 context-builder 的 reviewFindings 块），而那两样东西的唯一来源
         * 就是库里的旧树与 slot_reviews。先删再生成，等于让模型在看不见自己上一版的
         * 情况下「改」它——那不是返修，是重抽一次。
         *
         * 轮次必须**继承**：新树的根接着旧根的 revision_round 往下数。
         * 每棵新树都从 0 开始的话，`settleReview` 的 `revisionRound < maxRevisionRounds`
         * 永远成立，结构会无限重来——D-26「任务永不因审核卡死」正是靠这个数收口。
         *
         * 删 slot_reviews 必须在删 slots 之前，且必须**整任务删干净**——
         * 理由（连同我试图只删一部分时踩到的外键）写在 `deleteByTask` 上。
         * 往轮的审核意见不会因此丢失：它们同时在 trace 里，而 trace 只追加。
         */
        const previous = repos.slots.listByTask(input.taskId);
        const previousRoot = previous.find((slot) => slot.parentId === null);
        const carriedRound = previousRoot?.revisionRound ?? 0;
        if (previous.length > 0) {
          repos.slotReviews.deleteByTask(input.taskId);
          repos.slots.deleteAll(input.taskId);
        }

        repos.slots.insertMany(
          result.slots.map((slot) =>
            // 只有根携带轮次：其余槽位的返修轮是它们自己填槽审核的事，与结构无关。
            toInsertInput(input.taskId, slot, slot.parentId === null ? carriedRound : 0),
          ),
        );
        repos.executions.markSucceeded(input.executionId);
        // 条件 UPDATE：`changes !== 1` 即抛 EXECUTION_STALE，把上面那批槽位一起回滚。
        // 守卫必须在这里而不是在 insertMany 之前——放前面就是「读判写」，
        // 而放后面则是「写完再让数据库裁定这次写作不作数」。
        repos.tasks.completeStructurePhase({
          taskId: input.taskId,
          executionId: input.executionId,
        });
        trace.record({
          taskId: input.taskId,
          executionId: input.executionId,
          actor: 'system',
          kind: 'validation_passed',
          title: '结构校验通过',
          summary: `${result.slots.length} 个槽位已创建`,
          payload: { slotIds: result.slots.map((slot) => slot.slotId) },
        });
        /**
         * 收尾事件（M5-D 补正）。
         *
         * 原先结构这条路径**只有失败才收尾**：`failAttempt` 写
         * `assignment_failed`，而成功这一支写完 `validation_passed` 就结束了。
         * 于是一次真实任务的轨迹里，6 个 assignment 只有 5 条
         * `assignment_completed`——少的那条正是结构。
         *
         * 后果有两层。轻的一层是 UX §13 的时间线：结构那一格永远处在
         * 「已提交、已校验、然后没有下文」的状态，看起来像卡住了。
         * 重的一层是任何按 trace 统计「跑完了几次 assignment」的东西
         * （measure-runs.ts 就是）都会稳定少算一次，
         * 而少算的方式是系统性的、每次都一样的，因此不会被当成异常。
         *
         * 这与 M4 修掉的 `assignment_started` 写两次是同一类问题：
         * 一条 assignment 的轨迹必须自洽，缺一半和多一半同样坏。
         */
        trace.record({
          taskId: input.taskId,
          executionId: input.executionId,
          actor: 'system',
          kind: 'assignment_completed',
          title: '结构已完成',
          summary: `${result.slots.length} 个槽位已保存`,
          payload: {
            slotIds: result.slots.map((slot) => slot.slotId),
            rootSlotId: input.proposal.rootSlotId,
          },
        });

        /*
         * R5：绑了结构审核时，这里**不**把根置成 reviewing。
         *
         * 我先是在这个事务里加了一次 `markContainerReviewing`，理由写得挺像回事
         * （「phase 已经推到 slots 了，中间崩一次就会留下一棵不会被审的树」）。
         * 反证的时候把那段整个删掉，测试全绿——因为调度器本来就认
         * 「pending 的根容器 + 有结构审核绑定 = 该审」（见 `pendingStructureRoot`），
         * 而那条判定是**删不掉的**：stop 与崩溃恢复会用 `cancelReview` 把根放回
         * pending，只认 reviewing 的话 resume 之后审核会被静默跳过。
         *
         * 于是这里那一次转换是第二条通往同一件事的路，且没有任何测试分得出它在不在。
         * 分不出的分支迟早会烂，所以删掉它，只留调度器那一条。
         * 状态转换统一由引擎在开跑前做（`markContainerReviewing` 的唯一调用点）。
         */
      });

      return { ok: true, slots: result.slots };
    },

    failAttempt({ taskId, executionId, errorCode, reason }) {
      traces.runWithTraces((repos, trace) => {
        repos.executions.markFailed(executionId, errorCode, reason);
        // 让出活动执行位。少了这一步，下一次 attempt 会在
        // `AssignmentService.create` 的 `activeExecutionId !== null` 守卫上失败，
        // 任务从此调度不动，而报错指向的是「已有正在进行的执行」——
        // 一个把真正原因（上次超时了）完全盖住的归因。
        repos.tasks.update(taskId, { activeExecutionId: null });
        trace.record({
          taskId,
          executionId,
          actor: 'system',
          kind: 'assignment_failed',
          title: '结构设计未完成',
          summary: reason,
          payload: { errorCode },
        });
      });
    },

    markExhausted({ taskId, violations, attempts, lastReason }) {
      const reason = composeExhaustedReason(violations, attempts, lastReason);

      traces.runWithTraces((repos, trace) => {
        repos.tasks.update(taskId, {
          status: 'failed',
          phase: 'structure',
          activeExecutionId: null,
          errorCode: 'STRUCTURE_RETRY_EXHAUSTED',
          // D-19：写进库的就是最终要显示的那句话，派生层不再加工
          errorMessage: reason,
        });
        trace.record({
          taskId,
          executionId: null,
          actor: 'system',
          kind: 'assignment_failed',
          title: '结构重试已耗尽',
          summary: reason,
          payload: violationsPayload(violations),
        });
      });
    },
  };
}

/**
 * 供调用方在需要时自行构造同款错误（例如 API 层要把「结构耗尽」直接回给用户）。
 * 与 `markExhausted` 写进库的那句话是同一句，避免两处文案漂移。
 */
export function structureExhaustedError(
  taskId: string,
  violations: readonly StructureViolation[],
  attempts: number,
  lastReason = '结构创建失败',
): ForgeError {
  return new ForgeError(
    'STRUCTURE_RETRY_EXHAUSTED',
    composeExhaustedReason(violations, attempts, lastReason),
    `task:${taskId}`,
    '点击重试重新设计结构，已冻结的输入不变',
  );
}
