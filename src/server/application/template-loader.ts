/**
 * 模板加载与编译（文档 §4.1 / D-01 / D-02 / D-06 / D-08 / D-16）。
 *
 * 职责链：读 YAML → Zod 解析（不可信输入边界）→ 交叉引用校验 →
 * 回退链求解 → 剥离 presentation → 算 `templateHash`。
 *
 * 三条设计纪律，改这个文件前先读：
 *
 * 1. **`presentation` 不进 `CompiledTemplate`。**
 *    这不是洁癖，是快照隔离的前提（D-02）：`templateHash` 进 Task Snapshot，
 *    若展示字段计入 hash，那么给模板加一个 tag 就会让所有历史任务的快照 hash 失配，
 *    NFR-004 的「上下文可重建」信号随之失去诊断价值。因此 `presentation`
 *    与编译产物是两个物理隔离的对象，`LoadedTemplate` 才把它们并排放在一起。
 *
 * 2. **D-06 的回退在这里一次算完，运行时不再回退。**
 *    `CompiledBinding` 的 `modelAlias` / `timeoutMs` / `maxRetries` 全部必填。
 *    把回退链留到运行时意味着模板详情页要在前端重算一遍同样的链条，
 *    两处实现迟早漂移；也意味着「最终生效值」不是确定值，违反 NFR-006。
 *
 * 3. **能在加载期发现的错误，一律不许留到运行期。**
 *    绑定引用了不存在的 Agent、Skill 的 operation 与绑定位置不匹配、
 *    forbidPattern 会灾难性回溯——这些在运行期表现为
 *    「任务跑到一半失败」或「整个进程卡死」，在加载期则只是一条清楚的报错。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { ExecutionDefaults, InputField, TemplateStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import { canonicalHash } from '@server/domain/canonical.ts';
import type { LoadedSkill } from './skill-loader.ts';
import { loadSkill } from './skill-loader.ts';
import { checkPatternBudget, DEFAULT_PATTERN_BUDGET_MS } from './regex-budget.ts';
import type { PatternBudgetSpec } from './regex-budget.ts';
import type { RawBinding, RawTemplate } from './template-schema.ts';
import { RawTemplateSchema } from './template-schema.ts';

/** 模板目录下的固定文件名（§2.1 的目录树） */
export const TEMPLATE_FILE_NAME = 'template.yaml';

// ---------------------------------------------------------------------------
// 编译产物。进程内自造自用，按 §3 判据表用普通 TS 类型而非 Zod。
// ---------------------------------------------------------------------------

export interface CompiledSlotValidation {
  minChars: number | null;
  maxChars: number | null;
  /**
   * 正则源码，**已剥离 `(?m)` 这类前置内联标志**（见 splitInlineFlags）。
   * 保留字符串而非 RegExp 对象：RegExp 既不可 canonicalJson 也不可入快照。
   */
  forbidPattern: string | null;
  /** 从内联标志前缀解析出的 flags，配合 forbidPattern 直接 `new RegExp(p, f)` */
  forbidPatternFlags: string | null;
  forbidPatternMessage: string | null;
}

export interface CompiledSlotType {
  id: string;
  name: string;
  description: string;
  contentBearing: boolean;
  /** D-16：默认 true（含容器类型）。这里已经补齐，下游不需要再判 undefined */
  includeInArtifact: boolean;
  validation: CompiledSlotValidation;
  guidance: readonly string[];
  /** R2：返修上限，默认 2（D-26） */
  maxRevisionRounds: number;
}

export interface CompiledAgent {
  id: string;
  name: string;
  role: string;
  /** 别名，可能为 null——此时该 Agent 的每条绑定都必须自带 modelAlias */
  modelAlias: string | null;
  systemInstruction: string;
}

export interface CompiledSkillRef {
  id: string;
  version: string;
  /** SKILL.md 全文哈希。快照冻结的锚点 */
  contentHash: string;
}

/** D-06：三个值均为必填，回退已在编译期完成 */
export interface CompiledBinding {
  agentId: string;
  skillId: string;
  skillVersion: string;
  modelAlias: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface CompiledLimits {
  maxSlots: number;
  maxStructureDepth: number;
  maxExecutionRetries: number;
  executionTimeoutMs: number;
  maxToolCallsPerAssignment: number;
}

/**
 * 编译后的模板——**不含 presentation**。
 *
 * 结构上刻意与 `domain/structure-validation.ts` 的 `StructureValidationTemplate`
 * 兼容（`slotTypes[].{id,contentBearing,includeInArtifact}` + `limits.{maxSlots,maxStructureDepth}`），
 * 因此可以直接传进 `validateConcreteStructure`，不需要中间适配层。
 */
export interface CompiledTemplate {
  id: string;
  version: string;
  name: string;
  description: string;
  status: TemplateStatus;
  inputFields: readonly InputField[];
  slotTypes: readonly CompiledSlotType[];
  agents: readonly CompiledAgent[];
  skills: readonly CompiledSkillRef[];
  bindings: {
    createStructure: CompiledBinding;
    /** key 是槽位类型 ID，覆盖全部 contentBearing 类型 */
    fillSlotByType: Readonly<Record<string, CompiledBinding>>;
    /** R2：审核绑定，可选（D-27）。不覆盖全部 contentBearing 类型是合法默认 */
    reviewSlotByType: Readonly<Record<string, CompiledBinding>>;
  };
  limits: CompiledLimits;
  output: { fileName: string; mediaType: string; assembler: 'markdown_concat_v1' };
  /** `canonicalHash` 本对象（不含此字段）的结果。见 computeTemplateHash */
  templateHash: string;
}

/** D-02：只用于渲染，永不进快照、永不进 Agent 上下文、永不参与运行时逻辑 */
export interface TemplatePresentation {
  outputKind: string;
  tags: readonly string[];
  exampleStructure:
    | readonly { name: string; typeId: string; kind: 'container' | 'content'; depth: number }[]
    | null;
}

export interface LoadedTemplate {
  compiled: CompiledTemplate;
  presentation: TemplatePresentation;
  /** 按 Skill ID 索引的完整 Skill。snapshot-service 冻结的是这里的 `raw` */
  skills: Readonly<Record<string, LoadedSkill>>;
  /** template.yaml 的绝对路径。只用于报错与 mtime，不进编译产物 */
  sourcePath: string;
  /** template.yaml 的 mtime（ISO）。TemplateSummary.updatedAt 的数据源 */
  updatedAt: string;
}

export interface TemplateLoaderOptions {
  /**
   * SKILL.md 的根目录（.env 的 `SKILLS_DIR`）。
   * `skills[].source` 按 §4.1 示例写成 `skills/xxx/SKILL.md`，
   * 即相对 SKILLS_DIR 的**父目录**——见 resolveSkillPath 的说明。
   */
  skillsDir: string;
  /** D-06 回退链最后一级，来自 config/providers.yaml */
  defaults: Pick<ExecutionDefaults, 'timeoutMs' | 'maxRetries'>;
  /**
   * D-19：`config/providers.yaml` 里已声明的别名集合。
   *
   * 传入则在编译期校验别名存在性。**这不与 D-03 的晚绑定冲突**：晚绑定推迟的是
   * 「别名 → provider/model 的**取值**」，好让换模型不必重建历史快照；
   * 它不是「别名写错了也要拖到执行时才发现」的许可。
   * 加载期放行的代价是任务创建成功、跑起来、烧掉一次 Assignment 才失败，
   * 而报错指向运行期而不是那行 YAML。
   *
   * 运行期的 `MODEL_ALIAS_UNRESOLVED` 仍然必须保留——它防的是另一件事：
   * providers.yaml 在模板编译之后被改瘦了。编译期检查对此无能为力。
   *
   * 可选是为了让「只想编译、手边没有 providers.yaml」的测试仍能跑。
   */
  knownAliases?: ReadonlySet<string>;
  /** 单条 forbidPattern 的时间预算 */
  patternBudgetMs?: number;
}

// ---------------------------------------------------------------------------

function invalid(templateRef: string, message: string, cause?: unknown): ForgeError {
  return new ForgeError(
    'TEMPLATE_INVALID',
    `模板 ${templateRef} 非法：${message}`,
    `template:${templateRef}`,
    '检查 template.yaml 后重新加载',
    cause,
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；');
}

function findDuplicate(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * 解析 `skills[].source`。
 *
 * §4.1 的示例写的是 `skills/chapter-structure-design/SKILL.md`，但没说基准目录是哪个。
 * 对着 §2.1 的目录树只有一种读法讲得通：**相对仓库根**，而仓库根正是
 * `SKILLS_DIR`（`./skills`）的父目录。取这个定义的好处是测试夹具只要
 * 保持 `<root>/skills/...` 的相对布局就能整体搬走，不必在 YAML 里写 `../../`。
 *
 * 同时做**目录逃逸检查**：`source` 来自可手改的文件，`../../../etc/passwd`
 * 这种写法必须在拼路径的地方拦下。这里不是「防黑客」——单机部署没有攻击者——
 * 而是防止一次手滑让加载器去读仓库外的文件并把内容哈希进快照。
 */
function resolveSkillPath(source: string, skillsDir: string, templateRef: string): string {
  const skillsRoot = path.resolve(skillsDir);
  const base = path.dirname(skillsRoot);
  const resolved = path.resolve(base, source);
  const withSep = skillsRoot.endsWith(path.sep) ? skillsRoot : skillsRoot + path.sep;
  if (!resolved.startsWith(withSep)) {
    throw invalid(templateRef, `skills[].source 指向了 SKILLS_DIR 之外：${source}`);
  }
  return resolved;
}

/** 只接受这几个标志：`g` 会带来 `lastIndex` 状态，`y` 会改变匹配语义，都不适合「禁止出现」的判定 */
const INLINE_FLAG_PATTERN = /^\(\?([imsu]+)\)/;

/**
 * 拆出正则开头的内联标志前缀。
 *
 * 起因是 §4.1 的示例写着 `forbidPattern: '(?m)^#{1,6}\s'`——这在 PCRE / Python 里
 * 合法，**在 JavaScript 里不合法**：V8 直接抛 `Invalid group`（ES2025 的内联修饰符
 * 只支持 `(?m:...)` 这种带作用域的形式，不支持这种全局前缀）。
 * 照搬文档写模板的人会得到一个「正则语法错误」，而他抄的正是规范里的例子。
 *
 * 两条路：把文档示例改成 JS 合法写法并新增一个 `forbidPatternFlags` 字段，
 * 或者在编译期把前缀翻译成 `RegExp` 的 flags 参数。选后者：
 * 前者要给每个模板作者多一个字段和一条「别忘了配对」的约束，
 * 而 `(?m)` 前缀是跨语言正则的通用写法，作者本来就会这么写。
 * （文档 §4.1 已相应补充说明。）
 */
function splitInlineFlags(source: string): { source: string; flags: string } {
  const match = INLINE_FLAG_PATTERN.exec(source);
  if (match === null) return { source, flags: '' };
  // 去重：`(?mm)` 传给 RegExp 会抛错，而作者的意图显然只是 m
  const flags = [...new Set(match[1] ?? '')].join('');
  return { source: source.slice(match[0].length), flags };
}

/**
 * D-06 的回退求解。
 *
 * `modelAlias` 与另外两个的差别是刻意的：超时和重试有全局默认值（providers.yaml），
 * 别名**没有**——§4.2 明确「不允许兜底到某个全局别名」。
 * 一个默认别名会让「忘了给 Agent 配模型」变成静默生效，
 * 于是模板详情页显示的模型与实际跑的模型可能是两回事。缺失就该在这里炸。
 */
function resolveBinding(
  raw: RawBinding,
  where: string,
  agent: CompiledAgent,
  skillVersion: string,
  limits: { maxExecutionRetries?: number | undefined; executionTimeoutMs?: number | undefined },
  defaults: Pick<ExecutionDefaults, 'timeoutMs' | 'maxRetries'>,
  templateRef: string,
  knownAliases: ReadonlySet<string> | undefined,
): CompiledBinding {
  const modelAlias = raw.modelAlias ?? agent.modelAlias;
  if (modelAlias === null || modelAlias === undefined) {
    throw invalid(
      templateRef,
      `绑定 ${where} 解析不出模型别名：binding.modelAlias 与 agent(${agent.id}).model 都没有声明。` +
        `模型别名没有全局默认值（§4.2），必须显式给出`,
    );
  }
  // D-19：打错字要在这里炸，而不是等任务跑起来烧掉一次 Assignment 才炸
  if (knownAliases !== undefined && !knownAliases.has(modelAlias)) {
    throw invalid(
      templateRef,
      `绑定 ${where} 的模型别名 ${modelAlias} 不在 config/providers.yaml 的 aliases 中。` +
        `已声明的别名：${[...knownAliases].sort().join(', ')}`,
    );
  }
  return {
    agentId: raw.agentId,
    skillId: raw.skillId,
    skillVersion,
    modelAlias,
    timeoutMs: raw.timeoutMs ?? limits.executionTimeoutMs ?? defaults.timeoutMs,
    maxRetries: raw.maxRetries ?? limits.maxExecutionRetries ?? defaults.maxRetries,
  };
}

/**
 * 算 `templateHash`。
 *
 * 输入是**编译产物本身去掉 hash 字段**，不是 YAML 原文：
 * - 原文包含注释、缩进、键序，改一个空格就换 hash，没有语义价值
 * - 编译产物已经把回退链求解完，两个写法不同但语义相同的模板会得到同一个 hash
 * 用 `canonicalHash` 而不是自己拼字符串：`canonicalJson` 的码点序排序与 NFC
 * 规范化是 AC-013 确定性的地基，另造一套就等于把地基挖掉一半。
 */
function computeTemplateHash(compiled: Omit<CompiledTemplate, 'templateHash'>): string {
  return canonicalHash(compiled);
}

/**
 * 编译一份已读入的 YAML 文本。
 *
 * 拆成独立导出而不是塞进 `loadTemplate`：非法模板的测试用例大多是「YAML 内容有问题」，
 * 让它们能直接喂字符串，就不必为每个错误各建一个夹具目录。
 */
export async function compileTemplate(
  yamlText: string,
  sourcePath: string,
  options: TemplateLoaderOptions,
): Promise<{ compiled: CompiledTemplate; presentation: TemplatePresentation; skills: Record<string, LoadedSkill> }> {
  const templateRef = path.basename(path.dirname(sourcePath));

  let data: unknown;
  try {
    data = parseYaml(yamlText, { prettyErrors: true });
  } catch (error) {
    throw invalid(templateRef, `不是合法 YAML：${(error as Error).message}`, error);
  }

  const parsed = RawTemplateSchema.safeParse(data);
  if (!parsed.success) {
    throw invalid(templateRef, formatIssues(parsed.error), parsed.error);
  }
  const raw: RawTemplate = parsed.data;

  // --- 1. 同名冲突。放在最前：后面所有交叉引用都建立在「ID 唯一」之上 ---
  for (const [label, ids] of [
    ['slotTypes', raw.slotTypes.map((s) => s.id)],
    ['agents', raw.agents.map((a) => a.id)],
    ['skills', raw.skills.map((s) => s.id)],
    ['inputFields', raw.inputFields.map((f) => f.id)],
  ] as const) {
    const duplicate = findDuplicate(ids);
    if (duplicate !== null) {
      throw invalid(templateRef, `${label} 中存在重复 ID：${duplicate}`);
    }
  }

  // --- 2. 槽位类型 ---
  const slotTypes: CompiledSlotType[] = raw.slotTypes.map((s) => {
    const pattern = s.validation?.forbidPattern === undefined ? null : splitInlineFlags(s.validation.forbidPattern);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      contentBearing: s.contentBearing,
      // D-16 / D-18：默认 true，**容器类型也是 true**。
      // 反过来设（容器默认 false）会让整棵树装配不出任何东西——
      // assembly 遇到 includeInArtifact=false 的容器直接返回空子树。
      includeInArtifact: s.includeInArtifact ?? true,
      validation: {
        minChars: s.validation?.minChars ?? null,
        maxChars: s.validation?.maxChars ?? null,
        forbidPattern: pattern?.source ?? null,
        forbidPatternFlags: pattern?.flags ?? null,
        forbidPatternMessage: s.validation?.forbidPatternMessage ?? null,
      },
      guidance: s.guidance ?? [],
      maxRevisionRounds: s.maxRevisionRounds ?? 2,
    };
  });
  const slotTypeById = new Map(slotTypes.map((s) => [s.id, s]));
  const contentBearingIds = slotTypes.filter((s) => s.contentBearing).map((s) => s.id);
  if (contentBearingIds.length === 0) {
    throw invalid(templateRef, 'slotTypes 中至少要有一个 contentBearing 类型，否则模板产不出任何内容');
  }

  // --- 3. Agent ---
  const agents: CompiledAgent[] = raw.agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    modelAlias: a.model ?? null,
    systemInstruction: a.systemInstruction,
  }));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  // --- 4. Skill：必须真的读进来，否则 operation 匹配无从校验 ---
  const skills: Record<string, LoadedSkill> = {};
  for (const ref of raw.skills) {
    const skillPath = resolveSkillPath(ref.source, options.skillsDir, templateRef);
    const skill = await loadSkill(skillPath);
    if (skill.id !== ref.id) {
      throw invalid(templateRef, `skills[${ref.id}] 指向的文件里 id 是 ${skill.id}，两者必须一致`);
    }
    // 版本对不上说明模板引用的是另一个版本的 Skill。放行等于让快照记下一个
    // 与实际注入内容不符的版本号，事后无法据此复现上下文（NFR-004）。
    if (skill.version !== ref.version) {
      throw invalid(
        templateRef,
        `skills[${ref.id}] 声明 version ${ref.version}，但 SKILL.md 里是 ${skill.version}`,
      );
    }
    skills[ref.id] = skill;
  }

  // --- 5. 绑定 ---
  const bindingLimits = {
    maxExecutionRetries: raw.limits.maxExecutionRetries,
    executionTimeoutMs: raw.limits.executionTimeoutMs,
  };

  const resolveOne = (rawBinding: RawBinding, where: string, expected: 'create_structure' | 'fill_slot' | 'review_slot', slotTypeId: string | null): CompiledBinding => {
    const agent = agentById.get(rawBinding.agentId);
    if (agent === undefined) {
      throw invalid(templateRef, `绑定 ${where} 引用了不存在的 agentId：${rawBinding.agentId}`);
    }
    const skill = skills[rawBinding.skillId];
    if (skill === undefined) {
      throw invalid(templateRef, `绑定 ${where} 引用了不存在的 skillId：${rawBinding.skillId}`);
    }
    if (skill.operation !== expected) {
      throw invalid(
        templateRef,
        `绑定 ${where} 需要 operation 为 ${expected} 的 Skill，` +
          `但 ${skill.id} 声明的是 ${skill.operation}`,
      );
    }
    // fill_slot 的 Skill 还要管得了这个具体类型。只校验 operation 会放过
    // 「拿 title-writing 去填 scene」这种错配——它跑得起来，只是产出是错的。
    if (slotTypeId !== null && !skill.slotTypes.includes(slotTypeId)) {
      throw invalid(
        templateRef,
        `绑定 ${where} 使用的 Skill ${skill.id} 的 slotTypes 是 [${skill.slotTypes.join(', ')}]，` +
          `不包含 ${slotTypeId}`,
      );
    }
    return resolveBinding(
      rawBinding,
      where,
      agent,
      skill.version,
      bindingLimits,
      options.defaults,
      templateRef,
      options.knownAliases,
    );
  };

  const createStructure = resolveOne(raw.bindings.createStructure, 'createStructure', 'create_structure', null);

  const fillSlotByType: Record<string, CompiledBinding> = {};
  for (const [slotTypeId, rawBinding] of Object.entries(raw.bindings.fillSlotByType)) {
    const slotType = slotTypeById.get(slotTypeId);
    if (slotType === undefined) {
      throw invalid(templateRef, `bindings.fillSlotByType 声明了不存在的槽位类型：${slotTypeId}`);
    }
    if (!slotType.contentBearing) {
      throw invalid(
        templateRef,
        `bindings.fillSlotByType 给容器类型 ${slotTypeId} 配了绑定，但容器槽位没有 Assignment（D-16）`,
      );
    }
    fillSlotByType[slotTypeId] = resolveOne(rawBinding, `fillSlotByType.${slotTypeId}`, 'fill_slot', slotTypeId);
  }

  // 覆盖完备性。漏一个类型的后果是「结构创建成功、跑到那个槽位才失败」，
  // 此时任务已经烧掉了结构步骤的 token，且没有任何自动恢复路径。
  const uncovered = contentBearingIds.filter((id) => fillSlotByType[id] === undefined);
  if (uncovered.length > 0) {
    throw invalid(
      templateRef,
      `bindings.fillSlotByType 未覆盖全部 contentBearing 槽位类型，缺少：${uncovered.join(', ')}`,
    );
  }

  // R2：审核绑定编译（D-27）。reviewSlotByType 是可选的——不绑定是合法默认。
  // 不套用 fillSlotByType 的「必须覆盖全部 contentBearing 类型」校验（FR-REVIEW-001/D-27）。
  // operation 校验用同型 resolveOne（不匹配自动拒）。
  // FR-TPL-003 的判据唯一性等校验归 R4，不做。
  const reviewSlotByType: Record<string, CompiledBinding> = {};
  for (const [slotTypeId, rawBinding] of Object.entries(raw.bindings.reviewSlotByType ?? {})) {
    const slotType = slotTypeById.get(slotTypeId);
    if (slotType === undefined) {
      throw invalid(templateRef, `bindings.reviewSlotByType 声明了不存在的槽位类型：${slotTypeId}`);
    }
    if (!slotType.contentBearing) {
      throw invalid(
        templateRef,
        `bindings.reviewSlotByType 给容器类型 ${slotTypeId} 配了绑定，但容器槽位没有内容可审`,
      );
    }
    reviewSlotByType[slotTypeId] = resolveOne(rawBinding, `reviewSlotByType.${slotTypeId}`, 'review_slot', slotTypeId);
  }

  // --- 6. forbidPattern：先查语法，再查时间预算 ---
  const patternSpecs: PatternBudgetSpec[] = [];
  for (const slotType of slotTypes) {
    const source = slotType.validation.forbidPattern;
    if (source === null) continue;
    const flags = slotType.validation.forbidPatternFlags ?? '';
    try {
      new RegExp(source, flags);
    } catch (error) {
      throw invalid(
        templateRef,
        `槽位类型 ${slotType.id} 的 forbidPattern 不是合法正则：${(error as Error).message}`,
        error,
      );
    }
    patternSpecs.push({ key: `slotType:${slotType.id}`, source, flags });
  }
  const budgetMs = options.patternBudgetMs ?? DEFAULT_PATTERN_BUDGET_MS;
  const budget = await checkPatternBudget(patternSpecs, budgetMs);
  if (!budget.ok) {
    throw invalid(
      templateRef,
      budget.reason === 'timeout'
        ? `${budget.key} 的 forbidPattern 在 ${budgetMs}ms 预算内跑不完代表性输入，` +
            `存在灾难性回溯风险，拒绝加载：${budget.detail}`
        : `forbidPattern 预算检查失败：${budget.detail}`,
    );
  }

  // --- 7. presentation：先校验，再整块剥离 ---
  for (const node of raw.presentation.exampleStructure ?? []) {
    const slotType = slotTypeById.get(node.typeId);
    if (slotType === undefined) {
      throw invalid(templateRef, `presentation.exampleStructure 引用了不存在的槽位类型：${node.typeId}`);
    }
    const expected = slotType.contentBearing ? 'content' : 'container';
    if (node.kind !== expected) {
      throw invalid(
        templateRef,
        `presentation.exampleStructure 的 ${node.name} 标为 ${node.kind}，` +
          `但类型 ${node.typeId} 的 contentBearing=${String(slotType.contentBearing)}`,
      );
    }
  }
  const presentation: TemplatePresentation = {
    outputKind: raw.presentation.outputKind,
    tags: raw.presentation.tags ?? [],
    exampleStructure: raw.presentation.exampleStructure ?? null,
  };

  // --- 8. 编译产物 + hash ---
  const withoutHash: Omit<CompiledTemplate, 'templateHash'> = {
    id: raw.id,
    version: raw.version,
    name: raw.name,
    description: raw.description,
    status: raw.status,
    inputFields: raw.inputFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required,
      // DTO 侧 hint 是 `string | null`（不是可选），这里就地补齐，
      // 免得每个消费方各自 `?? null` 一次，也免得 canonicalJson 因 undefined 剔除键
      // 而让「有 hint」和「hint 为 null」哈希成同一个值。
      hint: f.hint ?? null,
    })),
    slotTypes,
    agents,
    skills: raw.skills.map((ref) => ({
      id: ref.id,
      version: ref.version,
      // Skill 全文哈希进 templateHash：改了 SKILL.md 就是改了模板的行为，
      // 只记 id+version 会让「版本号没动但内容改了」悄悄溜过去。
      contentHash: skills[ref.id]?.contentHash ?? '',
    })),
    bindings: { createStructure, fillSlotByType, reviewSlotByType },
    limits: {
      maxSlots: raw.limits.maxSlots,
      maxStructureDepth: raw.limits.maxStructureDepth,
      maxExecutionRetries: raw.limits.maxExecutionRetries ?? options.defaults.maxRetries,
      executionTimeoutMs: raw.limits.executionTimeoutMs ?? options.defaults.timeoutMs,
      maxToolCallsPerAssignment: raw.limits.maxToolCallsPerAssignment,
    },
    output: raw.output,
  };

  return {
    compiled: { ...withoutHash, templateHash: computeTemplateHash(withoutHash) },
    presentation,
    skills,
  };
}

/** 从 `<dir>/template.yaml` 加载。`dir` 是单个模板的目录，不是 TEMPLATES_DIR */
export async function loadTemplate(
  templateDir: string,
  options: TemplateLoaderOptions,
): Promise<LoadedTemplate> {
  const sourcePath = path.resolve(templateDir, TEMPLATE_FILE_NAME);
  const templateRef = path.basename(path.resolve(templateDir));

  let yamlText: string;
  try {
    yamlText = await readFile(sourcePath, 'utf8');
  } catch (error) {
    throw new ForgeError(
      'TEMPLATE_NOT_FOUND',
      // 只出目录名，不出绝对路径。这条 message 会经 TemplateCatalog 的 failures
      // 一路出到 `GET /api/templates`，而 §9.3 的纪律是「Node 的报错带绝对路径，
      // 一律不出网」。投影层剥掉 sourcePath 字段还不够——路径同时藏在 message 里。
      // 完整路径进 cause，而 cause 不出网（ForgeError.toPublic 不带它）。
      `模板目录 ${templateRef} 下没有 ${TEMPLATE_FILE_NAME}`,
      `template:${templateRef}`,
      '确认 TEMPLATES_DIR 下该目录含 template.yaml',
      error,
    );
  }

  const { compiled, presentation, skills } = await compileTemplate(yamlText, sourcePath, options);
  const stats = await stat(sourcePath);

  return {
    compiled,
    presentation,
    skills,
    sourcePath,
    // 用 mtime 而不是「加载时刻」：后者每次重启都变，会让模板列表的
    // 「更新于」栏目在什么都没改的情况下跳动。
    updatedAt: stats.mtime.toISOString(),
  };
}
