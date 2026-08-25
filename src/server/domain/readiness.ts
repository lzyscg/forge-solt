/**
 * 槽位就绪判定与确定性调度（文档 §6.2 / REQ FR-SCH-001~004）。
 *
 * 这一层回答「下一个该做哪个槽位」。它是纯函数：输入一组槽位，输出结论——
 * 不读时钟、不读数据库、不带隐藏状态。REQ FR-SCH-002 要求「相同结构和相同状态
 * 必须得到相同的下一 Slot」，只要这里出现一处非确定性（比如依赖 Map 迭代顺序、
 * 依赖数组传入顺序、用 `localeCompare` 排序），这条要求就静默失守。
 *
 * 三个容易写错的地方，都在下面各自的函数上写明了：
 * 1. `documentOrder` 的 tiebreaker 必须落到 slotId，不能只按 sortOrder
 * 2. `selectNextReadySlot` 用**文档序**而非拓扑序——文档序靠前但依赖未满足的会被跳过
 * 3. `detectDeadlock` 的四个前提缺一不可，少一个就会把「正在跑」误判成死锁
 *
 * D-16 提醒：工作槽位（`includeInArtifact === false`）在本层与普通内容槽位**完全一样**
 * ——仍要被调度、仍计入「全部内容槽位已完成」。它只在 `assembly.ts` 里被跳过。
 */

import type { Slot } from './types.ts';
import { compareCodePoints } from './canonical.ts';

/** `detectDeadlock` 的返回。给 `DEPENDENCY_DEADLOCK` 错误提供定位信息（FR-SCH-004） */
export interface DeadlockInfo {
  /** 永远等不到的 pending 内容槽位，按文档序 */
  slotIds: string[];
  /** 这些槽位在等的、且不会再完成的前置槽位（并集，去重后按字典序） */
  blockedBy: string[];
}

/**
 * 字典序比较。
 *
 * 不用 `String.prototype.localeCompare`：它的结果依赖 ICU 版本与运行环境语言设置，
 * 同一份数据在开发机与 CI 上可能排出不同顺序——正是 REQ NFR-006 要禁止的不确定性。
 *
 * 也不用裸 `a < b`（本函数的原实现）：JS 字符串比较走 **UTF-16 码元序**，
 * 对 BMP 外字符与码点序不一致。`assembly.ts` 的同名比较器用的是
 * `compareCodePoints`，两者对 `'\u{20000}'` vs `'＀'` 给出**相反**的顺序——
 * 而这两个文件各自的注释都声称「必须与对方逐字一致」。
 * 今天有 `SLOT_ID_PATTERN`（`[a-z][a-z0-9_]{0,63}`）挡着，看不出差别；
 * 但本文件明说要容忍「不受今天校验保护的历史数据」，那层保护并不覆盖它。
 * 统一到码点序，并且直接复用同一个函数，让「保持一致」不再依赖两处各自的自觉。
 */
const compareIds = compareCodePoints;

/**
 * 同级排序：先 sortOrder，再 slotId（FR-SCH-002 的第 2、3 顺位）。
 *
 * **导出是刻意的**：`assembly.ts` 必须用这一个函数，而不是自己再写一份。
 * 「产物顺序」与「生产顺序」分叉是一类事后极难发现的 bug，
 * 消除它最可靠的办法是让两边根本没有第二份实现可用。
 */
export function compareSiblings(a: Slot, b: Slot): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return compareIds(a.slotId, b.slotId);
}

function indexById(slots: readonly Slot[]): Map<string, Slot> {
  const byId = new Map<string, Slot>();
  for (const slot of slots) {
    if (!byId.has(slot.slotId)) byId.set(slot.slotId, slot);
  }
  return byId;
}

/**
 * 每个槽位的深度，**0 基**：根槽位为 0。
 *
 * 0 基是为了对上 `SlotViewSchema.depth` ——前端直接拿它做 `depth × 20px` 缩进。
 * （`structure-validation` 的 `DEPTH_EXCEEDED` 文案是 1 基的「第 N 层」，
 * 判据为 `depth + 1 > maxStructureDepth`，两处刻意差一，各自注释里都写了。）
 *
 * 对异常数据的容忍：parentId 悬空的槽位视为根（深度 0）；父子成环的槽位得到深度 0
 * 并被记为已处理，绝不死循环。正常路径上这两种数据已被结构校验挡在门外，
 * 但本函数也服务于「从数据库读出来的历史数据」，不能假设它一定干净。
 */
export function computeDepth(slots: readonly Slot[]): Map<string, number> {
  const byId = indexById(slots);
  const depths = new Map<string, number>();

  for (const slot of slots) {
    if (depths.has(slot.slotId)) continue;
    // 自底向上收集这条链，再一次性回填，避免深树上重复回溯同一段祖先
    const path: Slot[] = [];
    const onPath = new Set<string>();
    let cursor: Slot | undefined = slot;
    /** 赋给 path 最后一个元素（离根最近的那个）的深度 */
    let startDepth = 0;

    while (cursor !== undefined) {
      const known = depths.get(cursor.slotId);
      if (known !== undefined) {
        startDepth = known + 1; // 上一段已算过，接着往下数
        break;
      }
      if (onPath.has(cursor.slotId)) {
        startDepth = 0; // 父子环：结构校验规则 8 本该拦下，这里只保证不挂死
        break;
      }
      path.push(cursor);
      onPath.add(cursor.slotId);
      const parentId = cursor.parentId;
      if (parentId === null) break; // 真正的根
      const parent = byId.get(parentId);
      if (parent === undefined) break; // 悬空 parent，按根处理
      cursor = parent;
    }

    // 从离根最近的一端开始回填。用 `reverse()` 配 for...of 而不是下标倒序：
    // `path` 是本轮新建的局部数组，原地反转没有外部可见的副作用，而 for...of 拿到的
    // 元素类型是 `Slot` 而不是 `Slot | undefined`（`noUncheckedIndexedAccess`），
    // 省掉一个永远不会成立、因而也永远测不到的 undefined 兜底。
    let depth = startDepth;
    for (const node of path.reverse()) {
      depths.set(node.slotId, depth);
      depth += 1;
    }
  }

  return depths;
}

/**
 * 文档序：从根开始深度优先前序遍历，同一父节点下按 `(sortOrder, slotId)` 升序
 * （REQ FR-SCH-002 / 文档 §6.2）。
 *
 * `slotId` 作为最终 tiebreaker，保证即使 sortOrder 重复（理论上已被结构校验
 * 规则 10 挡住）也有确定结果——「理论上不会发生」不是省掉 tiebreaker 的理由，
 * 数据是从库里读出来的，历史数据不受今天的校验保护。
 *
 * 与 `assembly.ts` 的遍历顺序必须逐字一致，否则「产物顺序」和「生产顺序」会分叉。
 *
 * 异常数据处理：parentId 悬空的槽位当作根参与遍历；父子环里的槽位无法从任何根
 * 到达，会在最后按 slotId 追加，保证**输入的每个槽位都恰好出现一次**——
 * 调度器少看见一个槽位，表现出来就是任务永远差一块内容却又不报错。
 */
export function documentOrder(slots: readonly Slot[]): Slot[] {
  const byId = indexById(slots);
  const childrenOf = new Map<string, Slot[]>();
  const roots: Slot[] = [];

  for (const slot of slots) {
    const parentId = slot.parentId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(slot);
      continue;
    }
    const bucket = childrenOf.get(parentId);
    if (bucket === undefined) childrenOf.set(parentId, [slot]);
    else bucket.push(slot);
  }

  roots.sort(compareSiblings);
  for (const bucket of childrenOf.values()) bucket.sort(compareSiblings);

  const out: Slot[] = [];
  const visited = new Set<string>();

  const walk = (slot: Slot): void => {
    if (visited.has(slot.slotId)) return;
    visited.add(slot.slotId);
    out.push(slot);
    for (const child of childrenOf.get(slot.slotId) ?? []) walk(child);
  };

  for (const root of roots) walk(root);

  // 环里的槽位到不了，兜底追加，保证不丢
  const orphans = slots.filter((s) => !visited.has(s.slotId));
  orphans.sort((a, b) => compareIds(a.slotId, b.slotId));
  for (const orphan of orphans) walk(orphan);

  return out;
}

/**
 * 某个槽位在等哪些前置（D-07 的「等待依赖」子行必须点名在等谁）。
 *
 * 返回未完成的依赖 ID，保持 `dependsOn` 的声明顺序并去重。
 * 不存在的依赖也算「未满足」并原样返回——结构校验规则 14 本该拦下它，
 * 若真出现在库里，让用户看见这个陌生 ID 远比静默忽略有用。
 *
 * 与槽位自身状态无关：本函数只回答「它的依赖满足了吗」。
 * 「要不要显示这一行」是 `presentation.ts` 的判断，不是这里的。
 */
export function blockedBy(slot: Slot, slots: readonly Slot[]): string[] {
  const byId = indexById(slots);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dep of slot.dependsOn) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (byId.get(dep)?.status === 'completed') continue;
    out.push(dep);
  }
  return out;
}

/**
 * Ready 判定（REQ FR-SCH-001）：内容承载 + pending + 全部依赖已 completed。
 *
 * 容器槽位永不 Ready：它没有 Assignment，不产出内容，没有什么可调度的。
 *
 * 判据只看 `contentBearing`，**不看容器自己的 status**（D-19 澄清）：
 * 容器落库即 `pending` 并永远保持 pending——仓储层根本没有把它置成别的状态的入口。
 * 早先的注释说「结构提交时被置为 completed」，那与实现不符；
 * 好在本层每一个读取点都先按 `contentBearing` 过滤，所以那句话错了也没造成 bug。
 * 现在把话说准：容器的 status 取什么值，对调度都不该有影响。
 */
export function isSlotReady(slot: Slot, slots: readonly Slot[]): boolean {
  if (!slot.contentBearing) return false;
  if (slot.status !== 'pending') return false;
  return blockedBy(slot, slots).length === 0;
}

/** 全部 Ready 槽位，按文档序返回 */
export function deriveReadySlots(slots: readonly Slot[]): Slot[] {
  return documentOrder(slots).filter((slot) => isSlotReady(slot, slots));
}

/**
 * 下一个要执行的槽位，没有则 null（REQ FR-SCH-002 / FR-SCH-003：由系统指定，Agent 无权选）。
 *
 * 用**文档序**而不是依赖拓扑序：一个文档序靠前但依赖未满足的槽位会被跳过，
 * 选中靠后的那个。这两种顺序会给出不同答案，REQ 明确要的是前者。
 */
export function selectNextReadySlot(slots: readonly Slot[]): Slot | null {
  return documentOrder(slots).find((slot) => isSlotReady(slot, slots)) ?? null;
}

/**
 * 全部内容承载槽位是否都已完成——Assembly 的入口条件（FR-SCH-004 第 1 条）。
 *
 * 工作槽位（`includeInArtifact === false`）同样计入：它不进产物，但它必须被生产出来，
 * 否则下游槽位读不到它（D-16 影响面第 2 条明确要求本层不变）。
 *
 * 没有任何内容槽位时返回 true（空集全称命题）。这种结构已被结构校验规则 18 拒绝，
 * 因此不给它特殊语义——真要发生，问题在结构提交那一步，不在这里。
 */
export function allContentSlotsCompleted(slots: readonly Slot[]): boolean {
  return slots.every((slot) => !slot.contentBearing || slot.status === 'completed');
}

/**
 * 死锁检测（REQ FR-SCH-004 第 3 条 / `DEPENDENCY_DEADLOCK`）。
 *
 * 四个前提**必须同时成立**，缺一条就会误判：
 *   1. 存在 pending 的内容槽位     —— 没有就是干完了，该进 Assembly
 *   2. 不存在 ready 槽位           —— 有就继续调度，不是死锁
 *   3. 不存在 running 槽位         —— 有就是还在跑，等它结束再说
 *   4. 不存在 failed 槽位          —— 有就该按失败处理（FR-SCH-004 第 2 条优先），
 *                                    报成 DEPENDENCY_DEADLOCK 会把真正的失败原因盖掉
 *
 * 正常情况下依赖环在结构提交时就被规则 16 拒了，本函数是保护异常数据的最后一道。
 */
export function detectDeadlock(slots: readonly Slot[]): DeadlockInfo | null {
  const ordered = documentOrder(slots);

  const hasRunning = ordered.some((s) => s.status === 'running');
  if (hasRunning) return null;

  const hasFailed = ordered.some((s) => s.status === 'failed');
  if (hasFailed) return null;

  const pending = ordered.filter((s) => s.contentBearing && s.status === 'pending');
  if (pending.length === 0) return null;

  const hasReady = pending.some((slot) => isSlotReady(slot, slots));
  if (hasReady) return null;

  const blockers = new Set<string>();
  for (const slot of pending) {
    for (const dep of blockedBy(slot, slots)) blockers.add(dep);
  }

  return {
    slotIds: pending.map((s) => s.slotId),
    blockedBy: [...blockers].sort(compareIds),
  };
}
