/**
 * 快照服务：创建任务时把模板与 Skill **冻结**下来（文档 §5.2 / §5.5「创建 Task」/
 * D-02 / D-08 / D-12 / D-18 / REQ AC-002）。
 *
 * 这一层回答两个问题，且只回答这两个：
 * 「创建任务时该把什么冻起来」与「任务运行期从哪里读回它」。
 * 谁来启动任务、怎么组装上下文都不在这里——那是 M3 的 lifecycle-service 与 ContextBuilder。
 *
 * ## 为什么必须「先读后写」，而不是在事务里边读边写
 *
 * `uow.run()` 的回调被 `NotPromise` 约束为同步（D-10 / D-15：事务不跨微任务）。
 * 而模板与 SKILL.md 的加载是 async 的。于是顺序被物理地固定成：
 *
 *   事务外：`catalog.requireUsable()` → 校验输入 → `prepareSnapshot()` 序列化
 *   事务内：三条 INSERT，纯写入，不做任何可能失败的重活
 *
 * 这不是风格取舍。若把加载塞进事务，回调就得是 async，事务会在第一个 await 处
 * 先于回调完成而提交——「快照写了一半、任务没写进去」这种半截状态会静默出现，
 * 而 §5.5 第一行要求的正是这三条 INSERT 的原子性。
 *
 * ## 为什么序列化发生在这里，而不是仓储里
 *
 * D-12 要求 hash 与落库文本**逐字对应**。`snapshotHash = sha256(compiled_json)`，
 * 于是任何时候都能拿库里那一列重新算一遍来判断「这份快照还是当初那份吗」——
 * 这正是 NFR-004「上下文可重建」的诊断信号。
 * 如果仓储自己 `JSON.stringify` 一遍，序列化就有了两个发生地（服务算 hash 用一份、
 * 仓储落库用另一份），两份文本只要有一处键序不同，这个信号就永久失效且无人察觉。
 * 所以 `SnapshotRepo` 收的是**文本**，产出文本的责任在本文件，用的是
 * `domain/canonical.ts` 的 `canonicalJson`（码点序 + NFC，AC-013 确定性的地基）。
 *
 * ## D-02：presentation 一个字段都不进快照
 *
 * `prepareSnapshot` 的入参类型刻意写成 `Pick<LoadedTemplate, 'compiled' | 'skills'>`
 * 而不是 `LoadedTemplate`：`presentation` 连进入这个函数作用域的机会都没有，
 * 于是「顺手带一下」在编译期就不成立。
 * 代价是调用方要多写一次解构，换来的是这条约束不依赖任何人记得住它。
 * （若展示字段计入 hash，给模板加一个 tag 就会让所有历史任务的快照 hash 失配。）
 *
 * ## REQ §13：凭据绝不落库
 *
 * 本文件不读 `process.env`、不接触 `providers.yaml` 的 provider 条目。
 * 快照里与 Provider 相关的只有 `modelAlias`——一个别名字符串。
 * 别名 → provider/model 的解析是 D-03 的晚绑定，发生在执行期的 ProviderRegistry，
 * API Key 只在那一刻从环境变量取出、用完即弃。
 */

import { randomUUID } from 'node:crypto';
import type { InputField } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import { canonicalJson, compareCodePoints, sha256Hex } from '@server/domain/canonical.ts';
import type { Task } from '@server/domain/types.ts';
import type { TaskSkillSnapshot, TaskSnapshot } from '@server/infrastructure/database/repositories/index.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { LoadedSkill, SkillSection } from './skill-loader.ts';
import type { CompiledTemplate, LoadedTemplate } from './template-loader.ts';
import type { TemplateCatalog } from './template-catalog.ts';
import type { ModelAliasChain } from './provider-config.ts';
import { describePick, pickProvider } from '@server/domain/provider-fallback.ts';

// ---------------------------------------------------------------------------
// 冻结产物的形状
// ---------------------------------------------------------------------------

/**
 * `task_skill_snapshots.section_index_json` 的内容。
 *
 * 文档 §5.2 只给了列名，没定义结构；这里定死它，并给出两条取舍：
 *
 * 1. **`sections` 是数组不是 map。** types.ts 把这一列描述成「section id → 位置索引」，
 *    但 map 会被 `canonicalJson` 按码点序重排 key，而 §4.3 明确
 *    「保持文件中的出现顺序——注入顺序对模型的理解有影响」。
 *    `S10` 在码点序里排在 `S2` 之前，一份十章以上的 Skill 会被悄悄打乱注入顺序。
 *    需要 O(1) 取用的地方（`read_skill_section`）由读回时重建索引承担，
 *    那是内存里的一次 for 循环，不值得拿顺序去换。
 *
 * 2. **正文与 `content_markdown` 存在重复。** 这是有意的分工：
 *    `content_markdown` 是**证据原文**（可与磁盘上的文件逐字对比、可重算 contentHash），
 *    本字段是**读路径**（ContextBuilder 与 read_skill_section 直接取用，运行期不再解析 markdown）。
 *    两者在同一次 `prepareSnapshot` 里由同一份解析结果产出，此后永不更新，
 *    不存在「改了一个忘了另一个」的窗口；测试 `parseSkill(contentMarkdown)` 逐字比对二者。
 */
export interface FrozenSkillIndex {
  operation: LoadedSkill['operation'];
  slotTypes: readonly string[];
  summary: string;
  preamble: string;
  requiredSections: readonly string[];
  sections: readonly SkillSection[];
}

/** 读回后的 Skill 快照。形状对齐 `LoadedSkill`，去掉了只在加载期有意义的 `sourcePath` */
export interface FrozenSkill extends FrozenSkillIndex {
  id: string;
  version: string;
  /** 冻结时的 SKILL.md 全文原样 */
  contentMarkdown: string;
  contentHash: string;
  /** 由 `sections` 重建，供 `read_skill_section` O(1) 取用 */
  sectionIndex: Readonly<Record<string, SkillSection>>;
}

/**
 * 任务运行期的唯一上下文来源（AC-002）。
 *
 * M3 的 `ContextBuilder` 只认这个对象：一旦任务创建完成，磁盘上的
 * `template.yaml` 与 `SKILL.md` 对它就不再有任何影响。
 */
export interface FrozenTaskSnapshot {
  taskId: string;
  snapshotId: string;
  templateId: string;
  templateVersion: string;
  compiled: CompiledTemplate;
  snapshotHash: string;
  /** 按 Skill ID 索引 */
  skills: Readonly<Record<string, FrozenSkill>>;
  /** 冻结的任务输入（键是 `compiled.inputFields[].id`） */
  input: Readonly<Record<string, string>>;
}

/** `prepareSnapshot` 的产物：**全部是文本**，可以直接交给事务内的三条 INSERT */
export interface PreparedSnapshot {
  snapshotId: string;
  taskId: string;
  templateId: string;
  templateVersion: string;
  /** `canonicalJson(compiled)`，`snapshotHash` 与它逐字对应 */
  compiledJson: string;
  snapshotHash: string;
  /** 按 skillId 码点序排列，让同一份模板在任何机器上写出同样的行序 */
  skills: readonly TaskSkillSnapshot[];
}

// ---------------------------------------------------------------------------
// 冻结（同步、无 IO，可在事务外先跑完）
// ---------------------------------------------------------------------------

function freezeSkill(taskId: string, skill: LoadedSkill): TaskSkillSnapshot {
  const index: FrozenSkillIndex = {
    operation: skill.operation,
    slotTypes: skill.slotTypes,
    summary: skill.summary,
    preamble: skill.preamble,
    requiredSections: skill.requiredSections,
    sections: skill.sections,
  };
  return {
    taskId,
    skillId: skill.id,
    skillVersion: skill.version,
    // 存**未经加工的原文**而不是规范化文本：快照隔离要验证的是「磁盘上的文件改了没有」，
    // 存原文才能和磁盘逐字对比。contentHash 是对 LF+NFC 规范化后的文本算的
    // （见 skill-loader），因此校验式是 `sha256(normalize(contentMarkdown)) === contentHash`，
    // 而不是直接对本字段取哈希。
    contentMarkdown: skill.raw,
    sectionIndexJson: canonicalJson(index),
    contentHash: skill.contentHash,
  };
}

/**
 * 把一份已加载的模板冻结成可落库的文本。
 *
 * 入参是 `Pick<LoadedTemplate, 'compiled' | 'skills'>` 而非 `LoadedTemplate`——
 * 见文件头 D-02 一节：`presentation` 不在作用域内。
 */
export function prepareSnapshot(
  template: Pick<LoadedTemplate, 'compiled' | 'skills'>,
  ids: { taskId: string; snapshotId: string },
): PreparedSnapshot {
  const compiledJson = canonicalJson(template.compiled);
  const skillIds = Object.keys(template.skills).sort(compareCodePoints);

  return {
    snapshotId: ids.snapshotId,
    taskId: ids.taskId,
    templateId: template.compiled.id,
    templateVersion: template.compiled.version,
    compiledJson,
    // 不是 `canonicalHash(compiled)`：那样会**再序列化一次**，落库文本与哈希输入
    // 就成了两个独立产生的字符串。对着实际落库的那一列取哈希，
    // 「重算一遍对不对得上」才是一句有意义的话（D-12）。
    snapshotHash: sha256Hex(compiledJson),
    skills: skillIds.map((skillId) => {
      const skill = template.skills[skillId];
      if (skill === undefined) {
        // Object.keys 取出来的键必然有值；这一分支不可达，写出来只是为了
        // 满足 noUncheckedIndexedAccess，不代表存在这种运行时状态。
        throw new ForgeError('STORAGE_ERROR', `模板 Skill 索引损坏：${skillId}`);
      }
      return freezeSkill(ids.taskId, skill);
    }),
  };
}

// ---------------------------------------------------------------------------
// 任务输入校验
// ---------------------------------------------------------------------------

function inputInvalid(templateId: string, message: string): ForgeError {
  return new ForgeError(
    'TASK_INPUT_INVALID',
    message,
    `template:${templateId}`,
    '补齐必填字段后重新创建',
  );
}

/**
 * 按模板的 `inputFields` 规整任务输入。
 *
 * 三条规则，都是「宁可创建失败，也不要任务跑到一半才发现」：
 *
 * - **未知键直接拒绝**，不静默丢弃。静默丢弃的表现是「我明明填了内容，
 *   Agent 却看不见」——上下文里少一段的 bug 极难从产出反推。
 *   最常见的成因是字段 id 拼错，此时报错必须指出这个键。
 * - **required 字段空白等同于缺失。** 前端表单提交空字符串是常态，
 *   若放行，Agent 会拿到一个「有这个字段但没内容」的上下文，
 *   产出无从判断是模型的问题还是输入的问题。
 * - **返回值按 `inputFields` 顺序重建**，不沿用调用方的键序。
 *   `tasks.input_json` 因此对同一份输入是确定的字节，
 *   D-12 的 `contextHash` 才不会因为请求体的键序而漂移。
 */
export function normalizeTaskInput(
  inputFields: readonly InputField[],
  input: Readonly<Record<string, unknown>>,
  templateId: string,
): Record<string, string> {
  const known = new Set(inputFields.map((field) => field.id));
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw inputInvalid(
      templateId,
      `任务输入包含模板未声明的字段：${unknown.sort(compareCodePoints).join('、')}。` +
        `模板 ${templateId} 声明的字段是：${[...known].join('、')}`,
    );
  }

  const normalized: Record<string, string> = {};
  for (const field of inputFields) {
    const value = input[field.id];
    if (value === undefined || value === null) {
      if (field.required) {
        throw inputInvalid(templateId, `必填字段「${field.label}」（${field.id}）缺失`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      // 输入来自 HTTP 请求体，属于不可信边界：DTO 那层的 zod 只保证「像个对象」，
      // 到不了「每个值都是 string」的强度时，这里是最后一道。
      throw inputInvalid(
        templateId,
        `字段「${field.label}」（${field.id}）必须是字符串，实际是 ${typeof value}`,
      );
    }
    if (field.required && value.trim() === '') {
      throw inputInvalid(templateId, `必填字段「${field.label}」（${field.id}）不能为空`);
    }
    normalized[field.id] = value;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  templateId: string;
  name: string;
  /** 键必须是模板 `inputFields[].id`（见 normalizeTaskInput） */
  input: Readonly<Record<string, unknown>>;
}

export interface CreatedTask {
  task: Task;
  snapshot: TaskSnapshot;
  skills: readonly TaskSkillSnapshot[];
}

/**
 * 挑档所需的最小窗口（D-67）。
 *
 * 刻意只要这一个方法，而不是整个 ProviderRegistry：创建任务不需要 adapter、
 * 不需要 API Key，把整个 Registry 传进来等于让「建任务」依赖「能调模型」——
 * 那样连建一个任务都要求凭据配好，而凭据没配恰恰是最该能把任务建出来、
 * 再在界面上看到问题的场景。
 */
export interface AliasChains {
  chainOf(alias: string): ModelAliasChain;
  listAliases(): { alias: string }[];
}

export interface SnapshotServiceOptions {
  catalog: TemplateCatalog;
  uow: UnitOfWorkHandle<UnitOfWork>;
  /**
   * 有它才做降级挑档。缺省（测试、旧装配）则不写 pin，任务照旧走链首——
   * 与引入降级链之前的行为逐字一致。
   */
  aliases?: AliasChains;
  /** ID 生成器。注入是为了让测试断言确定的 ID，生产用 randomUUID */
  newId?: () => string;
}

export interface SnapshotService {
  /**
   * §5.5 第一行：`INSERT task_snapshots` + `INSERT task_skill_snapshots × n` + `INSERT tasks`。
   * 新任务落在 `ready` / `structure`——启动是另一件事（M3 的 lifecycle-service）。
   */
  createTask(input: CreateTaskInput): Promise<CreatedTask>;
  /** M3 ContextBuilder 的读入口。同步，因为它只查库（better-sqlite3） */
  readSnapshot(taskId: string): FrozenTaskSnapshot;
}

function storageError(taskId: string, message: string, cause?: unknown): ForgeError {
  return new ForgeError('STORAGE_ERROR', message, `task:${taskId}`, '请查看服务日志', cause);
}

function parseFrozenSkill(taskId: string, row: TaskSkillSnapshot): FrozenSkill {
  let index: FrozenSkillIndex;
  try {
    index = JSON.parse(row.sectionIndexJson) as FrozenSkillIndex;
  } catch (error) {
    throw storageError(taskId, `Skill 快照 ${row.skillId} 的 section 索引无法解析`, error);
  }
  const sectionIndex: Record<string, SkillSection> = {};
  for (const section of index.sections) sectionIndex[section.id] = section;
  return {
    id: row.skillId,
    version: row.skillVersion,
    contentMarkdown: row.contentMarkdown,
    contentHash: row.contentHash,
    operation: index.operation,
    slotTypes: index.slotTypes,
    summary: index.summary,
    preamble: index.preamble,
    requiredSections: index.requiredSections,
    sections: index.sections,
    sectionIndex,
  };
}

/**
 * 给每个别名挑一档并落成 pin，同时把「跳过了谁、为什么」写进轨迹（D-70）。
 *
 * 只记结果的话（`executions.provider` 已经在记），
 * 「为什么这次跑得比上次贵」在事后是查不出来的——
 * 那正是最需要解释、也最容易被当成玄学的一类问题。
 */
interface PinResult {
  pinned: Record<string, string>;
  /** 人话，进轨迹 summary */
  lines: string[];
  /** 有任何一个别名没走首选档 */
  degraded: boolean;
  /** 有任何一个别名落到了按量付费档（D-69） */
  paid: boolean;
}

function pinAliases(aliases: AliasChains, repos: UnitOfWork): PinResult {
  const pinned: Record<string, string> = {};
  const lines: string[] = [];
  let degraded = false;
  let paid = false;

  for (const { alias } of aliases.listAliases()) {
    const chain = aliases.chainOf(alias);
    const pick = pickProvider(chain, (id) => repos.providerHealth.isExhausted(id));
    pinned[alias] = pick.chosen.provider;
    lines.push(describePick(alias, pick));
    if (pick.tier > 0) degraded = true;
    if (pick.paid) paid = true;
  }

  return { pinned, lines, degraded, paid };
}

export function createSnapshotService(options: SnapshotServiceOptions): SnapshotService {
  const { catalog, uow, aliases } = options;
  const newId = options.newId ?? randomUUID;

  return {
    async createTask(request) {
      const name = request.name.trim();
      if (name === '') {
        throw new ForgeError(
          'TASK_INPUT_INVALID',
          '任务名称不能为空',
          `template:${request.templateId}`,
          '补齐必填字段后重新创建',
        );
      }

      // --- 事务外：全部 async 与全部可能失败的工作都发生在这里 ---

      // D-08：draft / archived 不得用于创建任务。走 requireUsable 而不是 get，
      // 是为了让状态不对时报 TEMPLATE_NOT_PUBLISHED 而不是 TEMPLATE_NOT_FOUND——
      // 对着一个自己刚建的模板说「不存在」是最令人困惑的错误。
      const loaded = await catalog.requireUsable(request.templateId);
      const input = normalizeTaskInput(loaded.compiled.inputFields, request.input, loaded.compiled.id);

      const taskId = newId();
      // 冻结的入参只取 compiled + skills：presentation 进不来（D-02）
      const prepared = prepareSnapshot(
        { compiled: loaded.compiled, skills: loaded.skills },
        { taskId, snapshotId: newId() },
      );

      // --- 事务内：只做写入。三条 INSERT 要么全成，要么一行都不留 ---
      return uow.run((repos) => {
        // 顺序不是随意的：`tasks.snapshot_id` 的外键**不是**延迟的（§5.2），
        // 快照必须先在。反方向 `task_snapshots.task_id → tasks.id` 才是
        // `DEFERRABLE INITIALLY DEFERRED`（D-18），它在 COMMIT 时校验，
        // 所以先写快照、后写任务是唯一可行的顺序。
        const snapshot = repos.snapshots.insert({
          id: prepared.snapshotId,
          taskId: prepared.taskId,
          templateId: prepared.templateId,
          templateVersion: prepared.templateVersion,
          compiledJson: prepared.compiledJson,
          snapshotHash: prepared.snapshotHash,
        });
        repos.snapshots.insertSkills(prepared.skills);
        // D-67：任务边界定住降级档。
        //
        // 在**事务内**挑档不是随意的：耗尽状态和任务行必须看到同一个瞬间。
        // 放到事务外的话，两次读之间另一个任务可能刚把某档标成耗尽，
        // 于是这个任务的 pin 指向一个已知不可用的档——而 pin 一旦写下就不再改。
        //
        // 对所有已配置别名都挑一遍（只有三个），而不是去 compiled 里翻这个模板
        // 用了哪几个：多挑几个别名的成本是零，漏挑一个的代价是运行到一半
        // 才发现某个别名没有 pin。
        const pick = aliases === undefined ? null : pinAliases(aliases, repos);

        const task = repos.tasks.insert({
          id: taskId,
          name,
          snapshotId: prepared.snapshotId,
          input,
          status: 'ready',
          phase: 'structure',
          pinnedProviders: pick?.pinned ?? null,
        });

        // 轨迹必须写在任务行之后：trace_events.task_id 的外键**不是延迟的**
        // （只有 task_snapshots.task_id 是 DEFERRABLE，D-18）。
        //
        // 只在**发生了降级**时写。都走首选档是常态，给常态也发一条事件
        // 只会把轨迹冲淡，让真正该看见的那条更难被看见。
        if (pick !== null && pick.degraded) {
          repos.traces.insert({
            taskId,
            executionId: null,
            actor: 'system',
            kind: 'provider_pinned',
            title: pick.paid ? '已降级到按量付费的 Provider' : 'Provider 降级',
            summary: pick.lines.join('；'),
            payload: { pinned: pick.pinned, paid: pick.paid },
          });
        }

        return { task, snapshot, skills: prepared.skills };
      });
    },

    readSnapshot(taskId) {
      const { tasks, snapshots } = uow.repositories;
      const task = tasks.getOrThrow(taskId);
      const snapshot = snapshots.getByTaskOrThrow(taskId);

      // NFR-004 的诊断点：库里那一列重算一遍必须还等于 snapshot_hash。
      // 对不上说明有人绕过本服务改了 compiled_json（或写入路径出现了第二次序列化），
      // 此时继续生产会产出一份无法追溯来源的内容——宁可当场停下。
      if (sha256Hex(snapshot.compiledJson) !== snapshot.snapshotHash) {
        throw storageError(
          taskId,
          `任务 ${taskId} 的模板快照校验失败：compiled_json 与 snapshot_hash 不一致`,
        );
      }

      let compiled: CompiledTemplate;
      try {
        compiled = JSON.parse(snapshot.compiledJson) as CompiledTemplate;
      } catch (error) {
        throw storageError(taskId, `任务 ${taskId} 的模板快照无法解析`, error);
      }

      const skills: Record<string, FrozenSkill> = {};
      for (const row of snapshots.listSkills(taskId)) {
        skills[row.skillId] = parseFrozenSkill(taskId, row);
      }

      return {
        taskId,
        snapshotId: snapshot.id,
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        compiled,
        snapshotHash: snapshot.snapshotHash,
        skills,
        input: task.input,
      };
    },
  };
}
