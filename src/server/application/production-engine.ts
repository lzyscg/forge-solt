/**
 * 生产引擎（文档 §7.1 时序 / D-04 互斥队列 / D-14 排队位次 / §8.7 重试配额）。
 *
 * 这个文件回答一个问题：**「现在该做什么」以及「做完之后该做什么」。**
 * 它是系统里唯一持有「任务在推进」这个概念的地方——其余每一层都只处理一个瞬间。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **完成由系统决定（AC-014）。** 相位从 structure → slots → assembly → done 的每一步
 *    都由这里根据库里的事实推断，不接受任何来自模型的「我完成了」。
 *
 * 2. **不允许出现永久 running。** 三道网：Runtime 的超时（§8.2）、
 *    本文件的双桶配额（下面 `RetryBudget`，保证 tick 循环必然终止）、
 *    以及 lifecycle 的启动恢复（§8.6）。少任何一道，某条异常路径就会把任务永远挂住。
 *
 * 3. **P0 并发固定 1（D-04）。** 不是性能取舍——串行是 `active_execution_id` 这套
 *    Token 机制成立的前提之一，也是「排队中」这个业务状态存在的原因（D-14）。
 */

import type { Operation, TaskStatus } from '@shared/contracts.ts';
import { ForgeError, type ErrorCode } from '@shared/errors.ts';
import type { Slot, Task } from '@server/domain/types.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import { settleReview } from '@server/domain/review-settlement.ts';
import type { AssignmentOutcome, RateLimitBackoffConfig } from '@server/runtime/assignment-runner.ts';
import { AssignmentRunner } from '@server/runtime/assignment-runner.ts';
import type { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { CompiledBinding, CompiledSlotType } from './template-loader.ts';
import type { FrozenSkill, FrozenTaskSnapshot, SnapshotService } from './snapshot-service.ts';
import type { AssignmentService } from './assignment-service.ts';
import type { CompletionService } from './completion-service.ts';
import type { StructureService } from './structure-service.ts';
import type { SlotScheduler } from './slot-scheduler.ts';
import type { AssemblyService } from './assembly-service.ts';
import type { TraceService } from './trace-service.ts';
import { buildContext } from './context-builder.ts';
import type {
  StructureRetryInput,
  StructureReviewInput,
  FillSlotRetryInput,
  FillSlotRevisionInput,
} from './context-builder.ts';
import { collectPriorRounds } from './revision-source.ts';
import { isStructureRoot, reviewBindingOf } from './review-binding.ts';
import { contentUnderReviewOf } from './review-target.ts';
import {
  createCompletionPort,
  createStructurePort,
  createTracePort,
  emptySubmissionRecord,
  errorCodeOf,
  reasonOf,
  type SubmissionRecord,
} from './runtime-ports.ts';


/**
 * D-68 L1：耗尽判定的**与 Provider 无关**的那一层。
 *
 * 判据只有一条：重试与退避配额**全部用尽**之后，仍以 Provider 级错误告终。
 * 满足即把该 Provider 标成耗尽，下一个新任务的挑档会跳过它。
 *
 * ## 为什么不去认「额度不足」那种错误码
 *
 * 因为我不知道它长什么样。火山方舟与优云智算在额度耗尽时返回什么，
 * **无法在不真烧掉一份额度的前提下测出来**（见 notes/PROVIDER-FALLBACK-DESIGN-V0.1.md
 * D-68）。猜一个特征写进去，代价是：猜错时正常的限流会被误判成耗尽，
 * 好端端的 Provider 被拉黑、任务掉到付费档去烧钱——而且因为它「看起来在工作」，
 * 没有人会去查。
 *
 * 本判据不依赖任何一家的错误形状，因此**必然可用**。代价是慢：
 * 要先把退避配额（最多 5 次、上限 1 分钟）走完才认输。
 * 快速通道（L2 特征表）等第一次真撞上、从 exhausted_reason 抄到原文之后再补。
 *
 * ## 为什么排除校验失败
 *
 * `VALIDATION_*` 是模型没按格式产出，与额度无关。把它算进来，
 * 一个写不出合法结构树的模型会把整条链一路拉黑到付费档——
 * 那是在为模型能力问题付钱。
 */
const PROVIDER_LEVEL_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
]);

function markProviderExhaustedIfNeeded(
  repos: UnitOfWork,
  exhausted: boolean,
  outcome: { kind: string; code?: string | null; provider?: string | null; message?: string },
): void {
  if (!exhausted) return;
  if (outcome.kind !== 'failed') return;
  if (outcome.provider == null) return;
  if (outcome.code == null || !PROVIDER_LEVEL_CODES.has(outcome.code)) return;

  // reason 必须带上游原文。这一列是 L2 特征表**唯一**的数据来源——
  // 写成自拟的「额度不足」，等于把这次用真钱换来的样本丢了。
  repos.providerHealth.markExhausted(
    outcome.provider,
    `${outcome.code}: ${outcome.message ?? '(无 message)'}`,
  );
}

// ---------------------------------------------------------------------------
// maxTokens 派生（§7.3 的 M3-C 定案）
// ---------------------------------------------------------------------------

const MAX_TOKENS_FLOOR = 4096;
const MAX_TOKENS_CEIL = 16384;

/**
 * 从模板已有的约束派生 `maxTokens`，不新增配置项。
 *
 * 理由见文档 §7.3：这个数的**唯一**作用是「别让模型写到一半被截断」，
 * 而「最多该写多少」模板已经用 `validation.maxChars` 说过一遍了。
 * 取一个与模板无关的常量，等于让一个 400 字的标题槽和一个 8000 字的场景槽
 * 拿到同一个上限——前者浪费额度，后者可能不够。
 */
export function deriveMaxTokens(slotType: CompiledSlotType | null): number {
  const maxChars = slotType?.validation.maxChars ?? null;
  if (maxChars === null) return MAX_TOKENS_CEIL;
  // 系数 2 是「一个汉字最坏约 2 token」的保守估计，+1024 留给工具调用的 JSON 包装
  const derived = maxChars * 2 + 1024;
  return Math.min(MAX_TOKENS_CEIL, Math.max(MAX_TOKENS_FLOOR, derived));
}

// ---------------------------------------------------------------------------
// 重试配额（§8.7 的 M3-C 定案）
// ---------------------------------------------------------------------------

/**
 * 配额计数器，**tick 的局部变量**，按 `targetSlotId` 分桶。
 *
 * 为什么不按 `executions.attempt_number` 算：那个数是持久且单调递增的
 * （`UNIQUE (task_id, target_slot_id, attempt_number)` 的组成部分，也是 UI 上
 * 「第 3 次尝试」的来源），不能因为一次 retry 就倒回去。若拿它当配额判据，
 * 用户点重试后第 4 次尝试会立刻被判耗尽——重试按钮点了等于没点。
 *
 * 局部变量意味着 retry / resume 重新入队时天然拿到一份新配额，
 * 这正是「用户显式要求再试一次」应有的语义。
 */
class RetryBudget {
  readonly #consuming = new Map<string, number>();
  readonly #fallback = new Map<string, number>();

  constructor(private readonly maxRetriesOf: (key: string) => number) {}

  /**
   * 记一次失败，返回配额是否已耗尽。
   *
   * 两个桶：`consumesRetry` 的失败（超时 / provider 错 / 校验没过，D-04）进主桶；
   * 不消耗配额的失败（别名解析不出、原因不明的中止）进一个**容量为 1** 的兜底桶。
   * 兜底桶存在的唯一理由是**保证终止**——一个不消耗任何配额的失败若允许无限重试，
   * 就是不报错、不前进、只烧钱的死循环，而它在 UI 上与「正在生产」长得一模一样。
   *
   * 于是每一次失败必定消耗两个桶之一，下面 `tick` 的循环因此必然终止。
   */
  consume(key: string, consumesRetry: boolean): boolean {
    if (consumesRetry) {
      const used = (this.#consuming.get(key) ?? 0) + 1;
      this.#consuming.set(key, used);
      // maxRetries=2 → 总共 3 次机会（首次 + 2 次重试）
      return used > this.maxRetriesOf(key);
    }
    const used = (this.#fallback.get(key) ?? 0) + 1;
    this.#fallback.set(key, used);
    return used > 1;
  }

  /** 已用掉的尝试次数（含首次），用于成文的「已尝试 N 次」 */
  attempts(key: string): number {
    return (this.#consuming.get(key) ?? 0) + (this.#fallback.get(key) ?? 0);
  }
}

// ---------------------------------------------------------------------------

export interface ProductionEngineOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  snapshots: SnapshotService;
  assignments: AssignmentService;
  completion: CompletionService;
  structure: StructureService;
  scheduler: SlotScheduler;
  assembly: AssemblyService;
  traces: TraceService;
  registry: ProviderRegistry;
  rateLimitBackoff: RateLimitBackoffConfig;
  /**
   * §8.3：stop 事务**提交之后**要能同步拿到 controller 去 abort。
   * 由引擎登记、由 lifecycle 读取，所以这张表由外部传入而不是引擎私有。
   */
  activeControllers: Map<string, AbortController>;
}

export interface ProductionEngine {
  /**
   * 把任务放进串行队列。已在队列里则忽略（幂等）。
   *
   * 返回的 Promise 在**该任务本轮推进结束**时 resolve，不是在入队时。
   * CLI 与集成测试靠它等结果；HTTP 层不该 await 它（那会把一次生产
   * 变成一个几分钟不返回的请求）。
   */
  enqueue(taskId: string): Promise<void>;
  /** D-14：非 null 表示已入队但还没轮到它。0 表示下一个就是它 */
  positionOf(taskId: string): number | null;
  /** 队列排空（含正在跑的那个）。测试与优雅关闭用 */
  drain(): Promise<void>;
}

export function createProductionEngine(options: ProductionEngineOptions): ProductionEngine {
  const {
    uow,
    snapshots,
    assignments,
    completion,
    structure,
    scheduler,
    assembly,
    traces,
    registry,
    rateLimitBackoff,
    activeControllers,
  } = options;

  const tracePort = createTracePort(traces);
  const structurePort = createStructurePort(uow);

  /**
   * D-04 的互斥队列：等待中的任务 ID，**保序**。
   * 用数组而不是 Set：D-14 的 `queuePosition` 要的就是位次，而 Set 没有位次概念。
   * 去重靠 `includes`——队列长度是个位数，线性查找的代价可以忽略。
   */
  const waiting: string[] = [];
  let runningTaskId: string | null = null;
  /** 当前这一轮（含排队者）全部结束时 resolve 的句柄 */
  const settlers = new Map<string, Array<() => void>>();
  let pump: Promise<void> = Promise.resolve();

  return { enqueue, positionOf, drain };

  function enqueue(taskId: string): Promise<void> {
    const done = new Promise<void>((resolve) => {
      const list = settlers.get(taskId);
      if (list === undefined) settlers.set(taskId, [resolve]);
      else list.push(resolve);
    });
    /**
     * 去重的判据**只看队列，不看「是不是正在跑」**（M5 审查补正）。
     *
     * 原判据多了一个 `runningTaskId !== taskId`，意思是「正在跑的就别重复入队」。
     * 听起来对，实际会丢事件：`stop` 之后 tick 并不是立刻返回的——
     * 它要等 Provider 的流解绑、缓冲区刷盘、controller 摘除，
     * 而 `runningTaskId` 要到 `runPump` 的 finally 才清空。
     * 落在这段窗口里的 `resume`：状态已经被同步改成 running、trace 也写了，
     * 而入队这一步被静默跳过——于是任务停在 running，
     * 却没有任何东西会再推它，只能靠下次进程启动的 `recoverOnStartup` 收拾。
     * 那正是文件头第 2 条纪律（不允许永久 running）要防的状态，
     * 而三道网没有一道盖得住它：超时早已解除、配额是 tick 局部的、启动恢复要等重启。
     *
     * 改成只看 `waiting` 之后，落在窗口里的 resume 会排到队尾，
     * 由下一轮 `runPump` 接手；多排的那一轮由 `tick` 开头
     * 「`task.status !== 'running'` 就返回」兜住——那一行本来就是为这种情况写的。
     */
    if (!waiting.includes(taskId)) {
      waiting.push(taskId);
      pump = pump.then(runPump);
    }
    return done;
  }

  function positionOf(taskId: string): number | null {
    if (runningTaskId === taskId) return null;
    const index = waiting.indexOf(taskId);
    return index < 0 ? null : index;
  }

  function drain(): Promise<void> {
    return pump;
  }

  async function runPump(): Promise<void> {
    for (;;) {
      const next = waiting.shift();
      if (next === undefined) return;
      runningTaskId = next;
      /**
       * 在开跑**之前**就把等待者摘下来。
       *
       * 现在 `enqueue` 允许一个正在跑的任务再次入队（见那里的说明），
       * 于是本轮进行期间可能有新的 settler 挂到同一个 taskId 上。
       * 若等到 finally 再 `settlers.get`，那些属于**下一轮**的等待者
       * 会被这一轮的结束顺手 resolve 掉——调用方以为自己那次 resume 跑完了，
       * 实际它还没开始。摘早一步，两轮的等待者就各归各的。
       */
      const waiters = settlers.get(next) ?? [];
      settlers.delete(next);
      try {
        await tick(next);
      } catch (error) {
        // 见 `settleEscapedError`：异常绝不允许离开这个循环
        settleEscapedError(next, error);
      } finally {
        runningTaskId = null;
        for (const resolve of waiters) resolve();
      }
    }
  }

  /**
   * 逃逸异常的收尾（M5-C 补正）。
   *
   * 这个 catch 在 M5 之前不存在，因为在此之前**总有人在 await**：
   * CLI 和集成测试都 `await lifecycle.start(id)`，`tick` 抛出的东西
   * 会直接变成那次调用的失败，看得见、查得到。
   *
   * HTTP 把这个前提拿掉了——§9.1 的 start / resume / retry 只能立刻返回，
   * 不可能等一次生产跑完（那是几分钟不返回的请求）。于是没了 catch 会同时坏两件事：
   *
   * 1. **任务永远 running。** `tick` 抛出时，任务的 `status` 还停在 running，
   *    却再也没有东西会推它。这正是文件头第 2 条纪律要防的「永久 running」，
   *    而三道网里没有一道盖得住「引擎自己抛了」。
   * 2. **整个引擎当场死掉。** `pump = pump.then(runPump)`——`pump` 一旦变成
   *    rejected，后续每一次 enqueue 挂上去的 `then` 都不会执行，
   *    进程活着但再也跑不动任何任务，且只在控制台留下一条 unhandled rejection。
   *
   * 因此这里必须自己把任务落到终态。收尾本身再抛就前功尽弃（rejected 的 pump
   * 又回来了），所以整段再包一层 try/catch 兜住。
   */
  function settleEscapedError(taskId: string, error: unknown): void {
    try {
      const isForge = error instanceof ForgeError;
      // 非 ForgeError 的 message 里可能带表名、SQL、绝对路径，而
      // `task.error_message` 是**要出网也要显示给用户**的字段——
      // 与 §9.3「原始错误只进日志」是同一条纪律。
      const code: ErrorCode = isForge ? error.code : 'STORAGE_ERROR';
      const reason = isForge
        ? error.message
        : '生产过程中出现未预期的内部错误，请查看服务日志';

      traces.runWithTraces((repos, trace) => {
        const task = repos.tasks.get(taskId);
        // 已经是终态就不要再改写它：逃逸的异常有可能发生在收尾之后
        if (task === null || task.status !== 'running') return;
        repos.tasks.update(taskId, {
          status: 'failed',
          activeExecutionId: null,
          errorCode: code,
          // D-19：写进去的必须是一句可直接展示的完整中文，不是错误码
          errorMessage: reason,
        });
        trace.record({
          taskId,
          executionId: null,
          actor: 'system',
          kind: 'task_state_changed',
          title: '任务因内部错误终止',
          summary: reason,
          payload: null,
        });
      });
    } catch {
      // 收尾都失败说明库已经不可用了。这里只能保证一件事：
      // 不要让 pump 变成 rejected，否则整个进程从此跑不动任何任务。
    }
  }

  // -------------------------------------------------------------------------
  // 一轮推进
  // -------------------------------------------------------------------------

  /**
   * 把一个任务从当前状态推进到「不能再推进为止」。
   *
   * 循环而不是递归（§7.1 的时序图写的是递归调用）：一个 32 槽位的任务要跑 33 轮，
   * 递归会把整条生产线叠成 33 层栈帧，一旦出错，栈里全是同一个函数名，
   * 而真正有用的信息（是第几个槽位）反而看不出来。
   */
  async function tick(taskId: string): Promise<void> {
    const snapshot = snapshots.readSnapshot(taskId);
    // 配额与重试上下文**同生共死**，都是本轮调度的局部状态（§8.7 定案）。
    // 若把重试上下文提到 tick 之外，一次 retry 会带着上一轮的违规列表重新开始，
    // 于是模型第一次尝试就收到「你上次错了」——而那是上一轮的事。
    const round: RoundState = {
      budget: new RetryBudget((key) => maxRetriesFor(snapshot, key)),
      structure: new Map(),
      slots: new Map(),
      reviews: new Map(),
    };

    for (;;) {
      const task = uow.repositories.tasks.getOrThrow(taskId);
      // 每一轮重新读任务状态：stop 可能在上一轮的 await 期间插进来。
      // 用库里的事实判断，而不是记住进入循环时的那个 status——
      // 后者会让一次 stop 之后的循环再跑一轮，把刚放回 pending 的槽位又拉起来。
      if (task.status !== 'running') return;

      if (task.phase === 'structure') {
        const settled = await runStructurePhase(taskId, snapshot, round);
        if (!settled) return;
        continue;
      }

      if (task.phase === 'slots') {
        const settled = await runSlotPhase(taskId, snapshot, round);
        if (!settled) return;
        continue;
      }

      if (task.phase === 'assembly') {
        runAssemblyPhase(taskId);
        return;
      }

      return; // phase === 'done'
    }
  }

  // -------------------------------------------------------------------------
  // 结构相位
  // -------------------------------------------------------------------------

  /** 返回 true 表示还可以继续推进；false 表示本轮到此为止（失败 / 被停 / 已收敛） */
  async function runStructurePhase(
    taskId: string,
    snapshot: FrozenTaskSnapshot,
    round: RoundState,
  ): Promise<boolean> {
    const binding = snapshot.compiled.bindings.createStructure;
    /*
     * R5：配额桶按**重新设计的轮次**分开，与填槽的 `budgetKeyOfFill` 同一个理由。
     *
     * 桶键不带轮次时真实语义会变成「这个任务一生只有 maxRetries+1 次结构失败额度，
     * 跨审核轮共享」：第 0 版 Provider 抖一次重试成功，审核判返修之后
     * 第 1 版**第一次**失败即判耗尽，任务直接 failed——而重新设计本身不是故障。
     *
     * 同一个键还决定 `RetryState` 的作用域：不带轮次的话，第 0 版那次
     * 「少了 parentId」会一直留在同一个 RetryState 上，于是重新设计那一版的 prompt
     * 里会追加一整段【上一次提交未通过校验】，内容是上一版早已改掉的违规。
     */
    const structureReview = structureReviewOf(taskId, snapshot);
    const key = structureBudgetKey(structureReview?.round ?? 0);
    const previous = structureRetryOf(round, key);

    const outcome = await runAssignment({
      taskId,
      snapshot,
      binding,
      operation: 'create_structure',
      targetSlotId: null,
      slotType: null,
      contextRetry: previous.retry,
      structureReview,
      record: previous.record,
      state: previous,
    });

    if (outcome.kind === 'succeeded') {
      // 相位推进由 StructureService 在提交事务里一起做（§5.5「提交 Structure」），
      // 这里不再动 phase——两处都写会让「结构提交」这条边界不再原子。
      return true;
    }
    if (outcome.kind === 'cancelled') return false;

    const exhausted = round.budget.consume(key, outcome.consumesRetry);
    markProviderExhaustedIfNeeded(uow.repositories, exhausted, outcome);
    previous.remember(outcome);

    // D-20：无论因为什么失败，收尾都在这里做——被拒的提交不会替引擎收尾
    structure.failAttempt({
      taskId,
      executionId: previous.executionId,
      errorCode: outcome.code,
      reason: outcome.message,
    });

    if (!exhausted) return true;

    structure.markExhausted({
      taskId,
      violations: outcome.violations,
      attempts: round.budget.attempts(key),
      // D-19：没有违规时（超时 / Provider 报错 / 别名解析不出），
      // 成文原因必须是真实原因，不能一律说成「校验未通过」
      lastReason: outcome.message,
    });
    return false;
  }

  // -------------------------------------------------------------------------
  // 槽位相位
  // -------------------------------------------------------------------------

  async function runSlotPhase(
    taskId: string,
    snapshot: FrozenTaskSnapshot,
    round: RoundState,
  ): Promise<boolean> {
    const work = scheduler.selectNext(taskId);

    /*
     * R5：结构审核的工作可能是从**pending 的根容器**进来的——
     * 结构刚建好还没审过，或者审到一半被 stop / 崩过一次
     * （恢复路径用 `cancelReview` 把根放回 pending，见 `pendingStructureRoot`）。
     *
     * 在这里统一推回 reviewing，是因为**两条分支都需要它**：
     * `review` 那条要它才能让审核结果落到一个 reviewing 的槽位上；
     * `review_settle` 那条更要——`clearReview` / `markForRevision` 的 WHERE 里
     * 带着 `status = 'reviewing'`，根停在 pending 时结算是一次 0 行更新，
     * 状态不动，调度器下一轮又选中同一个根，任务在这里**空转不退出**。
     * 只在 `review` 分支里做过一版，正是漏了这个（见 R5 的用例「停在最后一条判据上」）。
     *
     * 已经是 reviewing 时这是一次 0 行更新，无副作用。
     */
    if ((work.kind === 'review' || work.kind === 'review_settle') && isStructureRoot(work.slot)) {
      traces.runWithTraces((repos) => {
        repos.slots.markContainerReviewing(taskId, work.slot.slotId);
      });
    }

    if (work.kind === 'assembly') {
      // 全部内容槽位已完成 → 系统判定可以组装（AC-014）
      traces.runWithTraces((repos, trace) => {
        repos.tasks.update(taskId, { phase: 'assembly' });
        trace.record({
          taskId,
          executionId: null,
          actor: 'system',
          kind: 'task_state_changed',
          title: '全部槽位已完成',
          summary: '进入组装阶段',
          payload: null,
        });
      });
      return true;
    }

    if (work.kind === 'running') {
      // 有槽位仍在 running 而引擎却回到了调度点——说明上一轮没收敛干净。
      // 不静默继续：那会创建第二个 Assignment，两个 execution 同时写一个槽位。
      throw new ForgeError(
        'ENGINE_BUSY',
        `任务 ${taskId} 的槽位 ${work.slot.slotId} 仍在生产中，引擎不应在此刻调度`,
        `task:${taskId}/slot:${work.slot.slotId}`,
      );
    }

    if (work.kind === 'failed') {
      // 失败槽位没被重置就回到调度点，同样是不该发生的状态。
      // 任务此时应当已经是 failed；把它兜成 failed 而不是继续跑。
      return false;
    }

    // R2：审核中——本轮判据尚未审完，跑一条 review_slot execution（AC-R-002）。
    if (work.kind === 'review') {
      const slot = work.slot;
      const criterionId = work.criterionId;
      const slotType = slotTypeOf(snapshot, slot);
      const reviewBinding = reviewBindingOf(snapshot.compiled, slot);
      if (reviewBinding === null) {
        throw new ForgeError(
          'STORAGE_ERROR',
          `任务 ${taskId} 的快照里没有槽位类型「${slot.type}」的审核绑定`,
          `task:${taskId}/slot:${slot.slotId}`,
        );
      }

      // 审核重试配额独立分桶，且**按返修轮分桶**（见 budgetKeyOfReview）。
      // D-32：审核 Agent 每轮全新，不携带往轮审核记录——retry 不回灌
      const reviewKey = budgetKeyOfReview(slot, criterionId);
      const previous = reviewRetryOf(round, reviewKey);
      previous.record.criterionId = criterionId;

      const deps = scheduler.dependenciesOf(taskId, slot);

      const outcome = await runAssignment({
        taskId,
        snapshot,
        binding: reviewBinding,
        operation: 'review_slot',
        targetSlotId: slot.slotId,
        slotType,
        slots: uow.repositories.slots.listByTask(taskId),
        targetSlot: slot,
        dependencies: deps.contents,
        allowedDependencySlotIds: deps.slotIds,
        contextRetry: null,
        record: previous.record,
        state: previous,
      });

      if (outcome.kind === 'succeeded') return true;
      if (outcome.kind === 'cancelled') return false;

      const exhausted = round.budget.consume(reviewKey, outcome.consumesRetry);
      markProviderExhaustedIfNeeded(uow.repositories, exhausted, outcome);
      previous.remember(outcome);

      completion.failSlot({
        taskId,
        slotId: slot.slotId,
        executionId: previous.executionId,
        errorCode: outcome.code,
        reason: exhausted
          ? `${outcome.message}（已尝试 ${round.budget.attempts(reviewKey)} 次）`
          : outcome.message,
        exhausted,
      });
      return !exhausted;
    }

    // R2：本轮判据全审完 → 结算（D-21/D-26）。
    if (work.kind === 'review_settle') {
      const slot = work.slot;
      const slotType = slotTypeOf(snapshot, slot);
      const reviews = uow.repositories.slotReviews.listByRound(taskId, slot.slotId, slot.revisionRound);
      const verdicts = reviews.map((r) => r.verdict);

      const settlement = settleReview({
        verdicts,
        revisionRound: slot.revisionRound,
        maxRevisionRounds: slotType.maxRevisionRounds,
      });

      const structureRound = isStructureRoot(slot);

      traces.runWithTraces((repos, trace) => {
        if (settlement.action === 'revise') {
          repos.slots.markForRevision(taskId, slot.slotId);
          /*
           * R5：结构审核的返修不是「重填一个槽位」，是**整棵树重来**。
           *
           * `markForRevision` 上面那一行对两者是共用的（reviewing → pending，
           * 轮次 +1），差别全在这里：把 phase 退回 structure，让下一轮 tick 走
           * `runStructurePhase` 重新生成一份提案。旧树留着不删——返修那一轮的 prompt
           * 要把它和审核引文一起回灌给模型，真正的替换发生在
           * `StructureService.submit` 拿到新提案之后（那里是一个事务）。
           *
           * 不在这里删还有一个更硬的理由：删了就没有根槽位，而轮次就存在根槽位上。
           * 那样每次重来都从第 0 轮开始，D-26 的预算永远用不完。
           */
          if (structureRound) {
            repos.tasks.update(taskId, { phase: 'structure' });
          }
          trace.record({
            taskId,
            executionId: null,
            actor: 'system',
            kind: 'review_revise',
            title: structureRound ? '结构审核检出问题，重新设计结构' : '审核检出问题，进入返修',
            summary: structureRound
              ? `第 ${slot.revisionRound + 1} 次重新设计结构`
              : `槽位 ${slot.slotId} 第 ${slot.revisionRound + 1} 次返修`,
            payload: {
              slotId: slot.slotId,
              revisionRound: slot.revisionRound,
              nextRound: settlement.nextRound,
              structure: structureRound,
              verdicts: [...verdicts],
            },
          });
        } else {
          // complete（含 exhausted）
          repos.slots.clearReview(taskId, slot.slotId, settlement.exhausted);
          trace.record({
            taskId,
            executionId: null,
            actor: 'system',
            kind: settlement.exhausted ? 'revision_budget_exhausted' : 'review_no_finding',
            // D-30：不许说「通过 / 合格」。结构那一支同样——「未检出问题」说的是
            // 这四条判据没抓到东西，不是这棵结构是对的。
            title: settlement.exhausted
              ? structureRound
                ? '结构重来次数用尽，按现状继续'
                : '返修次数用尽，按现状完成'
              : structureRound
                ? '结构审核未检出问题，开始填槽'
                : '审核未检出问题，槽位完成',
            summary: structureRound
              ? `根槽位 ${slot.slotId}${settlement.exhausted ? ' · 重来次数用尽' : ''}`
              : `槽位 ${slot.slotId}${settlement.exhausted ? ' · 返修次数用尽' : ''}`,
            payload: {
              slotId: slot.slotId,
              revisionRound: slot.revisionRound,
              exhausted: settlement.exhausted,
              structure: structureRound,
              verdicts: [...verdicts],
            },
          });
        }
      });
      return true;
    }

    const slot = work.slot;
    const slotType = slotTypeOf(snapshot, slot);
    const binding = snapshot.compiled.bindings.fillSlotByType[slot.type];
    if (binding === undefined) {
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${taskId} 的快照里没有槽位类型「${slot.type}」的填充绑定`,
        `task:${taskId}/slot:${slot.slotId}`,
      );
    }

    const key = budgetKeyOfFill(slot);
    const previous = slotRetryOf(round, key);
    const deps = scheduler.dependenciesOf(taskId, slot);

    /**
     * R3 / D-31：返修那一轮，把上一轮**从库里重建出来**接上去。
     *
     * 每次调度都重算一遍，不缓存在 `RoundState` 里：缓存就是一个跨 execution 存活的
     * 会话对象，D-31 明确否决了它（撑不过重启的连续性等于没有连续性）。
     * 重算的代价是两次索引查询，换来的是「清空进程内存也能逐字重建」（FR-CTX-005）。
     */
    const priorRounds = collectPriorRounds(uow.repositories, slot);
    /*
     * R6 / D-65：本轮是不是已经降级（放行整篇提交）。
     *
     * 判据是「这一轮已经不是第一次尝试」——一次返修尝试之所以会被重试，
     * 只可能是上一次失败了（编辑清单不合格、确定性校验没过、或压根没提交）。
     * 场景槽 maxRetries=1，于是恰好落成「第一次要求编辑清单，第二次放行整篇」。
     *
     * 用现成的本轮尝试计数而不是新加一个「编辑清单失败了几次」的计数器：
     * 多一个计数器就多一处可能与返修预算不同步的状态，而这里只需要
     * 「别在同一轮里反复撞同一堵墙」这一个效果。
     * 与下面 `promptAttemptNumber` 同源，两处必须用同一个数。
     */
    const degraded = round.budget.attempts(key) > 0;
    const revision: FillSlotRevisionInput | null =
      priorRounds.length === 0 ? null : { round: slot.revisionRound, priorRounds, degraded };

    const outcome = await runAssignment({
      taskId,
      snapshot,
      binding,
      operation: 'fill_slot',
      targetSlotId: slot.slotId,
      slotType,
      slots: uow.repositories.slots.listByTask(taskId),
      targetSlot: slot,
      dependencies: deps.contents,
      allowedDependencySlotIds: deps.slotIds,
      contextRetry: previous.retry,
      revision,
      /**
       * 「这是第 n 次尝试，共 m 次机会」里的 n 必须是**本轮内**的序号。
       *
       * `attemptNumber` 是按槽位全局单调递增的（`UNIQUE (task_id, target_slot_id,
       * operation, attempt_number)` 的组成部分），而 m 是每轮的配额。
       * 直接把它印进 prompt，返修轮会出现「这是第 4 次尝试，共 2 次机会」这种
       * 自相矛盾的数字——模型据此以为自己已经超额了。
       */
      promptAttemptNumber: round.budget.attempts(key) + 1,
      record: previous.record,
      state: previous,
    });

    if (outcome.kind === 'succeeded') return true;
    if (outcome.kind === 'cancelled') return false;

    const exhausted = round.budget.consume(key, outcome.consumesRetry);
    markProviderExhaustedIfNeeded(uow.repositories, exhausted, outcome);
    previous.remember(outcome);

    // D-20：收尾统一在这里。`exhausted` 决定的是「任务是否随之 failed」，
    // 而不是「要不要收尾」——execution 每次都必须收敛，否则活动执行位永远让不出来。
    completion.failSlot({
      taskId,
      slotId: slot.slotId,
      executionId: previous.executionId,
      errorCode: outcome.code,
      reason: exhausted
        ? `${outcome.message}（已尝试 ${round.budget.attempts(key)} 次）`
        : outcome.message,
      exhausted,
    });
    return !exhausted;
  }

  // -------------------------------------------------------------------------
  // 组装相位
  // -------------------------------------------------------------------------

  function runAssemblyPhase(taskId: string): void {
    // 空产物的拒绝在 AssemblyService 里（D-19），这里不重复判。
    // 组装失败是终态：重跑组装不会让内容变多，只有用户 retry 才有意义。
    assembly.assemble(taskId);
  }

  // -------------------------------------------------------------------------
  // 一次 Assignment
  // -------------------------------------------------------------------------

  interface RunAssignmentInput {
    taskId: string;
    snapshot: FrozenTaskSnapshot;
    binding: CompiledBinding;
    operation: Operation;
    targetSlotId: string | null;
    slotType: CompiledSlotType | null;
    slots?: readonly Slot[];
    targetSlot?: Slot;
    dependencies?: readonly { slotId: string; content: string }[];
    allowedDependencySlotIds?: readonly string[];
    contextRetry: StructureRetryInput | FillSlotRetryInput | null;
    /** R5：只有 create_structure 会给，且只在审核判了重新设计之后 */
    structureReview?: StructureReviewInput | null;
    /** R3 / D-31：只有 fill_slot 会给。D-32：review_slot 恒不给 */
    revision?: FillSlotRevisionInput | null;
    /**
     * 印进 prompt 的「第 n 次尝试」。缺省沿用落库的 `attempt_number`。
     * 两者刻意分开：前者是本轮配额里的序号，后者是全局单调、UNIQUE 键的一部分。
     */
    promptAttemptNumber?: number;
    record: SubmissionRecord;
    /** 失败收尾要知道刚建的是哪个 execution，写回这里 */
    state: { executionId: string };
  }

  async function runAssignment(input: RunAssignmentInput): Promise<AssignmentOutcome> {
    const { taskId, snapshot, binding, operation, targetSlotId, record } = input;

    const skill = snapshot.skills[binding.skillId];
    if (skill === undefined) {
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${taskId} 的快照里没有 Skill「${binding.skillId}」`,
        `task:${taskId}`,
      );
    }
    const agent = snapshot.compiled.agents.find((a) => a.id === binding.agentId);
    if (agent === undefined) {
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${taskId} 的快照里没有 Agent「${binding.agentId}」`,
        `task:${taskId}`,
      );
    }

    const attemptNumber = assignments.nextAttemptNumber(taskId, targetSlotId);
    const context =
      operation === 'create_structure'
        ? buildContext({
            operation: 'create_structure',
            snapshot,
            agent,
            skill,
            attemptNumber,
            maxAttempts: binding.maxRetries + 1,
            retry: input.contextRetry as StructureRetryInput | null,
            review: input.structureReview ?? null,
          })
        : operation === 'fill_slot'
          ? buildContext({
              operation: 'fill_slot',
              snapshot,
              agent,
              skill,
              // 印进 prompt 的是本轮序号，落库的仍是全局 attemptNumber（见上）
              attemptNumber: input.promptAttemptNumber ?? attemptNumber,
              maxAttempts: binding.maxRetries + 1,
              slots: input.slots ?? [],
              targetSlot: mustHave(input.targetSlot, 'targetSlot'),
              slotType: mustHave(input.slotType, 'slotType'),
              dependencies: input.dependencies ?? [],
              retry: input.contextRetry as FillSlotRetryInput | null,
              revision: input.revision ?? null,
            })
          : buildContext({
              operation: 'review_slot',
              snapshot,
              agent,
              skill,
              attemptNumber,
              maxAttempts: binding.maxRetries + 1,
              slots: input.slots ?? [],
              targetSlot: mustHave(input.targetSlot, 'targetSlot'),
              slotType: mustHave(input.slotType, 'slotType'),
              dependencies: input.dependencies ?? [],
              criterionId: mustHave(record.criterionId, 'criterionId'),
              // 内容槽位取正文，根容器取整棵树的结构概要。与引文闸门调的是同一个
              // 函数——两边算出不同的文本会让所有 finding 被静默丢弃，见那个文件。
              contentUnderReview: contentUnderReviewOf(
                mustHave(input.targetSlot, 'targetSlot'),
                input.slots ?? [],
              ),
            });

    /**
     * D-03：**每次 attempt 重新解析**别名，不缓存。
     * 缓存会让「换了模型别名的指向」这件事对一个正在重试的任务不生效，
     * 而 D-03 的整个价值就是「换模型不必重建快照」。
     */
    // D-67：本任务在创建时定住的那一档。pin 存在就只解析它，不再看链。
    // 每次 attempt 重读（而不是缓存）与上面 D-03 的理由一致；
    // 但注意 pin 本身是**不会变的**——变的是链，而 pin 正是用来无视链的。
    const pinnedProviderId =
      uow.repositories.tasks.get(taskId)?.pinnedProviders?.[binding.modelAlias];

    let resolved;
    try {
      resolved = registry.resolve(binding.modelAlias, pinnedProviderId);
    } catch (error) {
      // 别名解析不出来不是模型的错，也不消耗 maxRetries——但会消耗兜底桶（见 RetryBudget）
      return {
        kind: 'failed',
        code: errorCodeOf(error),
        message: reasonOf(error, `模型别名「${binding.modelAlias}」无法解析`),
        violations: [],
        noSubmission: false,
        consumesRetry: false,
        provider: null,
        model: null,
        usage: null,
        toolCalls: 0,
      };
    }

    const created = assignments.create({
      taskId,
      operation,
      targetSlotId,
      binding: {
        agentId: binding.agentId,
        skillId: binding.skillId,
        skillVersion: binding.skillVersion,
        modelAlias: binding.modelAlias,
      },
      resolved: { provider: resolved.providerId, model: resolved.model },
      context,
      attemptNumber,
    });
    record.proposalJson = null;
    record.reasons = [];
    // R2：非 review_slot 操作不保留 criterionId（防止上一次审核的 criterionId 残留）
    if (operation !== 'review_slot') record.criterionId = null;
    input.state.executionId = created.id;

    // §8.3：controller 由调用方创建并登记，stop 提交后才能同步拿到它 abort
    const controller = new AbortController();
    activeControllers.set(taskId, controller);

    const runner = new AssignmentRunner({
      registry,
      trace: tracePort,
      structure: structurePort,
      completion: createCompletionPort({ completion, structure, snapshots, uow, record }),
      rateLimitBackoff,
    });

    try {
      const outcome = await runner.run({
        taskId,
        executionId: created.id,
        executionToken: created.token,
        operation,
        targetSlotId,
        modelAlias: binding.modelAlias,
        systemText: context.systemText,
        userText: context.userText,
        maxToolCalls: snapshot.compiled.limits.maxToolCallsPerAssignment,
        maxTokens: deriveMaxTokens(input.slotType),
        timeoutMs: binding.timeoutMs,
        allowedDependencySlotIds: input.allowedDependencySlotIds ?? [],
        skill: toSkillView(skill),
        taskInput: snapshot.input,
        /*
         * R6 / D-61：返修轮的编辑基线。
         *
         * 正文取自 `targetSlot.contentText`——`markForRevision` 刻意不碰它，
         * 所以返修轮开始时它就是上一稿那份字节，也正是 prompt 里给模型看的那一份。
         *
         * **D-65 的降级由系统按尝试次数决定，不由模型自己选。**
         * 判据是「这一轮已经不是第一次尝试」：一次返修尝试之所以会被重试，
         * 只可能是上一次失败了（编辑清单不合格、校验没过、或压根没提交）。
         * 场景槽 maxRetries=1，于是恰好是「第一次要求编辑清单，第二次放行整篇」。
         * 用现成的 promptAttemptNumber 而不是新加一个计数器：多一个计数器就多一处
         * 可能与预算不同步的状态。
         *
         * 实测（probe/edit-contract-replay.ts）里模型**一次都没主动**走过整篇退路，
         * 两次失败都是硬撞（非法 JSON、输出到长度上限也不提交）。
         * 不由系统降级，这两种在生产里就是执行失败→重试→白烧一轮返修预算。
         */
        revisionBase:
          operation === 'fill_slot' && input.revision != null && input.targetSlot?.contentText != null
            ? {
                round: input.revision.round,
                content: input.targetSlot.contentText,
                degraded: (input.promptAttemptNumber ?? attemptNumber) > 1,
              }
            : null,
        controller,
      });

      /*
       * token 记账的**唯一**落库点（三个调用点都经过这里，谁也漏不掉）。
       *
       * 必须在循环结束之后写：`complete_assignment` 是工具调用，它在循环
       * **进行中**就把 execution 标成 succeeded 了，而 usage 要等 Provider
       * 发回最后一帧（`stream_options.include_usage`）才知道。两件事天然不同时。
       * 适配器解析了 usage、agent-runtime 跨轮累加了、runner 也带出来了，
       * 却一直没有人写回去——`executions.input_tokens/output_tokens` 于是
       * **从 M4 起在生产中恒为 NULL**（m4-measure 121 条、m7-accept10 68 条，全空）。
       *
       * 不区分 outcome.kind：失败与取消的 execution 同样烧了 token，
       * 只记成功的会让「这次任务花了多少」系统性偏低。
       */
      const usage = outcome.usage;
      if (usage !== null) {
        traces.runWithTraces((repos) => {
          repos.executions.recordUsage(created.id, usage);
        });
      }
      return outcome;
    } finally {
      // 只删自己登记的那一个：stop 可能已经把它换掉了，删错会让下一次 stop 无处可 abort
      if (activeControllers.get(taskId) === controller) activeControllers.delete(taskId);
      traces.flushOutput(created.id);
    }
  }

  // -------------------------------------------------------------------------
  // 重试上下文
  // -------------------------------------------------------------------------

  interface RetryState<TRetry> {
    retry: TRetry | null;
    record: SubmissionRecord;
    /** 本 key 上最近一次创建的 execution。失败收尾要用它 */
    executionId: string;
    remember(outcome: Extract<AssignmentOutcome, { kind: 'failed' }>): void;
  }

  /**
   * 一轮调度的全部可变状态。
   *
   * 与 `RetryBudget` 同生共死是刻意的（§8.7 定案）：配额是本轮的，重试上下文也必须是。
   * 若把重试上下文提到 tick 之外，用户点 retry 之后模型第一次尝试就会收到
   * 「你上次错了，违规如下」——而那是上一轮的事，这一轮它还什么都没做。
   */
  interface RoundState {
    budget: RetryBudget;
    structure: Map<string, RetryState<StructureRetryInput>>;
    /**
     * key = `fill:<slotId>:<revisionRound>`（见 `budgetKeyOfFill`）。
     *
     * **轮次必须在键里**：`state.retry` 只在失败路径被赋值，没有任何一处把它置回 null。
     * 键不带轮次的话，第 0 轮那次「字数不足」会一直留在同一个 `RetryState` 上，
     * 于是第 1 轮返修的 prompt 会追加一整段【上一次提交未通过校验】，
     * 内容是上一轮**早已修好**的违规——正是下面这段注释要防的那件事。
     */
    slots: Map<string, RetryState<FillSlotRetryInput>>;
    /** R2：审核重试状态。key = `review:<slotId>:<revisionRound>:<criterionId>` */
    reviews: Map<string, ReviewRetryState>;
  }

  function structureRetryOf(round: RoundState, key: string): RetryState<StructureRetryInput> {
    const existing = round.structure.get(key);
    if (existing !== undefined) return existing;
    const state: RetryState<StructureRetryInput> = {
      retry: null,
      record: emptySubmissionRecord(),
      executionId: '',
      remember(outcome) {
        // D-13：违规原样传下去，不压成一句话；提案原文回灌让模型做增量修正
        state.retry = {
          previousProposalJson: state.record.proposalJson,
          violations: outcome.violations,
          noSubmission: outcome.noSubmission,
        };
      },
    };
    round.structure.set(key, state);
    return state;
  }

  function slotRetryOf(round: RoundState, key: string): RetryState<FillSlotRetryInput> {
    const existing = round.slots.get(key);
    if (existing !== undefined) return existing;
    const state: RetryState<FillSlotRetryInput> = {
      retry: null,
      record: emptySubmissionRecord(),
      executionId: '',
      remember(outcome) {
        state.retry = {
          noSubmission: outcome.noSubmission,
          // 逐条列出，不合并：§7.4 要求模型知道每一条没过的判据
          reasons: state.record.reasons.length > 0 ? state.record.reasons : [outcome.message],
        };
      },
    };
    round.slots.set(key, state);
    return state;
  }

  /**
   * R2：审核重试状态。D-32：审核 Agent 每轮全新，不携带往轮审核记录——retry 为 null。
   * 唯一需要记的是 executionId（失败收尾用）和 record（criterionId 侧信道）。
   */
  interface ReviewRetryState {
    retry: null;
    record: SubmissionRecord;
    executionId: string;
    remember(outcome: Extract<AssignmentOutcome, { kind: 'failed' }>): void;
  }

  function reviewRetryOf(round: RoundState, key: string): ReviewRetryState {
    const existing = round.reviews.get(key);
    if (existing !== undefined) return existing;
    const state: ReviewRetryState = {
      retry: null,
      record: emptySubmissionRecord(),
      executionId: '',
      remember() {
        // D-32：审核 Agent 每轮全新，不回灌 retry 上下文
      },
    };
    round.reviews.set(key, state);
    return state;
  }

  /**
   * R5：上一版结构与审核意见，**每次都从库里重建**，不缓存在 `RoundState` 里。
   *
   * 与 R3 的 `collectPriorRounds` 同一条纪律（D-31）：缓存就是一个跨 execution 存活的
   * 会话对象，撑不过重启的连续性等于没有连续性。重建的代价是两次索引查询，
   * 换来的是「进程重启后接着跑，模型看到的上下文一个字不差」。
   *
   * 返回 null 有两种情形，都不该带审核块：结构还没建过（首次创建），
   * 或者根槽位的轮次是 0（建过但从没被判返修）。
   */
  function structureReviewOf(
    taskId: string,
    snapshot: FrozenTaskSnapshot,
  ): StructureReviewInput | null {
    if (snapshot.compiled.bindings.reviewStructure === null) return null;
    const slots = uow.repositories.slots.listByTask(taskId);
    const root = slots.find(isStructureRoot);
    if (root === undefined || root.revisionRound === 0) return null;

    // 审核行属于**上一轮**：`markForRevision` 已经把根的轮次从 N 推到了 N+1。
    const findings: { criterionId: string; quote: string; problem: string }[] = [];
    for (const review of uow.repositories.slotReviews.listByRound(taskId, root.slotId, root.revisionRound - 1)) {
      for (const finding of parseReviewFindings(review.findingsJson)) findings.push(finding);
    }

    return {
      round: root.revisionRound,
      // 与审核 Agent 当时看到的是同一个函数的输出，逐字相同（见 review-target.ts）
      previousOutline: contentUnderReviewOf(root, slots),
      findings,
    };
  }

  function maxRetriesFor(snapshot: FrozenTaskSnapshot, key: string): number {
    // `create_structure:<round>` / `fill:<slotId>:<round>` /
    // `review:<slotId>:<round>:<criterionId>`。slotId 与 criterionId 都不含冒号
    // （SLOT_ID_PATTERN / SECTION_ID_PATTERN），拆分是安全的。
    const parts = key.split(':');
    if (parts[0] === STRUCTURE_BUDGET_PREFIX) {
      return snapshot.compiled.bindings.createStructure.maxRetries;
    }
    const slot = uow.repositories.slots.get(snapshot.taskId, parts[1] ?? '');
    if (slot === null) return snapshot.compiled.limits.maxExecutionRetries;
    const binding =
      parts[0] === 'review'
        ? snapshot.compiled.bindings.reviewSlotByType[slot.type]
        : snapshot.compiled.bindings.fillSlotByType[slot.type];
    return binding?.maxRetries ?? snapshot.compiled.limits.maxExecutionRetries;
  }
}

// ---------------------------------------------------------------------------
// 配额分桶键（R3 返修）
// ---------------------------------------------------------------------------

const STRUCTURE_BUDGET_PREFIX = 'create_structure';

/** 结构的配额桶键。轮次在键里的理由见 `runStructurePhase` 里的说明 */
function structureBudgetKey(reviewRound: number): string {
  return `${STRUCTURE_BUDGET_PREFIX}:${reviewRound}`;
}

/**
 * `slot_reviews.findings_json` → findings。
 *
 * 解析失败**抛出去**，不静默当成空数组。这一列是我们自己在同一个事务里
 * `JSON.stringify` 写进去的，读不回来说明库里的数据坏了；
 * 而静默吞掉的后果是模型收到一段「审核认为这一版需要重新设计，但具体意见没有保留」——
 * 一句读起来完全正常的话，掩盖着一个数据损坏。
 */
function parseReviewFindings(
  json: string,
): readonly { criterionId: string; quote: string; problem: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ForgeError('STORAGE_ERROR', '审核结果的 findings 无法解析', null, undefined, error);
  }
  if (!Array.isArray(parsed)) {
    throw new ForgeError('STORAGE_ERROR', '审核结果的 findings 不是数组', null);
  }
  return parsed.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      criterionId: typeof row['criterionId'] === 'string' ? row['criterionId'] : '',
      quote: typeof row['quote'] === 'string' ? row['quote'] : '',
      problem: typeof row['problem'] === 'string' ? row['problem'] : '',
    };
  });
}

/**
 * 填槽的配额桶键。**必须含 `revisionRound`**（§8 速查第 5 条）。
 *
 * `RetryBudget` 的计数器从 `tick()` 建立到结束从不重置，所以桶键就是配额的作用域。
 * 键里不带轮次的话，真实语义会变成「该槽位一生只有 maxRetries+1 次失败额度，
 * 跨返修轮共享」：第 0 轮 Provider 抖一次重试成功，进第 1 轮返修后**第一次**失败
 * 即判耗尽，槽位直接 failed——而返修本身并不是故障，不该吃掉故障重试预算（AC-R-017）。
 *
 * 带上轮次之后，`round.slots` / `round.reviews` 里的 `RetryState` 也随之一轮一份，
 * 于是上一轮的违规列表不会串进返修轮的 prompt（见 `RoundState` 的注释）。
 */
function budgetKeyOfFill(slot: Slot): string {
  return `fill:${slot.slotId}:${slot.revisionRound}`;
}

/** 审核的配额桶键。同样按轮分桶——第 0 轮某条判据重试过，不该扣掉第 1 轮的额度 */
function budgetKeyOfReview(slot: Slot, criterionId: string): string {
  return `review:${slot.slotId}:${slot.revisionRound}:${criterionId}`;
}

// ---------------------------------------------------------------------------

function slotTypeOf(snapshot: FrozenTaskSnapshot, slot: Slot): CompiledSlotType {
  const found = snapshot.compiled.slotTypes.find((t) => t.id === slot.type);
  if (found === undefined) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `任务 ${snapshot.taskId} 的快照里没有槽位类型「${slot.type}」`,
      `task:${snapshot.taskId}/slot:${slot.slotId}`,
    );
  }
  return found;
}

/** `FrozenSkill` → runtime 的 `SkillSnapshotView`。两边结构兼容，只是各自声明 */
function toSkillView(skill: FrozenSkill): {
  id: string;
  version: string;
  summary: string;
  preamble: string;
  requiredSections: readonly string[];
  sectionIndex: Readonly<Record<string, { id: string; title: string; content: string }>>;
  sections: readonly { id: string; title: string; content: string }[];
} {
  return {
    id: skill.id,
    version: skill.version,
    summary: skill.summary,
    preamble: skill.preamble,
    requiredSections: skill.requiredSections,
    sectionIndex: skill.sectionIndex,
    sections: skill.sections,
  };
}

function mustHave<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new ForgeError('STORAGE_ERROR', `内部错误：缺少 ${name}`, null);
  }
  return value;
}

/** 便于 lifecycle 与测试判定「这个状态还能不能被引擎推进」 */
export function isEngineRunnable(task: Pick<Task, 'status'>): boolean {
  const runnable: TaskStatus[] = ['running'];
  return runnable.includes(task.status);
}

export type { StructureViolation, ErrorCode };
