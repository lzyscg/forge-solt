import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import type { PreparedNarrativeSubmission } from '@server/runtime/tools/context.ts';
import type { AssignmentOutcome, StreamDiagnostics } from '@server/runtime/assignment-runner.ts';
import type { ProviderAdapter } from '@server/runtime/provider/provider-adapter.ts';
import { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';
import type { ProviderEntry, ProviderConfig } from '@server/application/provider-config.ts';
import { validateSlotContent } from '@server/application/completion-service.ts';
import {
  buildContext,
  parseReplayInput,
  rebuildContextFromReplay,
  type ContextBuilderInput,
  type ReplayInput,
} from '@server/application/context-builder.ts';
import { canonicalHash } from '@server/domain/canonical.ts';
import { NarrativeAnswerSchema, NarrativeAnswerV3Schema, prepareNarrativeAnswerContract } from '@server/domain/narrative-answer.ts';
import { toJsonSchema } from '@shared/zod-json-schema.ts';
import { deriveMaxTokens } from '@server/application/narrative-production-policy.ts';
import { reviewBindingOf } from '@server/application/review-binding.ts';
import { parseSkill } from '@server/application/skill-loader.ts';
import type { FrozenSkill } from '@server/application/snapshot-service.ts';
import { splitTaskInput } from '@server/application/snapshot-service.ts';
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
  providerId: string;
  skillsDir: string;
  providerConfig: ProviderConfig;
}

export interface BenchmarkDeps {
  adapterFactory?: (entry: ProviderEntry) => ProviderAdapter | null;
  env?: NodeJS.ProcessEnv;
  newId?: () => string;
  newToken?: () => string;
  now?: () => Date;
  /** Runtime-only source for explicitly authorized system-private fields. Never serialized. */
  readPrivateTaskInput?: ((caseId: string, fieldId: string) => string | null) | undefined;
  /** 测试/外部编排钩子：checkpoint 落盘后调用，可用于模拟进程中断。 */
  afterSample?: (sample: BenchmarkSample) => void | Promise<void>;
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
  variant: 'r0' | 'baseline' | 'variant';
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
  stream_diagnostics: StreamDiagnostics | null;
  sample_unit: 'outline' | 'section' | 'story' | 'structured';
  fingerprint_comparable: boolean;
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

interface PreparedPrivateInputs {
  readonly read: (caseId: string, fieldId: string) => string | null;
  readonly identity: readonly {
    readonly caseId: string;
    readonly fieldId: string;
    readonly sha256: string;
  }[];
}

function preparePrivateInputs(
  fixtures: readonly BenchFixtureCase[],
  resolver: BenchmarkDeps['readPrivateTaskInput'],
): PreparedPrivateInputs {
  const values = new Map<string, string>();
  for (const fixture of fixtures) {
    const replay = parseReplayInput(fixture.replayInputJson, fixture.replayInputHash);
    const systemPrivate = replay.contextInput.snapshot.compiled.inputFields.filter(
      (field) => field.visibility === 'system',
    );
    const authorized = systemPrivate.filter((field) => field.toolReadable);
    const requiredPrivateFieldIds = new Set(
      systemPrivate.filter((field) => field.required).map((field) => field.id),
    );
    const overlap = replay.contextInput.operation === 'fill_slot'
      ? replay.contextInput.slotType.validation.sourceOverlap
      : null;
    if (overlap !== null) requiredPrivateFieldIds.add(overlap.privateInputField);
    const fieldIds = new Set([
      ...authorized.map((field) => field.id),
      ...requiredPrivateFieldIds,
    ]);
    for (const fieldId of fieldIds) {
      const value = resolver?.(fixture.caseId, fieldId) ?? null;
      if (value === null || (requiredPrivateFieldIds.has(fieldId) && value.trim() === '')) {
        if (requiredPrivateFieldIds.has(fieldId)) {
          throw new Error(`${fixture.caseId}: 缺少必填私有输入 ${fieldId}`);
        }
        continue;
      }
      values.set(`${fixture.caseId}\0${fieldId}`, value);
    }
  }
  return {
    read: (caseId, fieldId) => values.get(`${caseId}\0${fieldId}`) ?? null,
    identity: [...values.entries()].map(([key, value]) => {
      const [caseId = '', fieldId = ''] = key.split('\0');
      return {
        caseId,
        fieldId,
        sha256: createHash('sha256').update(value).digest('hex'),
      };
    }),
  };
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

  constructor(
    private readonly prepared: PreparedCase,
    private readonly readPrivateTaskInput: (fieldId: string) => string | null,
  ) {}

  async submit(request: CompletionRequest): Promise<CompletionOutcome> {
    const reportRequest = redactPrivateValidatedRawSubmission(request, this.prepared.replay);
    this.submissions.push(structuredClone(reportRequest));
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
      const overlap = input.slotType.validation.sourceOverlap;
      const privateSource = overlap === null
        ? null
        : this.readPrivateTaskInput(overlap.privateInputField);
      const reasons = validateSlotContent(
        payload.content,
        input.slotType.validation,
        privateSource,
        input.productionPolicy?.han ?? input.effectiveHanRange ?? null,
      );
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

function redactPrivateValidatedRawSubmission(
  request: CompletionRequest,
  replay: ReplayInput,
): CompletionRequest {
  if (
    request.payload.kind !== 'slot_content'
    || replay.contextInput.operation !== 'fill_slot'
    || replay.contextInput.slotType.validation.sourceOverlap === null
  ) {
    return request;
  }
  return {
    ...request,
    payload: {
      ...request.payload,
      content: '[REDACTED: private-source overlap validation enabled]',
    },
  };
}

function invalidSubmission(message: string): CompletionOutcome {
  return { ok: false, code: 'ASSIGNMENT_OUTPUT_INVALID', message, violations: [] };
}

export interface ComparisonBenchmarkOptions {
  fixturesPath: string;
  outPath: string;
  repeats: number;
  providerId: string;
  baselineSkillsDir: string;
  variantSkillsDir?: string | undefined;
  skillId: string;
  runId: string;
  modelServiceResolution?: string | undefined;
  runnerBundleHash?: string | undefined;
  conditions?: readonly ('baseline' | 'variant')[];
  caseIds?: readonly string[];
  providerConfig: ProviderConfig;
}

interface ComparisonPreparedCase extends Omit<PreparedCase, 'skill' | 'context'> {
  baselineSkill: FrozenSkill;
  variantSkill: FrozenSkill | null;
  baselineContext: ReturnType<typeof buildContext>;
  variantContext: ReturnType<typeof buildContext>;
}

export async function runComparisonBenchmark(
  options: ComparisonBenchmarkOptions,
  deps: BenchmarkDeps = {},
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(options.repeats) || options.repeats < 3) throw new Error('--repeats 必须是 >= 3 的整数');
  const outPath = path.resolve(options.outPath);
  const partialPath = `${outPath}.partial.json`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  try {
    const [outputStat, partialStat] = await Promise.all([
      fs.stat(outPath).catch(() => null),
      fs.stat(partialPath).catch(() => null),
    ]);
    if (outputStat !== null && outputStat.size === 0 && partialStat?.isFile() === true) {
      await fs.rm(outPath);
    }
  } catch {
    // The exclusive open below remains the authority for all non-resume cases.
  }
  const outHandle = await fs.open(outPath, 'wx');
  try {
    const fixtures = await loadFixtureCases(options.fixturesPath);
  if (options.caseIds !== undefined) {
    const availableCaseIds = new Set(fixtures.map((fixture) => fixture.caseId));
    const missingCaseIds = [...new Set(options.caseIds)].filter((caseId) => !availableCaseIds.has(caseId));
    if (missingCaseIds.length > 0) {
      throw new Error(`显式请求的 fixture case 不存在：${missingCaseIds.join(', ')}`);
    }
  }
  const selected = fixtures.filter(
    (fixture) =>
      fixture.execution.skillId === options.skillId &&
      (options.caseIds === undefined || options.caseIds.includes(fixture.caseId)),
  );
    if (selected.length === 0) throw new Error(`fixture 中没有 skill ${options.skillId}`);
    ensureUniqueCaseIds(selected);
    const privateInputs = preparePrivateInputs(selected, deps.readPrivateTaskInput);
    const conditions = options.conditions ?? ['baseline', 'variant'];
    if (conditions.length === 0 || conditions.some((condition) => condition !== 'baseline' && condition !== 'variant')) {
      throw new Error('conditions 必须是 baseline/variant 的非空子集');
    }
    if (new Set(conditions).size !== conditions.length) {
      throw new Error('conditions 不得重复');
    }
    const baselineSkill = await loadOneSkill(options.baselineSkillsDir, options.skillId);
    const needsVariant = conditions.includes('variant');
    if (needsVariant && options.variantSkillsDir === undefined) {
      throw new Error('包含 variant 条件时必须提供 variantSkillsDir');
    }
    const variantSkill = needsVariant
      ? await loadOneSkill(options.variantSkillsDir!, options.skillId)
      : null;
    assertComparisonSkill('baseline', baselineSkill, options.skillId);
    if (variantSkill !== null) {
      assertComparisonSkill('variant', variantSkill, options.skillId);
      if (baselineSkill.version !== variantSkill.version) throw new Error('A/B 变体必须保持同 version');
      if (baselineSkill.contentHash === variantSkill.contentHash) throw new Error('A/B Skill 正文相同，不构成实验');
    }

    const registry = new ProviderRegistry({
      config: options.providerConfig,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.adapterFactory === undefined ? {} : { adapterFactory: deps.adapterFactory }),
    });
    const prepared = selected.map((fixture): ComparisonPreparedCase => {
      const replay = parseReplayInput(fixture.replayInputJson, fixture.replayInputHash);
      const input = replay.contextInput;
      if (input.skill.id !== options.skillId) throw new Error(`${fixture.caseId}: ReplayInput skill 不一致`);
      if (
        baselineSkill.id !== input.skill.id
        || baselineSkill.version !== input.skill.version
        || baselineSkill.contentHash !== input.skill.contentHash
      ) {
        throw new Error(`${fixture.caseId}: baseline Skill 与 ReplayInput 冻结生产 Skill 不一致`);
      }
      const frozenSkillRef = input.snapshot.compiled.skills.find((skill) => skill.id === input.skill.id);
      if (
        frozenSkillRef === undefined
        || frozenSkillRef.version !== input.skill.version
        || frozenSkillRef.contentHash !== input.skill.contentHash
      ) {
        throw new Error(`${fixture.caseId}: ReplayInput Skill 与 snapshot Skill 引用不一致`);
      }
      const binding = bindingForInput(input);
      const targetSlotId = input.operation === 'create_structure' ? null : input.targetSlot.slotId;
      if (
        fixture.execution.operation !== input.operation
        || fixture.execution.taskId !== input.snapshot.taskId
        || fixture.execution.targetSlotId !== targetSlotId
        || fixture.execution.agentId !== binding.agentId
        || fixture.execution.skillId !== binding.skillId
        || fixture.execution.skillVersion !== binding.skillVersion
        || fixture.execution.modelAlias !== binding.modelAlias
        || fixture.execution.attemptNumber !== input.attemptNumber
      ) {
        throw new Error(`${fixture.caseId}: execution metadata 与冻结 ReplayInput binding/attempt 不一致`);
      }
      const privateAccess = {
        readPrivateInput: (fieldId: string) => privateInputs.read(fixture.caseId, fieldId),
      };
      const frozenContext = replay.version === 2
        ? rebuildContextFromReplay(
            fixture.replayInputJson,
            fixture.replayInputHash,
            input.skill,
            privateAccess,
          )
        : buildContext(input);
      if (frozenContext.contextHash !== fixture.expected.contextHash || frozenContext.promptHash !== fixture.expected.promptHash) {
        throw new Error(`${fixture.caseId}: 冻结 ReplayInput 未命中 expected hash`);
      }
      const baselineContext = replay.version === 2
        ? rebuildContextFromReplay(
            fixture.replayInputJson,
            fixture.replayInputHash,
            baselineSkill,
            privateAccess,
          )
        : buildContext({ ...input, skill: baselineSkill } as ContextBuilderInput);
      const variantContext = variantSkill === null
        ? baselineContext
        : replay.version === 2
          ? rebuildContextFromReplay(
              fixture.replayInputJson,
              fixture.replayInputHash,
              variantSkill,
              privateAccess,
            )
          : buildContext({ ...input, skill: variantSkill } as ContextBuilderInput);
      if (variantSkill !== null && baselineContext.contextHash !== variantContext.contextHash) throw new Error(`${fixture.caseId}: A/B contextHash 不同`);
      if (variantSkill !== null && baselineContext.promptHash === variantContext.promptHash) throw new Error(`${fixture.caseId}: A/B promptHash 相同`);
      const resolved = registry.resolve(fixture.execution.modelAlias, options.providerId);
      if (fixture.execution.provider !== resolved.providerId || fixture.execution.model !== resolved.model) {
        throw new Error(`${fixture.caseId}: provider/model 漂移`);
      }
      const replaySlots = input.operation === 'create_structure' ? [] : input.slots;
      return {
        fixture,
        replay,
        baselineSkill,
        variantSkill,
        baselineContext,
        variantContext,
        outline: replaySlots.map((slot) => ({
          slotId: slot.slotId,
          type: slot.type,
          parentId: slot.parentId,
          sortOrder: slot.sortOrder,
          instruction: slot.instruction,
          dependsOn: slot.dependsOn,
          contentBearing: slot.contentBearing,
          status: slot.status,
        })),
        contents: Object.fromEntries(replaySlots.map((slot) => [slot.slotId, {
          slotId: slot.slotId,
          type: slot.type,
          instruction: slot.instruction,
          status: slot.status,
          contentText: slot.contentText,
        }])),
        resolved: { providerId: resolved.providerId, model: resolved.model },
      };
    });
    const groups = new Set(
      prepared.map((item) => JSON.stringify([item.resolved.providerId, item.resolved.model])),
    );
    if (groups.size !== 1) {
      throw new Error(`选中的 A/B case 解析成 ${groups.size} 个 provider/model 组，拒绝混组`);
    }

    const newId = deps.newId ?? randomUUID;
    const newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
    const contractIdentities = prepared.map((item) => {
      const input = item.replay.contextInput;
      const declaration = input.operation === 'fill_slot' ? input.slotType.answerContract : undefined;
      return {
        caseId: item.fixture.caseId,
        templateId: input.snapshot.templateId,
        templateVersion: input.snapshot.templateVersion,
        templateHash: input.snapshot.compiled.templateHash,
        snapshotHash: input.snapshot.snapshotHash,
        contractHash: declaration == null ? null : canonicalHash(declaration),
        answerSchemaHash: declaration == null
          ? null
          : canonicalHash(toJsonSchema(
              declaration.version === 2 ? NarrativeAnswerSchema : NarrativeAnswerV3Schema,
            )),
        sourceSegmentation: declaration?.sourceSegmentation ?? null,
        expansionPolicy: declaration?.expansionPolicy ?? null,
        storyBudget: declaration?.storyBudget ?? null,
      };
    });
    const checkpointIdentity = {
      runId: options.runId,
      skillId: options.skillId,
      repeats: options.repeats,
      conditions: [...conditions],
      caseIds: prepared.map((item) => item.fixture.caseId),
      replayInputs: prepared.map((item) => ({
        caseId: item.fixture.caseId,
        replayInputHash: item.fixture.replayInputHash,
      })),
      privateInputs: privateInputs.identity,
      baselineHash: baselineSkill.contentHash,
      variantHash: variantSkill?.contentHash ?? null,
      provider: prepared[0]?.resolved.providerId ?? '',
      model: prepared[0]?.resolved.model ?? '',
      modelServiceResolution: options.modelServiceResolution ?? 'unspecified-test-resolution',
      providerConfigHash: canonicalHash(options.providerConfig),
      runnerBundleHash: options.runnerBundleHash ?? 'unspecified-test-runner',
      timeoutPolicy: {
        id: 'stream-idle-v1',
        idleTimeouts: contractIdentities.map((identity, index) => ({
          caseId: identity.caseId,
          idleTimeoutMs: bindingForInput(prepared[index]!.replay.contextInput).timeoutMs,
          totalDeadlineMs: bindingForInput(prepared[index]!.replay.contextInput).timeoutMs * 10,
          toolExecutionTimeoutMs: Math.min(bindingForInput(prepared[index]!.replay.contextInput).timeoutMs, 30_000),
        })),
      },
      contracts: contractIdentities,
    };
    const samples = await loadComparisonCheckpoint(partialPath, checkpointIdentity);
    validateCheckpointSamples(samples, checkpointIdentity);
    const completedIds = new Set(samples.map((sample) => sample.id));
    for (const item of prepared) {
      for (const variant of conditions) {
        const skill = variant === 'baseline' ? item.baselineSkill : item.variantSkill!;
        const context = variant === 'baseline' ? item.baselineContext : item.variantContext;
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          const sampleId = `${item.fixture.caseId}-${variant}-r${repeat}`;
          if (completedIds.has(sampleId)) continue;
          const sample = await runOne(
            { ...item, skill, context },
            repeat,
            {
              fixturesPath: options.fixturesPath,
              outPath: options.outPath,
              repeats: options.repeats,
              providerId: options.providerId,
              skillsDir: variant === 'baseline' ? options.baselineSkillsDir : options.variantSkillsDir!,
              providerConfig: options.providerConfig,
            },
            registry,
            newId,
            newToken,
            privateInputs.read,
          );
          samples.push({ ...sample, id: sampleId, variant });
          completedIds.add(sampleId);
          await writeComparisonCheckpoint(partialPath, checkpointIdentity, samples);
          await deps.afterSample?.(samples.at(-1)!);
        }
      }
    }
    const first = prepared[0];
    const overlapConfigured = prepared.some((item) =>
      item.replay.contextInput.operation === 'fill_slot'
      && item.replay.contextInput.slotType.validation.sourceOverlap !== null,
    );
    const report = {
      run_id: options.runId,
      label: variantSkill === null
        ? `${options.skillId} 单槽位 v2-r0 基线`
        : `${options.skillId} 单槽位 A/B`,
      created_at: (deps.now?.() ?? new Date()).toISOString(),
      provider: first?.resolved.providerId ?? '',
      model: first?.resolved.model ?? '',
      baseline_conditions: {
        comparison: variantSkill !== null,
        skill_id: options.skillId,
        context_hash_same: variantSkill === null ? 'not_applicable' : true,
        prompt_hash_different: variantSkill === null ? 'not_applicable' : true,
        no_best_of: true,
        private_source_overlap: overlapConfigured
          ? 'evaluated_from_runtime_private_input'
          : 'not_configured',
      },
      experiment_identity: checkpointIdentity,
      selection: {
        fixture_cases: prepared.length,
        repeats: options.repeats,
        samples: samples.length,
        case_ids: prepared.map((item) => item.fixture.caseId),
      },
      skills: [{
        id: options.skillId,
        name: options.skillId,
        baseline: { ref: 'baseline', hash: baselineSkill.contentHash, label: variantSkill === null ? 'v2-r0 基线' : '生产基线' },
        variants: variantSkill === null
          ? []
          : [{ id: 'variant', hash: variantSkill.contentHash, label: options.runId }],
      }],
      samples,
    };
    await outHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await outHandle.close();
    await fs.rm(partialPath, { force: true });
    return report;
  } catch (error) {
    await outHandle.close();
    await fs.rm(outPath, { force: true });
    throw error;
  }
}

interface ComparisonCheckpointIdentity {
  runId: string;
  skillId: string;
  repeats: number;
  conditions: readonly ('baseline' | 'variant')[];
  caseIds: readonly string[];
  replayInputs: readonly {
    readonly caseId: string;
    readonly replayInputHash: string;
  }[];
  privateInputs: readonly {
    readonly caseId: string;
    readonly fieldId: string;
    readonly sha256: string;
  }[];
  baselineHash: string;
  variantHash: string | null;
  provider: string;
  model: string;
  modelServiceResolution: string;
  providerConfigHash: string;
  runnerBundleHash: string;
  timeoutPolicy: {
    id: string;
    idleTimeouts: readonly {
      caseId: string;
      idleTimeoutMs: number;
      totalDeadlineMs: number;
      toolExecutionTimeoutMs: number;
    }[];
  };
  contracts: readonly {
    caseId: string;
    templateId: string;
    templateVersion: string;
    templateHash: string;
    snapshotHash: string;
    contractHash: string | null;
    answerSchemaHash: string | null;
    sourceSegmentation: string | null;
    expansionPolicy: string | null;
    storyBudget: { minHan: number; targetHan: number; maxHan: number } | null;
  }[];
}

interface ComparisonCheckpoint {
  version: 1;
  identity: ComparisonCheckpointIdentity;
  samples: BenchmarkSample[];
}

async function loadComparisonCheckpoint(
  partialPath: string,
  identity: ComparisonCheckpointIdentity,
): Promise<BenchmarkSample[]> {
  try {
    const raw = JSON.parse(await fs.readFile(partialPath, 'utf8')) as ComparisonCheckpoint;
    if (raw.version !== 1 || JSON.stringify(raw.identity) !== JSON.stringify(identity) || !Array.isArray(raw.samples)) {
      throw new Error(`A/B checkpoint 与本次实验身份不一致：${partialPath}`);
    }
    return raw.samples;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function validateCheckpointSamples(
  samples: readonly BenchmarkSample[],
  identity: ComparisonCheckpointIdentity,
): void {
  const expected = new Set<string>();
  for (const caseId of identity.caseIds) {
    for (const condition of identity.conditions) {
      for (let repeat = 1; repeat <= identity.repeats; repeat += 1) {
        expected.add(`${caseId}-${condition}-r${repeat}`);
      }
    }
  }
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!expected.has(sample.id)) {
      throw new Error(`A/B checkpoint 样本不在本次实验网格：${sample.id}`);
    }
    if (seen.has(sample.id)) {
      throw new Error(`A/B checkpoint 样本重复：${sample.id}`);
    }
    seen.add(sample.id);
    const suffix = `-${sample.variant}-r${sample.repeat}`;
    if (
      !identity.caseIds.includes(sample.case_id)
      || !identity.conditions.includes(sample.variant as 'baseline' | 'variant')
      || sample.repeat < 1
      || sample.repeat > identity.repeats
      || sample.id !== `${sample.case_id}${suffix}`
    ) {
      throw new Error(`A/B checkpoint 样本字段与实验网格不一致：${sample.id}`);
    }
  }
}

async function writeComparisonCheckpoint(
  partialPath: string,
  identity: ComparisonCheckpointIdentity,
  samples: readonly BenchmarkSample[],
): Promise<void> {
  const tempPath = `${partialPath}.tmp`;
  const checkpoint: ComparisonCheckpoint = { version: 1, identity, samples: [...samples] };
  await fs.writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await fs.rename(tempPath, partialPath);
}

function assertComparisonSkill(
  condition: 'baseline' | 'variant',
  skill: FrozenSkill,
  expectedId: string,
): void {
  if (skill.id !== expectedId) {
    throw new Error(`${condition} Skill id 与请求不一致：${skill.id}`);
  }
  if (skill.operation !== 'fill_slot') {
    throw new Error(`${condition} Skill operation 必须是 fill_slot`);
  }
  if (skill.status !== 'active') {
    throw new Error(`${condition} Skill status 必须是 active`);
  }
  if (
    !skill.slotTypes.includes('story_outline')
    && !skill.slotTypes.includes('scene')
    && !skill.slotTypes.includes('section')
  ) {
    throw new Error(`${condition} Skill slotTypes 与单槽位 A/B 不匹配`);
  }
}

async function loadOneSkill(skillsDir: string, skillId: string): Promise<FrozenSkill> {
  const sourcePath = path.join(skillsDir, skillId, 'SKILL.md');
  const raw = await fs.readFile(sourcePath, 'utf8');
  const loaded = parseSkill(raw, sourcePath);
  return {
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
  const privateInputs = preparePrivateInputs(selected, deps.readPrivateTaskInput);

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
      samples.push(await runOne(item, repeat, options, registry, newId, newToken, privateInputs.read));
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
  readPrivateTaskInput: BenchmarkDeps['readPrivateTaskInput'],
): Promise<BenchmarkSample> {
  const fixture = item.fixture;
  const executionId = newId();
  const token = newToken();
  const controller = new AbortController();
  const trace = new MemoryTracePort();
  const completion = new MemoryCompletionPort(
    item,
    (fieldId) => readPrivateTaskInput?.(fixture.caseId, fieldId) ?? null,
  );
  const structure = new FixtureStructurePort(item.outline, item.contents);
  const runner = new AssignmentRunner({
    registry,
    trace,
    completion,
    structure,
    rateLimitBackoff: options.providerConfig.defaults.rateLimitBackoff,
  });
  const input = item.replay.contextInput;
  let preparedSubmission: PreparedNarrativeSubmission | undefined;
  if (item.replay.version === 2 && input.operation === 'fill_slot' && input.slotType.answerContract != null) {
    const declaration = input.slotType.answerContract;
    const source = readPrivateTaskInput?.(fixture.caseId, declaration.sourceField) ?? null;
    if (source === null || source.trim() === '') {
      throw new Error(`${fixture.caseId}: ReplayInput v2 缺少私有输入 ${declaration.sourceField}`);
    }
    const prepared = prepareNarrativeAnswerContract(source);
    if (!prepared.ok) throw new Error(`${fixture.caseId}: ReplayInput v2 私有输入无法准备 narrative-plan/v2`);
    preparedSubmission = {
      kind: declaration.kind,
      version: declaration.version,
      contract: prepared.contract,
      storyBudget: declaration.storyBudget,
    };
  }
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
      maxTokens:
        input.operation === 'fill_slot' && input.productionPolicy !== undefined
          ? input.productionPolicy?.runtimeMaxTokens ?? deriveMaxTokens(input.slotType)
          : deriveMaxTokens(input.operation === 'create_structure' ? null : input.slotType),
      timeoutMs: bindingFor(item).timeoutMs,
      allowedDependencySlotIds: input.operation === 'create_structure' ? [] : input.dependencies.map((dependency) => dependency.slotId),
      skill: item.skill,
      taskInput: splitTaskInput(
        input.snapshot.compiled.inputFields,
        input.snapshot.input,
      ).agent,
      toolReadablePrivateInputIds: input.snapshot.compiled.inputFields
        .filter((field) => field.visibility === 'system' && field.toolReadable)
        .map((field) => field.id),
      readPrivateTaskInput: (fieldId) =>
        input.snapshot.compiled.inputFields.some(
          (field) => field.id === fieldId && field.visibility === 'system' && field.toolReadable,
        )
          ? readPrivateTaskInput?.(fixture.caseId, fieldId) ?? null
          : null,
      revisionBase,
      ...(preparedSubmission === undefined ? {} : { preparedSubmission }),
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
    stream_diagnostics: outcome.streamDiagnostics ?? null,
    sample_unit:
      fixture.execution.skillId === 'outline-writing'
        ? 'outline'
        : fixture.execution.skillId === 'scene-writing'
          ? 'section'
          : 'structured',
    fingerprint_comparable: fixture.execution.skillId === 'scene-writing',
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
  const binding = reviewBindingOf(input.snapshot.compiled, input.targetSlot);
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
  if (options.providerId.trim() === '') throw new Error('--provider-id 不能为空');
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
