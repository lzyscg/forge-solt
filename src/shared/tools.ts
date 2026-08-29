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
 * R6 / D-61：返修轮的一条定点编辑。
 *
 * `oldText` 必须逐字出现在上一稿里且唯一——比对用与引文闸门（D-25）**同一套**
 * 归一化，实现与校验在 `server/domain/slot-edits.ts`。
 * 两个字段都不设 max：正文本身受 `validation.maxChars` 约束，
 * 在这里再设一个上限只会多出一处需要对齐的数字。
 */
export const SlotEditSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
});
export type SlotEdit = z.infer<typeof SlotEditSchema>;

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
    /*
     * R6 / D-61：返修轮提交编辑清单，而不是整篇正文。
     *
     * 只在返修轮（`slots.revision_round > 0`）可用，首稿仍走 slot_content——
     * 首稿没有「上一稿」可以引，编辑清单无从谈起。
     *
     * 形状刻意只有 oldText/newText 两个字段，**不给行号或序号**：
     * 坐标一旦让模型提供，就要处理它数错的情况；而把 oldText 加长到唯一，
     * 让歧义在提交那一刻就消失。与引文闸门（D-25）同一条思路。
     */
    z.object({
      kind: z.literal('slot_edits'),
      slotId: z.string(),
      edits: z.array(SlotEditSchema).min(1),
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

/**
 * 工具层解析之后的提交载荷。
 *
 * `slot_edits` 在 `complete-assignment.ts` 里就地应用成整篇正文，**下游看不到它**——
 * CompletionPort、仓储、确定性校验、组装拿到的永远是 slot_content。
 * 把这件事写成类型而不是留成约定：将来有人把 slot_edits 往下传，编译期就炸。
 */
export type ResolvedSubmissionPayload = Exclude<CompleteAssignmentInput, { kind: 'slot_edits' }>;
export type ReportWorkInput = ToolInput<'report_work'>;

/** report_work 的类型词表映射到 work_* trace kind，供 Runtime 直接转换 */
export const REPORT_WORK_TRACE_KIND = {
  understanding: 'work_understanding',
  plan: 'work_plan',
  decision: 'work_decision',
  progress: 'work_progress',
  completion: 'work_completion',
} as const satisfies Record<ReportWorkInput['type'], TraceKind>;
