/**
 * 产物组装（文档 §6.3 / REQ FR-ASM-002 / D-16 / D-18 / AC-013）。
 *
 * 唯一的组装器是 `markdown_concat_v1`：深度优先前序遍历槽位树，把内容槽位的正文
 * 用空行连起来。全部逻辑是纯函数，输入只有槽位数组——因此 AC-013
 *「同一任务多次组装逐字节相同」由类型系统而非纪律保证。
 */

import type { Slot } from './types.ts';
import { sha256Hex } from './canonical.ts';
// 同级排序**必须**与 readiness 逐字一致，否则「产物顺序」与「生产顺序」会分叉。
// 曾经这里有一份自己的实现，两份的 slotId tiebreak 一个用码点序、一个用 UTF-16 码元序，
// 注释都写着「必须一致」却并不一致。现在直接复用同一个函数——
// 一致性不该靠两处各自的自觉来维持。
import { compareSiblings, documentOrder } from './readiness.ts';

/**
 * 归一化单个槽位的正文。
 *
 * `\r\n` 可能来自模型输出，不归一化会让同一份内容在不同次运行里产出不同字节，
 * checksum 随之漂移（AC-013）。孤立的 `\r` 同样处理——有的模型会吐出老式 Mac 行尾。
 */
function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * `markdown_concat_v1` 组装。
 *
 * 规则（文档 §6.3，顺序即语义）：
 * 1. 深度优先前序遍历，同级按 (sortOrder, slotId)
 * 2. `includeInArtifact === false` → **整棵子树跳过**（D-16 / D-18）
 * 3. `contentBearing === false` 的容器槽位自身不产出内容，继续下钻
 * 4. 其余槽位取 contentText
 * 5. 用 '\n\n' 连接
 * 6. 除行尾归一化与 trim 外不改动槽位内部格式
 * 7. 行尾统一 '\n'，末尾补一个 '\n'
 *
 * 第 2 步必须在第 3 步之前——顺序反了，子树语义就退化成「只跳自己」，
 * 一个标了 `includeInArtifact:false` 的 `working_notes` 容器会把它的孩子全漏进正文。
 *
 * **空产物不是本函数的责任（D-19）**：若所有槽位都被排除或都无正文，
 * 这里返回 `''`，不抛错。判断「一个空产物是否可以落库」需要任务上下文
 * （模板是否本来就允许全工作槽位、是否处于组装阶段），而这里只有 `Slot[]`。
 * M2 的 assembly-service 必须在写 artifact 前拒绝空产物并置任务为 failed；
 * 让本函数抛错等于把一个业务规则藏进纯函数里，还会顺带打死单元测试里的空输入用例。
 */
export function assembleMarkdownConcatV1(slots: readonly Slot[]): string {
  const byId = new Map<string, Slot>();
  // 重复 slotId 是脏数据（今天由 DUPLICATE_SLOT_ID 拦下），但两处索引策略必须一致：
  // **首个优先**，与 readiness.indexById 以及下面 visited 去重保留的那一个对齐。
  // 后写覆盖会让「祖先排除判定读到的槽位」和「正文取自的槽位」变成两个不同对象。
  for (const slot of slots) if (!byId.has(slot.slotId)) byId.set(slot.slotId, slot);

  const childrenOf = new Map<string | null, Slot[]>();
  for (const slot of slots) {
    const parentKey = slot.parentId !== null && byId.has(slot.parentId) ? slot.parentId : null;
    const bucket = childrenOf.get(parentKey);
    if (bucket === undefined) childrenOf.set(parentKey, [slot]);
    else bucket.push(slot);
  }
  for (const bucket of childrenOf.values()) bucket.sort(compareSiblings);

  const visited = new Set<string>();

  const collect = (slot: Slot): string[] => {
    if (visited.has(slot.slotId)) return [];
    visited.add(slot.slotId);

    // ① 子树整体跳过（必须先判，见上文）
    if (!slot.includeInArtifact) return [];
    // ② 容器槽位自身无正文，下钻
    if (!slot.contentBearing) {
      return (childrenOf.get(slot.slotId) ?? []).flatMap(collect);
    }
    // ③ 内容槽位取正文；内容槽位理论上是叶子，但结构上允许有子节点，一并下钻
    const own = slot.contentText === null ? [] : [normalizeContent(slot.contentText)];
    const below = (childrenOf.get(slot.slotId) ?? []).flatMap(collect);
    return [...own.filter((part) => part.length > 0), ...below];
  };

  const parts = (childrenOf.get(null) ?? []).flatMap(collect);
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n`;
}

/**
 * 产物校验和。`sha256:` 前缀是存储格式的一部分（文档 §6.3），
 * 让 artifact 表里的值自解释，未来换算法时旧值仍可辨识。
 */
export function computeArtifactChecksum(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

/**
 * 组装列表：按文档序列出**实际进入产物**的内容槽位 ID。
 * UI 的「组装顺序」区块用它——D-16 影响面第 7 条要求工作槽位不出现在该列表中。
 */
export function assemblyOrder(slots: readonly Slot[]): string[] {
  const included = new Set<string>();
  const byId = new Map<string, Slot>();
  // 重复 slotId 是脏数据（今天由 DUPLICATE_SLOT_ID 拦下），但两处索引策略必须一致：
  // **首个优先**，与 readiness.indexById 以及下面 visited 去重保留的那一个对齐。
  // 后写覆盖会让「祖先排除判定读到的槽位」和「正文取自的槽位」变成两个不同对象。
  for (const slot of slots) if (!byId.has(slot.slotId)) byId.set(slot.slotId, slot);

  for (const slot of documentOrder(slots)) {
    if (!slot.includeInArtifact) continue;
    // 祖先链上任一环节被排除，本节点就不在产物里（子树语义）
    let excludedByAncestor = false;
    let cursor: string | null = slot.parentId;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent: Slot | undefined = byId.get(cursor);
      if (parent === undefined) break;
      if (!parent.includeInArtifact) {
        excludedByAncestor = true;
        break;
      }
      cursor = parent.parentId;
    }
    if (excludedByAncestor) continue;
    if (slot.contentBearing) included.add(slot.slotId);
  }

  return documentOrder(slots)
    .filter((slot) => included.has(slot.slotId))
    .map((slot) => slot.slotId);
}
