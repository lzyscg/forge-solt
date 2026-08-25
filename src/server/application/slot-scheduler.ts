/**
 * 槽位调度（文档 §6.2 / §7.1 / REQ FR-SCH-001~004）。
 *
 * 本文件**不做任何判定**，判定全在 `domain/readiness.ts` 的纯函数里。
 * 它做的是三件事：从库里读出槽位、按 FR-SCH-004 的优先级把纯函数的结论组装成
 * 一个「下一步该干什么」的答案、以及为 ContextBuilder 取出依赖槽位的正文。
 *
 * 为什么不在这里写 if：REQ FR-SCH-002 要求「相同结构和相同状态必须得到相同的下一
 * Slot」。只要调度判据存在第二份实现，两份就会漂移，而漂移的表现是
 * 「同一个任务重跑一次选了另一个槽位」——一个没有任何报错、只能靠比对产物发现的 bug。
 *
 * ## 优先级顺序（FR-SCH-004，不可调换）
 *
 *   running 槽位 → 等它（引擎不该并发，NFR-001）
 *   failed 槽位  → 按失败处理，**先于**死锁判定
 *   全部内容槽完成 → 进 Assembly
 *   有 ready 槽位 → 调度它
 *   否则         → DEPENDENCY_DEADLOCK
 *
 * failed 必须排在死锁之前：一个失败槽位会让它的下游全部永远等不到，
 * 此时报「依赖死锁」是把真正的失败原因盖掉，用户看到的是一句
 * 「结构存在无法满足的依赖」而实际上结构没问题、只是某个槽位超时了。
 */

import { ForgeError } from '@shared/errors.ts';
import {
  allContentSlotsCompleted,
  detectDeadlock,
  documentOrder,
  selectNextReadySlot,
} from '@server/domain/readiness.ts';
import type { Slot } from '@server/domain/types.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { DependencyContent } from './context-builder.ts';

/** 「下一步该干什么」。每个分支都带上依据的槽位，调用方不必再查一次库 */
export type NextWork =
  /** 有槽位正在生产。引擎应当什么都不做，等它收敛 */
  | { kind: 'running'; slot: Slot }
  /** 有槽位处于失败态。按失败处理，不进入死锁判定 */
  | { kind: 'failed'; slot: Slot }
  /** 全部内容承载槽位已完成，可以组装（FR-SCH-004 第 1 条） */
  | { kind: 'assembly' }
  /** 下一个要生产的槽位（文档序中第一个 ready 的） */
  | { kind: 'slot'; slot: Slot };

export interface SlotDependencies {
  /** 按 `dependsOn` 声明序去重后的槽位 ID。同时是 `buildToolset` 的 `allowedDependencySlotIds` */
  slotIds: readonly string[];
  /** 与 `slotIds` 同序的正文 */
  contents: readonly DependencyContent[];
}

export interface SlotScheduler {
  /**
   * 选出下一步工作。死锁时抛 `DEPENDENCY_DEADLOCK`，
   * 错误消息已成文（D-19），调用方可直接写进 `task.error_message`。
   */
  selectNext(taskId: string): NextWork;
  /** ContextBuilder 的 `dependencies` 输入。依赖未完成即抛 `SLOT_NOT_READY` */
  dependenciesOf(taskId: string, slot: Slot): SlotDependencies;
}

export interface SlotSchedulerOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
}

/**
 * 成文的死锁原因（D-19）。
 *
 * 必须点名「谁在等谁」：`DEPENDENCY_DEADLOCK` 的 action 是「需要重新创建任务」，
 * 这是个代价很高的动作，只给一句「存在无法满足的依赖」等于让用户在没有任何线索的
 * 情况下决定要不要重来。
 */
function composeDeadlockReason(slotIds: readonly string[], blockedBy: readonly string[]): string {
  return (
    `结构存在无法满足的依赖：${slotIds.join('、')} 在等待 ${blockedBy.join('、')}，` +
    '而这些前置槽位不会再完成'
  );
}

export function createSlotScheduler(options: SlotSchedulerOptions): SlotScheduler {
  const { slots: slotRepo } = options.uow.repositories;

  return {
    selectNext(taskId) {
      // 一次读全量。分多次查会让「读到的状态」跨越多个时刻，
      // 而下面五条判定必须建立在同一张状态快照上，否则可能同时得出
      // 「没有 running」和「没有 ready」两个来自不同时刻的结论。
      const slots = slotRepo.listByTask(taskId);
      if (slots.length === 0) {
        throw new ForgeError(
          'SLOT_NOT_FOUND',
          `任务 ${taskId} 还没有结构，无法调度槽位`,
          `task:${taskId}`,
        );
      }

      const ordered = documentOrder(slots);

      const running = ordered.find((slot) => slot.status === 'running');
      if (running !== undefined) return { kind: 'running', slot: running };

      const failed = ordered.find((slot) => slot.status === 'failed');
      if (failed !== undefined) return { kind: 'failed', slot: failed };

      if (allContentSlotsCompleted(slots)) return { kind: 'assembly' };

      const next = selectNextReadySlot(slots);
      if (next !== null) return { kind: 'slot', slot: next };

      const deadlock = detectDeadlock(slots);
      if (deadlock !== null) {
        throw new ForgeError(
          'DEPENDENCY_DEADLOCK',
          composeDeadlockReason(deadlock.slotIds, deadlock.blockedBy),
          `slot:${deadlock.slotIds[0] ?? ''}`,
          '结构存在无法满足的依赖，需要重新创建任务',
        );
      }

      // 走不到：内容槽位只有四种状态，前四条判定已穷举。
      // 仍然显式报错而不是静默返回 assembly——静默的结果是产出一份缺段的产物。
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${taskId} 的槽位状态无法解释：既没有可调度的槽位，也不构成死锁`,
        `task:${taskId}`,
        '请查看服务日志',
      );
    },

    dependenciesOf(taskId, slot) {
      const slotIds: string[] = [];
      const contents: DependencyContent[] = [];
      const seen = new Set<string>();

      // 保持 `dependsOn` 的**声明顺序**：它决定模型读到上游正文的先后，
      // 也是 D-12 里 contextHash 明确覆盖的「依赖槽位内容及其顺序」。
      for (const dependencyId of slot.dependsOn) {
        if (seen.has(dependencyId)) continue;
        seen.add(dependencyId);

        const dependency = slotRepo.get(taskId, dependencyId);
        if (dependency === null) {
          // 结构校验规则 14 本该拦下悬空依赖。真出现在库里说明结构是绕过本系统写进去的，
          // 此时继续生产会让模型在缺少上游的情况下硬写——宁可当场停下。
          throw new ForgeError(
            'SLOT_NOT_FOUND',
            `槽位 ${slot.slotId} 依赖的 ${dependencyId} 不存在`,
            `slot:${slot.slotId}`,
          );
        }
        if (dependency.status !== 'completed' || dependency.contentText === null) {
          throw new ForgeError(
            'SLOT_NOT_READY',
            `槽位 ${slot.slotId} 的前置 ${dependencyId} 尚未完成，不能开始生产`,
            `slot:${slot.slotId}`,
            '等待前置槽位完成',
          );
        }
        slotIds.push(dependencyId);
        contents.push({ slotId: dependencyId, content: dependency.contentText });
      }

      return { slotIds, contents };
    },
  };
}
