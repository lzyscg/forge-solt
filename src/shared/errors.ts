/**
 * 错误契约（文档 §3.2 + 附录 A + §9.3）。
 *
 * 错误码是前后端唯一共享的失败词表：后端按码抛，前端按码决定要不要显示重试按钮。
 * 因此 HTTP 状态与 action 文案也放在契约层——放在 API 层会让前端只能靠猜，
 * 放在前端会让两侧文案漂移。
 */

import { z } from 'zod';

/** 错误码全表（附录 A）。顺序按领域分组，方便 review 时对照文档逐条核。 */
export const ERROR_CODES = [
  // 模板
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_INVALID',
  'TEMPLATE_NOT_PUBLISHED',
  // 任务
  'TASK_NOT_FOUND',
  'TASK_STATE_INVALID',
  'TASK_INPUT_INVALID',
  // 引擎
  'ENGINE_BUSY',
  // 结构
  'STRUCTURE_INVALID',
  'STRUCTURE_RETRY_EXHAUSTED',
  // 槽位
  'SLOT_NOT_FOUND',
  'SLOT_NOT_READY',
  'SLOT_TARGET_MISMATCH',
  'SLOT_CONTENT_INVALID',
  'DEPENDENCY_DEADLOCK',
  // Provider / 执行
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED', // ← D-04 新增
  'PROVIDER_UNAVAILABLE', // ← D-03 新增
  'MODEL_ALIAS_UNRESOLVED', // ← D-03 新增
  'EXECUTION_CANCELLED',
  'EXECUTION_STALE',
  'EXECUTION_TOKEN_INVALID',
  'MAX_TOOL_CALLS_EXCEEDED', // ← 新增
  // 工具
  'TOOL_NOT_ALLOWED',
  'TOOL_INPUT_INVALID',
  'SKILL_SECTION_NOT_FOUND',
  'ASSIGNMENT_OUTPUT_INVALID',
  // 组装 / 存储
  'ASSEMBLY_FAILED',
  'ARTIFACT_NOT_FOUND',
  'STORAGE_ERROR',
] as const;

/** 用 schema 而不是裸联合类型，是为了让 HTTP 响应体也能被运行时校验（契约层统一要求） */
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * 对外错误结构（REQ §12）。
 * 注意 `cause` 不在其中——它只写脱敏服务日志，不出网（REQ §13）。
 */
export const PublicErrorSchema = z.object({
  code: ErrorCodeSchema,
  /** 面向用户的中文说明 */
  message: z.string(),
  /** 如 'slot:scene_02'，供 UI 定位到具体槽位 */
  location: z.string().nullable(),
  /** 用户可执行的下一步，如 '点击重试从该槽位继续' */
  action: z.string().nullable(),
});
export type PublicError = z.infer<typeof PublicErrorSchema>;

/**
 * 错误码 → HTTP 状态（§9.3 + 附录 A）。
 * 全表列全而不是「其余默认 500」，是为了让新增错误码时编译器强制补一行，
 * 避免漏配后静默变成 500。
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  TEMPLATE_NOT_FOUND: 404,
  TEMPLATE_INVALID: 400,
  TEMPLATE_NOT_PUBLISHED: 400,
  TASK_NOT_FOUND: 404,
  TASK_STATE_INVALID: 409,
  TASK_INPUT_INVALID: 400,
  ENGINE_BUSY: 429,
  STRUCTURE_INVALID: 500,
  STRUCTURE_RETRY_EXHAUSTED: 500,
  SLOT_NOT_FOUND: 404,
  SLOT_NOT_READY: 409,
  SLOT_TARGET_MISMATCH: 500,
  SLOT_CONTENT_INVALID: 500,
  DEPENDENCY_DEADLOCK: 500,
  PROVIDER_TIMEOUT: 500,
  PROVIDER_ERROR: 500,
  PROVIDER_RATE_LIMITED: 503,
  PROVIDER_UNAVAILABLE: 503,
  MODEL_ALIAS_UNRESOLVED: 500,
  EXECUTION_CANCELLED: 500,
  EXECUTION_STALE: 500,
  EXECUTION_TOKEN_INVALID: 500,
  MAX_TOOL_CALLS_EXCEEDED: 500,
  TOOL_NOT_ALLOWED: 500,
  TOOL_INPUT_INVALID: 500,
  SKILL_SECTION_NOT_FOUND: 500,
  ASSIGNMENT_OUTPUT_INVALID: 500,
  ASSEMBLY_FAILED: 500,
  ARTIFACT_NOT_FOUND: 404,
  STORAGE_ERROR: 500,
};

/**
 * 只在内部流转、不直接返回给用户的错误码（附录 A 中 HTTP 列标 `—` 的那些）。
 * 它们会被上层转换为任务失败状态；若直接出现在 HTTP 响应里说明有实现漏洞，
 * API 层可据此断言。
 */
export const INTERNAL_ONLY_ERROR_CODES = [
  'STRUCTURE_INVALID',
  'SLOT_TARGET_MISMATCH',
  'SLOT_CONTENT_INVALID',
  'EXECUTION_CANCELLED',
  'EXECUTION_STALE',
  'EXECUTION_TOKEN_INVALID',
  'MAX_TOOL_CALLS_EXCEEDED',
  'TOOL_NOT_ALLOWED',
  'TOOL_INPUT_INVALID',
  'SKILL_SECTION_NOT_FOUND',
] as const satisfies readonly ErrorCode[];

/**
 * 各错误码的默认 action 文案（附录 A）。
 * `null` 表示该错误没有用户可执行的下一步——此时 UI 不显示操作按钮，
 * 而不是显示一个点了没用的「重试」（UX §18.8）。
 */
export const DEFAULT_ERROR_ACTION: Record<ErrorCode, string | null> = {
  TEMPLATE_NOT_FOUND: '返回模板列表重新选择',
  TEMPLATE_INVALID: '检查 template.yaml 后重新加载',
  TEMPLATE_NOT_PUBLISHED: '该模板不可用于新任务，请选择已发布模板',
  TASK_NOT_FOUND: null,
  TASK_STATE_INVALID: '刷新页面查看最新状态',
  TASK_INPUT_INVALID: '补齐必填字段后重新创建',
  ENGINE_BUSY: '等待当前任务完成后重试',
  STRUCTURE_INVALID: null,
  STRUCTURE_RETRY_EXHAUSTED: '点击重试重新设计结构，已冻结的输入不变',
  SLOT_NOT_FOUND: null,
  SLOT_NOT_READY: '等待前置槽位完成',
  SLOT_TARGET_MISMATCH: null,
  SLOT_CONTENT_INVALID: null,
  DEPENDENCY_DEADLOCK: '结构存在无法满足的依赖，需要重新创建任务',
  PROVIDER_TIMEOUT: '点击重试从当前槽位继续，已完成的槽位不会重新生成',
  PROVIDER_ERROR: '检查 Provider 设置后重试',
  PROVIDER_RATE_LIMITED: '该 Provider 正在限流，稍后重试或切换模型别名',
  PROVIDER_UNAVAILABLE: '前往 Provider 设置检查配置',
  MODEL_ALIAS_UNRESOLVED: '在 config/providers.yaml 中补充该别名',
  EXECUTION_CANCELLED: null,
  EXECUTION_STALE: null,
  EXECUTION_TOKEN_INVALID: null,
  MAX_TOOL_CALLS_EXCEEDED: null,
  TOOL_NOT_ALLOWED: null,
  TOOL_INPUT_INVALID: null,
  SKILL_SECTION_NOT_FOUND: null,
  ASSIGNMENT_OUTPUT_INVALID: '点击重试',
  ASSEMBLY_FAILED: '点击重试，已完成的槽位内容保留，只重新执行组装',
  ARTIFACT_NOT_FOUND: null,
  STORAGE_ERROR: '请查看服务日志',
};

/**
 * 系统内唯一的业务异常类型。
 * 之所以不用多个子类：错误的差异全在 `code` 上，子类树只会诱使 catch 写成 instanceof 链。
 */
export class ForgeError extends Error {
  override readonly name = 'ForgeError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** 如 'slot:scene_02' */
    readonly location: string | null = null,
    /** 缺省时由调用方按 DEFAULT_ERROR_ACTION 兜底 */
    readonly action: string | null = null,
    /** 原始错误。只写脱敏服务日志，绝不进 toPublic()（REQ §13） */
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  /**
   * 转成可出网的形状。这是 `cause` 被丢弃的唯一保证点，不要绕过它直接序列化 ForgeError。
   * 此处不对 `action` 做兜底（照文档 §3.2 原样返回）；兜底由 API 层用
   * DEFAULT_ERROR_ACTION 完成，以免 domain 抛错时被静默补上一句不适用的操作提示。
   */
  toPublic(): PublicError {
    return {
      code: this.code,
      message: this.message,
      location: this.location,
      action: this.action,
    };
  }
}
