/**
 * 模板查询与 DTO 投影（文档 §3.5 / §9.1 / §9.2 修订 / D-01 / D-02 / D-05 / D-06 / D-08）。
 *
 * 与 `task-service.ts` 是同一类角色，落在同一层，理由也相同（见 §9.2 的 M3-B 修订）：
 * 投影要跨「磁盘上的模板目录」与「数据库里的任务」两个来源取数，
 * 放进 `api/` 就等于让 HTTP 层同时持有 TemplateCatalog、ProviderRegistry 和仓储。
 *
 * ## 三条来源纪律
 *
 * 1. **`presentation` 的字段只从 `LoadedTemplate.presentation` 取。**
 *    `outputKind` / `tags` / `exampleStructure` 不在 `CompiledTemplate` 里，
 *    这是 D-02 的物理隔离——它们不进 `templateHash`。本文件是它们唯一的出口。
 *
 * 2. **`resolvedModel` 走 `describeAlias` 而不是 `resolve`。**
 *    D-03 的晚绑定意味着这个值随时可能变，所以详情页要显示「此刻解析成什么」。
 *    但展示路径不该因为「API Key 没配」而 500——那恰恰是页面最需要显示的状态。
 *
 * 3. **`runCount` 数的是快照，不是磁盘。**
 *    `countTasksByTemplate` 查 `task_snapshots.template_id`：一个任务即便是用
 *    某个已被删掉的模板建的，它也仍然计入那个模板的引用数。这正是 D-08
 *    「draft / archived 不可硬删」的依据所在。
 */

import type {
  SlotTypeDetail,
  TaskSummary,
  TemplateDetail,
  TemplateListResponse,
  TemplateSummary,
} from '@shared/contracts.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { CompiledSlotType, CompiledTemplate, LoadedTemplate } from './template-loader.ts';
import type { TemplateCatalog } from './template-catalog.ts';
import type { TaskService } from './task-service.ts';

/**
 * 别名解析器端口。
 *
 * 声明成端口而不是直接吃 `ProviderRegistry`：本层需要的只是「别名 → 模型名」，
 * 而 Registry 还带着 adapter、健康状态、限流窗口。依赖整个类会让
 * 「渲染一个模板详情页」在类型上要求一套能发 HTTP 的东西。
 */
export interface AliasPeek {
  describeAlias(alias: string): { providerId: string; providerName: string; model: string } | null;
}

export interface TemplateServiceOptions {
  catalog: TemplateCatalog;
  uow: UnitOfWorkHandle<UnitOfWork>;
  aliases: AliasPeek;
  /** 任务投影复用 TaskService，不在本文件重造一份 summary */
  tasks: TaskService;
}

export interface TemplateService {
  list(): Promise<TemplateListResponse>;
  get(id: string): Promise<TemplateDetail>;
  /** D-08：引用该模板的任务，按 updatedAt 倒序 */
  listTasks(id: string, options?: { limit?: number }): Promise<TaskSummary[]>;
}

/** 模板详情页「引用该模板的任务」区块的默认条数 */
const DEFAULT_TASK_LIMIT = 50;

/**
 * D-05 的「确定性校验」翻译成人话。
 *
 * 三条规则各自独立成句而不是拼一句：设计稿把它们渲染成一列 chip，
 * 而且缺哪条就少哪个 chip——合成一句话之后前端只能整块显示或整块不显示。
 *
 * 刻意**不输出 `forbidPattern` 的正则源码**。它是给机器看的，
 * 放进 UI 只会让人以为那是要遵守的写作要求。有 `forbidPatternMessage`
 * 就用作者写的那句话，没有就给一句中性的兜底——不是「无限制」，
 * 因为限制确实存在，只是模板作者没写清楚。
 */
function describeValidation(validation: CompiledSlotType['validation']): string[] {
  const rules: string[] = [];
  if (validation.minChars !== null) rules.push(`不少于 ${validation.minChars} 字`);
  if (validation.maxChars !== null) rules.push(`不超过 ${validation.maxChars} 字`);
  if (validation.forbidPattern !== null) {
    rules.push(validation.forbidPatternMessage ?? '存在内容格式限制（见模板定义）');
  }
  return rules;
}

function toSlotTypeDetail(
  slotType: CompiledSlotType,
  loaded: LoadedTemplate,
  aliases: AliasPeek,
): SlotTypeDetail {
  const compiled = loaded.compiled;
  const binding = compiled.bindings.fillSlotByType[slotType.id];
  const agent = binding === undefined ? undefined : compiled.agents.find((a) => a.id === binding.agentId);
  const skill = binding === undefined ? undefined : loaded.skills[binding.skillId];

  return {
    id: slotType.id,
    name: slotType.name,
    description: slotType.description,
    contentBearing: slotType.contentBearing,
    includeInArtifact: slotType.includeInArtifact,
    // 容器类型没有绑定，binding 为 null。契约注释写明了「UI 不得为它伪造
    // Producer 信息」——伪造一个空壳 binding 会让容器行长出一个模型名。
    binding:
      binding === undefined
        ? null
        : {
            agentId: binding.agentId,
            agentName: agent?.name ?? binding.agentId,
            agentRole: agent?.role ?? '',
            skillId: binding.skillId,
            skillVersion: binding.skillVersion,
            skillSummary: skill?.summary ?? '',
            modelAlias: binding.modelAlias,
            // 别名配没配得上是页面要显示的信息之一，解析不出就是 null
            resolvedModel: aliases.describeAlias(binding.modelAlias)?.model ?? null,
            timeoutMs: binding.timeoutMs,
            maxRetries: binding.maxRetries,
          },
    validation: {
      minChars: slotType.validation.minChars,
      maxChars: slotType.validation.maxChars,
      rules: describeValidation(slotType.validation),
    },
    guidance: [...slotType.guidance],
  };
}

export function createTemplateService(options: TemplateServiceOptions): TemplateService {
  const { catalog, uow, aliases, tasks } = options;

  const runCountOf = (compiled: CompiledTemplate): number =>
    uow.repositories.snapshots.countTasksByTemplate(compiled.id);

  const summaryOf = (loaded: LoadedTemplate): TemplateSummary => {
    const { compiled, presentation } = loaded;
    return {
      id: compiled.id,
      name: compiled.name,
      version: compiled.version,
      description: compiled.description,
      status: compiled.status,
      outputKind: presentation.outputKind,
      slotTypeCount: compiled.slotTypes.length,
      agentCount: compiled.agents.length,
      skillCount: compiled.skills.length,
      runCount: runCountOf(compiled),
      tags: [...presentation.tags],
      updatedAt: loaded.updatedAt,
    };
  };

  return {
    async list() {
      // 不按 status 过滤：D-08 要求 draft / archived 在列表页可见并打 chip。
      // 过滤是前端的筛选器的事，后端一过滤，用户就再也找不到自己的草稿了。
      const [templates, failures] = await Promise.all([catalog.list(), catalog.failures()]);
      return {
        templates: templates.map(summaryOf),
        // sourcePath 刻意不出网，见 contracts 里该 schema 的注释
        failures: failures.map((failure) => ({ dirName: failure.dirName, error: failure.error })),
      };
    },

    async get(id) {
      // `get` 而非 `requireUsable`：draft / archived 的详情页必须打得开，
      // 否则用户没有任何途径看到自己的草稿模板长什么样（D-08）。
      const loaded = await catalog.get(id);
      const { compiled, presentation } = loaded;
      const structure = compiled.bindings.createStructure;
      const structureAgent = compiled.agents.find((a) => a.id === structure.agentId);

      return {
        ...summaryOf(loaded),
        inputFields: compiled.inputFields.map((field) => ({ ...field })),
        structureBinding: {
          agentId: structure.agentId,
          agentName: structureAgent?.name ?? structure.agentId,
          skillId: structure.skillId,
          skillVersion: structure.skillVersion,
          modelAlias: structure.modelAlias,
          resolvedModel: aliases.describeAlias(structure.modelAlias)?.model ?? null,
          timeoutMs: structure.timeoutMs,
          maxRetries: structure.maxRetries,
          // D-01：这两个上界是「结构由 Agent 设计」这件事唯一的硬护栏，
          // 详情页要显示它们，否则模板的实际约束只存在于 YAML 里
          maxSlots: compiled.limits.maxSlots,
          maxStructureDepth: compiled.limits.maxStructureDepth,
        },
        slotTypes: compiled.slotTypes.map((slotType) => toSlotTypeDetail(slotType, loaded, aliases)),
        // D-02：仅展示。null 与空数组不同——null 是「模板没提供示例」，
        // 空数组会让 UI 渲染出一个空的示例区块
        exampleStructure:
          presentation.exampleStructure === null ? null : presentation.exampleStructure.map((n) => ({ ...n })),
        output: { fileName: compiled.output.fileName, mediaType: compiled.output.mediaType },
      };
    },

    async listTasks(id, listOptions) {
      // 先 get 一次：模板不存在时要报 TEMPLATE_NOT_FOUND（404），
      // 而不是返回一个空数组假装「这个模板没有任务」
      await catalog.get(id);
      const limit = listOptions?.limit ?? DEFAULT_TASK_LIMIT;
      return uow.repositories.tasks
        .listByTemplate(id, limit)
        .map((task) => tasks.getTaskSummary(task.id));
    },
  };
}
