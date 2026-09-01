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
import type { Slot } from '@server/domain/types.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';
import {
  runBenchmark,
  type BenchFixtureCase,
  type BenchFixtureFile,
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
  const loaded = await loadTemplate(path.join(ROOT, 'templates/zhihu-chapter'), {
    skillsDir: path.join(ROOT, 'skills'),
    defaults: CONFIG.defaults,
    knownAliases: new Set(Object.keys(CONFIG.aliases)),
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
    skillsDir: path.join(ROOT, 'skills'),
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

  it('拒绝小于三次的重复数', async () => {
    const ws = await workspace();
    await expect(runBenchmark({ ...options(ws.fixturePath, ws.outPath), repeats: 2 }, {
      adapterFactory: () => new FakeProvider(),
      env: { DEEPSEEK_API_KEY: 'test-key' },
    })).rejects.toThrow(/repeats.*3/);
  });
});
