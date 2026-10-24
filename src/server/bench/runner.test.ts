import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import {
  buildContext,
  serializeReplayInput,
  type ContextBuilderInput,
} from '@server/application/context-builder.ts';
import type { FrozenSkill, FrozenTaskSnapshot } from '@server/application/snapshot-service.ts';
import { loadTemplate, type LoadedTemplate } from '@server/application/template-loader.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import type { Slot } from '@server/domain/types.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';
import {
  runBenchmark,
  runComparisonBenchmark,
  type BenchFixtureCase,
  type BenchFixtureFile,
  type BenchmarkSample,
} from './runner.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CONFIG: ProviderConfig = {
  providers: [{
    id: 'deepseek',
    name: 'DeepSeek test',
    kind: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat'],
  }],
  aliases: {
    main: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    structure: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    configured: [{ provider: 'deepseek', model: 'deepseek-chat' }],
  },
  defaults: {
    timeoutMs: 10_000,
    maxRetries: 2,
    concurrentSlots: 1,
    rateLimitBackoff: { strategy: 'exponential', initialMs: 1, maxMs: 2, maxAttempts: 2 },
  },
};

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<{ dir: string; fixturePath: string; outPath: string; loaded: LoadedTemplate }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bench-runner-'));
  temporaries.push(dir);
  const fixturePath = path.join(dir, 'fixtures.json');
  const outPath = path.join(dir, 'run.json');
  const providers = await loadProviderConfig(path.join(ROOT, 'config/providers.yaml'));
  const loaded = await loadTemplate(path.join(ROOT, 'tests/fixtures/s2-r0/templates/zhihu-chapter'), {
    skillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
    defaults: CONFIG.defaults,
    knownAliases: new Set(Object.keys(providers.aliases)),
  });
  return { dir, fixturePath, outPath, loaded };
}

function freezeSkill(loaded: LoadedTemplate, skillId: string): FrozenSkill {
  const skill = loaded.skills[skillId];
  if (skill === undefined) throw new Error(`missing skill ${skillId}`);
  return {
    id: skill.id,
    version: skill.version,
    contentMarkdown: skill.raw,
    contentHash: skill.contentHash,
    operation: skill.operation,
    slotTypes: skill.slotTypes,
    readsSlotTypes: skill.readsSlotTypes,
    status: skill.status,
    summary: skill.summary,
    preamble: skill.preamble,
    requiredSections: skill.requiredSections,
    sections: skill.sections,
    sectionIndex: skill.sectionIndex,
  };
}

function slots(taskId: string): Slot[] {
  const at = '2026-09-01T00:00:00.000Z';
  const base = {
    taskId,
    revisionRound: 0,
    reviewExhausted: false,
    narrativeUnitId: null,
    producer: null,
    errorCode: null,
    errorMessage: null,
    createdAt: at,
    updatedAt: at,
  } as const;
  return [
    { ...base, slotId: 'chapter', type: 'chapter', parentId: null, sortOrder: 0, instruction: '整章容器', dependsOn: [], contentBearing: false, includeInArtifact: true, status: 'completed', contentText: null },
    { ...base, slotId: 'title', type: 'title', parentId: 'chapter', sortOrder: 0, instruction: '拟定标题', dependsOn: ['scene_01', 'scene_02'], contentBearing: true, includeInArtifact: true, status: 'completed', contentText: '雨夜来客' },
    { ...base, slotId: 'scene_01', type: 'scene', parentId: 'chapter', sortOrder: 1, instruction: '来客闯入诊室并亮出证据', dependsOn: [], contentBearing: true, includeInArtifact: true, status: 'completed', contentText: '雨水顺着来客的袖口滴到诊室地面。医生抬头时，他把那只旧药瓶放在桌上。' },
    { ...base, slotId: 'scene_02', type: 'scene', parentId: 'chapter', sortOrder: 2, instruction: '医生辨认证据并承认隐瞒', dependsOn: ['scene_01'], contentBearing: true, includeInArtifact: true, status: 'pending', contentText: null },
  ];
}

function fixtureCase(
  loaded: LoadedTemplate,
  operation: 'create_structure' | 'fill_slot' | 'review_slot',
): BenchFixtureCase {
  const taskId = `task-${operation}`;
  const allSkills = Object.fromEntries(Object.keys(loaded.skills).map((id) => [id, freezeSkill(loaded, id)]));
  const snapshot: FrozenTaskSnapshot = {
    taskId,
    snapshotId: `snapshot-${operation}`,
    templateId: loaded.compiled.id,
    templateVersion: loaded.compiled.version,
    compiled: loaded.compiled,
    snapshotHash: `snapshot-hash-${operation}`,
    skills: allSkills,
    input: { chapter_packet: '雨夜诊室里，来客拿出旧药瓶，逼医生承认二十年前隐瞒了手术真相。' },
  };
  const allSlots = slots(taskId);
  const binding = operation === 'create_structure'
    ? loaded.compiled.bindings.createStructure
    : operation === 'fill_slot'
      ? loaded.compiled.bindings.fillSlotByType.scene
      : loaded.compiled.bindings.reviewSlotByType.scene;
  if (binding === undefined) throw new Error(`missing binding ${operation}`);
  const agent = loaded.compiled.agents.find((candidate) => candidate.id === binding.agentId);
  if (agent === undefined) throw new Error(`missing agent ${binding.agentId}`);
  const skill = allSkills[binding.skillId];
  if (skill === undefined) throw new Error(`missing skill ${binding.skillId}`);
  const sceneType = loaded.compiled.slotTypes.find((type) => type.id === 'scene');
  if (sceneType === undefined) throw new Error('missing scene type');

  const common = { snapshot, agent, skill, attemptNumber: 1, maxAttempts: binding.maxRetries + 1 };
  let contextInput: ContextBuilderInput;
  if (operation === 'create_structure') {
    contextInput = { ...common, operation, retry: null, review: null };
  } else if (operation === 'fill_slot') {
    contextInput = {
      ...common,
      operation,
      slots: allSlots,
      targetSlot: allSlots[3]!,
      slotType: sceneType,
      dependencies: [{ slotId: 'scene_01', content: allSlots[2]!.contentText! }],
      retry: null,
      revision: null,
    };
  } else {
    contextInput = {
      ...common,
      operation,
      slots: allSlots,
      targetSlot: allSlots[2]!,
      slotType: sceneType,
      dependencies: [],
      criterionId: 'S2',
      contentUnderReview: allSlots[2]!.contentText!,
    };
  }
  const context = buildContext(contextInput);
  const replay = serializeReplayInput(contextInput);
  const targetSlotId = operation === 'create_structure' ? null : operation === 'fill_slot' ? 'scene_02' : 'scene_01';
  return {
    caseId: `case-${operation}`,
    execution: {
      id: `frozen-${operation}`,
      taskId,
      operation,
      targetSlotId,
      agentId: binding.agentId,
      skillId: binding.skillId,
      skillVersion: binding.skillVersion,
      modelAlias: binding.modelAlias,
      provider: 'deepseek',
      model: 'deepseek-chat',
      attemptNumber: 1,
    },
    replayInputJson: replay.replayInputJson,
    replayInputHash: replay.replayInputHash,
    expected: { contextHash: context.contextHash, promptHash: context.promptHash },
  };
}

async function writeFixture(file: string, cases: BenchFixtureCase[]): Promise<void> {
  const fixture: BenchFixtureFile = { version: 1, cases };
  await fs.writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
}

function options(fixturePath: string, outPath: string) {
  return {
    fixturesPath: fixturePath,
    outPath,
    repeats: 3,
    providerId: 'deepseek' as const,
    skillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
    providerConfig: CONFIG,
  };
}

describe('S2 单槽位 benchmark runner', () => {
  it('经真实 Runner 接受三种 operation 提交，串行跑满固定的三次重复并只写 run JSON', async () => {
    const ws = await workspace();
    const cases = [
      fixtureCase(ws.loaded, 'create_structure'),
      fixtureCase(ws.loaded, 'fill_slot'),
      fixtureCase(ws.loaded, 'review_slot'),
    ];
    await writeFixture(ws.fixturePath, cases);

    const longScene = '医生盯着药瓶看了很久，终于承认当年的手术记录被人替换。来客没有追问姓名，只把录音笔推到灯下。'.repeat(7);
    const turns: FakeProviderScript[] = [];
    for (let repeat = 0; repeat < 3; repeat += 1) turns.push({ submitStructure: { rootSlotId: 'chapter', slots: [
      { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '整章容器', dependsOn: [] },
      { id: 'scene_01', type: 'scene', parentId: 'chapter', order: 0, instruction: '来客出示药瓶，医生承认隐瞒', dependsOn: [] },
    ] } });
    for (let repeat = 0; repeat < 3; repeat += 1) turns.push({ submitContent: { slotId: 'scene_02', content: longScene } });
    for (let repeat = 0; repeat < 3; repeat += 1) turns.push({ submitReview: { slotId: 'scene_01', verdict: 'revise', findings: [{ criterionId: 'S2', quote: '旧药瓶放在桌上', problem: '证据出现后没有形成行动变化' }] } });
    const provider = new FakeProvider({ turns });
    let ids = 0;
    let tokens = 0;

    const report = await runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      newId: () => `bench-exec-${++ids}`,
      newToken: () => `bench-token-${++tokens}`,
    });

    expect(report.samples).toHaveLength(9);
    expect(report.samples.map((sample) => sample.status)).toEqual(Array(9).fill('success'));
    expect(new Set(report.samples.map((sample) => sample.execution_id)).size).toBe(9);
    expect(ids).toBe(9);
    expect(tokens).toBe(9);
    expect(report.samples.filter((sample) => sample.operation === 'create_structure').every((sample) => sample.raw_submission?.kind === 'structure')).toBe(true);
    expect(report.samples.filter((sample) => sample.operation === 'fill_slot').every((sample) => sample.raw_submission?.kind === 'slot_content')).toBe(true);
    expect(report.samples.filter((sample) => sample.operation === 'review_slot').every((sample) => sample.raw_submission?.kind === 'review_result')).toBe(true);
    const reviewSamples = report.samples.filter((sample) => sample.operation === 'review_slot');
    expect(reviewSamples.every((sample) => sample.review_filter_audit?.submittedVerdict === 'revise')).toBe(true);
    expect(reviewSamples.every((sample) => sample.review_filter_audit?.finalVerdict === 'revise')).toBe(true);
    expect(reviewSamples.every((sample) => sample.review_filter_audit?.keptFindings === 1)).toBe(true);
    expect(reviewSamples.every((sample) => sample.accepted_submissions[0]?.kind === 'review_result')).toBe(true);
    expect(reviewSamples.every((sample) => sample.rejections.length === 0)).toBe(true);
    expect(report.samples.every((sample) => sample.provider === 'deepseek' && sample.model === 'deepseek-chat')).toBe(true);
    expect(report.samples.every((sample) => sample.usage?.input_tokens === 100 && sample.usage.output_tokens === 50)).toBe(true);
    expect(report.samples.every((sample) => sample.tool_calls === 1)).toBe(true);
    expect(report.samples.every((sample) => sample.elapsed_ms >= 0)).toBe(true);
    expect(report.baseline_conditions).toMatchObject({
      template_has_chapter_outline: false,
      scene_max_chars: 8000,
      known_defects_fixed: false,
    });
    expect(JSON.parse(await fs.readFile(ws.outPath, 'utf8'))).toEqual(report);
    expect((await fs.readdir(ws.dir)).sort()).toEqual(['fixtures.json', 'run.json']);
  });

  it('system-private 工具输入缺失时在 Provider 调用前拒绝，注入后只经显式工具结果进入模型且不落 report', async () => {
    const ws = await workspace();
    const fixture = fixtureCase(ws.loaded, 'fill_slot');
    const replay = JSON.parse(fixture.replayInputJson) as { contextInput: ContextBuilderInput };
    replay.contextInput.snapshot.compiled = {
      ...replay.contextInput.snapshot.compiled,
      inputFields: [
        ...replay.contextInput.snapshot.compiled.inputFields,
        {
          id: 'source_text',
          label: '原文',
          type: 'textarea',
          required: true,
          visibility: 'system',
          toolReadable: true,
          hint: null,
        },
      ],
    };
    const { canonicalJson, sha256Hex } = await import('@server/domain/canonical.ts');
    fixture.replayInputJson = canonicalJson(replay);
    fixture.replayInputHash = sha256Hex(fixture.replayInputJson);
    const context = buildContext(replay.contextInput);
    fixture.expected = { contextHash: context.contextHash, promptHash: context.promptHash };
    await writeFixture(ws.fixturePath, [fixture]);

    const missingProvider = new FakeProvider();
    await expect(runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => missingProvider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/缺少.*必填私有输入 source_text/);
    expect(missingProvider.observations).toHaveLength(0);

    const emptyProvider = new FakeProvider();
    await expect(runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => emptyProvider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      readPrivateTaskInput: (caseId, fieldId) =>
        caseId === fixture.caseId && fieldId === 'source_text' ? ' \n\t ' : null,
    })).rejects.toThrow(/缺少.*必填私有输入 source_text/);
    expect(emptyProvider.observations).toHaveLength(0);

    const secret = 'PRIVATE-RUNTIME-ONLY-SOURCE';
    const content = '医生把药瓶推到灯下，终于承认当年的记录被人替换。'.repeat(14);
    const provider = new FakeProvider({
      turns: Array.from({ length: 3 }, () => [
        { callTools: [{ name: 'read_task_input', args: { field: 'source_text' } }] },
        { submitContent: { slotId: 'scene_02', content } },
      ]).flat(),
    });
    const report = await runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      readPrivateTaskInput: (caseId, fieldId) =>
        caseId === fixture.caseId && fieldId === 'source_text' ? secret : null,
    });

    expect(report.samples.every((sample) => sample.status === 'success')).toBe(true);
    expect(provider.observations[0]?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining(secret) })]),
    );
    expect(provider.observations.some((observation) => JSON.stringify(observation.messages).includes(secret))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await fs.readFile(ws.outPath, 'utf8')).not.toContain(secret);
    expect(fixture.replayInputJson).not.toContain(secret);
  });

  it('必填且非 toolReadable 的 system 输入缺失时也在 Provider 调用前拒绝', async () => {
    const ws = await workspace();
    const fixture = fixtureCase(ws.loaded, 'fill_slot');
    const replay = JSON.parse(fixture.replayInputJson) as { contextInput: ContextBuilderInput };
    replay.contextInput.snapshot.compiled = {
      ...replay.contextInput.snapshot.compiled,
      inputFields: [
        ...replay.contextInput.snapshot.compiled.inputFields,
        {
          id: 'internal_policy',
          label: '内部策略',
          type: 'textarea',
          required: true,
          visibility: 'system',
          toolReadable: false,
          hint: null,
        },
      ],
    };
    const { canonicalJson, sha256Hex } = await import('@server/domain/canonical.ts');
    fixture.replayInputJson = canonicalJson(replay);
    fixture.replayInputHash = sha256Hex(fixture.replayInputJson);
    const context = buildContext(replay.contextInput);
    fixture.expected = { contextHash: context.contextHash, promptHash: context.promptHash };
    await writeFixture(ws.fixturePath, [fixture]);
    const provider = new FakeProvider();

    await expect(runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/缺少.*必填私有输入 internal_policy/);
    expect(provider.observations).toHaveLength(0);
  });

  it('审核引文无效时按生产语义接受提交并降级，原始与归一化结果分开审计', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'review_slot')]);
    const provider = new FakeProvider({
      turns: Array.from({ length: 3 }, () => ({
        submitReview: {
          slotId: 'scene_01',
          verdict: 'revise' as const,
          findings: [{ criterionId: 'S2', quote: '正文中不存在的引文', problem: '虚构问题' }],
        },
      })),
    });

    const report = await runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    });

    expect(report.samples.every((sample) => sample.status === 'success')).toBe(true);
    expect(report.samples.every((sample) => sample.raw_submission?.kind === 'review_result')).toBe(true);
    expect(report.samples.every((sample) => sample.review_filter_audit?.finalVerdict === 'discarded')).toBe(true);
    expect(report.samples.every((sample) => sample.review_filter_audit?.discardedFindings === 1)).toBe(true);
    expect(report.samples.every((sample) => sample.accepted_submissions[0]?.kind === 'review_result')).toBe(true);
    expect(report.samples.every((sample) => sample.rejections.length === 0)).toBe(true);
  });

  it('拒绝提交到非冻结目标 slot，并保留为失败样本', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const content = '医生把药瓶推到灯下，来客要求他承认旧记录被替换。'.repeat(14);
    const provider = new FakeProvider({
      turns: Array.from({ length: 3 }, () => ({
        submitContent: { slotId: 'scene_01', content },
      })),
    });

    const report = await runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    });

    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((sample) => sample.status === 'failure')).toBe(true);
    expect(report.samples.every((sample) => sample.accepted_submissions.length === 0)).toBe(true);
  });

  it('保留 Provider 失败、错误和 trace，且失败样本仍按 repeats 输出', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const provider = new FakeProvider({ turns: Array.from({ length: 3 }, () => ({ throwError: 'PROVIDER_ERROR' as const })) });

    const report = await runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    });

    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((sample) => sample.status === 'failure')).toBe(true);
    expect(report.samples.every((sample) => sample.error?.code === 'PROVIDER_ERROR')).toBe(true);
    expect(report.samples.every((sample) => sample.errors.length === 1)).toBe(true);
    expect(report.samples.every((sample) => sample.trace.some((event) => event.kind === 'assignment_started'))).toBe(true);
  });

  it('在任何 Provider 调用前拒绝 fixture 的 provider/model 漂移', async () => {
    const ws = await workspace();
    const drifted = fixtureCase(ws.loaded, 'fill_slot');
    drifted.execution.model = 'deepseek-v4-pro';
    await writeFixture(ws.fixturePath, [drifted]);
    const provider = new FakeProvider();

    await expect(runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/provider\/model.*漂移/i);
    expect(provider.observations).toHaveLength(0);
    await expect(fs.stat(ws.outPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('A/B 输出文件已存在时在任何 Provider 调用前失败且保留原文件', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-existing-output');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    await fs.writeFile(ws.outPath, 'original\n');
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'existing-output',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(provider.observations).toHaveLength(0);
    expect(await fs.readFile(ws.outPath, 'utf8')).toBe('original\n');
  });

  it('A/B 在 Provider 调用前拒绝不存在的显式 case 选择', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-missing-case');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'missing-case',
      conditions: ['baseline'],
      caseIds: ['case-fill_slot', 'case-not-found'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/case-not-found.*不存在|不存在.*case-not-found/);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在 Provider 调用前拒绝重复 condition', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-duplicate-condition');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'duplicate-condition',
      conditions: ['baseline', 'baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/conditions.*重复|重复.*conditions/);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在 Provider 调用前拒绝 execution attempt 与 Replay 不一致', async () => {
    const ws = await workspace();
    const fixture = fixtureCase(ws.loaded, 'fill_slot');
    fixture.execution.attemptNumber = 2;
    await writeFixture(ws.fixturePath, [fixture]);
    const variantRoot = path.join(ws.dir, 'variant-attempt-drift');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'attempt-drift',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/attempt/);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在 Provider 调用前拒绝 baseline Skill 偏离 Replay 冻结生产版本', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const baselineRoot = path.join(ws.dir, 'drifted-baseline');
    const variantRoot = path.join(ws.dir, 'variant-for-drifted-baseline');
    await fs.mkdir(path.join(baselineRoot, 'scene-writing'), { recursive: true });
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const production = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(baselineRoot, 'scene-writing/SKILL.md'), production.replace('可见行动', '明确行动'));
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), production.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: baselineRoot,
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'baseline-drift',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/baseline.*冻结|冻结.*baseline/i);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在 Provider 调用前拒绝 variant Skill 的 id 或 operation 不匹配', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-wrong-metadata');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const production = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(
      path.join(variantRoot, 'scene-writing/SKILL.md'),
      production.replace('id: scene-writing', 'id: title-writing').replace('可见行动', '有主次的可见行动'),
    );
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'variant-metadata-drift',
      conditions: ['variant'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/variant Skill.*id|id.*variant Skill/i);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在 Provider 调用前拒绝 Replay Skill 与 snapshot 引用不一致', async () => {
    const ws = await workspace();
    const fixture = fixtureCase(ws.loaded, 'fill_slot');
    const replay = JSON.parse(fixture.replayInputJson) as { contextInput: ContextBuilderInput };
    replay.contextInput.snapshot.compiled = {
      ...replay.contextInput.snapshot.compiled,
      skills: replay.contextInput.snapshot.compiled.skills.map((skill) =>
        skill.id === replay.contextInput.skill.id ? { ...skill, contentHash: '0'.repeat(64) } : skill,
      ),
    };
    const { canonicalJson, sha256Hex } = await import('@server/domain/canonical.ts');
    fixture.replayInputJson = canonicalJson(replay);
    fixture.replayInputHash = sha256Hex(fixture.replayInputJson);
    const rebuilt = buildContext(replay.contextInput);
    fixture.expected = { contextHash: rebuilt.contextHash, promptHash: rebuilt.promptHash };
    await writeFixture(ws.fixturePath, [fixture]);
    const variantRoot = path.join(ws.dir, 'variant-snapshot-skill-drift');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'snapshot-skill-drift',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/snapshot.*Skill|Skill.*snapshot/i);
    expect(provider.observations).toHaveLength(0);
  });

  it('A/B 在首次 Provider 调用前拒绝多个 provider/model 组', async () => {
    const ws = await workspace();
    const first = fixtureCase(ws.loaded, 'fill_slot');
    first.caseId = 'case-model-a';
    const second = fixtureCase(ws.loaded, 'fill_slot');
    second.caseId = 'case-model-b';
    const replay = JSON.parse(second.replayInputJson) as ContextBuilderInput extends never
      ? never
      : { contextInput: ContextBuilderInput };
    if (replay.contextInput.operation !== 'fill_slot') throw new Error('expected fill_slot fixture');
    const bindings = replay.contextInput.snapshot.compiled.bindings.fillSlotByType as Record<
      string,
      NonNullable<(typeof replay.contextInput.snapshot.compiled.bindings.fillSlotByType)['scene']>
    >;
    bindings['scene'] = {
      ...bindings['scene']!,
      modelAlias: 'configured',
    };
    const { canonicalJson, sha256Hex } = await import('@server/domain/canonical.ts');
    second.replayInputJson = canonicalJson(replay);
    second.replayInputHash = sha256Hex(second.replayInputJson);
    const rebuilt = buildContext(replay.contextInput);
    second.expected = { contextHash: rebuilt.contextHash, promptHash: rebuilt.promptHash };
    second.execution.modelAlias = 'configured';
    second.execution.model = 'deepseek-v4-pro';
    await writeFixture(ws.fixturePath, [first, second]);
    const variantRoot = path.join(ws.dir, 'variant-mixed-models');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const provider = new FakeProvider();
    const mixedConfig: ProviderConfig = {
      ...CONFIG,
      providers: [{ ...CONFIG.providers[0]!, models: ['deepseek-chat', 'deepseek-v4-pro'] }],
      aliases: {
        ...CONFIG.aliases,
        configured: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
      },
    };

    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'mixed-models',
      conditions: ['baseline'],
      providerConfig: mixedConfig,
    }, { adapterFactory: () => provider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/provider\/model 组/);
    expect(provider.observations).toHaveLength(0);
  });

  it('输出文件已存在时在任何 Provider 调用前失败且保留原文件', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    await fs.writeFile(ws.outPath, 'original\n');
    const provider = new FakeProvider();

    await expect(runBenchmark(options(ws.fixturePath, ws.outPath), {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(provider.observations).toHaveLength(0);
    expect(await fs.readFile(ws.outPath, 'utf8')).toBe('original\n');
  });

  it('单槽位 A/B 在 Provider 调用前要求防抄原文，并以私有原文执行 sourceOverlap', async () => {
    const ws = await workspace();
    const fixture = fixtureCase(ws.loaded, 'fill_slot');
    const replay = JSON.parse(fixture.replayInputJson) as { contextInput: { slotType: { validation: Record<string, unknown> } } };
    replay.contextInput.slotType.validation['sourceOverlap'] = { privateInputField: 'source_text', maxContainment: 0.05 };
    const { canonicalJson, sha256Hex } = await import('@server/domain/canonical.ts');
    const replayInputJson = canonicalJson(replay);
    fixture.replayInputJson = replayInputJson;
    fixture.replayInputHash = sha256Hex(replayInputJson);
    const built = buildContext(replay.contextInput as unknown as ContextBuilderInput);
    fixture.expected = { contextHash: built.contextHash, promptHash: built.promptHash };
    await writeFixture(ws.fixturePath, [fixture]);
    const variantRoot = path.join(ws.dir, 'variant');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const copied = '我把药瓶放到灯下。'.repeat(35);
    const missingProvider = new FakeProvider();
    await expect(runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'private-source-overlap-missing',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, { adapterFactory: () => missingProvider, env: { DEEPSEEK_API_KEY: 'test-key' } }))
      .rejects.toThrow(/缺少.*私有输入 source_text/);
    expect(missingProvider.observations).toHaveLength(0);

    const provider = new FakeProvider({
      turns: Array.from({ length: 3 }, () => [
        { submitContent: { slotId: 'scene_02', content: copied } },
        { neverSubmit: true },
      ]).flat(),
    });
    const report = await runComparisonBenchmark({
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek',
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'private-source-overlap',
      conditions: ['baseline'],
      providerConfig: CONFIG,
    }, {
      adapterFactory: () => provider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      readPrivateTaskInput: (caseId, fieldId) =>
        caseId === fixture.caseId && fieldId === 'source_text' ? copied : null,
    });
    expect((report['samples'] as BenchmarkSample[]).every((sample) => sample.status === 'failure')).toBe(true);
    expect((report['samples'] as BenchmarkSample[]).every((sample) =>
      sample.rejections.some((rejection) => rejection.message.includes('重合度')),
    )).toBe(true);
    expect((report['baseline_conditions'] as Record<string, unknown>)['private_source_overlap']).toBe('evaluated_from_runtime_private_input');
    expect(report['experiment_identity']).toMatchObject({
      replayInputs: [{ caseId: fixture.caseId, replayInputHash: fixture.replayInputHash }],
      privateInputs: [{
        caseId: fixture.caseId,
        fieldId: 'source_text',
        sha256: sha256Hex(copied),
      }],
    });
    expect(JSON.stringify(report)).not.toContain(copied);
  });

  it('A/B 拒绝身份匹配但样本不在实验网格内的 checkpoint', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-off-grid-checkpoint');
    await fs.mkdir(path.join(variantRoot, 'scene-writing'), { recursive: true });
    const baseline = await fs.readFile(path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md'), 'utf8');
    await fs.writeFile(path.join(variantRoot, 'scene-writing/SKILL.md'), baseline.replace('可见行动', '有主次的可见行动'));
    const comparisonOptions = {
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek' as const,
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'off-grid-checkpoint',
      conditions: ['baseline'] as const,
      providerConfig: CONFIG,
    };
    const firstProvider = new FakeProvider({ turns: [{ neverSubmit: true }] });
    await expect(runComparisonBenchmark(comparisonOptions, {
      adapterFactory: () => firstProvider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      afterSample: () => { throw new Error('建立 checkpoint'); },
    })).rejects.toThrow('建立 checkpoint');
    const partialPath = `${ws.outPath}.partial.json`;
    const checkpoint = JSON.parse(await fs.readFile(partialPath, 'utf8')) as {
      samples: Array<{ id: string; repeat: number }>;
    };
    checkpoint.samples[0]!.id = 'case-fill_slot-baseline-r4';
    checkpoint.samples[0]!.repeat = 4;
    await fs.writeFile(partialPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const resumedProvider = new FakeProvider();

    await expect(runComparisonBenchmark(comparisonOptions, {
      adapterFactory: () => resumedProvider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/checkpoint.*网格|样本.*网格/);
    expect(resumedProvider.observations).toHaveLength(0);
  });

  it('A/B 每个样本原子 checkpoint；中断后只补缺失样本并删除 partial', async () => {
    const ws = await workspace();
    await writeFixture(ws.fixturePath, [fixtureCase(ws.loaded, 'fill_slot')]);
    const variantRoot = path.join(ws.dir, 'variant-skills');
    const variantDir = path.join(variantRoot, 'scene-writing');
    await fs.mkdir(variantDir, { recursive: true });
    const baselinePath = path.join(ROOT, 'tests/fixtures/s2-r0/skills/scene-writing/SKILL.md');
    const baselineRaw = await fs.readFile(baselinePath, 'utf8');
    await fs.writeFile(
      path.join(variantDir, 'SKILL.md'),
      baselineRaw.replace('通过可见行动与信息变化推进单个场景', '通过有主次的可见行动推进单个场景'),
    );
    const longScene = '医生把药瓶推到灯下，我看见瓶底刻着日期。老周没有解释，只让我三天后带真账回来。'.repeat(8);
    const comparisonOptions = {
      fixturesPath: ws.fixturePath,
      outPath: ws.outPath,
      repeats: 3,
      providerId: 'deepseek' as const,
      baselineSkillsDir: path.join(ROOT, 'tests/fixtures/s2-r0/skills'),
      variantSkillsDir: variantRoot,
      skillId: 'scene-writing',
      runId: 'resume-test',
      conditions: ['baseline'] as const,
      providerConfig: CONFIG,
    };
    const firstProvider = new FakeProvider({ turns: [{ submitContent: { slotId: 'scene_02', content: longScene } }] });
    await expect(
      runComparisonBenchmark(comparisonOptions, {
        adapterFactory: () => firstProvider,
        env: { DEEPSEEK_API_KEY: 'test-key' },
        afterSample: () => {
          throw new Error('模拟进程中断');
        },
      }),
    ).rejects.toThrow('模拟进程中断');
    expect(firstProvider.observations).toHaveLength(1);
    const partialPath = `${ws.outPath}.partial.json`;
    expect(JSON.parse(await fs.readFile(partialPath, 'utf8'))).toMatchObject({
      identity: {
        replayInputs: [{ caseId: 'case-fill_slot', replayInputHash: expect.any(String) }],
      },
      samples: [{ id: 'case-fill_slot-baseline-r1' }],
    });
    await expect(fs.stat(ws.outPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(ws.outPath, '');
    const secondProvider = new FakeProvider({
      turns: Array.from({ length: 2 }, () => ({ submitContent: { slotId: 'scene_02', content: longScene } })),
    });
    const resumed = await runComparisonBenchmark(comparisonOptions, {
      adapterFactory: () => secondProvider,
      env: { DEEPSEEK_API_KEY: 'test-key' },
    });
    expect(secondProvider.observations).toHaveLength(2);
    expect(resumed['samples']).toHaveLength(3);
    expect((resumed['baseline_conditions'] as Record<string, unknown>)['private_source_overlap'])
      .toBe('not_configured');
    await expect(fs.stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('拒绝小于三次的重复数', async () => {
    const ws = await workspace();
    await expect(runBenchmark({ ...options(ws.fixturePath, ws.outPath), repeats: 2 }, {
      adapterFactory: () => new FakeProvider(),
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/repeats.*3/);
  });
});
