/**
 * 任务查询与 DTO 投影（文档 §3.5 契约 + §6.5 / D-07 / D-14 / D-19 + 附录 B）。
 *
 * 本文件把领域对象翻译成 `@shared/contracts.ts` 里的 DTO。它是**唯一**允许调用
 * `derive*Presentation` 的地方——D-07 的全部价值在于「同一套业务判断只有一份实现」，
 * 多一个调用点就多一处会漂移的口径。
 *
 * ## 与文档 §9.2 的差异（M3-B 修订）
 *
 * §9.2 把投影层画在 `api/dto/`，并写明「这是唯一允许调用 derive*Presentation 的地方」。
 * 实际实现放在 application 层，理由有二：
 *
 * 1. **投影需要跨多个仓储取数**：一个 `TaskDetail` 要 tasks + slots + executions +
 *    artifacts + task_snapshots 五张表，还要解冻结快照拿槽位类型名与 Agent 名。
 *    这是编排，不是搬运；放进 `api/dto/` 就等于让 HTTP 层直接持有六个仓储。
 * 2. **CLI 也要它**（§12 M3 的 `run-task.ts` 无 UI 无网络），而 CLI 不该经过 api 层。
 *
 * §9.2 的实质约束「DTO 层不得包含业务判断，所有 if/else 都在 domain 的 derive* 里」
 * 原样保留并在此生效：本文件不判断任何状态语义，只取数、调 derive*、搬字段。
 * 文档 §9.2 已相应修订。
 *
 * ## 为什么模板名取自冻结快照而不是 TemplateCatalog
 *
 * 任务展示的应该是**它创建时**那份模板的名字（AC-002 快照隔离）。
 * 从磁盘上的 `template.yaml` 现读，会让改一次模板名把所有历史任务的显示都改掉，
 * 而那些任务用的根本不是这份模板。快照不可变，因此按 snapshotId 缓存是安全的。
 *
 * ## 时间不是本层的判断依据，但确实要读
 *
 * `elapsedMs` / `durationMs` 需要「现在」。domain 的派生函数刻意不读时钟
 * （AC-013 确定性），所以由本层注入 `now` 并把结果算好传进去。
 * 注入而非直接 `Date.now()`：投影的快照测试要能断言确定的秒数。
 */

import type {
  ArtifactView,
  ExecutionView,
  FlowFinding,
  SlotDetail,
  SlotFlowView,
  SlotView,
  SseStateEvent,
  StepperKey,
  TaskDetail,
  TaskSummary,
  TraceListResponse,
} from '@shared/contracts.ts';
import type { PublicError } from '@shared/errors.ts';
import { DEFAULT_ERROR_ACTION, ForgeError } from '@shared/errors.ts';
import type { TraceEvent } from '@shared/trace.ts';
import type { Execution, Slot, Task } from '@server/domain/types.ts';
import { deriveSlotPresentation, deriveTaskPresentation } from '@server/domain/presentation.ts';
import {
  deriveSlotFlow,
  type FlowCriterion,
  type FlowReviewRecord,
  type FlowSettlement,
  type FlowSubmission,
} from '@server/domain/production-flow.ts';
import {
  blockedBy,
  computeDepth,
  documentOrder,
  selectNextReadySlot,
} from '@server/domain/readiness.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import { reviewBindingOf } from './review-binding.ts';
import type { CompiledTemplate } from './template-loader.ts';

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/**
 * D-14：排队位置。
 *
 * 排队中与真正在跑共用 `status='running'`，靠 `queuePosition` 区分（D-19 第 7 条）。
 * 队列住在 `ProductionEngine` 里（M3-C），本层只声明需要的那一个能力。
 * 缺省实现恒返回 null——CLI 与单测没有队列，而「没有队列」的正确表达是
 * 「不在排队」，不是「排在第 0 位」。
 */
export interface TaskQueueView {
  positionOf(taskId: string): number | null;
}

const noQueue: TaskQueueView = { positionOf: () => null };

export interface TaskServiceOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  queue?: TaskQueueView;
  /** 注入时钟；返回毫秒时间戳。默认 `Date.now` */
  now?: () => number;
}

export interface TaskService {
  listTasks(options?: { limit?: number }): TaskSummary[];
  getTaskSummary(taskId: string): TaskSummary;
  getTaskDetail(taskId: string): TaskDetail;
  listSlots(taskId: string): SlotView[];
  getSlotDetail(taskId: string, slotId: string): SlotDetail;
  /**
   * 右栏「生产过程」视图：把该槽位的执行序列折成轮次。
   *
   * 与 `getSlotDetail` 分开是因为两者的代价差一个量级——流程要多读
   * slot_reviews 与结算轨迹，而绝大多数打开右栏的场景只想看正文。
   * 合成一个端点等于让每次选中槽位都付这份钱。
   */
  getSlotFlow(taskId: string, slotId: string): SlotFlowView;
  listExecutions(taskId: string): ExecutionView[];
  /** `content` 仅在 `includeContent` 为 true 时返回，避免把整章正文塞进任务详情 */
  getArtifact(taskId: string, options?: { includeContent?: boolean }): ArtifactView | null;
  /**
   * 产物端点用。与 `getArtifact` 的差别全在**两种「没有」要分开报**：
   * 任务不存在 → `TASK_NOT_FOUND`，任务在但还没组装 → `ARTIFACT_NOT_FOUND`。
   * 合成一个 404 会让「任务 ID 打错了」和「任务还没跑完」显示成同一句话，
   * 而这两者的下一步动作完全不同。
   */
  getArtifactOrThrow(taskId: string, options?: { includeContent?: boolean }): ArtifactView;
  listTraces(taskId: string, options?: { after?: number; limit?: number }): TraceListResponse;
  /**
   * §9.4 的 `state` 事件载荷。任务不存在时返回 null。
   *
   * 刻意只有三个字段——它是**失效通知**，不是状态快照。带上完整状态会让前端
   * 长出第二套状态推导逻辑（一套来自 REST，一套来自 SSE 增量），两者必然不一致。
   * 权威状态永远来自 REST（TECH-V0.1 §3.4）。
   */
  getStreamState(taskId: string): SseStateEvent | null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const STEPPER_LABEL: Record<StepperKey, string> = {
  input: '输入',
  structure: '创建结构',
  slots: '填充槽位',
  assembly: '组装产物',
  done: '完成',
};

/**
 * 各段的负责方。
 *
 * 「输入 / 组装 / 完成」是系统的确定性动作，「创建结构 / 填充槽位」才有 Agent 参与。
 * 这个区分直接对应 REQ「系统侧 vs Agent 侧」的边界，UI 据此决定右栏显示
 * 「系统组装」还是某个 Agent 的工作面板（任务工作台的 PanelSubject）。
 */
const STEPPER_OWNER: Record<StepperKey, 'system' | 'agent'> = {
  input: 'system',
  structure: 'agent',
  slots: 'agent',
  assembly: 'system',
  done: 'system',
};

const STEPPER_KEYS: readonly StepperKey[] = ['input', 'structure', 'slots', 'assembly', 'done'];

/** phase → stepper 段序号。`input` 恒为 0，它在任务创建时就完成了（输入已冻结） */
const PHASE_INDEX: Record<Task['phase'], number> = {
  structure: 1,
  slots: 2,
  assembly: 3,
  done: 4,
};

function toPublicError(code: string | null, message: string | null, location: string | null): PublicError | null {
  if (code === null) return null;
  const errorCode = code as keyof typeof DEFAULT_ERROR_ACTION;
  return {
    code: errorCode,
    message: message ?? '未提供失败原因',
    location,
    // API 层的 `action` 兜底表在这里就用上：DTO 一旦出网就没有第二次补的机会，
    // 而 UX §18.8 要求「没有可执行下一步时不显示按钮」，null 是有意义的取值。
    action: DEFAULT_ERROR_ACTION[errorCode] ?? null,
  };
}

function durationOf(execution: Execution, now: number): number | null {
  if (execution.startedAt === null) return null;
  const started = Date.parse(execution.startedAt);
  const finished = execution.finishedAt === null ? now : Date.parse(execution.finishedAt);
  const elapsed = finished - started;
  // 时钟回拨或时间戳损坏时给 0 而不是负数：负的「已耗时」在界面上是纯噪音
  return elapsed < 0 ? 0 : elapsed;
}

// ---------------------------------------------------------------------------

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { uow } = options;
  const queue = options.queue ?? noQueue;
  const now = options.now ?? ((): number => Date.now());

  /**
   * 冻结快照的 `CompiledTemplate` 缓存。
   *
   * 按 snapshotId 缓存而不是 taskId：快照表没有任何 update 入口（M2 的 SnapshotRepo
   * 只有 insert 与读），所以同一个 snapshotId 的 compiled_json 永不改变，
   * 缓存不会陈旧。这里刻意不复用 `SnapshotService.readSnapshot`——
   * 那个方法还要解全部 Skill 快照并重算一遍 hash，
   * 而列表页渲染 50 个任务只需要模板名和槽位类型名。
   */
  const compiledCache = new Map<string, CompiledTemplate>();

  const compiledFor = (task: Task): CompiledTemplate => {
    const cached = compiledCache.get(task.snapshotId);
    if (cached !== undefined) return cached;
    const snapshot = uow.repositories.snapshots.getByTaskOrThrow(task.id);
    let compiled: CompiledTemplate;
    try {
      compiled = JSON.parse(snapshot.compiledJson) as CompiledTemplate;
    } catch (error) {
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${task.id} 的模板快照无法解析`,
        `task:${task.id}`,
        '请查看服务日志',
        error,
      );
    }
    compiledCache.set(task.snapshotId, compiled);
    return compiled;
  };

  /**
   * 冻结快照里某个 Skill 的判据表（= sections，按书写顺序）。
   *
   * 与 `compiledCache` 同一条理由按 snapshotId 缓存：快照表没有 update 入口，
   * 同一个 snapshotId 下的 section_index_json 永不改变。
   *
   * 刻意**不复用 `SnapshotService.readSnapshot`**：那个方法要解全部 Skill 快照
   * 并重算一遍 contentHash，而这里只需要一份 Skill 的章节标题。
   */
  const criteriaCache = new Map<string, readonly FlowCriterion[]>();

  const criteriaOf = (task: Task, skillId: string): readonly FlowCriterion[] => {
    const key = `${task.snapshotId}:${skillId}`;
    const cached = criteriaCache.get(key);
    if (cached !== undefined) return cached;

    const row = uow.repositories.snapshots.getSkill(task.id, skillId);
    // 绑定指向的 Skill 不在快照里 = 快照与模板对不上。这不该让整个面板打不开，
    // 给空判据表即可：界面会显示成「没有判据」，而审核节点仍然按推断的 ID 画出来。
    if (row === null) return [];

    let sections: readonly { id: string; title: string }[];
    try {
      sections = (JSON.parse(row.sectionIndexJson) as { sections: { id: string; title: string }[] })
        .sections;
    } catch (error) {
      throw new ForgeError(
        'STORAGE_ERROR',
        `任务 ${task.id} 的 Skill 快照「${skillId}」无法解析`,
        `task:${task.id}`,
        '请查看服务日志',
        error,
      );
    }
    const criteria = sections.map((section) => ({ id: section.id, title: section.title }));
    criteriaCache.set(key, criteria);
    return criteria;
  };

  const agentNameOf = (compiled: CompiledTemplate, agentId: string): string =>
    // 找不到就退回 ID 而不是「Agent」：一个陌生的 ID 至少能查，
    // 一个通用词只会把「快照与绑定对不上」这件事盖住（D-19 第 4 条的同一条纪律）。
    compiled.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  const slotTypeNameOf = (compiled: CompiledTemplate, typeId: string): string =>
    compiled.slotTypes.find((type) => type.id === typeId)?.name ?? typeId;

  /**
   * 「上次失败原因」（D-19）。
   *
   * 取的是**同一目标上、当前这次之外、最近一次已成文的失败**。
   * 本层只取用不解析——那句话是 `CompletionService.failSlot` /
   * `StructureService` 写进去的完整中文，附录 B.1 第 3/5 行与 B.2 第 5 行直接展示它。
   */
  const lastFailureReasonOf = (
    executions: readonly Execution[],
    targetSlotId: string | null,
    currentExecutionId: string | null,
  ): string | null => {
    // listByTask 已按 created_at 倒序，第一条命中的就是最近一次
    for (const execution of executions) {
      if (execution.id === currentExecutionId) continue;
      if (execution.targetSlotId !== targetSlotId) continue;
      if (execution.errorMessage === null) continue;
      return execution.errorMessage;
    }
    return null;
  };

  /** 停止时的中断点：文档序中第一个未完成的内容槽位（stop 已把 running 放回 pending） */
  const interruptionPointOf = (slots: readonly Slot[]): string | null =>
    documentOrder(slots).find((slot) => slot.contentBearing && slot.status !== 'completed')
      ?.slotId ?? null;

  const toSlotView = (
    slot: Slot,
    context: {
      slots: readonly Slot[];
      compiled: CompiledTemplate;
      task: Task;
      executions: readonly Execution[];
      activeExecution: Execution | null;
      interruptionSlotId: string | null;
      timestamp: number;
    },
  ): SlotView => {
    const isActive = context.activeExecution?.targetSlotId === slot.slotId;
    const activeAttempt = isActive ? (context.activeExecution?.attemptNumber ?? null) : null;
    const elapsedMs =
      isActive && context.activeExecution !== null
        ? durationOf(context.activeExecution, context.timestamp)
        : null;

    const presentation = deriveSlotPresentation({
      slot,
      allSlots: context.slots,
      activeAttempt,
      lastFailureReason: lastFailureReasonOf(
        context.executions,
        slot.slotId,
        context.activeExecution?.id ?? null,
      ),
      elapsedMs,
      taskStatus: context.task.status,
      isInterruptionPoint: context.interruptionSlotId === slot.slotId,
      // D-19 第 4 条：running 期间 `slot.producer` 恒为 null，agentName 只能从
      // 当前 execution 解析。解析不出就传 null（派生层会省略主语），不编造。
      agentName:
        isActive && context.activeExecution !== null
          ? agentNameOf(context.compiled, context.activeExecution.agentId)
          : null,
    });

    const producerExecution =
      slot.producer === null
        ? null
        : (context.executions.find((e) => e.id === slot.producer?.executionId) ?? null);

    return {
      id: slot.slotId,
      type: slot.type,
      typeName: slotTypeNameOf(context.compiled, slot.type),
      parentId: slot.parentId,
      order: slot.sortOrder,
      depth: depthOf(context.slots, slot.slotId),
      path: pathOf(context.slots, slot),
      instruction: slot.instruction,
      dependsOn: [...slot.dependsOn],
      contentBearing: slot.contentBearing,
      includeInArtifact: slot.includeInArtifact,
      status: slot.status,
      revisionRound: slot.revisionRound,
      reviewExhausted: slot.reviewExhausted,
      presentation: {
        tone: presentation.tone,
        state: presentation.state,
        detail: presentation.detail,
      },
      blockedBy: presentation.blockedBy,
      charCount: presentation.charCount,
      producer:
        slot.producer === null
          ? null
          : {
              agentId: slot.producer.agentId,
              agentName: agentNameOf(context.compiled, slot.producer.agentId),
              skillId: slot.producer.skillId,
              skillVersion: slot.producer.skillVersion,
              executionId: slot.producer.executionId,
              durationMs:
                producerExecution === null
                  ? 0
                  : (durationOf(producerExecution, context.timestamp) ?? 0),
            },
      error: toPublicError(slot.errorCode, slot.errorMessage, `slot:${slot.slotId}`),
    };
  };

  const toExecutionView = (
    execution: Execution,
    compiled: CompiledTemplate,
    timestamp: number,
  ): ExecutionView => ({
    id: execution.id, // D-09：Assignment ID 与 Execution ID 同值
    taskId: execution.taskId,
    operation: execution.operation,
    targetSlotId: execution.targetSlotId,
    agentId: execution.agentId,
    agentName: agentNameOf(compiled, execution.agentId),
    skillId: execution.skillId,
    skillVersion: execution.skillVersion,
    modelAlias: execution.modelAlias,
    provider: execution.provider,
    model: execution.model,
    attemptNumber: execution.attemptNumber,
    status: execution.status,
    contextHash: execution.contextHash,
    promptHash: execution.promptHash, // D-12：两个 hash 并列展示（UX §13.5）
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    durationMs: durationOf(execution, timestamp),
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    createdAt: execution.createdAt,
    error: toPublicError(
      execution.errorCode,
      execution.errorMessage,
      execution.targetSlotId === null ? null : `slot:${execution.targetSlotId}`,
    ),
  });

  const toArtifactView = (
    artifact: { id: string; taskId: string; fileName: string; mediaType: string; content: string; checksum: string; byteSize: number; createdAt: string },
    includeContent: boolean,
  ): ArtifactView => ({
    id: artifact.id,
    taskId: artifact.taskId,
    fileName: artifact.fileName,
    mediaType: artifact.mediaType,
    byteSize: artifact.byteSize,
    checksum: artifact.checksum,
    content: includeContent ? artifact.content : null,
    createdAt: artifact.createdAt,
  });

  /**
   * 任务级 presentation 的输入装配。
   *
   * 唯一稍复杂的是 `currentSlotTypeName`：附录 B.1 第 6 行要显示
   *「scene_03 场景正文生成中」，其中「场景正文」是槽位**类型名**而非类型 ID。
   */
  const taskPresentationOf = (
    task: Task,
    slots: readonly Slot[],
    compiled: CompiledTemplate,
    activeExecution: Execution | null,
    executions: readonly Execution[],
  ): TaskSummary['presentation'] => {
    const running = documentOrder(slots).find((slot) => slot.status === 'running') ?? null;
    return deriveTaskPresentation({
      task,
      slots,
      activeExecution,
      currentSlotTypeName: running === null ? null : slotTypeNameOf(compiled, running.type),
      queuePosition: queue.positionOf(task.id),
      lastFailureReason: lastFailureReasonOf(
        executions,
        activeExecution?.targetSlotId ?? null,
        activeExecution?.id ?? null,
      ),
    });
  };

  const summaryOf = (task: Task): TaskSummary => {
    const compiled = compiledFor(task);
    const slots = uow.repositories.slots.listByTask(task.id);
    const executions = uow.repositories.executions.listByTask(task.id);
    const activeExecution =
      task.activeExecutionId === null
        ? null
        : (executions.find((execution) => execution.id === task.activeExecutionId) ?? null);
    const contentSlots = slots.filter((slot) => slot.contentBearing);

    return {
      id: task.id,
      name: task.name,
      templateId: compiled.id,
      templateName: compiled.name,
      status: task.status,
      phase: task.phase,
      presentation: taskPresentationOf(task, slots, compiled, activeExecution, executions),
      doneSlots: contentSlots.filter((slot) => slot.status === 'completed').length,
      totalSlots: contentSlots.length,
      updatedAt: task.updatedAt,
    };
  };

  return {
    listTasks(listOptions) {
      return uow.repositories.tasks.listRecent(listOptions?.limit ?? 50).map(summaryOf);
    },

    getTaskSummary(taskId) {
      return summaryOf(uow.repositories.tasks.getOrThrow(taskId));
    },

    getTaskDetail(taskId) {
      const timestamp = now();
      const { tasks, slots: slotRepo, executions: executionRepo, artifacts, snapshots } = uow.repositories;
      const task = tasks.getOrThrow(taskId);
      const compiled = compiledFor(task);
      const snapshot = snapshots.getByTaskOrThrow(taskId);
      const slots = slotRepo.listByTask(taskId);
      const executions = executionRepo.listByTask(taskId);
      const activeExecution =
        task.activeExecutionId === null
          ? null
          : (executions.find((execution) => execution.id === task.activeExecutionId) ?? null);
      const artifact = artifacts.getByTask(taskId);
      const interruptionSlotId = task.status === 'stopped' ? interruptionPointOf(slots) : null;

      const context = {
        slots,
        compiled,
        task,
        executions,
        activeExecution,
        interruptionSlotId,
        timestamp,
      };
      const slotViews = documentOrder(slots).map((slot) => toSlotView(slot, context));
      const contentSlots = slots.filter((slot) => slot.contentBearing);

      return {
        id: task.id,
        name: task.name,
        templateId: compiled.id,
        templateName: compiled.name,
        status: task.status,
        phase: task.phase,
        presentation: taskPresentationOf(task, slots, compiled, activeExecution, executions),
        doneSlots: contentSlots.filter((slot) => slot.status === 'completed').length,
        totalSlots: contentSlots.length,
        updatedAt: task.updatedAt,
        input: { ...task.input },
        snapshotHash: snapshot.snapshotHash,
        slots: slotViews,
        stepper: buildStepper(task, compiled, slots, artifact),
        activeExecution:
          activeExecution === null ? null : toExecutionView(activeExecution, compiled, timestamp),
        plannedAssignment: buildPlannedAssignment(task, compiled, slots, activeExecution),
        queuePosition: queue.positionOf(task.id),
        artifact: artifact === null ? null : toArtifactView(artifact, false),
        error: toPublicError(task.errorCode, task.errorMessage, `task:${task.id}`),
      };
    },

    listSlots(taskId) {
      const timestamp = now();
      const task = uow.repositories.tasks.getOrThrow(taskId);
      const compiled = compiledFor(task);
      const slots = uow.repositories.slots.listByTask(taskId);
      const executions = uow.repositories.executions.listByTask(taskId);
      const activeExecution =
        task.activeExecutionId === null
          ? null
          : (executions.find((execution) => execution.id === task.activeExecutionId) ?? null);
      const context = {
        slots,
        compiled,
        task,
        executions,
        activeExecution,
        interruptionSlotId: task.status === 'stopped' ? interruptionPointOf(slots) : null,
        timestamp,
      };
      return documentOrder(slots).map((slot) => toSlotView(slot, context));
    },

    getSlotDetail(taskId, slotId) {
      const view = this.listSlots(taskId).find((slot) => slot.id === slotId);
      if (view === undefined) {
        throw new ForgeError('SLOT_NOT_FOUND', `槽位 ${slotId} 不存在`, `slot:${slotId}`);
      }
      const slot = uow.repositories.slots.getOrThrow(taskId, slotId);
      // 正文单独在详情里返回而不进列表：50 个槽位的任务里列表响应会膨胀到不可接受
      return { ...view, content: slot.contentText };
    },

    getSlotFlow(taskId, slotId) {
      const task = uow.repositories.tasks.getOrThrow(taskId);
      const slot = uow.repositories.slots.getOrThrow(taskId, slotId);
      const compiled = compiledFor(task);

      // 没有审核绑定是合法默认（D-27）：判据表为空，流程里就只有填槽节点。
      const binding = reviewBindingOf(compiled, slot);
      const criteria = binding === null ? [] : criteriaOf(task, binding.skillId);

      const flow = deriveSlotFlow({
        slotId,
        executions: uow.repositories.executions.listByTask(taskId),
        reviews: uow.repositories.slotReviews
          .listBySlot(taskId, slotId)
          .map((row): FlowReviewRecord => ({
            criterionId: row.criterionId,
            executionId: row.executionId,
            verdict: row.verdict,
            findings: parseFindings(row.findingsJson, taskId, slotId),
          })),
        criteria,
        settlements: settlementsOf(uow.repositories.traces.listSettlements(taskId), slotId),
        submissions: submissionsOf(uow.repositories.traces.listSubmissions(taskId)),
      });

      return {
        slotId: flow.slotId,
        calls: flow.calls,
        inputTokens: flow.inputTokens,
        outputTokens: flow.outputTokens,
        criteria: criteria.map((criterion) => ({ id: criterion.id, title: criterion.title })),
        rounds: flow.rounds.map((round) => ({
          round: round.round,
          fills: round.fills.map((node) => ({
            executionId: node.executionId,
            attemptNumber: node.attemptNumber,
            status: node.status,
            inputTokens: node.inputTokens,
            outputTokens: node.outputTokens,
            durationMs: node.durationMs,
            error: toPublicError(node.errorCode, node.errorMessage, `slot:${slotId}`),
            edits: node.edits,
          })),
          reviews: round.reviews.map((node) => ({
            executionId: node.executionId,
            attemptNumber: node.attemptNumber,
            status: node.status,
            inputTokens: node.inputTokens,
            outputTokens: node.outputTokens,
            durationMs: node.durationMs,
            error: toPublicError(node.errorCode, node.errorMessage, `slot:${slotId}`),
            criterionId: node.criterionId,
            criterionTitle: node.criterionTitle,
            criterionInferred: node.criterionInferred,
            verdict: node.verdict,
            findings: node.findings.map((finding) => ({
              quote: finding.quote,
              problem: finding.problem,
            })),
          })),
          firedCount: round.firedCount,
          cleanCount: round.cleanCount,
          settlement: round.settlement,
        })),
        ending: flow.ending,
      };
    },

    listExecutions(taskId) {
      const timestamp = now();
      const task = uow.repositories.tasks.getOrThrow(taskId);
      const compiled = compiledFor(task);
      return uow.repositories.executions
        .listByTask(taskId)
        .map((execution) => toExecutionView(execution, compiled, timestamp));
    },

    getArtifact(taskId, artifactOptions) {
      const artifact = uow.repositories.artifacts.getByTask(taskId);
      return artifact === null
        ? null
        : toArtifactView(artifact, artifactOptions?.includeContent === true);
    },

    getArtifactOrThrow(taskId, artifactOptions) {
      // 先确认任务在。顺序反过来的话，一个打错的任务 ID 会得到
      // 「产物不存在」——把「查无此任务」说成「任务还没组装完」。
      uow.repositories.tasks.getOrThrow(taskId);
      const view = this.getArtifact(taskId, artifactOptions);
      if (view === null) {
        throw new ForgeError(
          'ARTIFACT_NOT_FOUND',
          `任务 ${taskId} 尚未组装出产物`,
          `task:${taskId}`,
          '等待任务完成后再下载',
        );
      }
      return view;
    },

    getStreamState(taskId) {
      const task = uow.repositories.tasks.get(taskId);
      if (task === null) return null;
      // 「当前槽位」取的是**真的在跑**的那个，不是「下一个该跑的」——
      // 前者是事实，后者是计划，而这个事件的用途是「有变化了，去拉」。
      const running = documentOrder(uow.repositories.slots.listByTask(taskId)).find(
        (slot) => slot.status === 'running',
      );
      return {
        taskStatus: task.status,
        phase: task.phase,
        activeSlotId: running?.slotId ?? null,
      };
    },

    listTraces(taskId, traceOptions) {
      // 任务不存在时要 404，不能返回空页。trace_events 对一个不存在的 taskId
      // 只会返回空数组，于是「ID 打错了」和「这个任务还没产生任何轨迹」
      // 在响应上完全一样——而前者应当立刻停止轮询，后者应当继续。
      uow.repositories.tasks.getOrThrow(taskId);
      const limit = traceOptions?.limit ?? 200;
      const events = uow.repositories.traces.listByTask(taskId, {
        after: traceOptions?.after ?? 0,
        limit,
      });
      const last = events[events.length - 1];
      return {
        events,
        // 只有「取满了一页」才可能还有下一页。少于 limit 时给 null，
        // 让前端停止翻页——否则它会拿着同一个游标反复空转。
        nextAfter: events.length === limit && last !== undefined ? last.sequence : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 生产流程视图的取数辅助
// ---------------------------------------------------------------------------

/**
 * `slot_reviews.findings_json` 反序列化。
 *
 * 解析失败**抛而不是吞**。吞掉的后果是这条判据在界面上显示成「未检出」——
 * 那是一条它明明报了问题却被说成没问题的假话，正是 D-30 要堵的那种。
 * 存储坏了就该让存储坏了这件事被看见。
 */
function parseFindings(json: string, taskId: string, slotId: string): FlowFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `槽位 ${slotId} 的审核意见无法解析`,
      `slot:${slotId}`,
      '请查看服务日志',
      error,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `任务 ${taskId} 槽位 ${slotId} 的审核意见不是数组`,
      `slot:${slotId}`,
      '请查看服务日志',
    );
  }
  // findings 里的 criterionId 在这一层被丢掉：它与 slot_reviews 那一行的
  // criterion_id 必然同值（一次调用只审一条判据，D-23），留着只会让前端
  // 多一个可以跟行头对不上的字段。
  return (parsed as { quote: string; problem: string }[]).map((finding) => ({
    quote: finding.quote,
    problem: finding.problem,
  }));
}

/**
 * 把结算轨迹认领到某个槽位，并读出它收口的轮号。
 *
 * 结算事件的 `executionId` 为 null（它收的是一整轮，不属于任何一次 execution），
 * 归属只能靠 `payload.slotId`——这正是 R2 那次界面缺陷的成因。
 * 读不出 `revisionRound` 的直接跳过：宁可这一轮不显示结算，也不能把它挂到错的轮上。
 */
function settlementsOf(events: readonly TraceEvent[], slotId: string): FlowSettlement[] {
  const settlements: FlowSettlement[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (payload === null || payload['slotId'] !== slotId) continue;
    const round = payload['revisionRound'];
    if (typeof round !== 'number') continue;
    settlements.push({
      round,
      kind: event.kind,
      title: event.title,
      summary: event.summary,
      createdAt: event.createdAt,
    });
  }
  return settlements;
}

/**
 * R6 / D-64：从 `assignment_submitted` 事件里取出每次提交的形态。
 *
 * `editCount` / `editedChars` 由 `complete-assignment.ts` 写进 payload，
 * **只有编辑清单那条路径才写**。取不到就是整篇提交——
 * 这里返回 `edits: null` 而不是干脆不放进表里，是为了让下游能区分
 * 「整篇提交」（有事件、无编辑）与「还没提交」（压根没有事件）。
 */
function submissionsOf(events: readonly TraceEvent[]): FlowSubmission[] {
  const submissions: FlowSubmission[] = [];
  for (const event of events) {
    if (event.executionId === null) continue;
    const payload = event.payload;
    const count = payload?.['editCount'];
    const chars = payload?.['editedChars'];
    submissions.push({
      executionId: event.executionId,
      edits:
        typeof count === 'number' && typeof chars === 'number' ? { count, chars } : null,
    });
  }
  return submissions;
}

// ---------------------------------------------------------------------------
// 派生字段：depth / path / stepper / plannedAssignment
// ---------------------------------------------------------------------------

/**
 * 服务端算好 depth（0 基），前端直接 `depth × 20px` 缩进（D-07：不让前端递归）。
 * 每次调用重算一遍整棵树的深度表，是因为槽位数是十几个的量级，
 * 缓存它需要处理失效，收益与复杂度完全不成比例。
 */
function depthOf(slots: readonly Slot[], slotId: string): number {
  return computeDepth(slots).get(slotId) ?? 0;
}

/** `['chapter','scene_03']`，中栏「位置」用。父子成环时沿链上行有上界保护 */
function pathOf(slots: readonly Slot[], slot: Slot): string[] {
  const byId = new Map<string, Slot>();
  for (const item of slots) if (!byId.has(item.slotId)) byId.set(item.slotId, item);

  const path: string[] = [slot.slotId];
  const seen = new Set<string>([slot.slotId]);
  let cursor = slot.parentId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (parent === undefined) break;
    path.unshift(parent.slotId);
    cursor = parent.parentId;
  }
  return path;
}

/**
 * UX §9.2 的五段进度条。
 *
 * `input` 恒为 done：任务一旦创建，输入就已冻结（AC-002），这一段不存在「进行中」。
 * `failed` 时当前段标 error 而不是 done——设计稿的第二行说明写着
 *「当前段转为异常，后续段不可达」。
 */
function buildStepper(
  task: Task,
  compiled: CompiledTemplate,
  slots: readonly Slot[],
  artifact: { fileName: string; byteSize: number } | null,
): TaskDetail['stepper'] {
  const contentSlots = slots.filter((slot) => slot.contentBearing);
  const done = contentSlots.filter((slot) => slot.status === 'completed').length;
  const phaseIndex = task.status === 'ready' ? 1 : PHASE_INDEX[task.phase];

  const summaryOf = (key: StepperKey): string => {
    switch (key) {
      case 'input':
        return `${compiled.inputFields.length} 个字段已冻结`;
      case 'structure':
        return slots.length === 0 ? '未创建' : `${slots.length} 个槽位`;
      case 'slots':
        return `${done} / ${contentSlots.length}`;
      case 'assembly':
        return artifact === null ? '待组装' : `${artifact.byteSize} 字节`;
      case 'done':
        return artifact === null ? '—' : artifact.fileName;
    }
  };

  return STEPPER_KEYS.map((key, index) => {
    let state: 'done' | 'current' | 'todo' | 'error';
    if (task.status === 'completed') {
      state = 'done';
    } else if (index < phaseIndex) {
      state = 'done';
    } else if (index > phaseIndex) {
      state = 'todo';
    } else if (task.status === 'failed') {
      state = 'error';
    } else if (task.status === 'ready') {
      // 待启动：结构段尚未开始，标 todo 而不是 current——current 会让进度条
      // 显示成「正在创建结构」，而实际上一个 Agent 都还没跑起来。
      state = 'todo';
    } else {
      state = 'current';
    }
    return { key, label: STEPPER_LABEL[key], state, summary: summaryOf(key), owner: STEPPER_OWNER[key] };
  });
}

/**
 * UX §12.3「计划工作」：下一次会派给谁、做什么。
 *
 * 有活动执行时为 null——那时展示的是「正在进行的工作」而不是「计划」。
 * `blockedBy` 非空表示这项计划暂时还开不了工，UI 据此显示「等待 xxx 定稿」。
 */
function buildPlannedAssignment(
  task: Task,
  compiled: CompiledTemplate,
  slots: readonly Slot[],
  activeExecution: Execution | null,
): TaskDetail['plannedAssignment'] {
  if (activeExecution !== null) return null;
  if (task.status === 'completed' || task.status === 'failed') return null;

  if (task.phase === 'structure') {
    const binding = compiled.bindings.createStructure;
    return {
      agentId: binding.agentId,
      agentName: compiled.agents.find((agent) => agent.id === binding.agentId)?.name ?? binding.agentId,
      skillId: binding.skillId,
      skillVersion: binding.skillVersion,
      operation: 'create_structure',
      targetSlotId: null,
      blockedBy: [],
    };
  }

  if (task.phase !== 'slots') return null;

  // 先看有没有真正 ready 的；没有就退回文档序里第一个未完成的内容槽位，
  // 这样「计划工作」在等待期间也能点名下一步是谁，而不是整块消失。
  const target =
    selectNextReadySlot(slots) ??
    documentOrder(slots).find((slot) => slot.contentBearing && slot.status === 'pending') ??
    null;
  if (target === null) return null;

  const binding = compiled.bindings.fillSlotByType[target.type];
  if (binding === undefined) return null;

  return {
    agentId: binding.agentId,
    agentName: compiled.agents.find((agent) => agent.id === binding.agentId)?.name ?? binding.agentId,
    skillId: binding.skillId,
    skillVersion: binding.skillVersion,
    operation: 'fill_slot',
    targetSlotId: target.slotId,
    blockedBy: blockedBy(target, slots),
  };
}
