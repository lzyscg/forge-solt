#!/usr/bin/env node
/** 导出/验证新的 ReplayInput fixture。旧格式审计保留在 --verify-legacy。 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parseReplayInput, rebuildContextFromReplay } from '@server/application/context-builder.ts';
import { parseSkill } from '@server/application/skill-loader.ts';
import type { FrozenSkill } from '@server/application/snapshot-service.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_DIR = path.join(ROOT, 'bench/fixtures');
const DEFAULT_DB = path.join(ROOT, 'data/forge-core.sqlite');
const CURRENT_SKILLS = new Set(['chapter-structure-design', 'title-writing', 'scene-writing', 'scene-review', 'structure-review']);

interface ReplayCase {
  execId: string;
  taskId: string;
  operation: 'create_structure' | 'fill_slot' | 'review_slot';
  skillId: string;
  skillVersion: string;
  targetSlotId: string | null;
  contextHash: string;
  promptHash: string;
  provider: string;
  model: string;
  attemptNumber: number;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  replayInputJson: string;
  replayInputHash: string;
  inputHash: string;
}

interface Bundle { schemaVersion: 2; exportedFrom: string; cases: ReplayCase[] }
interface RunnerFixtureCase {
  caseId: string;
  execution: {
    id: string; taskId: string; operation: ReplayCase['operation']; targetSlotId: string | null;
    agentId: string; skillId: string; skillVersion: string; modelAlias: string;
    provider: string; model: string; attemptNumber: number;
  };
  replayInputJson: string;
  replayInputHash: string;
  expected: { contextHash: string; promptHash: string };
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function loadSkill(skillId: string, baseDir = 'skills'): FrozenSkill {
  const source = path.join(ROOT, baseDir, skillId, 'SKILL.md');
  const raw = fs.readFileSync(source, 'utf8');
  const loaded = parseSkill(raw, source);
  return {
    id: loaded.id, version: loaded.version, contentMarkdown: raw, contentHash: loaded.contentHash,
    operation: loaded.operation, slotTypes: loaded.slotTypes, readsSlotTypes: loaded.readsSlotTypes,
    status: loaded.status, summary: loaded.summary,
    preamble: loaded.preamble, requiredSections: loaded.requiredSections,
    sections: loaded.sections, sectionIndex: loaded.sectionIndex,
  };
}

function loadBundle(file = path.join(FIXTURE_DIR, 'replay-v2.json')): Bundle {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Bundle;
  if (value.schemaVersion !== 2 || !Array.isArray(value.cases)) throw new Error('fixture 不是 ReplayInput bundle v2');
  return value;
}

function cmdExport(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT e.id, e.task_id, e.operation, e.skill_id, e.skill_version, e.target_slot_id,
              e.context_hash, e.prompt_hash, e.provider, e.model, e.status, e.attempt_number,
              e.input_tokens, e.output_tokens, e.replay_input_json, e.replay_input_hash, t.input_json
         FROM executions e JOIN tasks t ON t.id = e.task_id
        WHERE e.replay_input_json IS NOT NULL OR e.replay_input_hash IS NOT NULL
        ORDER BY e.created_at, e.id`,
    ).all() as Array<Record<string, string | number | null>>;
    const cases = rows.map((row): ReplayCase => {
      if (row['replay_input_json'] === null || row['replay_input_hash'] === null) throw new Error(`execution ${String(row['id'])} 的 ReplayInput 只有半套`);
      const replayInputJson = String(row['replay_input_json']);
      const replayInputHash = String(row['replay_input_hash']);
      parseReplayInput(replayInputJson, replayInputHash);
      return {
        execId: String(row['id']), taskId: String(row['task_id']),
        operation: String(row['operation']) as ReplayCase['operation'], skillId: String(row['skill_id']),
        skillVersion: String(row['skill_version']), targetSlotId: row['target_slot_id'] === null ? null : String(row['target_slot_id']),
        contextHash: String(row['context_hash']), promptHash: String(row['prompt_hash']), provider: String(row['provider']), model: String(row['model']),
        status: String(row['status']), attemptNumber: Number(row['attempt_number']), inputTokens: row['input_tokens'] === null ? null : Number(row['input_tokens']),
        outputTokens: row['output_tokens'] === null ? null : Number(row['output_tokens']), replayInputJson, replayInputHash,
        inputHash: hash(String(row['input_json'])),
      };
    });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const bundle: Bundle = { schemaVersion: 2, exportedFrom: path.basename(dbPath), cases };
    fs.writeFileSync(path.join(FIXTURE_DIR, 'replay-v2.json'), `${JSON.stringify(bundle, null, 1)}\n`);
    console.log(`导出 ${cases.length} 条带 ReplayInput 的执行`);
  } finally { db.close(); }
}

function verifyRows(bundle: Bundle, variantDir?: string): Array<Record<string, unknown>> {
  return bundle.cases.map((item) => {
    const scope = CURRENT_SKILLS.has(item.skillId) ? 'current_binding' : 'historical_snapshot';
    try {
      const replay = parseReplayInput(item.replayInputJson, item.replayInputHash);
      const frozen = replay.contextInput.skill as FrozenSkill;
      const skill = variantDir === undefined ? frozen : loadSkill(item.skillId, variantDir);
      const rebuilt = rebuildContextFromReplay(item.replayInputJson, item.replayInputHash, skill);
      const contextOk = rebuilt.contextHash === item.contextHash;
      const promptOk = rebuilt.promptHash === item.promptHash;
      return { execId: item.execId, taskId: item.taskId, skillId: item.skillId, operation: item.operation, inputHash: item.inputHash,
        scope, included: scope === 'current_binding' && contextOk && promptOk, contextOk, promptOk,
        reason: scope !== 'current_binding' ? 'historical_snapshot' : !contextOk ? 'context_hash_mismatch' : !promptOk ? 'prompt_hash_mismatch' : null };
    } catch (error) {
      return { execId: item.execId, taskId: item.taskId, skillId: item.skillId, operation: item.operation, inputHash: item.inputHash,
        scope, included: false, contextOk: false, promptOk: false, reason: 'rebuild_error', error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function cmdVerify(): void {
  const rows = verifyRows(loadBundle());
  const included = rows.filter((row) => row['included'] === true);
  const bySkill: Record<string, { candidates: number; included: number; stories: Set<string> }> = {};
  for (const row of rows) {
    const id = String(row['skillId']);
    bySkill[id] ??= { candidates: 0, included: 0, stories: new Set() };
    bySkill[id].candidates += 1;
    if (row['included'] === true) { bySkill[id].included += 1; bySkill[id].stories.add(String(row['inputHash'])); }
  }
  fs.writeFileSync(path.join(FIXTURE_DIR, 'verify-v2.json'), `${JSON.stringify(rows, null, 1)}\n`);
  console.log(`ReplayInput 对账：${included.length}/${rows.length} 可用于当前模板实验`);
  for (const [id, stat] of Object.entries(bySkill).sort()) console.log(`  ${id.padEnd(28)} ${stat.included}/${stat.candidates}，故事 ${stat.stories.size}`);
  if (included.length !== rows.filter((row) => row['scope'] === 'current_binding').length) process.exitCode = 1;
}

function cmdControl(skillId: string): void {
  const bundle = loadBundle();
  const base = loadSkill(skillId);
  const variant = loadSkill(skillId, 'skills-variants');
  if (base.version !== variant.version) throw new Error('变体必须保持同版本号');
  if (base.contentHash === variant.contentHash) throw new Error('基线与变体正文相同');
  const rows = bundle.cases.filter((item) => item.skillId === skillId).map((item) => {
    const a = rebuildContextFromReplay(item.replayInputJson, item.replayInputHash, base);
    const b = rebuildContextFromReplay(item.replayInputJson, item.replayInputHash, variant);
    return { execId: item.execId, contextSame: a.contextHash === b.contextHash, promptDifferent: a.promptHash !== b.promptHash };
  });
  console.log(`D-74 对照：${rows.length} 条，context同 ${rows.filter((r) => r.contextSame).length}，prompt异 ${rows.filter((r) => r.promptDifferent).length}`);
  if (rows.length === 0 || rows.some((r) => !r.contextSame || !r.promptDifferent)) process.exitCode = 1;
}

function selectRunnerCases(bundle: Bundle): RunnerFixtureCase[] {
  const selected: RunnerFixtureCase[] = [];
  for (const skillId of CURRENT_SKILLS) {
    const byStory = new Map<string, ReplayCase>();
    for (const item of bundle.cases) {
      if (item.skillId !== skillId || item.status !== 'succeeded') continue;
      const old = byStory.get(item.inputHash);
      if (old === undefined || item.attemptNumber < old.attemptNumber || (item.attemptNumber === old.attemptNumber && item.execId < old.execId)) {
        byStory.set(item.inputHash, item);
      }
    }
    const cases = [...byStory].sort(([a], [b]) => a.localeCompare(b)).slice(0, 3).map(([, item]) => item);
    if (cases.length < 3) throw new Error(`${skillId} 只有 ${cases.length} 个保真故事，不能冻结三故事 selection`);
    for (const item of cases) {
      const replay = parseReplayInput(item.replayInputJson, item.replayInputHash);
      selected.push({
        caseId: `${item.skillId}-${item.inputHash.slice(0, 12)}`,
        execution: {
          id: item.execId, taskId: item.taskId, operation: item.operation, targetSlotId: item.targetSlotId,
          agentId: replay.contextInput.agent.id, skillId: item.skillId, skillVersion: item.skillVersion,
          modelAlias: replay.contextInput.operation === 'create_structure'
            ? replay.contextInput.snapshot.compiled.bindings.createStructure.modelAlias
            : replay.contextInput.agent.modelAlias ?? 'main',
          provider: item.provider, model: item.model, attemptNumber: item.attemptNumber,
        },
        replayInputJson: item.replayInputJson,
        replayInputHash: item.replayInputHash,
        expected: { contextHash: item.contextHash, promptHash: item.promptHash },
      });
    }
  }
  return selected;
}

function cmdSelect(): void {
  const bundle = loadBundle();
  const cases = selectRunnerCases(bundle);
  fs.writeFileSync(path.join(FIXTURE_DIR, 'runner-r0-selection.json'), `${JSON.stringify({ version: 1, cases }, null, 1)}\n`);
  console.log(`冻结 runner selection：${cases.length} cases（5 bindings × 3 stories）`);
}

function cmdList(): void {
  const bundle = loadBundle();
  const groups = new Map<string, Set<string>>();
  for (const item of bundle.cases) {
    const key = `${CURRENT_SKILLS.has(item.skillId) ? 'current' : 'historical'} / ${item.skillId} / ${item.operation}`;
    const stories = groups.get(key) ?? new Set<string>(); stories.add(item.inputHash); groups.set(key, stories);
  }
  console.log(`${bundle.cases.length} 条 ReplayInput execution`);
  for (const [key, stories] of [...groups].sort()) console.log(`  ${key}：${stories.size} 个故事`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === '--export') cmdExport(arg ?? DEFAULT_DB);
    else if (command === '--verify') cmdVerify();
    else if (command === '--control' && arg !== undefined) cmdControl(arg);
    else if (command === '--select-r0') cmdSelect();
    else if (command === '--list') cmdList();
    else throw new Error('用法：replay-v2.ts --export [db] | --verify | --select-r0 | --control <skillId> | --list');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

await main();
