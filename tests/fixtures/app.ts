/**
 * M3-B 的 Application 服务图夹具。
 *
 * 与 `db.ts` 的分工：那边造的是「表和行」，这边造的是「服务和它们的接线」。
 * 用真模板、真 SKILL.md、真快照冻结，而不是塞一份手写的 compiled JSON——
 * 本层的大部分 bug 恰恰藏在「从快照读回来的东西和我以为的不一样」这条缝里，
 * 用假快照测等于把那条缝盖住。
 */

import type { SseDeltaEvent } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import type { StructureProposal } from '@server/domain/structure-validation.ts';
import type { BuiltAssignmentContext } from '@server/application/context-builder.ts';
import { createAssemblyService, type AssemblyService } from '@server/application/assembly-service.ts';
import { createAssignmentService, type AssignmentService } from '@server/application/assignment-service.ts';
import { createCompletionService, type CompletionService } from '@server/application/completion-service.ts';
import { createSlotScheduler, type SlotScheduler } from '@server/application/slot-scheduler.ts';
import { createSnapshotService, type SnapshotService } from '@server/application/snapshot-service.ts';
import { createStructureService, type StructureService } from '@server/application/structure-service.ts';
import { createTaskService, type TaskService } from '@server/application/task-service.ts';
import {
  createTraceService,
  type FlushScheduler,
  type TracePublisher,
  type TraceService,
} from '@server/application/trace-service.ts';
import { createTemplateCatalog, type TemplateCatalog } from '@server/application/template-catalog.ts';
import { createTestEnv, type TestEnv } from './db.ts';
import { createTemplateWorkspace, type TemplateWorkspace } from './workspace.ts';

export interface AppEnv extends TestEnv {
  workspace: TemplateWorkspace;
  catalog: TemplateCatalog;
  snapshots: SnapshotService;
  traces: TraceService;
  structures: StructureService;
  assignments: AssignmentService;
  completions: CompletionService;
  assembly: AssemblyService;
  scheduler: SlotScheduler;
  taskService: TaskService;
  /** 事务提交之后被推出去的 trace，顺序即推送顺序 */
  published: TraceEvent[];
  /** 实时推的正文增量（不落库） */
  deltas: SseDeltaEvent[];
  /** 待触发的延迟刷盘。测试手动调用，避免依赖真实的 250ms */
  pendingFlushes: (() => void)[];
  cleanup(): Promise<void>;
}

const TEMPLATE_ID = 'zhihu-chapter';

export async function createAppEnv(): Promise<AppEnv> {
  const base = createTestEnv();
  const workspace = await createTemplateWorkspace();

  const catalog = createTemplateCatalog({
    templatesDir: workspace.templatesDir,
    skillsDir: workspace.skillsDir,
    defaults: { timeoutMs: 120_000, maxRetries: 2 },
  });

  const published: TraceEvent[] = [];
  const deltas: SseDeltaEvent[] = [];
  const publisher: TracePublisher = {
    publishTrace: (_taskId, event) => published.push(event),
    publishDelta: (_taskId, event) => deltas.push(event),
  };

  const pendingFlushes: (() => void)[] = [];
  // 手动调度器：定时刷盘变成一个可以在断言前显式触发的动作。
  // 用真定时器会让「未达阈值不落库」这条断言变成一场与 250ms 的赛跑。
  const scheduler: FlushScheduler = {
    schedule(fn) {
      pendingFlushes.push(fn);
      return () => {
        const index = pendingFlushes.indexOf(fn);
        if (index >= 0) pendingFlushes.splice(index, 1);
      };
    },
  };

  const traces = createTraceService({ uow: base.uow, publisher, scheduler });
  const snapshots = createSnapshotService({ catalog, uow: base.uow, newId: sequentialId('id') });
  const structures = createStructureService({ snapshots, traces });
  const assignments = createAssignmentService({
    uow: base.uow,
    traces,
    newId: sequentialId('exec'),
    newToken: sequentialId('token'),
  });
  const completions = createCompletionService({ uow: base.uow, snapshots, traces });
  const assembly = createAssemblyService({
    uow: base.uow,
    snapshots,
    traces,
    newId: sequentialId('art'),
  });

  return {
    ...base,
    workspace,
    catalog,
    snapshots,
    traces,
    structures,
    assignments,
    completions,
    assembly,
    scheduler: createSlotScheduler({ uow: base.uow }),
    taskService: createTaskService({ uow: base.uow, now: () => Date.UTC(2026, 0, 1, 0, 5, 0) }),
    published,
    deltas,
    pendingFlushes,
    async cleanup() {
      base.close();
      await workspace.cleanup();
    },
  };
}

/** 确定性 ID：测试断言得起来，也让失败时的 dump 可读 */
function sequentialId(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** 建一个 ready/structure 的任务，返回 taskId */
export async function seedNewTask(env: AppEnv, packet = '第三章：雨夜的对峙'): Promise<string> {
  const created = await env.snapshots.createTask({
    templateId: TEMPLATE_ID,
    name: '第三章',
    input: { chapter_packet: packet },
  });
  return created.task.id;
}

/** 一份形状合法的上下文，用于不关心渲染内容的事务测试 */
export function fakeContext(tag: string): BuiltAssignmentContext {
  return {
    operation: 'create_structure',
    systemText: `system-${tag}`,
    userText: `user-${tag}`,
    contextJson: `{"tag":"${tag}"}`,
    contextHash: `ctx-${tag}`,
    promptHash: `prompt-${tag}`,
  };
}

/** 把任务推进到 running/structure 并建好结构 Assignment */
export function startStructureAssignment(env: AppEnv, taskId: string): { executionId: string; token: string } {
  env.uow.run((uow) => uow.tasks.update(taskId, { status: 'running' }));
  const assignment = env.assignments.create({
    taskId,
    operation: 'create_structure',
    targetSlotId: null,
    binding: {
      agentId: 'structure_designer',
      skillId: 'chapter-structure-design',
      skillVersion: '1.0.0',
      modelAlias: 'structure',
    },
    resolved: { provider: 'deepseek', model: 'deepseek-chat' },
    context: fakeContext('structure'),
    attemptNumber: env.assignments.nextAttemptNumber(taskId, null),
  });
  return { executionId: assignment.id, token: assignment.token };
}

/** 一份能通过全部 19 条校验的结构提案 */
export const VALID_PROPOSAL: StructureProposal = {
  rootSlotId: 'chapter',
  slots: [
    { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '整章容器', dependsOn: [] },
    {
      id: 'outline',
      type: 'chapter_outline',
      parentId: 'chapter',
      order: 0,
      instruction: '列出三个场景的目标与冲突',
      dependsOn: [],
    },
    { id: 'title', type: 'title', parentId: 'chapter', order: 1, instruction: '拟定单章标题', dependsOn: [] },
    {
      id: 'scene_01',
      type: 'scene',
      parentId: 'chapter',
      order: 2,
      instruction: '雨夜对峙的开场',
      dependsOn: ['outline'],
    },
  ],
};

/** 建一个 fill_slot Assignment（任务须已在 running/slots） */
export function startSlotAssignment(
  env: AppEnv,
  taskId: string,
  slotId: string,
  binding: { agentId: string; skillId: string; skillVersion: string; modelAlias: string } = {
    agentId: 'chapter_writer',
    skillId: 'scene-writing',
    skillVersion: '1.0.0',
    modelAlias: 'main',
  },
): { executionId: string; token: string } {
  const assignment = env.assignments.create({
    taskId,
    operation: 'fill_slot',
    targetSlotId: slotId,
    binding,
    resolved: { provider: 'deepseek', model: 'deepseek-chat' },
    context: { ...fakeContext(slotId), operation: 'fill_slot' },
    attemptNumber: env.assignments.nextAttemptNumber(taskId, slotId),
  });
  return { executionId: assignment.id, token: assignment.token };
}
