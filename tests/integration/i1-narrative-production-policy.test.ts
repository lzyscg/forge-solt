import { afterEach, describe, expect, it } from 'vitest';
import { buildContext, parseReplayInput } from '@server/application/context-builder.ts';
import { resolveSlotProductionPolicy } from '@server/application/narrative-production-policy.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { createEngineHarness, type EngineHarness } from '../fixtures/engine.ts';
import { createTemplateWorkspace, type TemplateWorkspace } from '../fixtures/workspace.ts';

let harness: EngineHarness | null = null;
let workspace: TemplateWorkspace | null = null;

afterEach(async () => {
  harness?.close();
  harness = null;
  await workspace?.cleanup();
  workspace = null;
});

function narrativeOutline(sectionCount = 8): string {
  return Array.from({ length: sectionCount }, (_, index) => {
    const number = index + 1;
    const priority = number === 1
      ? 'P0 P001'
      : number === sectionCount
        ? 'P0 P002'
        : 'bridge';
    const expansion = number % 3 === 1 ? '轻过渡' : number % 3 === 2 ? '标准' : '细写';
    const mode = number % 2 === 0 ? '冲突场景' : '自定义';
    return `${number}. 第${number}节
变化：状态${number - 1} → 状态${number}
重点：${priority}
展开：${expansion}
模式：${mode}
容量：对白轮次 ${number % 3}；动作反馈闭环 1；认知转折 1；事后余波 1
出场：我
目标：推进第${number}步
冲突：第${number}步遇到阻力
结束状态：完成第${number}步`;
  }).join('\n\n');
}

function narrativeStructure(sectionCount = 8) {
  return {
    rootSlotId: 'chapter',
    slots: [
      { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '整篇容器', dependsOn: [] },
      ...Array.from({ length: sectionCount }, (_, index) => ({
        id: `scene_${String(index + 1).padStart(2, '0')}`,
        type: 'scene',
        parentId: 'chapter',
        order: index,
        instruction: `完成 Narrative Unit ${index + 1}`,
        dependsOn: [] as string[],
      })),
    ],
  };
}

async function enableNarrativePlanTemplate(target: TemplateWorkspace): Promise<void> {
  await target.patchTemplate(
    'zhihu-chapter',
    `    validation:
      minChars: 300
      maxChars: 8000
      forbidPattern: '(?m)^#{1,6}\\s'`,
    `    validation:
      forbidPattern: '(?m)^#{1,6}\\s'`,
  );
  await target.patchTemplate(
    'zhihu-chapter',
    `output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1`,
    `output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1
  validation:
    outlineCount:
      inputField: chapter_packet
      slotType: scene
    storyHan:
      min: 2000
      target: 4000
      max: 8000
      slotType: scene
    narrativePlan:
      inputField: chapter_packet
      slotType: scene`,
  );
}

describe('I1 NarrativePlan zero-network production chain', () => {
  it('同一冻结 unit policy 驱动 Prompt、runtime、提交、组装与 Replay', async () => {
    workspace = await createTemplateWorkspace();
    await enableNarrativePlanTemplate(workspace);
    const provider = new FakeProvider();
    harness = createEngineHarness({
      provider,
      templatesDir: workspace.templatesDir,
      skillsDir: workspace.skillsDir,
    });

    const created = await harness.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: 'I1 离线贯通',
      input: { chapter_packet: narrativeOutline() },
    });
    const taskId = created.task.id;
    const frozenBefore = harness.snapshots.readSnapshot(taskId);
    expect(frozenBefore.narrativePlan?.units).toHaveLength(8);
    expect(frozenBefore.narrativePlanHash).toMatch(/^[a-f0-9]{64}$/u);

    provider.script({ submitStructure: narrativeStructure() });
    for (const unit of frozenBefore.narrativePlan!.units) {
      provider.script({
        submitContent: {
          slotId: `scene_${String(unit.order).padStart(2, '0')}`,
          content: '我'.repeat(unit.budget.targetHan),
        },
      });
    }

    await workspace.patchTemplate('zhihu-chapter', 'target: 4000', 'target: 7000');
    await harness.lifecycle.start(taskId);

    const task = harness.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.status).toBe('completed');
    expect(task.phase).toBe('done');
    const frozenAfter = harness.snapshots.readSnapshot(taskId);
    expect(frozenAfter.narrativePlan).toEqual(frozenBefore.narrativePlan);
    expect(frozenAfter.narrativePlanHash).toBe(frozenBefore.narrativePlanHash);
    expect(frozenAfter.narrativePlan?.storyBudget.targetHan).toBe(4000);

    const slots = harness.uow.repositories.slots.listByTask(taskId);
    const scenes = slots.filter((slot) => slot.type === 'scene');
    expect(scenes.map((slot) => slot.narrativeUnitId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `unit_${String(index + 1).padStart(2, '0')}`),
    );
    expect(scenes.every((slot) => slot.status === 'completed')).toBe(true);

    const fillExecutions = harness.uow.repositories.executions
      .listByTask(taskId)
      .filter((execution) => execution.operation === 'fill_slot');
    expect(fillExecutions).toHaveLength(8);
    for (const execution of fillExecutions) {
      const persisted = harness.uow.repositories.executions.getReplayInput(execution.id);
      expect(persisted).not.toBeNull();
      const replay = parseReplayInput(persisted!.replayInputJson, persisted!.replayInputHash);
      if (replay.contextInput.operation !== 'fill_slot') throw new Error('预期 fill_slot ReplayInput');
      const input = replay.contextInput;
      const policy = input.productionPolicy;
      expect(policy?.source).toBe('plan');
      expect(policy?.narrativeUnit?.unitId).toBe(input.targetSlot.narrativeUnitId);
      expect(input.snapshot.narrativePlanHash).toBe(frozenBefore.narrativePlanHash);
      expect(input.snapshot.narrativePlan).toEqual(frozenBefore.narrativePlan);

      const rebuilt = buildContext(input);
      const observed = provider.observations.find(
        (item) => item.system === rebuilt.systemText && item.messages[0]?.content === rebuilt.userText,
      );
      expect(observed, `${input.targetSlot.slotId} 没有对应的 Provider 请求`).toBeDefined();
      expect(observed?.maxTokens).toBe(policy?.runtimeMaxTokens);
      expect(rebuilt.userText).toContain(`目标 ${policy?.han?.targetHan}`);
      expect(rebuilt.userText).toContain(`叙事优先级 ${policy?.narrativeUnit?.priority}`);
      expect(rebuilt.contextJson).toContain('productionPolicy');

      const slotType = input.slotType;
      expect(resolveSlotProductionPolicy({
        snapshot: frozenAfter,
        targetSlot: input.targetSlot,
        allSlots: input.slots,
        slotType,
      })).toEqual(policy);
      expect(input.targetSlot.contentText).toBeNull();
      expect(harness.uow.repositories.slots.getOrThrow(taskId, input.targetSlot.slotId).contentText)
        .toHaveLength(policy!.han!.targetHan!);
    }

    const artifact = harness.uow.repositories.artifacts.getByTaskOrThrow(taskId);
    expect(artifact.content.match(/我/gu)).toHaveLength(4000);
    expect(provider.remainingTurns).toBe(0);
  });
});
