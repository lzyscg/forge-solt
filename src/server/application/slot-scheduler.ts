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
import { isStructureRoot, reviewBindingOf } from './review-binding.ts';
import type { SnapshotService } from './snapshot-service.ts';

/** 「下一步该干什么」。每个分支都带上依据的槽位，调用方不必再查一次库 */
export type NextWork =
  /** 有槽位正在生产。引擎应当什么都不做，等它收敛 */
  | { kind: 'running'; slot: Slot }
  /** 有槽位处于失败态。按失败处理，不进入死锁判定 */
  | { kind: 'failed'; slot: Slot }
  /**
   * R2：有槽位处于审核中，且该轮尚有未审判据。
   * 引擎应跑一条 review_slot execution（AC-R-002）。
   */
  | { kind: 'review'; slot: Slot; criterionId: string }
  /**
   * R2：该槽位本轮判据已全部审完，引擎应结算（D-21/D-26）。
   * 结算事务内调 settleReview → markForRevision / clearReview。
   */
  | { kind: 'review_settle'; slot: Slot }
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
  /** R2：读冻结快照以枚举判据（AC-R-008） */
  snapshots: SnapshotService;
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

/**
 * R2：从冻结快照枚举判据 ID（= 审核 Skill 的 section_index 章节按索引顺序），
 * 找出该轮在 slot_reviews 里尚无记录的第一条判据（§6.2「沿用 SECTION_ID_PATTERN 风格」）。
 *
 * 判据 ID = 冻结快照审核 Skill 的 section ID（S1、S2…，按 sections 数组顺序）。
 * 调度器从任务冻结的审核 Skill 快照枚举判据（AC-R-008）。
 *
 * 返回 null 表示本轮判据已全部审完。
 */
function findNextCriterion(
  snapshots: SnapshotService,
  slotReviewsRepo: { listByRound: (taskId: string, slotId: string, round: number) => readonly { criterionId: string }[] },
  slot: Slot,
): string | null {
  const snapshot = snapshots.readSnapshot(slot.taskId);
  const binding = reviewBindingOf(snapshot.compiled, slot);
  if (binding === null) {
    // 调度器给了 review 工作但没有审核绑定 = 内部错误
    throw new ForgeError(
      'STORAGE_ERROR',
      `槽位 ${slot.slotId}（类型 ${slot.type}）处于 reviewing 但快照无审核绑定`,
      `slot:${slot.slotId}`,
    );
  }
  const skill = snapshot.skills[binding.skillId];
  if (skill === undefined) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `任务 ${slot.taskId} 的快照里没有审核 Skill「${binding.skillId}」`,
      `slot:${slot.slotId}`,
    );
  }
  // 判据 ID = section ID，按 sections 数组顺序（不是 requiredSections 顺序）
  const allCriteria = skill.sections.map((s) => s.id);
  if (allCriteria.length === 0) return null;

  const reviewed = slotReviewsRepo.listByRound(slot.taskId, slot.slotId, slot.revisionRound);
  const reviewedIds = new Set(reviewed.map((r) => r.criterionId));
  for (const criterionId of allCriteria) {
    if (!reviewedIds.has(criterionId)) return criterionId;
  }
  return null;
}

export function createSlotScheduler(options: SlotSchedulerOptions): SlotScheduler {
  const { slots: slotRepo, slotReviews: slotReviewsRepo } = options.uow.repositories;
  const { snapshots } = options;

  /**
   * 还没审完的根容器。见 `selectNext` 里调用处的说明。
   *
   * 只在 `status === 'pending'` 时返回：审完之后 `clearReview` 会把根置成
   * completed，那时这里必须返回 undefined，否则任务在结构审核上原地打转。
   */
  const pendingStructureRoot = (ordered: readonly Slot[]): Slot | undefined => {
    const root = ordered.find(isStructureRoot);
    if (root === undefined || root.status !== 'pending') return undefined;
    return reviewBindingOf(snapshots.readSnapshot(root.taskId).compiled, root) === null
      ? undefined
      : root;
  };

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

      // R2：reviewing 必须排在 assembly 之前。否则 reviewing 的槽位会被
      // allContentSlotsCompleted 判为「没完成」而落到第 5 步去找新槽位——
      // 那会绕过审核直接开下一个（AC-R-007 必须反证）。
      //
      // R5 的第二个来源：**pending 的根容器**。结构审核期间被 stop 或进程崩过一次，
      // 恢复路径会用 `cancelReview` 把根放回 pending（AC-R-012，那条对内容槽位是对的：
      // 停止不是审核驱动的返修，不该吃 D-26 的预算）。只认 reviewing 的话，
      // resume 之后调度器看不到任何审核工作，直接开始填第一个槽位——
      // 结构审核被静默跳过，而跳过的表现是「一切正常，只是没审」。
      // 根容器永远不填槽，它停在 pending 只有这一种解释。
      const reviewing =
        ordered.find((slot) => slot.status === 'reviewing') ?? pendingStructureRoot(ordered);
      if (reviewing !== undefined) {
        // 从冻结快照枚举判据 ID（section_index 的章节 ID，按索引顺序）。
        const reviewWork = findNextCriterion(snapshots, slotReviewsRepo, reviewing);
        if (reviewWork !== null) {
          return { kind: 'review', slot: reviewing, criterionId: reviewWork };
        }
        // 本轮判据全审完 → 触发结算
        return { kind: 'review_settle', slot: reviewing };
      }

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

      // 走不到：内容槽位有五种状态（pending/running/reviewing/completed/failed），
      // 前五条判定已穷举（running/failed/reviewing/assembly/slot）。
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
