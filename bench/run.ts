#!/usr/bin/env node
/** S2 r0：保真 ReplayInput × 当前 Skill 的单槽位真实模型重复运行。 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { ResolvedSubmissionPayload } from '@shared/tools.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import { deriveMaxTokens } from '@server/application/production-engine.ts';
import { parseReplayInput, rebuildContextFromReplay } from '@server/application/context-builder.ts';
import { parseSkill } from '@server/application/skill-loader.ts';
import type { FrozenSkill } from '@server/application/snapshot-service.ts';
import { validateSlotContent } from '@server/application/completion-service.ts';
import { validateConcreteStructure } from '@server/domain/structure-validation.ts';
import { verifyFindings } from '@server/domain/review-evidence.ts';
import { AssignmentRunner } from '@server/runtime/assignment-runner.ts';
import type { CompletionPort, StructurePort, TracePort } from '@server/runtime/ports.ts';
import { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';

interface ReplayCase {
  execId: string; taskId: string; operation: 'create_structure' | 'fill_slot' | 'review_slot';
  skillId: string; skillVersion: string; targetSlotId: string | null; contextHash: string; promptHash: string;
  provider: string; model: string; status: string; attemptNumber: number; inputTokens: number | null; outputTokens: number | null;
  replayInputJson: string; replayInputHash: string; inputHash: string;
}
interface Bundle { schemaVersion: 2; cases: ReplayCase[] }
interface Args { fixtures: string; out: string; repeats: number; providerId: string; providerConfig: string; skillsDir: string }

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]; if (token === undefined || !token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(token.slice(2), next); i += 1; }
    else flags.set(token.slice(2), 'true');
  }
  const out = flags.get('out');
  if (out === undefined) throw new Error('用法：run.ts --out <r0.json> [--fixtures replay-v2.json] [--repeats 3]');
  const repeats = Number(flags.get('repeats') ?? '3');
  if (!Number.isInteger(repeats) || repeats < 3) throw new Error('--repeats 必须是 >= 3 的整数');
  return {
    fixtures: path.resolve(flags.get('fixtures') ?? 'bench/fixtures/replay-v2.json'), out: path.resolve(out), repeats,
    providerId: flags.get('provider-id') ?? 'deepseek', providerConfig: path.resolve(flags.get('provider-config') ?? 'config/providers.yaml'),
    skillsDir: path.resolve(flags.get('skills-dir') ?? 'skills'),
  };
}

function selectedProviderConfig(config: ProviderConfig, providerId: string): ProviderConfig {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined) throw new Error(`Provider 配置里没有 ${providerId}`);
  const aliases: Record<string, { provider: string; model: string; paid?: boolean | undefined }[]> = {};
  for (const [alias, chain] of Object.entries(config.aliases)) {
    const entry = chain.find((candidate) => candidate.provider === providerId);
    if (entry === undefined) throw new Error(`别名 ${alias} 的链里没有 ${providerId}`);
    aliases[alias] = [{ ...entry }];
  }
  return { providers: [provider], aliases, defaults: config.defaults };
}

function currentSkill(skillsDir: string, id: string): FrozenSkill {
  const source = path.join(skillsDir, id, 'SKILL.md');
  const raw = fs.readFileSync(source, 'utf8');
  const loaded = parseSkill(raw, source);
  return { id: loaded.id, version: loaded.version, contentMarkdown: raw, contentHash: loaded.contentHash,
    operation: loaded.operation, slotTypes: loaded.slotTypes, summary: loaded.summary, preamble: loaded.preamble,
    requiredSections: loaded.requiredSections, sections: loaded.sections, sectionIndex: loaded.sectionIndex };
}

function bindingOf(item: ReplayCase, replay: ReturnType<typeof parseReplayInput>) {
  const compiled = replay.contextInput.snapshot.compiled;
  if (item.operation === 'create_structure') return compiled.bindings.createStructure;
  const slotType = replay.contextInput.operation === 'create_structure' ? null : replay.contextInput.targetSlot.type;
  if (slotType === null) throw new Error(`execution ${item.execId} 缺槽位类型`);
  return item.operation === 'fill_slot'
    ? compiled.bindings.fillSlotByType[slotType]
    : (compiled.bindings.reviewSlotByType[slotType] ?? compiled.bindings.reviewStructure);
}

function chooseCases(bundle: Bundle): ReplayCase[] {
  const skills = ['chapter-structure-design', 'title-writing', 'scene-writing', 'scene-review', 'structure-review'];
  const selected: ReplayCase[] = [];
  for (const skill of skills) {
    const byStory = new Map<string, ReplayCase>();
    for (const item of bundle.cases) {
      if (item.skillId !== skill || item.status !== 'succeeded') continue;
      const old = byStory.get(item.inputHash);
      if (old === undefined || item.attemptNumber < old.attemptNumber || (item.attemptNumber === old.attemptNumber && item.execId < old.execId)) byStory.set(item.inputHash, item);
    }
    const stories = [...byStory].sort(([a], [b]) => a.localeCompare(b)).slice(0, 3).map(([, item]) => item);
    if (stories.length < 3) throw new Error(`${skill} 只有 ${stories.length} 个保真故事，不能冒充三故事基线`);
    selected.push(...stories);
  }
  return selected;
}

function skillView(skill: FrozenSkill) {
  return { id: skill.id, version: skill.version, summary: skill.summary, preamble: skill.preamble,
    requiredSections: skill.requiredSections, sectionIndex: skill.sectionIndex, sections: skill.sections };
}

async function runOne(item: ReplayCase, repeat: number, registry: ProviderRegistry, config: ProviderConfig, skillsDir: string) {
  const replay = parseReplayInput(item.replayInputJson, item.replayInputHash);
  const skill = currentSkill(skillsDir, item.skillId);
  if (skill.contentHash !== replay.contextInput.skill.contentHash) throw new Error(`${item.skillId} 已改变，r0 冻结条件失效`);
  const context = rebuildContextFromReplay(item.replayInputJson, item.replayInputHash, skill);
  if (context.contextHash !== item.contextHash || context.promptHash !== item.promptHash) throw new Error(`${item.execId} 不能逐字重建`);
  const binding = bindingOf(item, replay);
  if (binding === undefined || binding === null) throw new Error(`${item.execId} 找不到生产 binding`);
  const target = replay.contextInput.operation === 'create_structure' ? null : replay.contextInput.targetSlot;
  const slots = replay.contextInput.operation === 'create_structure' ? [] : replay.contextInput.slots;
  const submissionRef: { current: ResolvedSubmissionPayload | null } = { current: null };
  let submissionAudit: Record<string, unknown> | null = null;
  const traceRows: Array<{ kind: string; summary: string }> = [];

  const trace: TracePort = {
    record(_taskId, record) { traceRows.push({ kind: record.kind, summary: record.summary }); },
    bufferOutput() {},
  };
  const structure: StructurePort = {
    async readOutline() { return slots.map((slot) => ({ slotId: slot.slotId, type: slot.type, parentId: slot.parentId,
      sortOrder: slot.sortOrder, instruction: slot.instruction, dependsOn: slot.dependsOn, contentBearing: slot.contentBearing, status: slot.status })); },
    async readSlotContent(_taskId, slotId) {
      const slot = slots.find((candidate) => candidate.slotId === slotId);
      return slot === undefined ? null : { slotId: slot.slotId, type: slot.type, instruction: slot.instruction, status: slot.status, contentText: slot.contentText };
    },
  };
  const completion: CompletionPort = {
    async submit(request) {
      const payload = request.payload;
      if (payload.kind === 'structure') {
        const checked = validateConcreteStructure(payload, replay.contextInput.snapshot.compiled);
        if (!checked.ok) return { ok: false, code: 'STRUCTURE_INVALID', message: '结构校验未通过', violations: checked.violations };
        submissionAudit = { kind: payload.kind, slots: payload.slots.length };
      } else if (payload.kind === 'slot_content') {
        const validation = replay.contextInput.operation === 'fill_slot' ? replay.contextInput.slotType.validation : null;
        const reasons = validation === null ? [] : validateSlotContent(payload.content, validation);
        if (reasons.length > 0) return { ok: false, code: 'ASSIGNMENT_OUTPUT_INVALID', message: reasons.join('；'), violations: [] };
        submissionAudit = { kind: payload.kind, chars: [...payload.content].length };
      } else {
        const verified = verifyFindings(replay.contextInput.operation === 'review_slot' ? replay.contextInput.contentUnderReview : '', payload.findings);
        submissionAudit = { kind: payload.kind, verdict: payload.verdict, kept: verified.kept.length, discarded: verified.discardedCount };
      }
      submissionRef.current = payload;
      return { ok: true };
    },
  };
  const runner = new AssignmentRunner({ registry, trace, completion, structure, rateLimitBackoff: config.defaults.rateLimitBackoff });
  const controller = new AbortController();
  const started = performance.now();
  const outcome = await runner.run({
    taskId: `bench-${item.taskId}`, executionId: `bench-${item.execId}-${repeat}`, executionToken: `bench-token-${repeat}`,
    operation: item.operation, targetSlotId: item.targetSlotId, modelAlias: binding.modelAlias, pinnedProviderId: item.provider,
    systemText: context.systemText, userText: context.userText, maxToolCalls: replay.contextInput.snapshot.compiled.limits.maxToolCallsPerAssignment,
    maxTokens: deriveMaxTokens(replay.contextInput.operation === 'create_structure' ? null : replay.contextInput.slotType), timeoutMs: binding.timeoutMs,
    allowedDependencySlotIds: replay.contextInput.operation === 'create_structure' ? [] : replay.contextInput.dependencies.map((dependency) => dependency.slotId),
    skill: skillView(skill), taskInput: replay.contextInput.snapshot.input,
    revisionBase: replay.contextInput.operation === 'fill_slot' && replay.contextInput.revision !== null && target?.contentText !== null && target?.contentText !== undefined
      ? { round: replay.contextInput.revision.round, content: target.contentText, degraded: replay.contextInput.revision.degraded } : null,
    controller,
  });
  const elapsedMs = Math.round(performance.now() - started);
  const submitted = submissionRef.current;
  const output = submitted === null ? '' : submitted.kind === 'slot_content' ? submitted.content : JSON.stringify(submitted);
  return {
    id: `${item.skillId}-${item.inputHash.slice(0, 10)}-${repeat}`, case_id: item.execId, task_id: item.taskId,
    skill: item.skillId, story: item.inputHash.slice(0, 12), variant: 'r0', repeat, status: outcome.kind === 'succeeded' ? 'success' : 'failure',
    output, error: outcome.kind === 'failed' ? `${outcome.code}: ${outcome.message}` : outcome.kind === 'cancelled' ? outcome.reason : null,
    provider: outcome.provider, model: outcome.model, usage: outcome.usage === null ? {} : { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens },
    tool_calls: outcome.toolCalls, elapsed_ms: elapsedMs, context_hash: context.contextHash, prompt_hash: context.promptHash,
    skill_hash: skill.contentHash, template_hash: replay.contextInput.snapshot.compiled.templateHash, submission_audit: submissionAudit, trace: traceRows,
  };
}

export async function runBaseline(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (fs.existsSync(args.out)) throw new Error(`输出已存在，拒绝覆盖：${args.out}`);
  const bundle = JSON.parse(fs.readFileSync(args.fixtures, 'utf8')) as Bundle;
  if (bundle.schemaVersion !== 2 || !Array.isArray(bundle.cases)) throw new Error('fixture 不是 v2 bundle');
  const selected = chooseCases(bundle);
  const config = selectedProviderConfig(await loadProviderConfig(args.providerConfig), args.providerId);
  const registry = new ProviderRegistry({ config });
  const samples: Awaited<ReturnType<typeof runOne>>[] = [];
  for (const item of selected) {
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      const sample = await runOne(item, repeat, registry, config, args.skillsDir);
      samples.push(sample);
      console.log(`${sample.skill}  ${sample.story}  #${repeat}  ${sample.status}`);
    }
  }
  const firstReplay = parseReplayInput(selected[0]!.replayInputJson, selected[0]!.replayInputHash);
  const run = {
    run_id: 'r0', label: '当前模板与 Skill 基线', created_at: new Date().toISOString(), provider: args.providerId,
    model: [...new Set(samples.map((sample) => sample.model).filter(Boolean))].join(', '),
    baseline_conditions: {
      template_hash: firstReplay.contextInput.snapshot.compiled.templateHash,
      current_template: 'zhihu-chapter v1.0.0；chapter→scene；scene.maxChars=8000；无 chapter_outline；输出 chapter.md',
      known_skill_drift: 'title-writing/scene-writing 仍要求读取不存在的骨架槽位；scene-writing 仍禁止编号小节；本轮不修复',
      route: '模板与 Skill 一致性修复留到 S2.5；r0 只记录当前真实状态',
      selection: '5 skills × 3 unique story input hashes × repeats',
    },
    candidates: selected.length, included: selected.length, excluded: 0, repeats: args.repeats,
    skills: [...new Set(samples.map((sample) => sample.skill))].map((id) => ({ id, baseline: { ref: 'r0', hash: samples.find((sample) => sample.skill === id)?.skill_hash ?? 'unknown', label: '基线' }, variants: [] })),
    samples,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(run, null, 2)}\n`);
  return samples.every((sample) => sample.status === 'success') ? 0 : 1;
}

async function main(): Promise<void> {
  try { process.exitCode = await runBaseline(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
