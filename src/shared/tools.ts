/**
 * Agent 工具契约（文档 §3.4）。
 *
 * 这些 schema 有双重身份：既用于生成给模型的 tool definition，也用于校验模型回传的参数。
 * 同一份定义两用是刻意的——两份定义迟早会漂移，而漂移的后果是模型按 A 的形状产出、
 * 系统按 B 的形状校验，表现为莫名其妙的 TOOL_INPUT_INVALID。
 */

import { z } from 'zod';

import type { TraceKind } from './trace';

/**
 * Structure Agent 提交的单个槽位提案。
 * ID 正则同时承担 REQ FR-STR-004 第 4 条「Slot ID 满足安全字符规则」：
 * 放在 Zod 层意味着格式错误在解析阶段就被拦下，不会进入 19 条业务校验，报错也更精确。
 */
export const SlotProposalSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,63}$/,
      'Slot ID 只能包含小写字母、数字和下划线，且以字母开头，最长 64 字符',
    ),
  type: z.string(),
  parentId: z.string().nullable(),
  order: z.number().int().min(0),
  instruction: z.string(),
  dependsOn: z.array(z.string()).default([]),
});
export type SlotProposal = z.infer<typeof SlotProposalSchema>;

/**
 * 工具参数表。
 * 工具集合是封闭的：Agent 只有这 6 个动作，其中只有 complete_assignment 是写动作（REQ §12.3）。
 */
export const ToolSchemas = {
  read_task_input: z.object({
    field: z.string().optional(), // 省略则返回全部字段
  }),

  read_skill_section: z.object({
    sectionId: z.string(),
  }),

  read_structure_outline: z.object({}),

  read_slot: z.object({
    slotId: z.string(),
  }),

  report_work: z.object({
    type: z.enum(['understanding', 'plan', 'decision', 'progress', 'completion']),
    summary: z.string().min(1).max(2000),
    relatedSkillSectionIds: z.array(z.string()).optional(),
    relatedSlotIds: z.array(z.string()).optional(),
  }),

  complete_assignment: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('structure'),
      rootSlotId: z.string(),
      slots: z.array(SlotProposalSchema).min(1),
    }),
    z.object({
      kind: z.literal('slot_content'),
      slotId: z.string(),
      content: z.string(),
    }),
    z.object({
      kind: z.literal('review_result'),
      slotId: z.string(),
      verdict: z.enum(['no_finding', 'revise']),
      findings: z.array(
        z.object({
          criterionId: z.string(),
          quote: z.string(),
          problem: z.string(),
        }),
      ),
    }),
  ]),
} as const;

/** 工具名。SubmissionGate（D-11）与工具调用计数都按它做键，因此必须是类型而非裸字符串 */
export type ToolName = keyof typeof ToolSchemas;

/** 供 buildToolset 遍历注册，避免新增工具后忘记挂上去 */
export const TOOL_NAMES = Object.keys(ToolSchemas) as [ToolName, ...ToolName[]];
export const ToolNameSchema = z.enum(TOOL_NAMES);

/** 某个工具的参数类型，如 ToolInput<'read_slot'> */
export type ToolInput<N extends ToolName> = z.infer<(typeof ToolSchemas)[N]>;

/** 提交载荷。两种 operation 的产出形状不同，用判别联合而不是可选字段，写错时编译期就报 */
export type CompleteAssignmentInput = ToolInput<'complete_assignment'>;
export type ReportWorkInput = ToolInput<'report_work'>;

/** report_work 的类型词表映射到 work_* trace kind，供 Runtime 直接转换 */
export const REPORT_WORK_TRACE_KIND = {
  understanding: 'work_understanding',
  plan: 'work_plan',
  decision: 'work_decision',
  progress: 'work_progress',
  completion: 'work_completion',
} as const satisfies Record<ReportWorkInput['type'], TraceKind>;
