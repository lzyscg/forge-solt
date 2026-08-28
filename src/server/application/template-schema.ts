/**
 * `template.yaml` 的原始形状（文档 §4.1）。
 *
 * 这里是**解析边界**：YAML 文件可被任何人手改，属于 §3 判据表里
 * 「跨进程边界的不可信输入」，所以一律 Zod，不允许手写 interface 后 `as`。
 * 越过这一层之后（`CompiledTemplate`）就是进程内自造自用的形状，用普通 TS。
 *
 * 两条贯穿全文件的取舍：
 *
 * 1. **几乎所有对象都 `.strict()`。** 宽松模式下 `bindigns:`（拼错）
 *    会被静默忽略，然后报出来的是「fillSlotByType 未覆盖 scene 类型」——
 *    一个与真实原因隔了两层的错误。strict 让拼写错误在原地报出。
 * 2. **可选字段只留真正有回退来源的那些。** `timeoutMs` / `maxRetries` 可选，
 *    因为 D-06 明确了它们的回退链；`summary` / `outputKind` 这类没有回退来源的
 *    一律必填——「可选 + 前端兜个空字符串」等于把空数据推到 UI 上。
 */

import { z } from 'zod';
import { TemplateStatusSchema } from '@shared/contracts.ts';

/**
 * 槽位类型 ID 与 `shared/tools.ts` 的 `SlotProposalSchema.id` 同规则。
 * 两者必须同形：Structure Agent 提交的槽位 `type` 要能和这里的 `id` 对上，
 * 规则不一致会造成「模板里合法、提案里非法」的诡异失配。
 */
const SlotTypeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, '槽位类型 ID 只能包含小写字母、数字和下划线，且以字母开头，最长 64 字符');

const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'ID 只能包含小写字母、数字、下划线与连字符，且以字母开头');

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, '版本号必须是 x.y.z 三段式');

/** D-05：系统强制的确定性校验。与 `guidance`（写作要求，不强制）严格分开 */
const SlotValidationSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    /** 用户提供的正则。加载期必须过 regex-budget 的时间预算，见 template-loader */
    forbidPattern: z.string().min(1).optional(),
    forbidPatternMessage: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minChars !== undefined && value.maxChars !== undefined && value.minChars > value.maxChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minChars'],
        message: `minChars(${value.minChars}) 不得大于 maxChars(${value.maxChars})——这样的区间永远无法满足`,
      });
    }
    // 命中 forbidPattern 时要回给 Agent 一句可执行的说明（D-13）。
    // 只给正则源码等于让模型自己反推意图，是最典型的「不可执行反馈」。
    if (value.forbidPattern !== undefined && value.forbidPatternMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forbidPatternMessage'],
        message: '声明 forbidPattern 时必须同时给出 forbidPatternMessage（D-13：反馈必须可执行）',
      });
    }
    if (value.forbidPattern === undefined && value.forbidPatternMessage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forbidPattern'],
        message: 'forbidPatternMessage 没有对应的 forbidPattern',
      });
    }
  });

export const RawSlotTypeSchema = z
  .object({
    id: SlotTypeIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    /** false = 容器类型：没有 Assignment，不产出内容 */
    contentBearing: z.boolean(),
    /**
     * D-16 / D-18：以该槽位为根的整棵子树是否进入产物。
     * **不给默认值放在 Zod 里**，而是在编译期显式补 true——
     * 因为「容器类型默认 false 会让整棵树装配不出东西」这条推理值得写在补默认值的地方。
     */
    includeInArtifact: z.boolean().optional(),
    validation: SlotValidationSchema.optional(),
    guidance: z.array(z.string().min(1)).optional(),
    /** R2：返修上限，默认 2（D-26）。编译进 SlotTypeDefinition */
    maxRevisionRounds: z.number().int().min(0).optional(),
  })
  .strict();

export const RawAgentSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    role: z.string().min(1),
    /** 模型**别名**（D-03 晚绑定），不是模型 ID。D-06 回退链的第二级 */
    model: z.string().min(1).optional(),
    systemInstruction: z.string().min(1),
  })
  .strict();

export const RawSkillRefSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    /** 相对 SKILLS_DIR 的父目录，见 template-loader 的 resolveSkillPath */
    source: z.string().min(1),
  })
  .strict();

export const RawBindingSchema = z
  .object({
    agentId: IdentifierSchema,
    skillId: IdentifierSchema,
    /** D-06 回退链第一级。省略则用 agent.model */
    modelAlias: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(0).optional(),
  })
  .strict();

export const RawLimitsSchema = z
  .object({
    maxSlots: z.number().int().positive(),
    maxStructureDepth: z.number().int().positive(),
    /** D-06 回退链第二级；省略则落到 providers.yaml 的 defaults */
    maxExecutionRetries: z.number().int().min(0).optional(),
    executionTimeoutMs: z.number().int().positive().optional(),
    /**
     * 必填而非可选：providers.yaml 的 `defaults` 里**没有**这一项（§4.2），
     * 也就是说它没有回退来源。给它编一个隐式默认值，等于让「忘了配」
     * 变成一个要等到线上烧 token 才发现的问题（与 D-06 对 modelAlias 的态度一致）。
     */
    maxToolCallsPerAssignment: z.number().int().positive(),
  })
  .strict();

export const RawOutputSchema = z
  .object({
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
    /** P0 只有一个组装器。写成 literal 而非 string，拼错当场报错而不是组装时才发现 */
    assembler: z.literal('markdown_concat_v1'),
  })
  .strict();

/**
 * D-02：纯展示区块。
 *
 * 它与运行时字段**物理隔离**正是靠这个独立对象——编译时整块丢掉，
 * `templateHash` 因此与它无关。改个标签不会让历史任务的快照 hash 失配。
 */
export const RawPresentationSchema = z
  .object({
    /** D-08：前端筛选 chip 的聚合依据，自由文本 */
    outputKind: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    exampleStructure: z
      .array(
        z
          .object({
            name: z.string().min(1),
            typeId: z.string().min(1),
            kind: z.enum(['container', 'content']),
            /** 0 基（D-19）：根为 0 */
            depth: z.number().int().min(0),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const RawInputFieldSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().min(1),
    type: z.enum(['text', 'textarea']),
    required: z.boolean(),
    hint: z.string().min(1).optional(),
  })
  .strict();

export const RawTemplateSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    /** D-08。必填：默认成 published 会让半成品模板意外可用于新任务 */
    status: TemplateStatusSchema,
    presentation: RawPresentationSchema,
    inputFields: z.array(RawInputFieldSchema).min(1),
    slotTypes: z.array(RawSlotTypeSchema).min(1),
    agents: z.array(RawAgentSchema).min(1),
    skills: z.array(RawSkillRefSchema).min(1),
    bindings: z
      .object({
        /** D-01：结构由 Structure Agent 运行时创建，所以这条绑定是必需的 */
        createStructure: RawBindingSchema,
        /** key 是槽位类型 ID。编译期校验它覆盖了全部 contentBearing 类型 */
        fillSlotByType: z.record(RawBindingSchema),
        /**
         * R2：审核 Skill 按 Slot Type 可选绑定（D-27 / FR-REVIEW-001）。
         * 不绑定是合法且默认的状态——不覆盖全部 contentBearing 类型。
         * 结构与 fillSlotByType 相同（RawBindingSchema）。
         * operation 校验在编译期用 resolveOne 同型校验（R2 落，R4 只加规则）。
         */
        reviewSlotByType: z.record(RawBindingSchema).optional(),
        /**
         * R5：结构审核，可选。审的是根容器底下那棵树的 instruction，
         * 不是某个槽位的正文——所以它是一条独立绑定而不是 reviewSlotByType 的一项。
         * 理由见 CompiledTemplate.bindings.reviewStructure 上的注释。
         */
        reviewStructure: RawBindingSchema.optional(),
      })
      .strict(),
    limits: RawLimitsSchema,
    output: RawOutputSchema,
  })
  .strict();

export type RawTemplate = z.infer<typeof RawTemplateSchema>;
export type RawSlotType = z.infer<typeof RawSlotTypeSchema>;
export type RawBinding = z.infer<typeof RawBindingSchema>;
export type RawPresentation = z.infer<typeof RawPresentationSchema>;
