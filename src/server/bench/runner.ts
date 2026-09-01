import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';
import type { Operation } from '@shared/contracts.ts';
import type { ErrorCode } from '@shared/errors.ts';
import type { ResolvedSubmissionPayload } from '@shared/tools.ts';
import type { TraceRecord } from '@server/runtime/ports.ts';
import type {
  CompletionOutcome,
  CompletionPort,
  CompletionRequest,
  OutlineSlot,
  SlotContentView,
  StructurePort,
  TracePort,
} from '@server/runtime/ports.ts';
import { AssignmentRunner } from '@server/runtime/assignment-runner.ts';
import type { AssignmentOutcome } from '@server/runtime/assignment-runner.ts';
import type { ProviderAdapter } from '@server/runtime/provider/provider-adapter.ts';
import { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';
import type { ProviderEntry, ProviderConfig } from '@server/application/provider-config.ts';
import { validateSlotContent } from '@server/application/completion-service.ts';
import {
  buildContext,
  parseReplayInput,
  type ContextBuilderInput,
  type ReplayInput,
} from '@server/application/context-builder.ts';
import { deriveMaxTokens } from '@server/application/production-engine.ts';
import { reviewBindingOf } from '@server/application/review-binding.ts';
import { parseSkill } from '@server/application/skill-loader.ts';
import type { FrozenSkill } from '@server/application/snapshot-service.ts';
import { verifyFindings } from '@server/domain/review-evidence.ts';
import { validateConcreteStructure } from '@server/domain/structure-validation.ts';

const SUPPORTED_BINDINGS = [
  { operation: 'create_structure', skillId: 'chapter-structure-design' },
  { operation: 'fill_slot', skillId: 'title-writing' },
  { operation: 'fill_slot', skillId: 'scene-writing' },
  { operation: 'review_slot', skillId: 'scene-review' },
  { operation: 'review_slot', skillId: 'structure-review' },
] as const satisfies readonly { operation: Operation; skillId: string }[];

const REQUIRED_BASELINE_SKILLS = [...new Set(SUPPORTED_BINDINGS.map((binding) => binding.skillId))];

const ExecutionMetadataSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    operation: z.enum(['create_structure', 'fill_slot', 'review_slot']),
    targetSlotId: z.string().nullable(),
    agentId: z.string().min(1),
    skillId: z.string().min(1),
    skillVersion: z.string().min(1),
    modelAlias: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    attemptNumber: z.number().int().positive(),
  })
  .passthrough();

const FixtureCaseSchema = z
  .object({
    caseId: z.string().min(1),
    execution: ExecutionMetadataSchema,
    replayInputJson: z.string().min(1),
    replayInputHash: z.string().min(1),
    expected: z
      .object({ contextHash: z.string().min(1), promptHash: z.string().min(1) })
      .strict(),
  })
  .strict();

const FixtureFileSchema = z
  .object({ version: z.literal(1), cases: z.array(FixtureCaseSchema) })
  .strict();

export type BenchExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;
export type BenchFixtureCase = z.infer<typeof FixtureCaseSchema>;
export type BenchFixtureFile = z.infer<typeof FixtureFileSchema>;

export interface BenchmarkOptions {
  fixturesPath: string;
  outPath: string;
  repeats: number;
  providerId: 'deepseek';
  skillsDir: string;
  providerConfig: ProviderConfig;
}

export interface BenchmarkDeps {
  adapterFactory?: (entry: ProviderEntry) => ProviderAdapter | null;
  env?: NodeJS.ProcessEnv;
  newId?: () => string;
  newToken?: () => string;
  now?: () => Date;
}

interface RecordedRejection {
  code: ErrorCode;
  message: string;
  violations: readonly unknown[];
}

interface RecordedError {
  code: string;
  message: string;
}

interface ReviewFilterAudit {
  submittedVerdict: 'no_finding' | 'revise';
  finalVerdict: 'no_finding' | 'revise' | 'discarded';
  submittedFindings: number;
  keptFindings: number;
  discardedFindings: number;
}

export interface BenchmarkSample {
  id: string;
  case_id: string;
  repeat: number;
  skill: string;
  story: string;
  variant: 'r0';
  operation: Operation;
  status: 'success' | 'failure';
  output: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  tool_calls: number;
  elapsed_ms: number;
  provider: string | null;
  model: string | null;
  execution_id: string;
  source_execution_id: string;
  raw_submission: ResolvedSubmissionPayload | null;
  submissions: ResolvedSubmissionPayload[];
  accepted_submissions: ResolvedSubmissionPayload[];
  review_filter_audit: ReviewFilterAudit | null;
  rejections: RecordedRejection[];
  errors: RecordedError[];
  trace: TraceRecord[];
  error: RecordedError | null;
}

export interface BenchmarkReport {
  run_id: 'r0';
  label: string;
  created_at: string;
  provider: string;
  model: string;
  baseline_conditions: {
    template_has_chapter_outline: false;
    scene_max_chars: 8000;
    skills_still_read_skeleton: readonly ['title-writing', 'scene-writing', 'scene-review'];
    scene_skill_forbids_numbering: true;
    known_defects_fixed: false;
    declaration: string;
    binding_scope: readonly { operation: Operation; skill_id: string }[];
  };
  selection: {
    fixture_cases: number;
    repeats: number;
    samples: number;
    case_ids: string[];
  };
  skills: {
    id: string;
    name: string;
    baseline: { ref: 'r0'; hash: string; label: '当前生产 Skill' };
    variants: [];
  }[];
  samples: BenchmarkSample[];
}

interface PreparedCase {
  fixture: BenchFixtureCase;
  replay: ReplayInput;
  skill: FrozenSkill;
  context: ReturnType<typeof buildContext>;
  outline: OutlineSlot[];
  contents: Record<string, SlotContentView>;
  resolved: { providerId: string; model: string };
}

class MemoryTracePort implements TracePort {
  readonly records: TraceRecord[] = [];

  record(_taskId: string, record: TraceRecord): void {
    this.records.push(structuredClone(record));
  }

  bufferOutput(_taskId: string, _executionId: string, delta: string): void {
    this.output += delta;
  }

  output = '';
}

class FixtureStructurePort implements StructurePort {
  constructor(
    private readonly outline: readonly OutlineSlot[],
    private readonly contents: Readonly<Record<string, SlotContentView>>,
  ) {}

  async readOutline(): Promise<readonly OutlineSlot[]> {
    return this.outline;
  }

  async readSlotContent(_taskId: string, slotId: string): Promise<SlotContentView | null> {
    return this.contents[slotId] ?? null;
  }
}

class MemoryCompletionPort implements CompletionPort {
  readonly submissions: CompletionRequest[] = [];
  readonly acceptedSubmissions: ResolvedSubmissionPayload[] = [];
  readonly reviewFilterAudits: ReviewFilterAudit[] = [];
  readonly rejections: RecordedRejection[] = [];
  readonly errors: RecordedError[] = [];

  constructor(private readonly prepared: PreparedCase) {}

  async submit(request: CompletionRequest): Promise<CompletionOutcome> {
    this.submissions.push(structuredClone(request));
    try {
      const result = this.validate(request.payload);
      if (!result.outcome.ok) this.rejections.push(structuredClone(result.outcome));
      else this.acceptedSubmissions.push(structuredClone(result.payload));
      return result.outcome;
    } catch (error) {
      const recorded = toError(error);
      this.errors.push(recorded);
      throw error;
    }
  }

  private validate(payload: ResolvedSubmissionPayload): {
    outcome: CompletionOutcome;
    payload: ResolvedSubmissionPayload;
  } {
    const input = this.prepared.replay.contextInput;
    if (payload.kind === 'structure') {
      const result = validateConcreteStructure(payload, input.snapshot.compiled);
      if (result.ok) return { outcome: { ok: true }, payload };
      return {
        outcome: {
          ok: false,
          code: 'STRUCTURE_INVALID',
          message: result.violations.map((violation) => violation.message).join('；'),
          violations: result.violations,
        },
        payload,
      };
    }

    if (payload.kind === 'slot_content') {
      if (input.operation !== 'fill_slot') {
        return { outcome: invalidSubmission('slot_content 与 fixture operation 不匹配'), payload };
      }
      const reasons = validateSlotContent(payload.content, input.slotType.validation, null);
      if (reasons.length === 0) return { outcome: { ok: true }, payload };
      return {
        outcome: {
          ok: false,
          code: 'SLOT_CONTENT_INVALID',
          message: reasons.join('；'),
          violations: [],
        },
        payload,
      };
    }

    if (input.operation !== 'review_slot') {
      return { outcome: invalidSubmission('review_result 与 fixture operation 不匹配'), payload };
    }
    const findingsForVerification = payload.verdict === 'revise' ? payload.findings : [];
    const verified = verifyFindings(input.contentUnderReview, findingsForVerification);
    const finalVerdict = payload.verdict === 'revise' && verified.kept.length === 0
      ? 'discarded'
      : payload.verdict;
    this.reviewFilterAudits.push({
      submittedVerdict: payload.verdict,
      finalVerdict,
      submittedFindings: payload.findings.length,
      keptFindings: verified.kept.length,
      discardedFindings: payload.findings.length - verified.kept.length,
    });
    const finalPayload: ResolvedSubmissionPayload = {
      ...payload,
      verdict: finalVerdict === 'discarded' ? 'no_finding' : finalVerdict,
      findings: [...verified.kept],
    };
    return { outcome: { ok: true }, payload: finalPayload };
  }
}

function invalidSubmission(message: string): CompletionOutcome {
  return { ok: false, code: 'ASSIGNMENT_OUTPUT_INVALID', message, violations: [] };
}

export async function runBenchmark(
  options: BenchmarkOptions,
  deps: BenchmarkDeps = {},
): Promise<BenchmarkReport> {
  validateOptions(options);
  const outPath = path.resolve(options.outPath);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const outHandle = await fs.open(outPath, 'wx');

  try {
  const fixtures = await loadFixtureCases(options.fixturesPath);
  for (const fixture of fixtures) {
    const replay = parseReplayInput(fixture.replayInputJson, fixture.replayInputHash);
    const replaySupported = SUPPORTED_BINDINGS.some(
      (binding) => binding.operation === replay.contextInput.operation && binding.skillId === replay.contextInput.skill.id,
    );
    if (replaySupported !== isSupportedCase(fixture)) {
      throw new Error(`case ${fixture.caseId}: execution metadata 与 ReplayInput 的 binding scope 不一致`);
    }
  }
  const selected = fixtures.filter(isSupportedCase);
  if (selected.length === 0) throw new Error('fixture 中没有当前生产五个 binding scope 内的 case');
  ensureUniqueCaseIds(selected);

  const diskSkills = await loadBaselineSkills(options.skillsDir);
  assertBaselineConditions(selected, diskSkills);

  const registry = new ProviderRegistry({
    config: options.providerConfig,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.adapterFactory === undefined ? {} : { adapterFactory: deps.adapterFactory }),
  });

  // Selection and every fail-closed invariant are fixed before the first Provider request.
  const prepared = selected.map((fixture) => prepareCase(fixture, diskSkills, registry, options.providerId));
  const groups = new Set(
    prepared.map((item) => JSON.stringify([item.resolved.providerId, item.resolved.model])),
  );
  if (groups.size !== 1) throw new Error(`选中的 case 解析成 ${groups.size} 个 provider/model 组，拒绝混组`);
  const first = prepared[0];
  if (first === undefined) throw new Error('没有可运行 case');

  const newId = deps.newId ?? randomUUID;
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
  const samples: BenchmarkSample[] = [];

  // Deliberately serial: one case/repeat owns one controller, token and execution id.
  for (const item of prepared) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      samples.push(await runOne(item, repeat, options, registry, newId, newToken));
    }
  }

  const report: BenchmarkReport = {
    run_id: 'r0',
    label: 'S2 当前生产 Skill 单槽位基线',
    created_at: (deps.now?.() ?? new Date()).toISOString(),
    provider: first.resolved.providerId,
    model: first.resolved.model,
    baseline_conditions: baselineConditions(),
    selection: {
      fixture_cases: prepared.length,
      repeats: options.repeats,
      samples: samples.length,
      case_ids: prepared.map((item) => item.fixture.caseId),
    },
    skills: REQUIRED_BASELINE_SKILLS.map((id) => ({
      id,
      name: id,
      baseline: { ref: 'r0', hash: diskSkills[id]!.contentHash, label: '当前生产 Skill' },
      variants: [],
    })),
    samples,
  };

  await outHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  await outHandle.close();
  return report;
  } catch (error) {
    await outHandle.close();
    await fs.rm(outPath, { force: true });
    throw error;
  }
}

async function runOne(
  item: PreparedCase,
  repeat: number,
  options: BenchmarkOptions,
  registry: ProviderRegistry,
  newId: () => string,
  newToken: () => string,
): Promise<BenchmarkSample> {
  const fixture = item.fixture;
  const executionId = newId();
  const token = newToken();
  const controller = new AbortController();
  const trace = new MemoryTracePort();
  const completion = new MemoryCompletionPort(item);
  const structure = new FixtureStructurePort(item.outline, item.contents);
  const runner = new AssignmentRunner({
    registry,
    trace,
    completion,
    structure,
    rateLimitBackoff: options.providerConfig.defaults.rateLimitBackoff,
  });
  const input = item.replay.contextInput;
  const revisionBase = input.operation === 'fill_slot' && input.revision !== null && input.targetSlot.contentText !== null
    ? {
        round: input.revision.round,
        content: input.targetSlot.contentText,
        degraded: input.revision.degraded,
      }
    : null;
  const started = performance.now();
  let outcome: AssignmentOutcome;
  try {
    outcome = await runner.run({
      taskId: fixture.execution.taskId,
      executionId,
      executionToken: token,
      operation: fixture.execution.operation,
      targetSlotId: fixture.execution.targetSlotId,
      modelAlias: fixture.execution.modelAlias,
      pinnedProviderId: options.providerId,
      systemText: item.context.systemText,
      userText: item.context.userText,
      maxToolCalls: input.snapshot.compiled.limits.maxToolCallsPerAssignment,
      maxTokens: deriveMaxTokens(input.operation === 'create_structure' ? null : input.slotType),
      timeoutMs: bindingFor(item).timeoutMs,
      allowedDependencySlotIds: input.operation === 'create_structure' ? [] : input.dependencies.map((dependency) => dependency.slotId),
      skill: item.skill,
      taskInput: input.snapshot.input,
      revisionBase,
      controller,
    });
  } catch (error) {
    const recorded = toError(error);
    completion.errors.push(recorded);
    outcome = {
      kind: 'failed',
      code: 'PROVIDER_ERROR',
      message: recorded.message,
      violations: [],
      noSubmission: false,
      consumesRetry: true,
      provider: item.resolved.providerId,
      model: item.resolved.model,
      usage: null,
      toolCalls: 0,
    };
  }
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  const rawSubmissions = completion.submissions.map((submission) => submission.payload);
  const acceptedSubmissions = completion.acceptedSubmissions;
  const rawSubmission = rawSubmissions.at(-1) ?? null;
  const acceptedSubmission = acceptedSubmissions.at(-1) ?? null;
  const outcomeError = outcome.kind === 'failed' ? { code: outcome.code, message: outcome.message } : null;
  const errors = [...completion.errors];
  if (
    outcomeError !== null &&
    !errors.some((entry) => entry.code === outcomeError.code && entry.message === outcomeError.message)
  ) {
    errors.push(outcomeError);
  }
  const rejections = [...completion.rejections];
  if (outcome.kind === 'failed' && !outcome.noSubmission && !rejections.some((entry) => entry.code === outcome.code && entry.message === outcome.message)) {
    rejections.push({ code: outcome.code, message: outcome.message, violations: outcome.violations });
  }

  return {
    id: `${fixture.caseId}-r${repeat}`,
    case_id: fixture.caseId,
    repeat,
    skill: fixture.execution.skillId,
    story: fixture.execution.taskId,
    variant: 'r0',
    operation: fixture.execution.operation,
    status: outcome.kind === 'succeeded' ? 'success' : 'failure',
    output: outputOf(acceptedSubmission, trace.output),
    usage: outcome.usage === null
      ? null
      : { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens },
    tool_calls: outcome.toolCalls,
    elapsed_ms: elapsedMs,
    provider: outcome.provider,
    model: outcome.model,
    execution_id: executionId,
    source_execution_id: fixture.execution.id,
    raw_submission: rawSubmission,
    submissions: rawSubmissions,
    accepted_submissions: acceptedSubmissions,
    review_filter_audit: completion.reviewFilterAudits.at(-1) ?? null,
    rejections,
    errors,
    trace: trace.records,
    error: outcomeError,
  };
}

function prepareCase(
  fixture: BenchFixtureCase,
  diskSkills: Readonly<Record<string, FrozenSkill>>,
  registry: ProviderRegistry,
  providerId: string,
): PreparedCase {
  const replay = parseReplayInput(fixture.replayInputJson, fixture.replayInputHash);
  const input = replay.contextInput;
  const execution = fixture.execution;
  const targetSlotId = input.operation === 'create_structure' ? null : input.targetSlot.slotId;
  if (execution.operation !== input.operation || execution.taskId !== input.snapshot.taskId || execution.targetSlotId !== targetSlotId) {
    throw new Error(`case ${fixture.caseId}: execution metadata 与 ReplayInput 的 operation/task/target 不一致`);
  }
  if (execution.agentId !== input.agent.id || execution.skillId !== input.skill.id || execution.skillVersion !== input.skill.version || execution.attemptNumber !== input.attemptNumber) {
    throw new Error(`case ${fixture.caseId}: execution metadata 与 ReplayInput 的 agent/skill/attempt 不一致`);
  }
  const binding = bindingForInput(input);
  if (
    execution.modelAlias !== binding.modelAlias ||
    execution.agentId !== binding.agentId ||
    execution.skillId !== binding.skillId ||
    execution.skillVersion !== binding.skillVersion
  ) {
    throw new Error(`case ${fixture.caseId}: execution 与冻结 binding 的 model/agent/skill/version 不一致`);
  }

  const frozenRef = input.snapshot.compiled.skills.find((skill) => skill.id === input.skill.id);
  if (frozenRef === undefined || frozenRef.version !== input.skill.version || frozenRef.contentHash !== input.skill.contentHash) {
    throw new Error(`case ${fixture.caseId}: 冻结 Skill content hash/version 与 snapshot 不一致`);
  }
  const frozenContext = buildContext(input as ContextBuilderInput);
  if (frozenContext.contextHash !== fixture.expected.contextHash || frozenContext.promptHash !== fixture.expected.promptHash) {
    throw new Error(`case ${fixture.caseId}: 冻结 Skill 重建未命中 expected context/prompt hash`);
  }

  const skill = diskSkills[execution.skillId];
  if (skill === undefined) throw new Error(`case ${fixture.caseId}: --skills-dir 缺少 ${execution.skillId}`);
  if (skill.id !== input.skill.id || skill.version !== input.skill.version || skill.contentHash !== input.skill.contentHash) {
    throw new Error(`case ${fixture.caseId}: 当前 r0 Skill content hash/version 与冻结 Skill 不一致`);
  }
  const currentContext = buildContext({ ...input, skill } as ContextBuilderInput);
  if (currentContext.contextHash !== fixture.expected.contextHash || currentContext.promptHash !== fixture.expected.promptHash) {
    throw new Error(`case ${fixture.caseId}: 当前 r0 Skill 未命中 expected context/prompt hash`);
  }

  const resolved = registry.resolve(execution.modelAlias, providerId);
  if (execution.provider !== resolved.providerId || execution.model !== resolved.model) {
    throw new Error(
      `case ${fixture.caseId}: provider/model 发生漂移；fixture=${execution.provider}/${execution.model}，` +
      `当前=${resolved.providerId}/${resolved.model}`,
    );
  }

  const replaySlots = input.operation === 'create_structure' ? [] : input.slots;
  const outline = replaySlots.map((slot): OutlineSlot => ({
    slotId: slot.slotId,
    type: slot.type,
    parentId: slot.parentId,
    sortOrder: slot.sortOrder,
    instruction: slot.instruction,
    dependsOn: slot.dependsOn,
    contentBearing: slot.contentBearing,
    status: slot.status,
  }));
  const contents = Object.fromEntries(replaySlots.map((slot) => [slot.slotId, {
    slotId: slot.slotId,
    type: slot.type,
    instruction: slot.instruction,
    status: slot.status,
    contentText: slot.contentText,
  }]));

  return {
    fixture,
    replay,
    skill,
    context: currentContext,
    outline,
    contents,
    resolved: { providerId: resolved.providerId, model: resolved.model },
  };
}

function bindingFor(item: PreparedCase) {
  return bindingForInput(item.replay.contextInput);
}

function bindingForInput(input: ReplayInput['contextInput']) {
  if (input.operation === 'create_structure') return input.snapshot.compiled.bindings.createStructure;
  if (input.operation === 'fill_slot') {
    const binding = input.snapshot.compiled.bindings.fillSlotByType[input.targetSlot.type];
    if (binding === undefined) throw new Error(`冻结模板没有 ${input.targetSlot.type} 的 fill binding`);
    return binding;
  }
  const slot = input.targetSlot as Parameters<typeof reviewBindingOf>[1];
  const binding = reviewBindingOf(input.snapshot.compiled, slot);
  if (binding === null) throw new Error(`冻结模板没有 ${input.targetSlot.type} 的 review binding`);
  return binding;
}

async function loadBaselineSkills(skillsDir: string): Promise<Record<string, FrozenSkill>> {
  const result: Record<string, FrozenSkill> = {};
  for (const skillId of REQUIRED_BASELINE_SKILLS) {
    const sourcePath = path.join(skillsDir, skillId, 'SKILL.md');
    const raw = await fs.readFile(sourcePath, 'utf8');
    const loaded = parseSkill(raw, sourcePath);
    result[skillId] = {
      id: loaded.id,
      version: loaded.version,
      contentMarkdown: loaded.raw,
      contentHash: loaded.contentHash,
      operation: loaded.operation,
      slotTypes: loaded.slotTypes,
      readsSlotTypes: loaded.readsSlotTypes,
      status: loaded.status,
      summary: loaded.summary,
      preamble: loaded.preamble,
      requiredSections: loaded.requiredSections,
      sections: loaded.sections,
      sectionIndex: loaded.sectionIndex,
    };
  }
  return result;
}

function assertBaselineConditions(
  fixtures: readonly BenchFixtureCase[],
  skills: Readonly<Record<string, FrozenSkill>>,
): void {
  for (const fixture of fixtures) {
    const replay = parseReplayInput(fixture.replayInputJson, fixture.replayInputHash);
    if (replay.contextInput.snapshot.compiled.slotTypes.some((slotType) => slotType.id === 'chapter_outline')) {
      throw new Error(`case ${fixture.caseId}: r0 baseline 已出现 chapter_outline，不能声明旧缺陷未修复`);
    }
    const scene = replay.contextInput.snapshot.compiled.slotTypes.find((slotType) => slotType.id === 'scene');
    if (scene?.validation.maxChars !== 8000) {
      throw new Error(`case ${fixture.caseId}: r0 scene maxChars 不是 8000`);
    }
  }
  for (const id of ['title-writing', 'scene-writing', 'scene-review']) {
    if (!skills[id]?.contentMarkdown.includes('骨架')) throw new Error(`r0 Skill ${id} 已不再读取骨架`);
  }
  const scene = skills['scene-writing']?.contentMarkdown ?? '';
  if (!scene.includes('不写「第一场」「场景二」') && !scene.includes('没有出现「第一场」「场景二」')) {
    throw new Error('r0 scene-writing 已不再禁止场景编号');
  }
}

function baselineConditions(): BenchmarkReport['baseline_conditions'] {
  return {
    template_has_chapter_outline: false,
    scene_max_chars: 8000,
    skills_still_read_skeleton: ['title-writing', 'scene-writing', 'scene-review'],
    scene_skill_forbids_numbering: true,
    known_defects_fixed: false,
    declaration: '以上模板/Skill 基线缺陷在 r0 中均未修复；本次只冻结现状。',
    binding_scope: SUPPORTED_BINDINGS.map((binding) => ({
      operation: binding.operation,
      skill_id: binding.skillId,
    })),
  };
}

function isSupportedCase(fixture: BenchFixtureCase): boolean {
  return SUPPORTED_BINDINGS.some(
    (binding) => binding.operation === fixture.execution.operation && binding.skillId === fixture.execution.skillId,
  );
}

function ensureUniqueCaseIds(fixtures: readonly BenchFixtureCase[]): void {
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.caseId)) throw new Error(`重复的 fixture caseId：${fixture.caseId}`);
    seen.add(fixture.caseId);
  }
}

async function loadFixtureCases(fixturesPath: string): Promise<BenchFixtureCase[]> {
  const absolute = path.resolve(fixturesPath);
  const stat = await fs.stat(absolute);
  const files = stat.isDirectory()
    ? (await fs.readdir(absolute))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(absolute, name))
    : [absolute];
  const cases: BenchFixtureCase[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(raw)) {
      cases.push(...z.array(FixtureCaseSchema).parse(raw));
      continue;
    }
    if (typeof raw === 'object' && raw !== null && 'cases' in raw) {
      cases.push(...FixtureFileSchema.parse(raw).cases);
      continue;
    }
    if (typeof raw === 'object' && raw !== null && 'execution' in raw && 'replayInputJson' in raw) {
      cases.push(FixtureCaseSchema.parse(raw));
    }
  }
  return cases;
}

function validateOptions(options: BenchmarkOptions): void {
  if (!Number.isInteger(options.repeats) || options.repeats < 3) {
    throw new Error('--repeats 必须是 >= 3 的整数');
  }
  if (options.providerId !== 'deepseek') throw new Error('--provider-id 当前只允许 deepseek');
  if (options.fixturesPath.trim() === '') throw new Error('--fixtures 不能为空');
  if (options.outPath.trim() === '') throw new Error('--out 不能为空');
  if (options.skillsDir.trim() === '') throw new Error('--skills-dir 不能为空');
}

function outputOf(submission: ResolvedSubmissionPayload | null, streamed: string): string {
  if (submission === null) return streamed;
  if (submission.kind === 'slot_content') return submission.content;
  return JSON.stringify(submission);
}

function toError(error: unknown): RecordedError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    return { code, message: error.message };
  }
  return { code: 'UNKNOWN', message: String(error) };
}
