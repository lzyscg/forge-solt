/**
 * 任务生命周期（文档 §8.3 停止 / §8.6 重启恢复 / §8.7 Retry，以及 start / resume）。
 *
 * 本文件与 `production-engine.ts` 的分工：**引擎回答「现在该做什么」，
 * 这里回答「谁被允许改变任务的状态」。** 五个入口全部走
 * `domain/state-machine.ts` 的 `assertTransition`，一处 if-else 都不写——
 * 状态机是那个文件的职责，在这里复述一遍等于埋下两份会分叉的规则。
 *
 * 「不允许出现永久 running」的三道网里，最后一道在这里：
 * `recoverOnStartup()`。前两道（Runtime 超时、引擎的双桶配额）都只在进程存活时有效；
 * 进程被 kill -9 时，库里会留下 `status='running'` 但没有任何东西在推它的任务。
 */

import { ForgeError } from '@shared/errors.ts';
import { assertTransition } from '@server/domain/state-machine.ts';
import type { Task } from '@server/domain/types.ts';
import { UserStopSignal } from '@server/runtime/abort-reasons.ts';
import type { TraceService } from './trace-service.ts';
import type { ProductionEngine } from './production-engine.ts';

export interface LifecycleServiceOptions {
  traces: TraceService;
  engine: ProductionEngine;
  /** 与引擎共享的同一张表（§8.3：stop 事务提交后要同步拿到 controller） */
  activeControllers: Map<string, AbortController>;
}

/** 三个「让任务跑起来」的动作。它们的差别只在状态迁移与重置策略 */
export type LifecycleAction = 'start' | 'resume' | 'retry';

export interface LifecycleService {
  /** `ready → running`，随后入队。返回的 Promise 在本轮推进结束时 resolve */
  start(taskId: string): Promise<void>;
  /** `stopped → running`，从中断处继续。已完成槽位不重跑 */
  resume(taskId: string): Promise<void>;
  /** `failed → running`。按失败相位分派重置策略（§8.7） */
  retry(taskId: string): Promise<void>;
  /**
   * HTTP 用的入口：**状态迁移同步做完**，本轮推进留在后台。
   *
   * 存在的理由是上面三个方法的签名对 HTTP 不适用。它们返回的 Promise
   * 在**整轮生产结束**时才 resolve（几分钟），所以路由不能 await；
   * 可一旦不 await，`asPromise` 又把同步抛出的校验错误（比如
   * 「任务不是 ready，不能 start」）转成了 rejection——路由拿不到它，
   * 于是一次被状态机拒绝的请求会返回 200，而错误变成一条未处理的 rejection。
   *
   * 因此这里把两段拆开：迁移与校验**同步**（失败就同步抛，交给 §9.3 的
   * setErrorHandler），后台那段以 `done` 交还给调用方自行决定等不等。
   */
  dispatch(action: LifecycleAction, taskId: string): { done: Promise<void> };
  /** §8.3。事务内让库拒绝后续提交，事务**提交之后**才 abort */
  stop(taskId: string): void;
  /** §8.6。必须在 HTTP 开始监听**之前**调用 */
  recoverOnStartup(): { recovered: string[]; orphans: number };
}

/**
 * 取消原因的成文中文（D-19 / M5 审查补正）。
 *
 * 这两个值会写进 `executions.error_message`，而那一列会经
 * `ExecutionView.error.message` 投影到 API、显示在 UX §13.5 的技术详情面板上。
 * 原先写的是 `'USER_STOP'` / `'SERVICE_RESTART'` 两个内部枚举字面量——
 * 于是用户在界面上看到的是一串英文常量名。
 *
 * D-19 的原话是「失败原因的成文责任在 lifecycle 层」：写进去的时候就得是
 * 一句能直接展示的完整中文，派生层只取用、不做解析、不做翻译。
 */
const CANCEL_REASON = {
  userStop: '运营手动停止，本次执行已取消',
  serviceRestart: '服务重启，未完成的执行已取消',
} as const;

/** start / resume 的轨迹措辞。retry 的在 `retrySummary` 里，它要看失败相位 */
const RUNNING_TRACE: Record<'start' | 'resume', { title: string; summary: string }> = {
  start: { title: '任务已启动', summary: '开始创建结构' },
  resume: { title: '任务已继续', summary: '从中断处继续生产' },
};

export function createLifecycleService(options: LifecycleServiceOptions): LifecycleService {
  const { traces, engine, activeControllers } = options;

  return { start, resume, retry, dispatch, stop, recoverOnStartup };

  /**
   * 三个动作的共同骨架：同步迁移 → 入队。
   *
   * `start` / `resume` / `retry` 现在都只是「dispatch 之后 await 那段后台」，
   * 迁移逻辑只有这一份。两份必然分叉，而分叉的表现是
   *「用 HTTP 启动和用 CLI 启动，任务的初始状态不一样」。
   */
  function dispatch(action: LifecycleAction, taskId: string): { done: Promise<void> } {
    if (action === 'retry') resetForRetry(taskId);
    else transitionToRunning(taskId, action, RUNNING_TRACE[action].title, RUNNING_TRACE[action].summary);
    return { done: engine.enqueue(taskId) };
  }

  /**
   * 三个 async 入口都走 `asPromise` 包一层。
   *
   * 声明成返回 Promise 却**同步抛**，是一类很难查的坑：HTTP handler 写
   * `service.start(id).catch(next)` 看起来滴水不漏，实际同步抛出的那一支
   * 根本走不到 `.catch`，会以未处理异常的形式冒到进程顶上。
   * 既然签名承诺了 Promise，失败就必须以 rejection 的形式交付。
   */
  function start(taskId: string): Promise<void> {
    return asPromise(() => dispatch('start', taskId).done);
  }

  function resume(taskId: string): Promise<void> {
    // resume 不重置任何槽位：已完成的内容必须保留（AC-012），
    // 而被 stop 放回 pending 的那个槽位早在 stop 事务里就归位了。
    return asPromise(() => dispatch('resume', taskId).done);
  }

  function retry(taskId: string): Promise<void> {
    return asPromise(() => dispatch('retry', taskId).done);
  }

  function resetForRetry(taskId: string): void {
    traces.runWithTraces((repos, trace) => {
      const task = repos.tasks.getOrThrow(taskId);
      assertTransition(task.status, 'retry');

      // 按**失败相位**分派，而不是一律清空重来：
      // REQ FR-LIFE-004 / AC-012 明确「已完成 Slot 永不重新生成」。
      if (task.phase === 'structure') {
        // 结构失败时正常不该有槽位（提交是原子的），但保险起见清一次——
        // 留下半棵树会让下一次结构提交撞上主键冲突，而报错指向的是提交而不是这里。
        //
        // R5 之后「结构相位有槽位」不再是异常：结构审核检出问题时 phase 会退回
        // structure，而上一棵树要留到新提案通过校验才替换（见 StructureService.submit）。
        // 此时根槽位上挂着本轮的审核行，必须先删——外键不是 DEFERRABLE。
        repos.slotReviews.deleteByTask(taskId);
        repos.slots.deleteAll(taskId);
      } else if (task.phase === 'slots') {
        repos.slots.resetFailedToPending(taskId);
      }
      // assembly 失败：什么都不用重置，直接重跑组装

      repos.tasks.update(taskId, { status: 'running', errorCode: null, errorMessage: null });
      trace.record({
        taskId,
        executionId: null,
        // TraceActor 里没有 'user'（见 @shared/trace.ts）：轨迹记的是**流水线里谁动的手**，
        // 而状态迁移始终是系统执行的，用户只是触发者。触发者信息属于 API 层的审计，
        // 不是 Agent 轨迹的语义。
        actor: 'system',
        kind: 'task_state_changed',
        title: '任务已重试',
        summary: retrySummary(task),
        payload: null,
      });
    });
  }

  /**
   * §8.3。**两步的顺序不能颠倒**。
   *
   * 若先 abort，Provider 可能在 stop 事务开始之前就返回结果并成功提交——
   * 那正是 AC-011 要防的。先让数据库拒绝（`active_execution_id` 置空 +
   * execution 标 cancelled，D-10 的 WHERE 因此不再匹配），再去中断在途调用。
   */
  function stop(taskId: string): void {
    const controller = traces.runWithTraces((repos, trace) => {
      const task = repos.tasks.getOrThrow(taskId);
      assertTransition(task.status, 'stop');

      const execution =
        task.activeExecutionId === null ? null : repos.executions.get(task.activeExecutionId);
      if (execution !== null && (execution.status === 'running' || execution.status === 'created')) {
        repos.executions.markCancelled(execution.id, CANCEL_REASON.userStop);
        if (execution.targetSlotId !== null) {
          // R2 AC-R-012：审核期 stop 与 running 期同样有效，但走不同仓储方法。
          // reviewing 槽位用 cancelReview（不递增 revision_round，保留内容/producer）。
          // running 槽位用 resetToPending（它带 AND status='running' 守卫，reviewing 不会误伤）。
          const slot = repos.slots.get(taskId, execution.targetSlotId);
          if (slot !== null && slot.status === 'reviewing') {
            repos.slots.cancelReview(taskId, execution.targetSlotId);
          } else {
            repos.slots.resetToPending(taskId, execution.targetSlotId);
          }
        }
      }
      repos.tasks.update(taskId, { status: 'stopped', activeExecutionId: null });
      trace.record({
        taskId,
        executionId: execution?.id ?? null,
        actor: 'system',
        kind: 'task_state_changed',
        title: '任务已停止',
        // 附录 B：停止的措辞不带错误感
        summary: '运营手动停止，已完成槽位内容保留，可从中断处续跑',
        payload: null,
      });

      // 内存 map 的同步读取（notes Q-06 第 4 条）。这一行必须保持同步——
      // 换成异步查询会在事务里引入 await 点，D-10 的原子性保证随之失效。
      return activeControllers.get(taskId) ?? null;
    });

    // 第二步：事务提交之后才 abort
    controller?.abort(new UserStopSignal());
  }

  /**
   * §8.6。REQ FR-LIFE-003 明确 P0 **不自动恢复模型调用**，等用户 Resume。
   *
   * 自动恢复看起来更贴心，实际是把「进程为什么会挂」这个问题藏起来：
   * 若崩溃是某个特定槽位触发的，自动恢复会让它崩溃—恢复—再崩溃地循环下去。
   */
  function recoverOnStartup(): { recovered: string[]; orphans: number } {
    return traces.runWithTraces((repos, trace) => {
      const recovered: string[] = [];

      for (const task of repos.tasks.findByStatus('running')) {
        const execution =
          task.activeExecutionId === null ? null : repos.executions.get(task.activeExecutionId);
        if (
          execution !== null &&
          (execution.status === 'running' || execution.status === 'created')
        ) {
          repos.executions.markCancelled(execution.id, CANCEL_REASON.serviceRestart);
          if (execution.targetSlotId !== null) {
            // R2 AC-R-012：审核期恢复与 running 期同语义，但 reviewing 用 cancelReview。
            const slot = repos.slots.get(task.id, execution.targetSlotId);
            if (slot !== null && slot.status === 'reviewing') {
              repos.slots.cancelReview(task.id, execution.targetSlotId);
            } else {
              repos.slots.resetToPending(task.id, execution.targetSlotId);
            }
          }
        }
        repos.tasks.update(task.id, { status: 'stopped', activeExecutionId: null });
        trace.record({
          taskId: task.id,
          executionId: execution?.id ?? null,
          actor: 'system',
          kind: 'task_state_changed',
          title: '服务重启，任务已暂停',
          summary: '未完成的执行已取消，已完成的槽位内容保留。点击继续从中断处恢复。',
          payload: null,
        });
        recovered.push(task.id);
      }

      // 孤儿：execution 还是 created/running，但它的 task 已经不是 running 了。
      // 上面那个循环只覆盖「task 仍标着 running」的情形；进程在 stop 事务提交后、
      // abort 生效前被杀，就会留下这类记录。
      let orphans = 0;
      for (const execution of repos.executions.findOrphans()) {
        repos.executions.markCancelled(execution.id, CANCEL_REASON.serviceRestart);
        orphans += 1;
      }

      return { recovered, orphans };
    });
  }

  function transitionToRunning(
    taskId: string,
    action: 'start' | 'resume',
    title: string,
    summary: string,
  ): void {
    traces.runWithTraces((repos, trace) => {
      const task = repos.tasks.getOrThrow(taskId);
      assertTransition(task.status, action);
      if (task.activeExecutionId !== null) {
        // 启动一个还挂着活动执行的任务会立刻撞上 D-10 的 Token 校验，
        // 而报错会指向提交路径，看起来像是模型的问题。在入口处就拦下。
        throw new ForgeError(
          'TASK_STATE_INVALID',
          `任务 ${taskId} 仍挂着活动执行 ${task.activeExecutionId}，无法${title}`,
          `task:${taskId}`,
          '请先停止该任务',
        );
      }
      repos.tasks.update(taskId, { status: 'running', errorCode: null, errorMessage: null });
      trace.record({
        taskId,
        executionId: null,
        actor: 'system',
        kind: 'task_state_changed',
        title,
        summary,
        payload: null,
      });
    });
  }
}

/** 把同步抛出的错误转成 rejection，让签名上的 Promise 说话算数 */
function asPromise(fn: () => Promise<void>): Promise<void> {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function retrySummary(task: Task): string {
  if (task.phase === 'structure') return '重新创建结构';
  if (task.phase === 'slots') return '失败槽位已重置，已完成槽位保留';
  return '重新组装产物';
}
