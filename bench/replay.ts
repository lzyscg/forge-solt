/**
 * 回放器 —— S1。把「改一版 Skill → 看产出怎么变」从 63 万 token 的整跑
 * 压成单槽位重放（D-71）。
 *
 * ## 三条纪律，全都编码在这个文件里
 *
 * **D-72 fixture 取自 `executions.context_json`，不另造。**
 * 自己编的 fixture 会编成「Skill 应该能处理的样子」，而历史执行是真实分布，
 * 包含那些当初没处理好的输入。另造等于把已知失败案例排除在测试集之外。
 *
 * **D-73 复用真正的 `buildContext`。** 另写一套 harness 会调出一个线上根本不发的
 * prompt，在它上面调优的 Skill 不迁移。分界线：**prompt 装配必须是真的，
 * 任务编排（调度/预算/Provider 定档）不必是。**
 *
 * **D-74 对照组的合法性由 hash 对断言，不靠人声明。**
 * 改 Skill 正文不改 version 时：contextHash 相同（喂进去的信息没变）、
 * promptHash 不同（Skill 确实换了）。**两条都要断言**——promptHash 也相同说明新
 * Skill 根本没加载上（路径写错、缓存没刷），会安静地产出一份「两版没差别」的报告。
 *
 * ## 重建对不对，不靠我说
 *
 * `--export` 之后 `--verify` 拿**冻结的那一版 Skill** 重建上下文，把算出的
 * contextHash / promptHash 与库里那两列**逐字对账**。对不上的 fixture 直接标废，
 * 不进实验集——绝不拿一份「大概差不多」的 prompt 去调 Skill。
 * 这一手是从 `probe/edit-contract-replay.ts` 学来的，那次它救过一批近似 prompt。
 *
 * 用法：
 *   npx tsx bench/replay.ts --export [db 路径]     从库导出 fixture（默认 data/forge-core.sqlite，只读）
 *   npx tsx bench/replay.ts --verify               保真对账（零模型调用）
 *   npx tsx bench/replay.ts --control <skillId>    D-74 对照组断言（零模型调用）
 *   npx tsx bench/replay.ts --list                 fixture 清单
 *
 * ⚠️ `data/*.sqlite` **没有任何备份**，本文件只以 readonly 打开，任何时候都不写库。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildContext } from '../src/server/application/context-builder.ts';
import type {
  ContextBuilderInput,
  DependencyContent,
} from '../src/server/application/context-builder.ts';
import { parseSkill } from '../src/server/application/skill-loader.ts';
import type {
  FrozenSkill,
  FrozenTaskSnapshot,
} from '../src/server/application/snapshot-service.ts';
import type { CompiledTemplate } from '../src/server/application/template-loader.ts';
import type { Slot } from '../src/server/domain/types.ts';
import type { PriorRound } from '../src/server/domain/revision-context.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_DIR = path.join(ROOT, 'bench/fixtures');
const DEFAULT_DB = path.join(ROOT, 'data/forge-core.sqlite');

// ---------------------------------------------------------------------------
// fixture 形状
// ---------------------------------------------------------------------------

/**
 * 一次可回放的执行。**不含 Skill 正文**——那正是要换的变量（D-71）。
 * 冻结的 Skill 另存在 `TaskFixture.skills` 里，只供 `--verify` 做保真对账。
 */
interface Case {
  execId: string;
  operation: 'create_structure' | 'fill_slot' | 'review_slot';
  skillId: string;
  skillVersion: string;
  agentId: string;
  targetSlotId: string | null;
  /** review_slot 才有。= 审核 Skill 的 section ID，取自 context_json 的注入清单 */
  criterionId: string | null;
  attemptNumber: number;
  maxAttempts: number;
  dependencies: DependencyContent[];
  revision: { round: number; priorRounds: PriorRound[] } | null;
  /** 库里那两列，`--verify` 的对账基准 */
  contextHash: string;
  promptHash: string;
}

interface TaskFixture {
  taskId: string;
  snapshotId: string;
  templateId: string;
  templateVersion: string;
  snapshotHash: string;
  compiled: CompiledTemplate;
  input: Record<string, string>;
  /** 冻结的 Skill 快照，按 id 索引。只用于保真对账，不是实验变量 */
  skills: Record<string, FrozenSkill>;
  slots: Slot[];
  cases: Case[];
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

async function cmdExport(dbPath: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  // 只读打开。data/*.sqlite 没有备份，这个 flag 不是礼貌是防线。
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const tasks = db
    .prepare(
      `SELECT t.id, t.snapshot_id, t.input_json, s.template_id, s.template_version,
              s.compiled_json, s.snapshot_hash
         FROM tasks t JOIN task_snapshots s ON s.id = t.snapshot_id
        WHERE EXISTS (SELECT 1 FROM executions e WHERE e.task_id = t.id AND e.status = 'succeeded')
        ORDER BY t.id`,
    )
    .all() as {
    id: string; snapshot_id: string; input_json: string;
    template_id: string; template_version: string; compiled_json: string; snapshot_hash: string;
  }[];

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  let total = 0;
  const index: { taskId: string; templateId: string; cases: number; bySkill: Record<string, number> }[] = [];

  for (const t of tasks) {
    const compiled = JSON.parse(t.compiled_json) as CompiledTemplate;
    const skills: Record<string, FrozenSkill> = {};
    for (const r of db
      .prepare(`SELECT skill_id, skill_version, content_markdown, section_index_json, content_hash
                  FROM task_skill_snapshots WHERE task_id = ?`)
      .all(t.id) as { skill_id: string; skill_version: string; content_markdown: string;
                      section_index_json: string; content_hash: string }[]) {
      const idx = JSON.parse(r.section_index_json) as Omit<FrozenSkill, 'id' | 'version' | 'contentMarkdown' | 'contentHash' | 'sectionIndex'>;
      const sectionIndex: Record<string, (typeof idx.sections)[number]> = {};
      for (const s of idx.sections) sectionIndex[s.id] = s;
      skills[r.skill_id] = {
        ...idx, id: r.skill_id, version: r.skill_version,
        contentMarkdown: r.content_markdown, contentHash: r.content_hash, sectionIndex,
      };
    }

    const slots = (db
      .prepare(`SELECT * FROM slots WHERE task_id = ? ORDER BY sort_order, slot_id`)
      .all(t.id) as Record<string, unknown>[]).map(rowToSlot);

    const cases: Case[] = [];
    for (const e of db
      .prepare(`SELECT id, operation, target_slot_id, agent_id, skill_id, skill_version,
                       attempt_number, context_json, context_hash, prompt_hash
                  FROM executions WHERE task_id = ? AND status = 'succeeded'
                 ORDER BY created_at, id`)
      .all(t.id) as Record<string, string | number>[]) {
      const ctx = JSON.parse(String(e.context_json)) as {
        skill: { injectedSectionIds: string[] };
        dependencies: DependencyContent[];
        revision: { round: number; priorRounds: PriorRound[] } | null;
      };
      const op = String(e.operation) as Case['operation'];
      const binding = bindingFor(compiled, op, slots, e.target_slot_id == null ? null : String(e.target_slot_id));
      cases.push({
        execId: String(e.id),
        operation: op,
        skillId: String(e.skill_id),
        skillVersion: String(e.skill_version),
        agentId: String(e.agent_id),
        targetSlotId: e.target_slot_id == null ? null : String(e.target_slot_id),
        // review_slot 的注入清单就是那一条判据（D-23：一次一条）
        criterionId: op === 'review_slot' ? (ctx.skill.injectedSectionIds[0] ?? null) : null,
        attemptNumber: Number(e.attempt_number),
        maxAttempts: (binding?.maxRetries ?? 2) + 1,
        dependencies: ctx.dependencies,
        revision: ctx.revision,
        contextHash: String(e.context_hash),
        promptHash: String(e.prompt_hash),
      });
    }

    const fx: TaskFixture = {
      taskId: t.id, snapshotId: t.snapshot_id,
      templateId: t.template_id, templateVersion: t.template_version,
      snapshotHash: t.snapshot_hash, compiled,
      input: JSON.parse(t.input_json) as Record<string, string>,
      skills, slots, cases,
    };
    fs.writeFileSync(path.join(FIXTURE_DIR, `${t.id}.json`), JSON.stringify(fx, null, 1) + '\n');
    total += cases.length;
    const bySkill: Record<string, number> = {};
    for (const c of cases) bySkill[c.skillId] = (bySkill[c.skillId] ?? 0) + 1;
    index.push({ taskId: t.id, templateId: t.template_id, cases: cases.length, bySkill });
  }
  db.close();
  fs.writeFileSync(path.join(FIXTURE_DIR, 'index.json'), JSON.stringify({ 生成于: dbPath, 任务数: tasks.length, 用例数: total, 明细: index }, null, 1) + '\n');
  console.log(`导出 ${tasks.length} 个任务、${total} 条可回放执行 → ${path.relative(ROOT, FIXTURE_DIR)}/`);
  console.log('下一步：npx tsx bench/replay.ts --verify   ——重建对不对，由 hash 对账说了算');
}

/** slots 表的行 → domain 的 Slot。列名与字段名不同，错一处 hash 就对不上 */
function rowToSlot(r: Record<string, unknown>): Slot {
  return {
    taskId: String(r.task_id),
    slotId: String(r.slot_id),
    type: String(r.type),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    sortOrder: Number(r.sort_order),
    instruction: String(r.instruction),
    dependsOn: JSON.parse(String(r.depends_on_json ?? '[]')) as string[],
    contentBearing: Number(r.content_bearing) === 1,
    includeInArtifact: Number(r.include_in_artifact) === 1,
    status: String(r.status),
    revisionRound: Number(r.revision_round),
    reviewExhausted: Number(r.review_exhausted) === 1,
    contentText: r.content_text == null ? null : String(r.content_text),
    producerAgentId: r.producer_agent_id == null ? null : String(r.producer_agent_id),
    producerSkillId: r.producer_skill_id == null ? null : String(r.producer_skill_id),
    producerSkillVersion: r.producer_skill_version == null ? null : String(r.producer_skill_version),
    producerExecutionId: r.producer_execution_id == null ? null : String(r.producer_execution_id),
    errorCode: r.error_code == null ? null : String(r.error_code),
    errorMessage: r.error_message == null ? null : String(r.error_message),
  } as unknown as Slot;
}

function bindingFor(
  compiled: CompiledTemplate, op: Case['operation'], slots: Slot[], targetSlotId: string | null,
): { maxRetries: number } | undefined {
  if (op === 'create_structure') return compiled.bindings.createStructure;
  const slot = slots.find((s) => s.slotId === targetSlotId);
  if (slot === undefined) return undefined;
  const binding = op === 'fill_slot'
    ? compiled.bindings.fillSlotByType[slot.type]
    : (compiled.bindings.reviewSlotByType?.[slot.type] ?? compiled.bindings.reviewStructure);
  return binding ?? undefined;
}

// ---------------------------------------------------------------------------
// 重建 —— 只有一份，`--verify` 与实验走的是同一条路径
// ---------------------------------------------------------------------------

function loadFixtures(): TaskFixture[] {
  if (!fs.existsSync(FIXTURE_DIR)) {
    console.error(`没有 ${path.relative(ROOT, FIXTURE_DIR)}/，先跑 --export`);
    process.exit(2);
  }
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'verify.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as unknown)
    .filter((value): value is TaskFixture => {
      if (typeof value !== 'object' || value === null) return false;
      const fixture = value as Partial<TaskFixture>;
      return typeof fixture.taskId === 'string' && Array.isArray(fixture.cases);
    });
}

/**
 * 用给定的 Skill 重建这一条执行的上下文。
 *
 * `skill` 是**唯一的自由变量**：传冻结那版就是保真对账，传 `skills/` 就是基线，
 * 传 `skills-variants/X` 就是变体。其余一切来自 fixture，逐字不动。
 */
function rebuild(fx: TaskFixture, c: Case, skill: FrozenSkill): ReturnType<typeof buildContext> {
  const snapshot: FrozenTaskSnapshot = {
    taskId: fx.taskId, snapshotId: fx.snapshotId,
    templateId: fx.templateId, templateVersion: fx.templateVersion,
    compiled: fx.compiled, snapshotHash: fx.snapshotHash,
    skills: fx.skills, input: fx.input,
  };
  const agent = fx.compiled.agents.find((a) => a.id === c.agentId);
  if (agent === undefined) throw new Error(`fixture ${c.execId}: 快照里没有 Agent ${c.agentId}`);

  const common = { snapshot, agent, skill, attemptNumber: c.attemptNumber, maxAttempts: c.maxAttempts };
  if (c.operation === 'create_structure') {
    return buildContext({ ...common, operation: 'create_structure', retry: null, review: null } as ContextBuilderInput);
  }
  const targetSlot = fx.slots.find((s) => s.slotId === c.targetSlotId);
  if (targetSlot === undefined) throw new Error(`fixture ${c.execId}: 槽位 ${String(c.targetSlotId)} 已不在树上`);
  const slotType = fx.compiled.slotTypes.find((t) => t.id === targetSlot.type);
  if (slotType === undefined) throw new Error(`fixture ${c.execId}: 快照里没有槽位类型 ${targetSlot.type}`);

  if (c.operation === 'fill_slot') {
    return buildContext({
      ...common, operation: 'fill_slot', slots: fx.slots, targetSlot, slotType,
      dependencies: c.dependencies, retry: null, revision: c.revision,
    } as ContextBuilderInput);
  }
  return buildContext({
    ...common, operation: 'review_slot', slots: fx.slots, targetSlot, slotType,
    dependencies: c.dependencies,
    criterionId: c.criterionId ?? '',
    contentUnderReview: targetSlot.contentText ?? '',
  } as ContextBuilderInput);
}

/** 从磁盘读一版 Skill，塑成 `FrozenSkill`。变体机制就是「换一个目录」 */
function skillFromDisk(dir: string, skillId: string): FrozenSkill {
  const p = path.join(ROOT, dir, skillId, 'SKILL.md');
  const loaded = parseSkill(fs.readFileSync(p, 'utf8'), p);
  const sectionIndex: Record<string, (typeof loaded.sections)[number]> = {};
  for (const s of loaded.sections) sectionIndex[s.id] = s;
  return {
    id: loaded.id, version: loaded.version, operation: loaded.operation,
    slotTypes: loaded.slotTypes, summary: loaded.summary, preamble: loaded.preamble,
    requiredSections: loaded.requiredSections, sections: loaded.sections, sectionIndex,
    contentMarkdown: fs.readFileSync(p, 'utf8'), contentHash: loaded.contentHash,
  };
}

// ---------------------------------------------------------------------------
// --verify：保真对账
// ---------------------------------------------------------------------------

function cmdVerify(): void {
  const fxs = loadFixtures();
  const rows: { execId: string; skill: string; op: string; ctx: boolean; prompt: boolean; err: string | null }[] = [];

  for (const fx of fxs) {
    for (const c of fx.cases) {
      const frozen = fx.skills[c.skillId];
      if (frozen === undefined) {
        rows.push({ execId: c.execId, skill: c.skillId, op: c.operation, ctx: false, prompt: false, err: '快照里没有这个 Skill' });
        continue;
      }
      try {
        const b = rebuild(fx, c, frozen);
        rows.push({ execId: c.execId, skill: c.skillId, op: c.operation,
          ctx: b.contextHash === c.contextHash, prompt: b.promptHash === c.promptHash, err: null });
      } catch (e) {
        rows.push({ execId: c.execId, skill: c.skillId, op: c.operation, ctx: false, prompt: false,
          err: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const ok = rows.filter((r) => r.ctx && r.prompt);
  console.log(`保真对账：${rows.length} 条执行`);
  console.log(`  contextHash 对上 ${rows.filter((r) => r.ctx).length}`);
  console.log(`  promptHash  对上 ${rows.filter((r) => r.prompt).length}`);
  console.log(`  **两条都对上（可用于实验）${ok.length}**`);

  const bySkill: Record<string, { ok: number; n: number }> = {};
  for (const r of rows) {
    const k = `${r.skill} / ${r.op}`;
    bySkill[k] ??= { ok: 0, n: 0 };
    bySkill[k].n++;
    if (r.ctx && r.prompt) bySkill[k].ok++;
  }
  console.log('\n按 Skill：');
  for (const [k, v] of Object.entries(bySkill).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.ok).padStart(3)}/${String(v.n).padEnd(3)}  ${k}`);
  }

  const bad = rows.filter((r) => !(r.ctx && r.prompt));
  if (bad.length) {
    console.log(`\n对不上的 ${bad.length} 条（**不进实验集**，绝不拿近似 prompt 调 Skill）：`);
    const reasons: Record<string, number> = {};
    for (const r of bad) {
      const why = r.err ?? (r.ctx ? 'promptHash 不符（语义输入对，成文不对）' : 'contextHash 不符（语义输入就不对）');
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${why}`);
  }
  fs.writeFileSync(path.join(FIXTURE_DIR, 'verify.json'), JSON.stringify(rows, null, 1) + '\n');
  console.log(`\n逐条结果 → ${path.relative(ROOT, path.join(FIXTURE_DIR, 'verify.json'))}`);
}

// ---------------------------------------------------------------------------
// --control：D-74 对照组断言
// ---------------------------------------------------------------------------

/**
 * 断言「换了 Skill 正文而没换版本号」这件事确实发生了。
 *
 * 两条都要：
 *   contextHash 相同 → 喂进去的信息没变，这才是个合法的对照
 *   promptHash 不同  → Skill 真的换了。**相同说明变体根本没加载上**，
 *                      会安静地产出一份「两版没差别」的报告，这是最坏的失败模式
 */
function cmdControl(skillId: string): void {
  const variantPath = path.join(ROOT, 'skills-variants', skillId, 'SKILL.md');
  if (!fs.existsSync(variantPath)) {
    console.error(`没有 skills-variants/${skillId}/SKILL.md。`);
    console.error('变体住在 skills-variants/（D-77）——skills/ 保持是生产的唯一真相。');
    process.exit(2);
  }
  const base = skillFromDisk('skills', skillId);
  const variant = skillFromDisk('skills-variants', skillId);

  console.log(`基线 skills/${skillId}          v${base.version}  ${base.contentHash.slice(0, 12)}`);
  console.log(`变体 skills-variants/${skillId} v${variant.version}  ${variant.contentHash.slice(0, 12)}`);
  if (base.version !== variant.version) {
    console.log(`\n✗ 版本号不同（${base.version} vs ${variant.version}）。`);
    console.log('  D-74 的对照要求**不改版本号**：版本进 contextHash，改了它 contextHash 必然不同，');
    console.log('  于是「喂进去的信息没变」这条断言就没法做了。');
    process.exit(1);
  }
  if (base.contentHash === variant.contentHash) {
    console.log('\n✗ 两份正文逐字相同——这不是一次实验。');
    process.exit(1);
  }

  const fxs = loadFixtures();
  let n = 0, ctxSame = 0, promptDiff = 0;
  const bad: string[] = [];
  for (const fx of fxs) {
    for (const c of fx.cases) {
      if (c.skillId !== skillId) continue;
      const frozen = fx.skills[c.skillId];
      if (frozen === undefined) continue;
      try {
        const a = rebuild(fx, c, base);
        const b = rebuild(fx, c, variant);
        n++;
        if (a.contextHash === b.contextHash) ctxSame++; else bad.push(`${c.execId}: contextHash 变了`);
        if (a.promptHash !== b.promptHash) promptDiff++; else bad.push(`${c.execId}: promptHash 没变——变体没加载上`);
      } catch { /* 重建不了的在 --verify 里已经报过，这里不重复 */ }
    }
  }
  console.log(`\n对照组断言（${n} 条 fixture）：`);
  console.log(`  ${ctxSame === n ? '✓' : '✗'} contextHash 全部相同  ${ctxSame}/${n}   —— 喂进去的信息确实没变`);
  console.log(`  ${promptDiff === n ? '✓' : '✗'} promptHash 全部不同  ${promptDiff}/${n}   —— Skill 确实换了`);
  for (const b of bad.slice(0, 10)) console.log(`    ${b}`);
  if (ctxSame !== n || promptDiff !== n) process.exit(1);
  console.log('\n这是一次合法的对照。可以开始比产出了。');
}

// ---------------------------------------------------------------------------

function cmdList(): void {
  const idx = path.join(FIXTURE_DIR, 'index.json');
  if (!fs.existsSync(idx)) { console.error('先跑 --export'); process.exit(2); }
  const j = JSON.parse(fs.readFileSync(idx, 'utf8')) as { 任务数: number; 用例数: number; 明细: { taskId: string; templateId: string; cases: number; bySkill: Record<string, number> }[] };
  console.log(`${j.任务数} 个任务 / ${j.用例数} 条执行`);
  const tot: Record<string, number> = {};
  for (const d of j.明细) for (const [k, v] of Object.entries(d.bySkill)) tot[k] = (tot[k] ?? 0) + v;
  for (const [k, v] of Object.entries(tot).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === '--export') return cmdExport(args[1] ?? DEFAULT_DB);
  if (cmd === '--verify') return cmdVerify();
  if (cmd === '--list') return cmdList();
  if (cmd === '--control') {
    const id = args[1];
    if (id === undefined) { console.error('用法：--control <skillId>'); process.exit(2); }
    return cmdControl(id);
  }
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log((source.split('*/')[0] ?? '').replace(/^\/\*\*|^ \* ?|^ \*\//gm, ''));
  process.exit(1);
}

await main();
