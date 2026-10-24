import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReplayInput } from '@server/application/context-builder.ts';
import { canonicalJson } from '@server/domain/canonical.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_TEMPLATES = path.join(REPO_ROOT, 'templates-variants', 'i1-answer-contract-v3');
const SOURCE_SKILLS = path.join(REPO_ROOT, 'skills-variants', 'i1-answer-contract-v3');
const PRIVATE_SOURCE_MARKER = 'SYNTHETIC-CANDIDATE-SOURCE-ONLY';

let harness: ApiHarness | null = null;
let workspaceRoot: string | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (workspaceRoot !== null) await rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = null;
});

async function createCandidateWorkspace(): Promise<{ templatesDir: string; skillsDir: string }> {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'forge-answer-candidate-'));
  const templatesDir = path.join(workspaceRoot, 'templates-variants', 'i1-answer-contract-v3');
  const skillsDir = path.join(workspaceRoot, 'skills-variants', 'i1-answer-contract-v3');
  await cp(SOURCE_TEMPLATES, templatesDir, { recursive: true });
  await cp(SOURCE_SKILLS, skillsDir, { recursive: true });

  const templatePath = path.join(templatesDir, 'zhihu-outline-v3-candidate', 'template.yaml');
  const template = await readFile(templatePath, 'utf8');
  expect(template).toContain('status: draft');
  await writeFile(templatePath, template.replace('status: draft', 'status: published'), 'utf8');
  return { templatesDir, skillsDir };
}

function syntheticSource(): string {
  const events = [
    '记录员收到一封没有署名的测试信件。',
    '同伴指出信封日期与登记簿不一致。',
    '两人查到寄信窗口当天临时关闭。',
    '管理员否认接触信件但拿错了钥匙。',
    '记录员据此重新检查封存柜的开启记录。',
    '开启记录显示同伴曾在夜间进入档案室。',
    '同伴承认取走旧表格是为纠正自己的登记错误。',
    '记录员补齐记录并将更正经过一并归档。',
  ];
  return events.map((event, index) => [
    `${String(index + 1).padStart(2, '0')}、合成测试第${index + 1}节`,
    `${PRIVATE_SOURCE_MARKER}-${index + 1}。${event.repeat(index + 1)}`,
  ].join('\n')).join('\n');
}

function semanticAnswer() {
  const priorities = ['P1', 'bridge', 'P0', 'P1', 'P0', 'P0', 'P1', 'P0'] as const;
  return {
    initialState: '尚未开始核查任何记录',
    units: priorities.map((priority, index) => ({
      sourceSectionRef: `source-section-${String(index + 1).padStart(2, '0')}`,
      title: `合成记录变化${index + 1}`,
      intent: `核实第${index + 1}项合成记录`,
      resistance: `现有登记与第${index + 1}项新发现不一致`,
      outcome: `第${index + 1}项事实已经成立`,
      priority,
      mode: index === 1 ? 'fast-summary' as const : index === 2 || index === 5
        ? 'suspense-discovery' as const
        : 'conflict-scene' as const,
      capacity: {
        dialogueTurns: index === 1 ? 0 : 2,
        actionFeedbackLoops: 1,
        cognitionTurns: index === 2 || index === 5 ? 1 : 0,
        aftermathBeats: index === 7 ? 1 : 0,
      },
      cast: index === 1 ? ['记录员'] : ['记录员', '同伴'],
      informationControl: index === 2 ? '暂不解释管理员拿错钥匙的原因' : null,
    })),
  };
}

const STRUCTURE = {
  rootSlotId: 'outline_document',
  slots: [
    { id: 'outline_document', type: 'outline_document', parentId: null, order: 0, instruction: '合成大纲容器', dependsOn: [] },
    { id: 'story_outline', type: 'story_outline', parentId: 'outline_document', order: 0, instruction: '逐节分析合成故事', dependsOn: [] },
  ],
};

describe('NarrativePlan v3 候选离线纵向验收', () => {
  it('经真实 snapshot/runtime 使用 submit_answer，并且私有 source 不进入持久化与 API', async () => {
    const dirs = await createCandidateWorkspace();
    const privateSource = syntheticSource();
    const provider = new FakeProvider({
      turns: [
        { submitStructure: STRUCTURE },
        { callTools: [{ name: 'read_task_input', args: { field: 'source_text' } }] },
        { callTools: [{ name: 'submit_answer', args: semanticAnswer() }] },
        ...Array.from({ length: 5 }, () => ({
          submitReview: { slotId: 'story_outline', verdict: 'no_finding' as const },
        })),
      ],
    });
    harness = createApiHarness({ provider, ...dirs });

    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-outline-v3-candidate',
      name: '合成 NarrativePlan v3 候选验收',
      input: { source_text: privateSource },
    });
    await harness.lifecycle.start(created.task.id);

    const task = harness.uow.repositories.tasks.getOrThrow(created.task.id);
    expect(task.status, task.errorMessage ?? '无错误详情').toBe('completed');
    expect(provider.observations[1]?.toolNames).toContain('submit_answer');
    expect(provider.observations[1]?.toolNames).not.toContain('complete_assignment');
    const submitSchema = JSON.stringify(provider.observations[1]);
    expect(submitSchema).toContain('initialState');
    expect(submitSchema).toContain('intent');
    expect(submitSchema).toContain('resistance');
    expect(submitSchema).toContain('outcome');
    expect(submitSchema).not.toContain('objective');
    expect(submitSchema).not.toContain('endState');
    expect(submitSchema).not.toContain(PRIVATE_SOURCE_MARKER);

    const fillExecution = harness.uow.repositories.executions.listByTask(created.task.id)
      .find((execution) => execution.operation === 'fill_slot');
    expect(fillExecution).toBeDefined();
    const persistedReplay = harness.uow.repositories.executions.getReplayInput(fillExecution!.id);
    expect(persistedReplay).not.toBeNull();
    const replay = parseReplayInput(persistedReplay!.replayInputJson, persistedReplay!.replayInputHash);
    expect(replay.version).toBe(2);
    expect(persistedReplay!.replayInputJson).not.toContain(PRIVATE_SOURCE_MARKER);

    const outline = harness.uow.repositories.slots.getOrThrow(created.task.id, 'story_outline');
    expect(outline.status).toBe('completed');
    expect(outline.contentText).toContain('重点：P1 P001');
    expect(outline.contentText).toContain('展开：轻过渡');
    expect(outline.domainArtifact).toMatchObject({
      kind: 'narrative-plan',
      version: 3,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const artifact = JSON.parse(outline.domainArtifact!.json);
    expect(canonicalJson(artifact)).toBe(outline.domainArtifact!.json);
    expect(artifact).toMatchObject({
      version: 1,
      units: expect.arrayContaining([expect.objectContaining({ unitId: 'unit_01' })]),
    });

    for (const table of ['tasks', 'task_snapshots', 'task_skill_snapshots', 'slots', 'executions', 'trace_events', 'artifacts', 'slot_reviews']) {
      expect(JSON.stringify(harness.db.prepare(`SELECT * FROM ${table}`).all()), table)
        .not.toContain(PRIVATE_SOURCE_MARKER);
    }
    for (const url of [
      `/api/tasks/${created.task.id}`,
      `/api/tasks/${created.task.id}/traces?limit=500`,
      `/api/tasks/${created.task.id}/executions`,
      `/api/tasks/${created.task.id}/artifact`,
    ]) {
      const response = await harness.server.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(PRIVATE_SOURCE_MARKER);
    }
    expect(provider.remainingTurns).toBe(0);
  });
});
