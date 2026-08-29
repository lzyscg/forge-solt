/**
 * 工具闭包捕获的上下文（§7.5 / TECH-V0.1 §13）。
 *
 * **权限在闭包里冻结**是这一层的全部要点：`allowedDependencySlotIds` 在
 * Assignment 创建时就定死，工具 handler 只做集合判断，不看模型传的参数「合不合理」。
 * 任何「按需放宽」的写法（比如 slot 已完成就允许读）都会让依赖声明失去意义——
 * 依赖声明既是调度依据，也是上下文边界（REQ FR-CTX-003）。
 */

import type { Operation } from '@shared/contracts.ts';
import type { CompletionPort, SkillSnapshotView, StructurePort } from '../ports.ts';
import type { SubmissionGate } from '../submission-gate.ts';
import type { TraceWriter } from '../trace-writer.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import type { ErrorCode } from '@shared/errors.ts';

/** 提交被拒的记录。由 AssignmentRunner 收集，用于下一次 attempt 的 D-13 反馈块 */
export interface SubmissionRejection {
  code: ErrorCode;
  message: string;
  violations: readonly StructureViolation[];
}

export interface ToolsetContext {
  readonly taskId: string;
  readonly executionId: string;
  /** 明文 Token（§8.1）。只透传给 CompletionPort，绝不进 trace / 工具结果 */
  readonly executionToken: string;
  readonly operation: Operation;
  /** create_structure 时为 null */
  readonly targetSlotId: string | null;
  /** 白名单：`read_slot` 只认它 */
  readonly allowedDependencySlotIds: readonly string[];
  /**
   * R6 / D-61：返修轮里「上一稿」的正文，编辑清单就是对着它做的。
   *
   * 首稿为 null，此时 `kind: 'slot_edits'` 不可用——没有上一稿可引。
   * 取的是 `slots.content_text`：`markForRevision` 刻意不碰正文，
   * 所以返修轮开始时它仍然是上一稿那份字节。
   *
   * `degraded` 为 true 时表示系统已经降级（D-65）：本轮**允许**整篇提交。
   * 由系统按尝试次数决定，不由模型自己选——实测里模型一次都没主动走过退路，
   * 两次失败都是硬撞（非法 JSON、输出到长度上限也不提交）。
   */
  readonly revisionBase: { readonly round: number; readonly content: string; readonly degraded: boolean } | null;
  readonly skill: SkillSnapshotView;
  readonly taskInput: Readonly<Record<string, string>>;
  readonly gate: SubmissionGate;
  readonly trace: TraceWriter;
  readonly completion: CompletionPort;
  readonly structure: StructurePort;
  /** 提交成功后调用：关闸门 + abort（D-11） */
  readonly onSubmitted: () => void;
  /** 提交被拒时调用。**不影响工具循环**，只是把违规攒起来给下一次 attempt 用 */
  readonly onRejected: (rejection: SubmissionRejection) => void;
}
