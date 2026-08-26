/**
 * Trace 契约（文档 §3.3）。
 *
 * Trace 是「Agent 到底做了什么」的唯一可核查记录，也是用户判断要不要干预的依据，
 * 因此它的 kind 必须是封闭枚举——开放字符串会让前端筛选分组（UX §13.2）随时失效。
 *
 * 安全边界（REQ §13）：trace 会原样进入 API 响应与前端页面，
 * 所以这里刻意不提供任何承载 API Key / Authorization / 环境变量值 / 模型隐藏推理
 * 的字段，且 payload 在 schema 层做键名黑名单校验，从契约上堵死误写。
 */

import { z } from 'zod';

/**
 * 事件发起方。
 * 注意没有 `error` actor：失败事件的 actor 仍是 `system`，
 * 前端按 kind ∈ {validation_failed, assignment_failed, late_result_rejected} 走 danger 配色。
 */
export const TraceActorSchema = z.enum(['system', 'agent', 'tool', 'skill']);
export type TraceActor = z.infer<typeof TraceActorSchema>;

export const TRACE_KINDS = [
  'task_state_changed',
  'assignment_created',
  'assignment_started',
  'context_built',
  'skill_loaded',
  'skill_section_read',
  'work_understanding',
  'work_plan',
  'work_decision',
  'work_progress',
  'work_completion',
  'tool_call_started',
  'tool_call_completed',
  'public_output_chunk',
  'assignment_submitted',
  'validation_passed',
  'validation_failed',
  'assignment_completed',
  'assignment_failed',
  'assignment_cancelled',
  'late_result_rejected',
  'slot_state_changed',
  'assembly_started',
  'artifact_created',
  'provider_retry', // ← 新增，UX §18.6 要求展示 Attempt 变化
  'task_queued', // ← 新增，D-14
  // R2 审核返修（§4.1）。措辞受 D-30 约束：不得出现「审核通过/质量合格/已校验」。
  'review_started', // 一条判据的审核 execution 建立
  'review_no_finding', // 该判据未检出问题（不是 review_passed，D-30）
  'review_revise', // 检出问题，payload 带通过校验的 findings 与丢弃条数
  'revision_budget_exhausted', // 返修轮次用尽，按现状完成
] as const;
export const TraceKindSchema = z.enum(TRACE_KINDS);
export type TraceKind = (typeof TRACE_KINDS)[number];

/**
 * payload 键名黑名单（REQ §13 脱敏要求的机器化）。
 * 命中即解析失败——宁可让写 trace 的代码在测试里炸掉，也不要让密钥流到页面上。
 */
export const FORBIDDEN_PAYLOAD_KEY_PATTERN =
  /^(api_?key|apikey|authorization|auth_?header|bearer|secret|password|credential|access_?token|refresh_?token|session_?token|env|environment|process_?env|reasoning|reasoning_?content|hidden_?reasoning|thinking|thought|chain_?of_?thought)$/i;

/** 递归检查，因为脱敏事故通常发生在嵌套的 provider 原始响应对象里，而不是顶层 */
const hasForbiddenKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => FORBIDDEN_PAYLOAD_KEY_PATTERN.test(key) || hasForbiddenKey(child),
  );
};

/** 展开区结构。刻意是自由 record：不同 kind 的展开内容差异太大，穷举会变成 26 个近似 schema */
export const TracePayloadSchema = z
  .record(z.unknown())
  .refine((payload) => !hasForbiddenKey(payload), {
    message: 'trace payload 命中脱敏黑名单：不得承载密钥、Authorization、环境变量值或模型隐藏推理（REQ §13）',
  });
export type TracePayload = z.infer<typeof TracePayloadSchema>;

export const TraceEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executionId: z.string().nullable(),
  /** 任务内单调递增，同时充当 SSE 的 event id，断线后据此补发（§9.4） */
  sequence: z.number().int(),
  actor: TraceActorSchema,
  kind: TraceKindSchema,
  /** 卡片标题，如「读取上游产物」 */
  title: z.string(),
  /** 一句话正文，如「chapter_outline.scenes[1] · scene_01 结尾状态摘要」 */
  summary: z.string(),
  /** 展开区，已脱敏。大段正文不放这里 */
  payload: TracePayloadSchema.nullable(),
  createdAt: z.string(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** 前端筛选分组（UX §13.2）。分组放契约层，前后端才能用同一套口径统计与断言 */
export const TRACE_FILTER_GROUPS = {
  all: TRACE_KINDS,
  work: ['work_understanding', 'work_plan', 'work_decision', 'work_progress', 'work_completion'],
  skill: ['skill_loaded', 'skill_section_read'],
  tool: ['tool_call_started', 'tool_call_completed'],
  output: ['public_output_chunk'],
  system: [
    'task_state_changed',
    'assignment_created',
    'assignment_started',
    'context_built',
    'assignment_submitted',
    'validation_passed',
    'validation_failed',
    'assignment_completed',
    'assignment_failed',
    'assignment_cancelled',
    'late_result_rejected',
    'slot_state_changed',
    'assembly_started',
    'artifact_created',
    'provider_retry',
    'task_queued',
    // R2 审核返修：不加进过滤组 = 审核期间界面看起来卡死
    'review_started',
    'review_no_finding',
    'review_revise',
    'revision_budget_exhausted',
  ],
} as const satisfies Record<string, readonly TraceKind[]>;

/** 筛选分组名，前端 Tab 直接遍历它，避免硬编码 Tab 列表与分组表脱节 */
export const TraceFilterGroupSchema = z.enum(
  Object.keys(TRACE_FILTER_GROUPS) as [keyof typeof TRACE_FILTER_GROUPS, ...(keyof typeof TRACE_FILTER_GROUPS)[]],
);
export type TraceFilterGroup = z.infer<typeof TraceFilterGroupSchema>;
