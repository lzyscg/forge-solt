/**
 * Domain 层的实体类型。
 *
 * 这些是**进程内自己造、自己用**的类型，不跨边界，因此按文档 §3 澄清的判据
 * 用普通 TS 类型而非 Zod——它们永远不会从不可信输入被 parse 出来。
 * （跨边界的形状全在 `@shared/contracts.ts`，那边一律 Zod。）
 *
 * 与数据库行的关系：字段名是 camelCase 的领域名，Repository 负责与
 * `migrations/001_initial.sql` 的 snake_case 列互转。Domain 不认识 SQL。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type {
  ExecutionStatus,
  Operation,
  SlotStatus,
  TaskPhase,
  TaskStatus,
} from '@shared/contracts.ts';

/** 失败信息在三个实体上重复出现，抽出来避免三处各写各的 */
export interface FailureInfo {
  errorCode: ErrorCode | null;
  errorMessage: string | null;
}

export interface Task extends FailureInfo {
  id: string;
  name: string;
  snapshotId: string;
  /** 冻结的任务输入。键是模板的 inputFields[].id */
  input: Readonly<Record<string, string>>;
  status: TaskStatus;
  phase: TaskPhase;
  /** D-10：Token 校验的第二道判据。指向真实 execution 由库层延迟外键保证（D-18） */
  activeExecutionId: string | null;
  artifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Slot extends FailureInfo {
  taskId: string;
  /** 任务内唯一。注意不是全局 id——slots 的主键是 (taskId, slotId) */
  slotId: string;
  /** 槽位类型 id，对应快照里的 SlotTypeDefinition.id */
  type: string;
  parentId: string | null;
  sortOrder: number;
  instruction: string;
  dependsOn: readonly string[];
  /** false = 容器槽位：没有 Assignment，不产出内容，UI 不得为它伪造 Producer */
  contentBearing: boolean;
  /**
   * D-16 / D-18：false = 以该槽位为根的**整棵子树**不进入产物。
   * 对叶子内容槽位等价于「本节点不进正文」（工作槽位）；
   * 对容器槽位可一次性排除整节工作区。默认 true。
   */
  includeInArtifact: boolean;
  status: SlotStatus;
  /** 审核返修轮次，从 0 起（003_review.sql 新增列 revision_round） */
  revisionRound: number;
  /** 返修预算耗尽后按现状完成（003_review.sql 新增列 review_exhausted） */
  reviewExhausted: boolean;
  contentText: string | null;
  producer: SlotProducer | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * AC-009 要求「完成的内容槽必须同时具备 content 与 producer」。
 * 把四个字段捆成一个可空对象，而不是四个各自可空的字段——
 * 类型系统因此拒绝表达「有 agentId 但没有 skillId」这种半截状态。
 */
export interface SlotProducer {
  agentId: string;
  skillId: string;
  skillVersion: string;
  executionId: string;
}

export interface Execution extends FailureInfo {
  id: string;
  taskId: string;
  operation: Operation;
  /** create_structure 时为 null——目标是整棵结构，不是某个槽位 */
  targetSlotId: string | null;
  agentId: string;
  skillId: string;
  skillVersion: string;
  /** 只存 hash，明文 Token 从不落库（§8.1） */
  tokenHash: string;
  /** D-12：结构化输入的 hash，与 promptHash 分离 */
  contextHash: string;
  /** D-12：渲染后文本的 hash */
  promptHash: string;
  /** D-03：冻结的别名。历史任务据此可知它当时用的是哪个别名而非哪个模型 */
  modelAlias: string;
  /** D-03：解析后的实际取值，晚绑定的结果 */
  provider: string;
  model: string;
  attemptNumber: number;
  status: ExecutionStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
