/**
 * API DTO（文档 §3.5）。
 *
 * 这是前后端唯一的形状约定：后端用它做响应序列化校验，前端用推导类型渲染。
 * 字段名与 HANDOFF 各页面的数据常量保持一致，便于前端把原型里的假数据直接换成真数据源。
 *
 * 一条纪律：DTO 里出现的派生字段（depth / path / blockedBy / charCount / presentation）
 * 全部由服务端算好。让前端算意味着同一套业务判断存在两份实现，必然打架（D-07）。
 */

import { z } from 'zod';

import { PublicErrorSchema } from './errors';
import { PresentationSchema } from './presentation';
import { TraceEventSchema } from './trace';

// ---------- 通用词表 ----------

/** 任务状态机取值（§6.4）。与数据库 CHECK 约束逐字一致 */
export const TaskStatusSchema = z.enum(['ready', 'running', 'stopped', 'completed', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 任务阶段。与 status 正交：running 可能处在四个阶段中的任意一个 */
export const TaskPhaseSchema = z.enum(['structure', 'slots', 'assembly', 'done']);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const SlotStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

/** Assignment 的两种操作。系统只有这两条生产路径（REQ §5.4：只有一套生产协议） */
export const OperationSchema = z.enum(['create_structure', 'fill_slot']);
export type Operation = z.infer<typeof OperationSchema>;

export const ExecutionStatusSchema = z.enum([
  'created',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/** D-08：draft / archived 不可用于创建新任务，但不可硬删——历史任务引用其快照 */
export const TemplateStatusSchema = z.enum(['published', 'draft', 'archived']);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;

/** UX §9.2 的五段进度条 */
export const StepperKeySchema = z.enum(['input', 'structure', 'slots', 'assembly', 'done']);
export type StepperKey = z.infer<typeof StepperKeySchema>;

// ---------- 模板 ----------

/** 新建任务页据此渲染表单；type 决定控件形态 */
export const InputFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea']),
  required: z.boolean(),
  /** 字段说明，null 表示不显示提示行 */
  hint: z.string().nullable(),
});
export type InputField = z.infer<typeof InputFieldSchema>;

export const TemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  status: TemplateStatusSchema,
  outputKind: z.string(), // 「单章正文」，前端筛选用
  slotTypeCount: z.number(),
  agentCount: z.number(),
  skillCount: z.number(),
  runCount: z.number(), // D-08
  tags: z.array(z.string()),
  updatedAt: z.string(),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

/**
 * 加载失败的模板（§4.1「一个坏模板不许让整个列表页空白」）。
 *
 * 只出 `dirName`，**不出 `sourcePath`**。TemplateLoadFailure 内部带着绝对路径，
 * 它对定位问题有用，但出网就是信息泄露——与 §9.3「Node 的报错带绝对路径，
 * 一律不出网」是同一条纪律。目录名足够让人知道该去改哪个模板。
 */
export const TemplateLoadFailureViewSchema = z.object({
  dirName: z.string(),
  error: PublicErrorSchema,
});
export type TemplateLoadFailureView = z.infer<typeof TemplateLoadFailureViewSchema>;

/**
 * `GET /api/templates` 的返回体。
 *
 * 刻意不是裸数组：`failures` 必须跟模板一起出去。TemplateCatalog 花力气把
 * 坏模板收进 failures 而不是让 reload 抛错，为的就是「坏模板显式可见」；
 * 到了 HTTP 边界扔掉它，等于只保留了那个设计的一半——列表页确实不空白了，
 * 但用户也再无从知道自己那个模板为什么不在里面。
 */
export const TemplateListResponseSchema = z.object({
  templates: z.array(TemplateSummarySchema),
  failures: z.array(TemplateLoadFailureViewSchema),
});
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

/**
 * 槽位「类型」而非具体槽位（D-01）——模板层不存在结构树。
 * binding 为 null 即容器类型：容器没有 Assignment，UI 也不得为它伪造 Producer 信息。
 */
export const SlotTypeDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  contentBearing: z.boolean(),
  /**
   * D-16 / D-18：以该槽位为根的**整棵子树**是否进入最终产物，默认 true。
   * false = 工作槽位（大纲、人物卡这类只喂下游的中间产出）。
   * 作用域是子树而非单节点，所以容器类型上这个值同样有意义——
   * 标 false 可一次性排除整节工作区。正因如此，容器的默认值也必须是 true。
   */
  includeInArtifact: z.boolean(),
  // 以下仅 contentBearing=true 时存在
  binding: z
    .object({
      agentId: z.string(),
      agentName: z.string(),
      agentRole: z.string(),
      skillId: z.string(),
      skillVersion: z.string(),
      skillSummary: z.string(),
      modelAlias: z.string(),
      resolvedModel: z.string().nullable(), // 当前别名解析结果，供展示
      timeoutMs: z.number(),
      maxRetries: z.number(),
    })
    .nullable(),
  validation: z.object({
    // D-05 系统强制
    minChars: z.number().nullable(),
    maxChars: z.number().nullable(),
    rules: z.array(z.string()), // 人类可读描述
  }),
  guidance: z.array(z.string()), // D-05 写作要求，不强制
});
export type SlotTypeDetail = z.infer<typeof SlotTypeDetailSchema>;

export const TemplateDetailSchema = TemplateSummarySchema.extend({
  inputFields: z.array(InputFieldSchema),
  structureBinding: z.object({
    // D-01 新增区块
    agentId: z.string(),
    agentName: z.string(),
    skillId: z.string(),
    skillVersion: z.string(),
    modelAlias: z.string(),
    resolvedModel: z.string().nullable(),
    timeoutMs: z.number(),
    maxRetries: z.number(),
    maxSlots: z.number(),
    maxStructureDepth: z.number(),
  }),
  slotTypes: z.array(SlotTypeDetailSchema),
  exampleStructure: z
    .array(
      z.object({
        // D-02，仅展示
        name: z.string(),
        typeId: z.string(),
        kind: z.enum(['container', 'content']),
        depth: z.number(),
      }),
    )
    .nullable(),
  output: z.object({ fileName: z.string(), mediaType: z.string() }),
});
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

// ---------- 任务 ----------

export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  status: TaskStatusSchema,
  phase: TaskPhaseSchema,
  presentation: PresentationSchema, // D-07：tone / state / detail
  doneSlots: z.number(),
  totalSlots: z.number(), // 结构未创建时为 0
  updatedAt: z.string(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/**
 * 槽位视图。
 * depth / path / blockedBy / charCount 是服务端派生字段：HANDOFF 的树渲染直接用
 * depth × 20px 做缩进，blockedBy 则是「等待依赖子行必须点名在等谁」的数据来源。
 */
export const SlotViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  typeName: z.string(),
  parentId: z.string().nullable(),
  order: z.number(),
  depth: z.number(), // 服务端算好，前端不再递归
  path: z.array(z.string()), // ['chapter','scene_03']，中栏「位置」用
  instruction: z.string(),
  dependsOn: z.array(z.string()),
  contentBearing: z.boolean(),
  /**
   * D-16 / D-18：false = 该槽位连同其子树都不进正文（工作槽位）。
   * 前端用虚线圆点区分，组装列表不显示它。
   */
  includeInArtifact: z.boolean(),
  status: SlotStatusSchema,
  presentation: PresentationSchema, // D-07：8 态词表
  blockedBy: z.array(z.string()), // pending 且依赖未完成时，点名在等谁
  charCount: z.number().nullable(), // 「1,486 字 · 校验通过」子行用
  producer: z
    .object({
      agentId: z.string(),
      agentName: z.string(),
      skillId: z.string(),
      skillVersion: z.string(),
      executionId: z.string(),
      durationMs: z.number(),
    })
    .nullable(),
  error: PublicErrorSchema.nullable(),
});
export type SlotView = z.infer<typeof SlotViewSchema>;

/**
 * 单槽位详情（`GET /api/tasks/:id/slots/:slotId`）。
 * 正文单独在这里返回而不塞进列表，是因为 50 个槽位的任务里列表响应会膨胀到不可接受。
 */
export const SlotDetailSchema = SlotViewSchema.extend({
  content: z.string().nullable(),
});
export type SlotDetail = z.infer<typeof SlotDetailSchema>;

/**
 * 执行记录视图（UX §13.5 技术详情）。
 * modelAlias 与 provider/model 并列展示是 D-03 的要求：别名冻结、解析 late-bound，
 * 只有同时看到两者才能解释「同一任务两次 attempt 用了不同实际模型」。
 * contextHash / promptHash 分开是 D-12——前者答「喂进去的信息变了吗」，后者答「组织方式变了吗」。
 */
export const ExecutionViewSchema = z.object({
  id: z.string(), // D-09：Assignment ID 与 Execution ID 同值，UI 只展示一行
  taskId: z.string(),
  operation: OperationSchema,
  targetSlotId: z.string().nullable(),
  agentId: z.string(),
  agentName: z.string(),
  skillId: z.string(),
  skillVersion: z.string(),
  modelAlias: z.string(), // 冻结在快照里的别名
  provider: z.string(), // 解析后的实际 provider
  model: z.string(), // 解析后的实际 model
  attemptNumber: z.number().int(),
  status: ExecutionStatusSchema,
  contextHash: z.string(),
  promptHash: z.string(), // D-12
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  /** 运行中为「已耗时」，终态为总耗时；未开始为 null */
  durationMs: z.number().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  error: PublicErrorSchema.nullable(),
});
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

/** 产物元信息。content 仅 `GET /api/tasks/:id/artifact` 返回，下载走单独端点 */
export const ArtifactViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  fileName: z.string(),
  mediaType: z.string(),
  byteSize: z.number().int(),
  checksum: z.string(),
  /** 组装后的完整正文；列表类响应中为 null，避免把整章正文塞进任务详情 */
  content: z.string().nullable(),
  createdAt: z.string(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const TaskDetailSchema = TaskSummarySchema.extend({
  input: z.record(z.string()),
  snapshotHash: z.string(),
  slots: z.array(SlotViewSchema),
  stepper: z.array(
    z.object({
      // UX §9.2 五段
      key: StepperKeySchema,
      label: z.string(),
      state: z.enum(['done', 'current', 'todo', 'error']),
      summary: z.string(), // 「7 个槽位」「4 / 7」
      owner: z.enum(['system', 'agent']),
    }),
  ),
  activeExecution: ExecutionViewSchema.nullable(),
  plannedAssignment: z
    .object({
      // UX §12.3「计划工作」
      agentId: z.string(),
      agentName: z.string(),
      skillId: z.string(),
      skillVersion: z.string(),
      operation: OperationSchema,
      targetSlotId: z.string().nullable(),
      blockedBy: z.array(z.string()),
    })
    .nullable(),
  queuePosition: z.number().nullable(), // D-14
  artifact: ArtifactViewSchema.nullable(),
  error: PublicErrorSchema.nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

// ---------- 请求体 ----------

/** `POST /api/tasks`。是否立即启动由 query `?start=true` 决定，不进 body（§9.1） */
export const CreateTaskRequestSchema = z.object({
  templateId: z.string(),
  name: z.string().min(1),
  /** 输入字段值。全部按字符串传，类型语义由模板的 inputFields 定义 */
  input: z.record(z.string()),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/**
 * 启动/继续/重试的返回。
 * queued=true 时任务已入队而不是被拒绝（D-14）——直接返回 ENGINE_BUSY 会逼用户手动轮询。
 */
export const TaskCommandResultSchema = z.object({
  taskId: z.string(),
  status: TaskStatusSchema,
  queued: z.boolean(),
  /** 队列中的位置，未排队时为 null。UI 显示「前面还有 n 个任务」 */
  position: z.number().int().nullable(),
});
export type TaskCommandResult = z.infer<typeof TaskCommandResultSchema>;

/** `GET /api/tasks/:id/traces?after=&limit=` 的分页返回 */
export const TraceListResponseSchema = z.object({
  events: z.array(TraceEventSchema),
  /** 下一页游标（= 最后一条的 sequence）；无更多数据时为 null */
  nextAfter: z.number().int().nullable(),
});
export type TraceListResponse = z.infer<typeof TraceListResponseSchema>;

// ---------- Provider（D-03） ----------

/** 运行时观测结果，来自 provider_health 表；配置本身在 providers.yaml 里，只读 */
export const ProviderHealthSchema = z.object({
  status: z.enum(['ok', 'rate_limited', 'down']),
  latencyMs: z.number().nullable(),
  note: z.string().nullable(),
  /** 滚动 10 分钟内的 429 次数 */
  rateLimitCount: z.number().int(),
  checkedAt: z.string().nullable(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

/**
 * Provider 视图。
 * 只有 apiKeyEnv（环境变量「名」）与 apiKeyPresent（是否已配置），
 * 绝不返回密钥值本身——REQ §13 的脱敏要求在契约层就必须成立。
 */
export const ProviderViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['openai-compatible', 'anthropic']), // D-17：P0 只实现前者
  baseUrl: z.string(),
  /** 环境变量名，如 'DEEPSEEK_API_KEY'。只写名不写值 */
  apiKeyEnv: z.string(),
  /** 该环境变量当前是否非空。用于 UI 提示「凭证缺失」，不泄漏任何内容 */
  apiKeyPresent: z.boolean(),
  models: z.array(z.string()),
  health: ProviderHealthSchema,
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** 别名映射行（HANDOFF 的 MAPPINGS 表）。P0 只读——改映射就是改 providers.yaml 然后重启 */
export const ModelAliasViewSchema = z.object({
  alias: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  model: z.string(),
  /**
   * 引用该别名的**绑定**数，对应设计稿的「9 个槽位」。
   *
   * 早先写的是「槽位类型数」，照字面实现会让 `structure` 别名恒为 0——
   * 它只被 `bindings.createStructure` 引用，而那不是槽位类型。
   * 这一栏存在的目的是回答「改掉这个别名会影响到谁」，报 0 等于说「随便改」。
   * 因此 `createStructure` 与 `fillSlotByType` 两处都计入，
   * 范围是全部加载成功的模板。
   */
  usageCount: z.number().int(),
});
export type ModelAliasView = z.infer<typeof ModelAliasViewSchema>;

/** `GET /api/providers/defaults`。concurrentSlots 固定 1 且不可编辑（D-04） */
export const ExecutionDefaultsSchema = z.object({
  timeoutMs: z.number().int(),
  maxRetries: z.number().int(),
  concurrentSlots: z.literal(1),
  rateLimitBackoff: z.object({
    strategy: z.literal('exponential'),
    initialMs: z.number().int(),
    maxMs: z.number().int(),
    /** 限流重试是独立配额，不计入 maxRetries（§4.2） */
    maxAttempts: z.number().int(),
  }),
});
export type ExecutionDefaults = z.infer<typeof ExecutionDefaultsSchema>;

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderViewSchema),
  aliases: z.array(ModelAliasViewSchema),
  defaults: ExecutionDefaultsSchema,
});
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

// ---------- SSE（§9.4） ----------

/**
 * `state` 事件只做失效通知，不带完整状态。
 * 携带完整状态会让前端出现两套状态推导逻辑（一套来自 REST，一套来自 SSE 增量），
 * 两者必然不一致；权威状态永远来自 REST。
 */
export const SseStateEventSchema = z.object({
  taskStatus: TaskStatusSchema,
  phase: TaskPhaseSchema,
  activeSlotId: z.string().nullable(),
});
export type SseStateEvent = z.infer<typeof SseStateEventSchema>;

/** 流式正文增量。不是持久事件，因此不带 id，断线重连也不补发 */
export const SseDeltaEventSchema = z.object({
  executionId: z.string(),
  text: z.string(),
});
export type SseDeltaEvent = z.infer<typeof SseDeltaEventSchema>;

/** SSE 事件名词表（trace / delta / state）。心跳是注释行，不属于事件 */
export const SseEventNameSchema = z.enum(['trace', 'delta', 'state']);
export type SseEventName = z.infer<typeof SseEventNameSchema>;
