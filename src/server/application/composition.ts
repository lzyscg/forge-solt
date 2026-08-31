/**
 * 组合根（composition root）。
 *
 * 全系统只有这一个文件知道「谁依赖谁」。各 service 都只声明自己需要的接口，
 * 由这里一次性把图接起来——包括 M3-A 的 runtime port 与 M3-B 的 application service
 * 之间那层适配（见 `runtime-ports.ts`）。
 *
 * 为什么单独一个文件而不是在 `main.ts` 里现拼：CLI（`cli/run-task.ts`）、
 * 集成测试、HTTP 服务三者需要**同一张图**，只是入口不同。拼三遍必然漂移，
 * 而漂移的表现是「CLI 跑得通、服务跑不通」这种最难查的差异。
 */

import type { ForgeDb } from '@server/infrastructure/database/db.ts';
import { createUow } from '@server/infrastructure/uow.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';
import type { ProviderAdapter } from '@server/runtime/provider/provider-adapter.ts';
import type { ProviderConfig, ProviderEntry } from './provider-config.ts';
import { createTemplateCatalog, type TemplateCatalog } from './template-catalog.ts';
import { createSnapshotService, type SnapshotService } from './snapshot-service.ts';
import { createTraceService, type TraceService } from './trace-service.ts';
import { createAssignmentService, type AssignmentService } from './assignment-service.ts';
import { createStructureService, type StructureService } from './structure-service.ts';
import { createCompletionService, type CompletionService } from './completion-service.ts';
import { createSlotScheduler, type SlotScheduler } from './slot-scheduler.ts';
import { createAssemblyService, type AssemblyService } from './assembly-service.ts';
import { createTaskService, type TaskService } from './task-service.ts';
import { createTemplateService, type TemplateService } from './template-service.ts';
import { createProviderService, type ProviderService } from './provider-service.ts';
import { createProductionEngine, type ProductionEngine } from './production-engine.ts';
import { createLifecycleService, type LifecycleService } from './lifecycle-service.ts';
import { createSseHub, type SseHub } from '@server/infrastructure/sse-hub.ts';

export interface ForgeApp {
  uow: UnitOfWorkHandle<UnitOfWork>;
  catalog: TemplateCatalog;
  snapshots: SnapshotService;
  traces: TraceService;
  assignments: AssignmentService;
  structure: StructureService;
  completion: CompletionService;
  scheduler: SlotScheduler;
  assembly: AssemblyService;
  tasks: TaskService;
  templates: TemplateService;
  providers: ProviderService;
  engine: ProductionEngine;
  lifecycle: LifecycleService;
  registry: ProviderRegistry;
  /**
   * SSE 中枢。**无条件创建**，即便是 CLI 也有一个。
   *
   * 让它可选会立刻回到「谁来接线」的死结：TraceService 在构造时就要拿到
   * publisher，而 Hub 要读 TaskService，TaskService 又在 TraceService 之后建。
   * 无条件创建把这个环压成一条直线，代价只是 CLI 多一个空 Map 和一个
   * unref 过的定时器——它既不占内存也不吊住进程退出。
   */
  sse: SseHub;
}

export interface BuildAppOptions {
  db: ForgeDb;
  providers: ProviderConfig;
  templatesDir: string;
  skillsDir: string;
  /** 注入 FakeProvider 用。返回 null 表示该 kind 在 P0 未实现（D-17 的 anthropic） */
  adapterFactory?: (entry: ProviderEntry) => ProviderAdapter | null;
  env?: NodeJS.ProcessEnv;
  /** 心跳间隔。测试传一个假的调度器进来同步触发，见 sse-hub.ts */
  startHeartbeat?: (fn: () => void, intervalMs: number) => () => void;
}

export function buildApp(options: BuildAppOptions): ForgeApp {
  const uow = createUow(options.db);

  const registry = new ProviderRegistry({
    config: options.providers,
    ...(options.adapterFactory !== undefined ? { adapterFactory: options.adapterFactory } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const catalog = createTemplateCatalog({
    templatesDir: options.templatesDir,
    skillsDir: options.skillsDir,
    defaults: {
      timeoutMs: options.providers.defaults.timeoutMs,
      maxRetries: options.providers.defaults.maxRetries,
    },
    // D-19：别名打错字在模板编译期就炸，不等任务跑起来烧掉一次 Assignment
    knownAliases: new Set(Object.keys(options.providers.aliases)),
  });

  /**
   * Hub 与 TaskService 互相需要：Hub 要读状态与轨迹，而 TaceService 要在构造时
   * 就拿到 Hub 当 publisher，TaskService 又建在 TraceService 之后。
   *
   * 用一个「稍后填上」的引用打破这个环。安全性不靠自觉：`buildApp` 是同步的，
   * 而 Hub 的两个读口只有在**有人订阅或有 trace 推送**时才会被调到，
   * 那必然发生在本函数返回之后。下面的赋值是无条件的，不存在忘记填的分支。
   */
  let taskReader: TaskService | null = null;
  const sse = createSseHub({
    readState: (taskId) => taskReader?.getStreamState(taskId) ?? null,
    readTraces: (taskId, readOptions) => taskReader?.listTraces(taskId, readOptions).events ?? [],
    ...(options.startHeartbeat !== undefined ? { startHeartbeat: options.startHeartbeat } : {}),
  });

  const traces = createTraceService({ uow, publisher: sse });
  // registry 当 AliasChains 用：降级挑档只需要 chainOf / listAliases 两个只读方法（D-67）
  const snapshots = createSnapshotService({ catalog, uow, aliases: registry });
  const assignments = createAssignmentService({ uow, traces });
  const structure = createStructureService({ snapshots, traces });
  const completion = createCompletionService({ uow, snapshots, traces });
  const scheduler = createSlotScheduler({ uow, snapshots });
  const assembly = createAssemblyService({ uow, snapshots, traces });

  /**
   * §8.3：stop 事务**提交之后**要同步拿到 controller 去 abort。
   * 引擎登记、lifecycle 读取，所以这张表由组合根持有，两边共享同一个引用。
   */
  const activeControllers = new Map<string, AbortController>();

  const engine = createProductionEngine({
    uow,
    snapshots,
    assignments,
    completion,
    structure,
    scheduler,
    assembly,
    traces,
    registry,
    rateLimitBackoff: options.providers.defaults.rateLimitBackoff,
    activeControllers,
  });

  const lifecycle = createLifecycleService({ traces, engine, activeControllers });

  // D-14：排队位次由引擎给，TaskService 只负责投影。
  // 反过来（TaskService 自己维护一份队列）会立刻有两份队列状态。
  const tasks = createTaskService({ uow, queue: { positionOf: engine.positionOf } });
  taskReader = tasks;
  // registry 直接当 AliasPeek 用：`describeAlias` 是它的只读窗口，
  // 不碰 adapter 也不读环境变量（见该方法的注释）
  const templates = createTemplateService({ catalog, uow, aliases: registry, tasks });
  const providers = createProviderService({ registry, catalog, config: options.providers });

  return {
    uow,
    catalog,
    snapshots,
    traces,
    assignments,
    structure,
    completion,
    scheduler,
    assembly,
    tasks,
    templates,
    providers,
    engine,
    lifecycle,
    registry,
    sse,
  };
}
