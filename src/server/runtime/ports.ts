/**
 * Runtime 层向外声明的端口（依赖倒置）。
 *
 * **为什么 runtime 自己声明这些接口，而不是 import `application/` 的 service**：
 * §7.1 的时序里 Runtime 位于 `AssignmentService` 之下、`CompletionService` 之上，
 * 两个方向都指向 application。若直接 import，`runtime` 与 `application` 会互相引用，
 * 结果是「跑一次工具循环」必须把整个数据库层拖起来——集成测试因此只能用真库，
 * 而 §11.1 明确要求 Runtime 集成测试「无网络、可控时序」。
 *
 * 所以这里只声明**运行时真正调用到的最小签名**，实现由外部注入。
 * 端口的形状与 `application/` 的导出对不上时，写适配器是接线方的职责，
 * 不是把端口改宽——端口一旦按某个实现的形状长出来，倒置就名存实亡了。
 *
 * 安全约束（REQ §13）：本文件的任何端口都**不接受、不传递 API Key**。
 * 密钥只存在于 `ResolvedModel` 中，且只流向 adapter 的 HTTP 请求头。
 */

import type { Operation, SlotStatus } from '@shared/contracts.ts';
import type { ErrorCode } from '@shared/errors.ts';
import type { CompleteAssignmentInput } from '@shared/tools.ts';
import type { TraceActor, TraceKind, TracePayload } from '@shared/trace.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';

// ---------------------------------------------------------------- TracePort

/**
 * 一条待写入的 trace。
 *
 * `payload` 在写入前必须过 `TracePayloadSchema`（含递归脱敏黑名单）——
 * 这件事由 `trace-writer.ts` 统一做，端口实现方不需要重复校验，
 * 但也**不允许** Runtime 绕开 writer 直接调用本端口。
 */
export interface TraceRecord {
  /** 结构/槽位提交前的少数事件可能没有 execution 上下文 */
  executionId: string | null;
  actor: TraceActor;
  kind: TraceKind;
  title: string;
  summary: string;
  payload: TracePayload | null;
}

export interface TracePort {
  /** 写一条正式 trace。同步与否由实现决定，Runtime 不等待它 */
  record(taskId: string, record: TraceRecord): void;

  /**
   * 流式正文增量。**不逐 token 落库**（§7.7）：实现方负责按 1KB / 250ms 聚合成
   * `public_output_chunk`，Runtime 只负责把 delta 原样递过来。
   */
  bufferOutput(taskId: string, executionId: string, delta: string): void;
}

// ------------------------------------------------------------ CompletionPort

/** `complete_assignment` 的提交请求。Token 由 Runtime 透传，Runtime 自己从不解释它 */
export interface CompletionRequest {
  taskId: string;
  executionId: string;
  /** 明文 Token（§8.1）。只在内存中流转，绝不进 trace / 日志 / 工具结果 */
  executionToken: string;
  operation: Operation;
  /** create_structure 时为 null */
  targetSlotId: string | null;
  /** 已过 `ToolSchemas.complete_assignment` 的载荷 */
  payload: CompleteAssignmentInput;
}

/**
 * 提交结果。
 *
 * **为什么用返回值而不是异常表达「被拒」**：结构校验失败（19 条规则）是一次
 * *预期内*的业务结果，D-13 要求把违规列表原样回给 Agent 让它增量修正；
 * 而异常在这条链路上还要同时承载「数据库炸了」这种真故障。
 * 两者混在一个 catch 里，迟早会有人把 SQLITE_BUSY 当成校验失败喂给模型。
 *
 * 端口实现方若抛 `ForgeError`，Runtime 也会兜住并转成工具错误结果——
 * 那是兼容路径，不是推荐写法。
 */
export type CompletionOutcome =
  | { ok: true }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      /** 仅结构校验失败时非空（D-13） */
      violations: readonly StructureViolation[];
    };

export interface CompletionPort {
  submit(request: CompletionRequest): Promise<CompletionOutcome>;
}

// ------------------------------------------------------------- StructurePort

/**
 * `read_structure_outline` 需要的槽位投影。
 *
 * 刻意**不含 `contentText`**：结构概要是「有哪些槽位、什么状态」，
 * 正文属于 `read_slot`，而 `read_slot` 有依赖白名单闸门。
 * 把正文混进概要等于给了一条绕过白名单的旁路（§7.4「其他槽位的正文不在你的上下文中」）。
 */
export interface OutlineSlot {
  slotId: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  instruction: string;
  dependsOn: readonly string[];
  contentBearing: boolean;
  status: SlotStatus;
}

export interface StructurePort {
  /** 按文档序返回全部槽位。顺序由实现方保证与 `readiness.documentOrder` 一致 */
  readOutline(taskId: string): Promise<readonly OutlineSlot[]>;

  /**
   * 读单个槽位正文。**本方法不做权限判断**——白名单在工具闭包里
   * （§7.5：只看是否在 `allowedDependencySlotIds` 里）。
   * 端口若也判一次，两处规则迟早分叉，而分叉的那一侧一定是更松的那侧。
   */
  readSlotContent(taskId: string, slotId: string): Promise<SlotContentView | null>;
}

export interface SlotContentView {
  slotId: string;
  type: string;
  instruction: string;
  status: SlotStatus;
  contentText: string | null;
}

// ---------------------------------------------------------- SnapshotReadPort

/**
 * 冻结快照的只读视图（AC-002）。
 *
 * Runtime 只需要「Skill 章节」与「任务输入」两样东西，因此端口只开这两个口子。
 * 形状与 `application/snapshot-service.ts` 的 `FrozenSkill` 结构兼容，
 * 但**不 import 它**：那会把 runtime 钉死在 snapshot-service 的演化上。
 */
export interface SkillSectionView {
  id: string;
  title: string;
  content: string;
}

export interface SkillSnapshotView {
  id: string;
  version: string;
  summary: string;
  preamble: string;
  requiredSections: readonly string[];
  /** 按 Section ID 索引，`read_skill_section` O(1) 取用 */
  sectionIndex: Readonly<Record<string, SkillSectionView>>;
  /** 章节顺序，用于「其余章节可用 read_skill_section 读取」的清单与错误提示 */
  sections: readonly SkillSectionView[];
}

export interface SnapshotReadPort {
  /** 取某个任务冻结的 Skill 快照。找不到返回 null，由调用方决定报什么错 */
  getSkill(taskId: string, skillId: string): Promise<SkillSnapshotView | null>;
  /** 冻结的任务输入（键是模板 inputFields[].id） */
  getTaskInput(taskId: string): Promise<Readonly<Record<string, string>> | null>;
}
