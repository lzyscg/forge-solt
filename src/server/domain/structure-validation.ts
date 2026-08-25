/**
 * 结构确定性校验（文档 §6.1 / REQ FR-STR-004 / D-13）。
 *
 * 这一层回答一个问题：Structure Agent 提交的这棵树，能不能变成可调度的槽位集合。
 * 19 条规则全部是确定性判断——不做任何语义质量审核（REQ §7 已把 Slot Review 列入非目标）。
 *
 * 三条纪律：
 *
 * 1. **零 IO、零随机、零时钟。** 本文件不允许出现 `Date.now()` / `Math.random()` /
 *    `crypto.randomUUID()`。同一份 proposal + 同一份 template 必须产出逐字节相同的
 *    违规列表（REQ NFR-006 确定性要求；否则 D-13 的「首次通过率」根本没法测）。
 * 2. **一次返回全部违规，不短路**（D-13）。只报第一条会让 Agent 陷入
 *    「改一条冒出下一条」的循环，白白消耗 `maxExecutionRetries`（默认 2，总共只有 3 次机会）。
 * 3. **校验分三阶段执行，顺序不可调换**（§6.1「校验顺序要求」）：
 *
 *        引用完整性 (3/4/5/6/19/7/10/11/14/15)
 *          ↓  只有引用都能解析，图算法才有意义
 *        图性质    (8/16/9)
 *          ↓
 *        语义完备  (12/13/17/18)
 *
 *    悬空的 parentId 会让父子环检测把「断链」误判成环，悬空的 dependsOn 同理。
 *    因此图性质阶段受前一阶段的结果**闸门控制**：引用不干净就不跑，宁可让 Agent
 *    先修引用、下一轮再看图——报一个不存在的环比不报更糟。
 *
 * `agentHint` 的书写标准（D-13，review 时逐条对照）：
 *   ❌「依赖关系不合法」        —— 不可执行
 *   ❌「请修正 dependsOn」      —— 没说怎么改
 *   ✅「slot「scene_2」的 dependsOn 引用了「chapter」，但 chapter 是容器槽位。
 *      dependsOn 只能引用 contentBearing 为 true 的槽位。请改为引用具体的内容槽位，
 *      或删除该依赖。」
 * 判据：模型照着 hint 改，不需要再猜，就能改对。每新增一条规则都要过这一关。
 */

import type { SlotProposal } from '@shared/tools.ts';

/**
 * 规则 ID。机器可读，用于统计（D-13 的首次通过率按 rule 分组）与测试断言。
 *
 * 注意只有 18 个取值却有 19 条规则：第 19 条（rootSlotId 一致性）复用 `NO_ROOT`——
 * 它和第 6 条说的是同一件事的两面（「没有根」与「声明的根不是根」），
 * 对 Agent 而言修复动作也相同，拆成两个码只会让 hint 变得难写。
 */
export type StructureRuleId =
  | 'EMPTY_STRUCTURE'
  | 'TOO_MANY_SLOTS'
  | 'DUPLICATE_SLOT_ID'
  | 'INVALID_SLOT_ID'
  | 'NO_ROOT'
  | 'MULTIPLE_ROOTS'
  | 'ROOT_MUST_BE_CONTAINER'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_CYCLE'
  | 'DEPTH_EXCEEDED'
  | 'DUPLICATE_ORDER'
  | 'UNKNOWN_SLOT_TYPE'
  | 'MISSING_INSTRUCTION'
  | 'DEPENDENCY_NOT_FOUND'
  | 'SELF_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'DEPENDENCY_ON_CONTAINER'
  | 'NO_CONTENT_SLOT';

/**
 * 三段式违规（D-13）。
 *
 * 用普通 TS interface 而不是 Zod：它不跨进程边界——由本层构造、由 Runtime 消费后
 * 渲染成重试 User Message 的追加块（§7.4），永远不会从不可信输入被 parse 出来。
 * 判据见文档 §3「什么该用 Zod」的表。
 */
export interface StructureViolation {
  /** 机器可读，用于统计与测试断言 */
  rule: StructureRuleId;
  /** 给人看：出现在 trace 与 UI 上 */
  message: string;
  /** 给 Agent 看：可执行的修复指令（D-13） */
  agentHint: string;
  /** 涉及的槽位，便于 UI 高亮；无法定位到具体槽位时为空数组 */
  slotIds: string[];
}

/**
 * 校验通过后的规范化槽位——可直接交给 Repository 落库（FR-STR-005 的原子提交）。
 *
 * 与 `SlotProposal` 的差别正是本层补上的三件事：
 * - `contentBearing` / `includeInArtifact`：从模板的槽位类型定义解析而来，Agent 无权声明
 * - `depth`：遍历树算出来的，省得每个消费方各算一遍
 * - 顺序：文档序（深度优先前序，同级按 `(order, id)`），与 `readiness.documentOrder` 同序
 */
export interface ValidatedSlot {
  slotId: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  instruction: string;
  dependsOn: readonly string[];
  contentBearing: boolean;
  /** D-16 / D-18：以该槽位为根的整棵子树是否进入产物。模板未声明时为 true */
  includeInArtifact: boolean;
  /**
   * **0 基**：根槽位 depth = 0。
   *
   * 文档 §6.1 第 9 条的 hint 文案说的是「处于第 5 层，上限 4 层」——那是 1 基的
   * 人类说法。两者差一是刻意的：`SlotViewSchema.depth` 被前端直接用于
   * `depth × 20px` 缩进，根必须是 0；而报错文案面向人，从第 1 层数起更自然。
   * 因此判据是 `depth + 1 > maxStructureDepth`。
   */
  depth: number;
}

export type StructureValidationResult =
  | { ok: true; slots: ValidatedSlot[] }
  | { ok: false; violations: StructureViolation[] };

/**
 * 本层需要的槽位类型信息。
 *
 * 刻意只声明用得上的字段而不 import `CompiledTemplate`：一来那个类型属于模板编译层
 * （M1 的交付物），二来结构化类型让真正的 `CompiledTemplate` 天然可传入。
 * Domain 层不应该为了拿两个布尔值把整个模板编译产物拖进依赖图。
 */
export interface StructureSlotTypeSpec {
  id: string;
  contentBearing: boolean;
  /** D-16：默认 true。容器类型上同样有意义（标 false 可一次性排除整节工作区） */
  includeInArtifact?: boolean;
}

/** 结构限制，对应 `template.yaml` 的 `limits`（§4.1） */
export interface StructureLimits {
  maxSlots: number;
  maxStructureDepth: number;
}

/** `CompiledTemplate` 中与结构校验相关的子集 */
export interface StructureValidationTemplate {
  slotTypes: readonly StructureSlotTypeSpec[];
  limits: StructureLimits;
}

export interface StructureProposal {
  rootSlotId: string;
  slots: readonly SlotProposal[];
}

/** 与 `SlotProposalSchema` 同源（§3.4）。这里是第二道网，不是唯一一道 */
const SLOT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 引号统一用直角引号，与 D-13 的示例文案一致 */
const q = (s: string): string => `「${s}」`;

const listIds = (ids: readonly string[]): string => ids.map(q).join('、');

/**
 * 环的展示：`「a」→「b」→「a」`，末尾重复首元素才看得出它是个环。
 * 用 `slice(0, 1)` 而不是 `ids[0] ?? ''` 取首元素——后者在
 * `noUncheckedIndexedAccess` 下需要一个兜底值，而调用方给的环恒非空，
 * 那个兜底既跑不到也测不到。
 */
const chain = (ids: readonly string[]): string => [...ids, ...ids.slice(0, 1)].map(q).join('→');

/**
 * 校验 Structure Agent 提交的具体结构。
 *
 * 失败时返回**全部**违规；成功时返回可直接落库的规范化槽位（文档序）。
 * 纯函数：不读时钟、不读随机源、不做 IO。
 */
export function validateConcreteStructure(
  proposal: StructureProposal,
  template: StructureValidationTemplate,
): StructureValidationResult {
  const violations: StructureViolation[] = [];
  const slots = proposal.slots;

  // ---------- 规则 1：结构非空 ----------
  // 这是唯一一处允许提前返回的地方：0 个槽位时其余 18 条规则全部无话可说，
  // 继续跑只会产出「没有根槽位」「没有内容槽位」这类同义反复的噪音。
  if (slots.length === 0) {
    violations.push({
      rule: 'EMPTY_STRUCTURE',
      message: '结构提案不包含任何槽位。',
      agentHint:
        '本次提交的 slots 数组为空。结构中至少需要一个根容器槽位和一个内容槽位：' +
        '先创建一个 parentId 为 null 的容器槽位作为根，再在其下创建至少一个内容槽位。',
      slotIds: [],
    });
    return { ok: false, violations };
  }

  // ---------- 规则 2：不超过槽位数上限 ----------
  const maxSlots = template.limits.maxSlots;
  if (slots.length > maxSlots) {
    violations.push({
      rule: 'TOO_MANY_SLOTS',
      message: `结构包含 ${slots.length} 个槽位，超过模板上限 ${maxSlots}。`,
      agentHint:
        `当前提交 ${slots.length} 个槽位，上限 ${maxSlots}。请合并粒度过细的槽位` +
        `（例如把连续的短场景合并为一个场景槽位），把总数降到 ${maxSlots} 个以内后重新提交。`,
      slotIds: [],
    });
  }

  // 后续所有查表都用「首次出现」的那个槽位。重复 ID 由规则 3 单独报，
  // 这里不能让后来者覆盖前者——否则同一个错误会在多条规则里表现成不同的现象。
  const byId = new Map<string, SlotProposal>();
  for (const slot of slots) {
    if (!byId.has(slot.id)) byId.set(slot.id, slot);
  }

  const typeById = new Map<string, StructureSlotTypeSpec>();
  for (const type of template.slotTypes) {
    if (!typeById.has(type.id)) typeById.set(type.id, type);
  }
  const allowedTypeIds = template.slotTypes.map((t) => t.id);

  // ================= 阶段 A：引用完整性 =================
  // 规则 3 / 4 / 5 / 6 / 19 / 7 / 10 / 11 / 14 / 15

  // ---------- 规则 3：ID 唯一 ----------
  const idCounts = new Map<string, number>();
  for (const slot of slots) idCounts.set(slot.id, (idCounts.get(slot.id) ?? 0) + 1);
  const duplicateIds: string[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) duplicateIds.push(id);
  }
  duplicateIds.sort();
  for (const id of duplicateIds) {
    // 直接数一遍，而不是回查 `idCounts.get(id) ?? 0`：id 正是从 idCounts 的键里来的，
    // 那个 `?? 0` 永远不会命中，是个既测不到又没有保护作用的兜底。
    // 这条路径只在结构已经出错时走，重数一遍的代价可以忽略。
    const count = slots.filter((s) => s.id === id).length;
    violations.push({
      rule: 'DUPLICATE_SLOT_ID',
      message: `槽位 ID ${q(id)} 出现了 ${count} 次。`,
      agentHint:
        `槽位 ID ${q(id)} 出现了 ${count} 次。每个槽位需要唯一 ID。` +
        `请为重复的槽位改用不同 ID（例如 ${id}_2），并同步更新所有引用它的 parentId 与 dependsOn。`,
      slotIds: [id],
    });
  }

  // ---------- 规则 4：ID 安全字符 ----------
  // 正常路径上由 `SlotProposalSchema` 在解析层拦截（§3.4），走不到这里。
  // 保留实现是因为本函数也被 Repository 恢复路径与测试夹具直接调用——
  // 那两条路径不过 Zod，少这道网就等于把非法 ID 写进主键。
  const invalidIds = slots.filter((s) => !SLOT_ID_PATTERN.test(s.id)).map((s) => s.id);
  for (const id of unique(invalidIds)) {
    violations.push({
      rule: 'INVALID_SLOT_ID',
      message: `槽位 ID ${q(id)} 含有不允许的字符。`,
      agentHint:
        `槽位 ID ${q(id)} 不合法。Slot ID 只能包含小写字母、数字和下划线，` +
        '必须以小写字母开头，最长 64 字符。请改用形如 scene_01 的 ID。',
      slotIds: [id],
    });
  }

  // ---------- 规则 5 / 6：有且只有一个根 ----------
  const rootSlots = slots.filter((s) => s.parentId === null);
  const rootIds = unique(rootSlots.map((s) => s.id));
  if (rootSlots.length === 0) {
    violations.push({
      rule: 'NO_ROOT',
      message: '所有槽位都声明了 parentId，结构缺少根槽位。',
      agentHint:
        '所有槽位都有 parentId，缺少根槽位。请将最外层容器槽位的 parentId 设为 null，' +
        '并保证 rootSlotId 指向它。',
      slotIds: [],
    });
  } else if (rootIds.length > 1) {
    violations.push({
      rule: 'MULTIPLE_ROOTS',
      message: `${listIds(rootIds)} 的 parentId 都是 null，存在 ${rootIds.length} 个根槽位。`,
      agentHint:
        `${listIds(rootIds)} 的 parentId 都是 null。只能有一个根槽位：` +
        `请保留 ${q(proposal.rootSlotId)} 作为根，把其余槽位的 parentId 改为挂到根之下（或其某个子容器之下）。`,
      slotIds: rootIds,
    });
  }

  // ---------- 规则 19：rootSlotId 与 slots 一致（本文档新增） ----------
  // 与规则 6 复用 NO_ROOT，但说的是另一件事：这里检查的是「声明」与「事实」是否对得上。
  // 两条可能同时触发（一棵全都有 parent 的树 + 一个指向内部节点的 rootSlotId），
  // 那确实是两个独立的错误，各报一条比合并成一条更容易修。
  const declaredRoot = byId.get(proposal.rootSlotId);
  if (declaredRoot === undefined) {
    violations.push({
      rule: 'NO_ROOT',
      message: `声明的 rootSlotId ${q(proposal.rootSlotId)} 在 slots 中不存在。`,
      agentHint:
        `声明的 rootSlotId ${q(proposal.rootSlotId)} 在 slots 中不存在。` +
        'rootSlotId 必须等于某个 parentId 为 null 的槽位的 id。请改为该槽位的 id，或补上这个根槽位。',
      slotIds: [proposal.rootSlotId],
    });
  } else if (declaredRoot.parentId !== null) {
    violations.push({
      rule: 'NO_ROOT',
      message: `声明的 rootSlotId ${q(proposal.rootSlotId)} 的 parentId 是 ${q(declaredRoot.parentId)}，不是 null。`,
      agentHint:
        `rootSlotId 指向的槽位 ${q(proposal.rootSlotId)} 自己还有 parentId ` +
        `${q(declaredRoot.parentId)}，它不是根。请把它的 parentId 改为 null，` +
        '或把 rootSlotId 改为真正的最外层容器槽位 id。',
      slotIds: [proposal.rootSlotId],
    });
  }

  // ---------- 规则 7：parent 必须存在 ----------
  const danglingParents: string[] = [];
  for (const slot of slots) {
    const parentId = slot.parentId;
    if (parentId === null || byId.has(parentId)) continue;
    danglingParents.push(slot.id);
    violations.push({
      rule: 'PARENT_NOT_FOUND',
      message: `槽位 ${q(slot.id)} 的 parentId ${q(parentId)} 不存在。`,
      agentHint:
        `槽位 ${q(slot.id)} 的 parentId ${q(parentId)} 不在本次提交的 slots 中。` +
        `请把它改为已声明的槽位 ID（当前可用：${listIds(sortedIds(byId))}），` +
        '或补充声明该父槽位。',
      slotIds: [slot.id],
    });
  }

  // ---------- 规则 10：同级 order 唯一 ----------
  // 分组键用 parentId，null 归入「根层级」。多根时也会在根层级上比较——
  // 这不是误报：多根本身已由规则 5 报出，order 冲突是它的独立后果。
  interface OrderGroup {
    parentId: string | null;
    order: number;
    memberIds: string[];
  }
  const orderGroups = new Map<string, OrderGroup>();
  for (const slot of slots) {
    // 键用 JSON 而不是字符串拼接：parentId 悬空时是模型编的任意字符串，
    // 拼进 key 再 split 回来是自找解析歧义。键只负责去重，展示字段单独存。
    const key = JSON.stringify([slot.parentId, slot.order]);
    const group = orderGroups.get(key);
    if (group === undefined) {
      orderGroups.set(key, { parentId: slot.parentId, order: slot.order, memberIds: [slot.id] });
    } else {
      group.memberIds.push(slot.id);
    }
  }
  for (const key of [...orderGroups.keys()].sort()) {
    const group = orderGroups.get(key);
    if (group === undefined || group.memberIds.length < 2) continue;
    const members = group.memberIds;
    const parentLabel = group.parentId === null ? q('根层级') : q(group.parentId);
    const order = String(group.order);
    violations.push({
      rule: 'DUPLICATE_ORDER',
      message: `${parentLabel} 下的 ${listIds(members)} 的 order 都是 ${order}。`,
      agentHint:
        `${parentLabel} 下的 ${listIds(members)} 的 order 都是 ${order}。` +
        '同一父节点下 order 必须唯一。请按你希望的阅读顺序给这些槽位分配互不相同的 order（如 0、1、2）。',
      slotIds: [...members],
    });
  }

  // ---------- 规则 11：类型在模板允许范围内 ----------
  const unknownTypeSlots: string[] = [];
  for (const slot of slots) {
    if (typeById.has(slot.type)) continue;
    unknownTypeSlots.push(slot.id);
    violations.push({
      rule: 'UNKNOWN_SLOT_TYPE',
      message: `槽位 ${q(slot.id)} 的 type ${q(slot.type)} 不在模板允许范围。`,
      agentHint:
        `槽位 ${q(slot.id)} 的 type ${q(slot.type)} 不在模板允许范围。` +
        `可用类型：${allowedTypeIds.join(', ')}。请从中选择语义最接近的一个填入 type。`,
      slotIds: [slot.id],
    });
  }

  // ---------- 规则 14 / 15：dependsOn 引用完整性 ----------
  let hasDependencyIntegrityIssue = false;
  for (const slot of slots) {
    for (const dep of unique(slot.dependsOn)) {
      if (dep === slot.id) {
        hasDependencyIntegrityIssue = true;
        violations.push({
          rule: 'SELF_DEPENDENCY',
          message: `槽位 ${q(slot.id)} 的 dependsOn 包含自己。`,
          agentHint:
            `槽位 ${q(slot.id)} 的 dependsOn 包含它自己。请从该数组中移除 ${q(slot.id)}；` +
            '槽位只应依赖它需要先读到内容的**其他**槽位。',
          slotIds: [slot.id],
        });
        continue;
      }
      if (byId.has(dep)) continue;
      hasDependencyIntegrityIssue = true;
      violations.push({
        rule: 'DEPENDENCY_NOT_FOUND',
        message: `槽位 ${q(slot.id)} 依赖 ${q(dep)}，但该槽位不存在。`,
        agentHint:
          `槽位 ${q(slot.id)} 的 dependsOn 引用了 ${q(dep)}，但本次提交中没有这个槽位。` +
          `请把它改为已声明的槽位 ID（当前可用：${listIds(sortedIds(byId))}），或删除该依赖。`,
        slotIds: [slot.id],
      });
    }
  }

  // ================= 阶段 B：图性质 =================
  // 规则 8 / 16 / 9。两道闸门分别控制父子图与依赖图——
  // 引用没解析干净就跳过对应的图算法，避免把「断链」误报成「环」。
  const parentGraphUsable =
    duplicateIds.length === 0 && danglingParents.length === 0 && rootIds.length === 1;

  let parentCycleFound = false;

  if (parentGraphUsable) {
    // ---------- 规则 8：父子关系无环 ----------
    for (const cycle of findParentCycles(slots, byId)) {
      parentCycleFound = true;
      violations.push({
        rule: 'PARENT_CYCLE',
        message: `槽位 ${chain(cycle)} 形成父子环。`,
        agentHint:
          `槽位 ${chain(cycle)} 的 parentId 互相指向，形成了父子环。父子关系必须是一棵树。` +
          `请打断这个环：把其中一个槽位的 parentId 改为 ${q(proposal.rootSlotId)} 或其他不在环内的容器槽位。`,
        slotIds: [...cycle].sort(),
      });
    }
  }

  if (duplicateIds.length === 0 && !hasDependencyIntegrityIssue) {
    // ---------- 规则 16：依赖图无环 ----------
    for (const cycle of findDependencyCycles(slots, byId)) {
      violations.push({
        rule: 'DEPENDENCY_CYCLE',
        message: `${chain(cycle)} 形成依赖环。`,
        agentHint:
          `${chain(cycle)} 形成依赖环。依赖必须是有向无环图，否则没有任何槽位能先开始。` +
          // 环恒非空，但 `noUncheckedIndexedAccess` 不知道；用 slice 取首尾，
          // 免得写一对永远不会命中的 `?? ''` 兜底。
          `请删除其中一条依赖——通常应删除 ${q(cycle.slice(-1).join(''))} 对 ${q(cycle.slice(0, 1).join(''))} 的依赖，` +
          '让内容按前后顺序单向流动。',
        slotIds: [...cycle].sort(),
      });
    }
  }

  // ---------- 规则 9：深度不超上限 ----------
  // 依赖父子图无环：在环上算深度会走不出去。
  if (parentGraphUsable && !parentCycleFound) {
    const maxDepth = template.limits.maxStructureDepth;
    // 一趟算完并顺手记下层数。写成「先把深度填进 Map、再回查」的话，
    // 回查处要写两个 `?? 0` 兜底，而 Map 刚被填满，那两个兜底永远不会命中。
    const tooDeep: { id: string; level: number }[] = [];
    for (const slot of slots) {
      const level = depthOf(slot, byId) + 1;
      if (level > maxDepth) tooDeep.push({ id: slot.id, level });
    }
    for (const { id, level } of tooDeep) {
      violations.push({
        rule: 'DEPTH_EXCEEDED',
        message: `槽位 ${q(id)} 处于第 ${level} 层，超过模板上限 ${maxDepth} 层。`,
        agentHint:
          `槽位 ${q(id)} 处于第 ${level} 层，上限 ${maxDepth} 层（根槽位算第 1 层）。` +
          `请压平层级：把 ${q(id)} 的 parentId 改为更靠上的容器槽位，或去掉中间那层容器。`,
        slotIds: [id],
      });
    }
  }

  // ================= 阶段 C：语义完备 =================
  // 规则 12 / 13 / 17 / 18。每条都对「类型未知」做了保护——
  // 类型解析不出来时由规则 11 负责报，这里不能拿 undefined 去猜 contentBearing。

  // ---------- 规则 12：根必须是容器类型 ----------
  // 根的判定优先用「事实上的根」（唯一一个 parentId=null 的槽位），
  // 没有事实根时退回「声明的根」——这样即使 rootSlotId 写错，也仍能给出类型层面的反馈。
  // `rootIds.length === 1` 时 `rootIds[0]` 必然存在，但 `noUncheckedIndexedAccess`
  // 不认这个推理。先取值、再判 undefined，而不是写 `rootIds[0] ?? ''`——
  // 用空串去查表是个永远查不到、也永远测不到的分支。
  const soleRootId = rootIds.length === 1 ? rootIds[0] : undefined;
  const rootForTypeCheck = soleRootId === undefined ? declaredRoot : byId.get(soleRootId);
  if (rootForTypeCheck !== undefined) {
    const rootType = typeById.get(rootForTypeCheck.type);
    if (rootType !== undefined && rootType.contentBearing) {
      const containerTypeIds = template.slotTypes.filter((t) => !t.contentBearing).map((t) => t.id);
      violations.push({
        rule: 'ROOT_MUST_BE_CONTAINER',
        message: `根槽位 ${q(rootForTypeCheck.id)} 的类型 ${q(rootForTypeCheck.type)} 是内容承载类型。`,
        agentHint:
          `根槽位 ${q(rootForTypeCheck.id)} 的类型 ${q(rootForTypeCheck.type)} 是内容承载类型，` +
          '根槽位必须使用容器类型。' +
          (containerTypeIds.length > 0
            ? `请把根改用容器类型（可用：${containerTypeIds.join(', ')}），并把原来的内容槽位挂到这个新的根之下。`
            : '模板未声明任何容器类型，请联系模板作者补充。'),
        slotIds: [rootForTypeCheck.id],
      });
    }
  }

  // ---------- 规则 13：内容槽位必须有非空 instruction ----------
  for (const slot of slots) {
    const type = typeById.get(slot.type);
    if (type === undefined || !type.contentBearing) continue;
    if (slot.instruction.trim() !== '') continue;
    violations.push({
      rule: 'MISSING_INSTRUCTION',
      message: `槽位 ${q(slot.id)} 缺少 instruction。`,
      agentHint:
        `槽位 ${q(slot.id)} 的 instruction 为空。每个内容槽位都需要说明本槽位要完成什么：` +
        '请写一到两句话，点明这个槽位要写的内容目标（写什么、推进到什么状态），' +
        '写作 Agent 只能看到这句话，看不到你的思考过程。',
      slotIds: [slot.id],
    });
  }

  // ---------- 规则 17：dependsOn 只能引用内容承载槽位 ----------
  for (const slot of slots) {
    for (const dep of unique(slot.dependsOn)) {
      if (dep === slot.id) continue;
      const depSlot = byId.get(dep);
      if (depSlot === undefined) continue; // 规则 14 已报
      const depType = typeById.get(depSlot.type);
      if (depType === undefined || depType.contentBearing) continue; // 规则 11 已报 / 合法
      violations.push({
        rule: 'DEPENDENCY_ON_CONTAINER',
        message: `槽位 ${q(slot.id)} 依赖 ${q(dep)}，但 ${dep} 是容器槽位。`,
        agentHint:
          `槽位 ${q(slot.id)} 的 dependsOn 引用了 ${q(dep)}，但 ${dep} 是容器槽位（类型 ${q(depSlot.type)}，` +
          'contentBearing 为 false）。容器不产出内容，依赖它永远等不到东西。' +
          'dependsOn 只能引用 contentBearing 为 true 的槽位。' +
          `请改为引用 ${dep} 之下具体的内容槽位，或删除该依赖。`,
        slotIds: [slot.id, dep],
      });
    }
  }

  // ---------- 规则 18：至少一个内容槽位 ----------
  const contentSlots = slots.filter((s) => typeById.get(s.type)?.contentBearing === true);
  if (contentSlots.length === 0) {
    const contentTypeIds = template.slotTypes.filter((t) => t.contentBearing).map((t) => t.id);
    violations.push({
      rule: 'NO_CONTENT_SLOT',
      message: '结构中没有任何内容承载槽位，无法产出正文。',
      agentHint:
        '结构中全部是容器槽位，没有任何内容槽位，无法产出正文。' +
        (contentTypeIds.length > 0
          ? `请至少添加一个内容类型的槽位（可用：${contentTypeIds.join(', ')}），挂在容器之下，并为它写好 instruction。`
          : '模板未声明任何内容类型，请联系模板作者补充。'),
      slotIds: [],
    });
  }

  if (violations.length > 0) return { ok: false, violations };

  // ---------- 通过：产出规范化槽位 ----------
  return { ok: true, slots: toValidatedSlots(slots, typeById) };
}

// ---------------------------------------------------------------- 内部工具

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sortedIds(byId: ReadonlyMap<string, SlotProposal>): string[] {
  return [...byId.keys()].sort();
}

/** 0 基深度。调用前必须确认父子图无环且无悬空 parentId */
function depthOf(slot: SlotProposal, byId: ReadonlyMap<string, SlotProposal>): number {
  let depth = 0;
  let cursor: SlotProposal | undefined = slot;
  // 上界保护：即便调用方漏了闸门，也不会变成死循环
  while (cursor !== undefined && cursor.parentId !== null && depth <= byId.size) {
    cursor = byId.get(cursor.parentId);
    depth += 1;
  }
  return depth;
}

/**
 * 父子图找环。每个节点只有一条出边（parentId），因此沿链上行即可，
 * 无需完整 DFS。返回的每个环按发现顺序给出成员链。
 */
function findParentCycles(
  slots: readonly SlotProposal[],
  byId: ReadonlyMap<string, SlotProposal>,
): string[][] {
  const settled = new Set<string>();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  for (const start of slots) {
    if (settled.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = start.id;

    while (cursor !== undefined) {
      if (settled.has(cursor)) break;
      if (onPath.has(cursor)) {
        const from = path.indexOf(cursor);
        const cycle = path.slice(from);
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
        break;
      }
      path.push(cursor);
      onPath.add(cursor);
      const node: SlotProposal | undefined = byId.get(cursor);
      const parentId = node?.parentId ?? null;
      cursor = parentId === null ? undefined : parentId;
    }

    for (const id of path) settled.add(id);
  }

  return cycles;
}

/**
 * 依赖图找环。多出边，用带路径栈的 DFS。
 * 起点按 ID 字典序遍历，保证同一份输入永远报出同一个环（确定性要求）。
 */
function findDependencyCycles(
  slots: readonly SlotProposal[],
  byId: ReadonlyMap<string, SlotProposal>,
): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, GREY);
    stack.push(id);
    const node = byId.get(id);
    /* v8 ignore next -- id 取自 slots 自身，byId 必然命中，`[]` 那支不可达（仅为类型收窄） */
    const deps = node === undefined ? [] : unique(node.dependsOn);
    // 「自依赖」与「悬空依赖」在进入本函数前就被规则 15 / 14 拦下了（调用点有闸门），
    // 所以这里用 filter 表达「哪些边是真边」，而不是在循环体里写一个永远不会
    // 命中的 `continue`——那种守卫既跑不到，也会让人误以为本函数能独立处理脏引用。
    for (const dep of deps.filter((d) => d !== id && byId.has(d))) {
      const depColor = color.get(dep) ?? WHITE;
      if (depColor === WHITE) {
        visit(dep);
      } else if (depColor === GREY) {
        const from = stack.indexOf(dep);
        const cycle = stack.slice(from);
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of unique(slots.map((s) => s.id)).sort()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }

  return cycles;
}

/**
 * 规范化 + 排序。顺序与 `readiness.documentOrder` 严格一致
 * （深度优先前序，同级按 `(order, id)`）——两处不一致会让「组装顺序」
 * 与「调度顺序」悄悄分叉，那种 bug 只有在产物读起来不对劲时才会被发现。
 */
function toValidatedSlots(
  slots: readonly SlotProposal[],
  typeById: ReadonlyMap<string, StructureSlotTypeSpec>,
): ValidatedSlot[] {
  const childrenOf = new Map<string | null, SlotProposal[]>();
  for (const slot of slots) {
    const bucket = childrenOf.get(slot.parentId);
    if (bucket === undefined) childrenOf.set(slot.parentId, [slot]);
    else bucket.push(slot);
  }
  for (const bucket of childrenOf.values()) {
    // 只按 order 排：走到这里说明规则 10 已通过，同一父节点下的 order 互不相同，
    // 再写一个 `a.id` tiebreaker 就是一段永远不会执行的代码。
    // `Array.prototype.sort` 自 ES2019 起稳定，因此同一份输入的结果依旧唯一确定，
    // 与 `readiness.documentOrder` 的 (order, id) 顺序在此前提下等价。
    // 显式不用 `localeCompare`——它受 ICU 版本与语言环境影响，不确定。
    bucket.sort((a, b) => a.order - b.order);
  }

  const out: ValidatedSlot[] = [];
  // 从「null 这个虚拟父节点」统一下钻：根和非根走同一段代码，depth 直接就是递归层数
  // （根 = 0），不必再从外面传一份算好的深度表进来，也就不必写
  // `depthById.get(id) ?? depthOf(...)` 那种查不空的兜底。
  const walk = (parentId: string | null, depth: number): void => {
    for (const slot of childrenOf.get(parentId) ?? []) {
      const type = typeById.get(slot.type);
      out.push({
        slotId: slot.id,
        type: slot.type,
        parentId: slot.parentId,
        sortOrder: slot.order,
        instruction: slot.instruction,
        dependsOn: unique(slot.dependsOn),
        // 规则 11 已保证 type 能解析；`=== true` 只是把可选链的 undefined 收成 boolean，
        // 与规则 18 里判定内容槽位的写法保持一致
        contentBearing: type?.contentBearing === true,
        includeInArtifact: type?.includeInArtifact ?? true,
        depth,
      });
      walk(slot.id, depth + 1);
    }
  };

  walk(null, 0);
  return out;
}
