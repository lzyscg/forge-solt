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
