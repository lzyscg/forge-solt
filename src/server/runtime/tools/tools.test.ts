/**
 * 工具层测试（§7.5 / D-11 / D-18）。
 *
 * 直接驱动 `buildToolset` + `dispatchToolCall`，不经过 Provider——
 * 工具的权限边界是独立的不变量，不该只能通过一整轮模型调用来验证。
 */

import { describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { TOOL_NAMES } from '@shared/tools.ts';
import type { ProviderToolCall } from '../provider/provider-adapter.ts';
import { SubmissionGate } from '../submission-gate.ts';
import { TraceWriter } from '../trace-writer.ts';
import { FAKE_SKILL, FakeCompletionPort, FakeStructurePort, FakeTracePort } from '../test-doubles.ts';
import type { OutlineSlot, SlotContentView } from '../ports.ts';
import { prepareNarrativeAnswerContract } from '@server/domain/narrative-answer.ts';
import { buildToolset, dispatchToolCall, renderOutline, toProviderTools } from './index.ts';
import type { ToolsetContext } from './index.ts';

const OUTLINE: OutlineSlot[] = [
  {
    slotId: 'chapter',
    type: 'chapter',
    parentId: null,
    sortOrder: 0,
    instruction: '整章容器',
    dependsOn: [],
    contentBearing: false,
    status: 'pending',
  },
  {
    slotId: 'scene_02',
    type: 'scene',
    parentId: 'chapter',
    sortOrder: 0,
    instruction: '第二场',
    dependsOn: [],
    contentBearing: true,
    status: 'completed',
  },
  {
    slotId: 'scene_03',
    type: 'scene',
    parentId: 'chapter',
    sortOrder: 1,
    instruction: '第三场',
    dependsOn: ['scene_02'],
    contentBearing: true,
    status: 'running',
  },
];

const CONTENTS: Record<string, SlotContentView> = {
  scene_02: {
    slotId: 'scene_02',
    type: 'scene',
    instruction: '第二场',
    status: 'completed',
    contentText: '第二场的正文。',
  },
  scene_01: {
    slotId: 'scene_01',
    type: 'scene',
    instruction: '第一场',
    status: 'pending',
    contentText: null,
  },
};

function makeContext(overrides: Partial<ToolsetContext> = {}): {
  ctx: ToolsetContext;
  trace: FakeTracePort;
  gate: SubmissionGate;
  completion: FakeCompletionPort;
  submitted: { count: number };
} {
  const tracePort = new FakeTracePort();
  const gate = new SubmissionGate();
  const completion = new FakeCompletionPort();
  const submitted = { count: 0 };
  const ctx: ToolsetContext = {
    taskId: 'task_1',
    executionId: 'exec_1',
    executionToken: 'token-plaintext',
    operation: 'fill_slot',
    targetSlotId: 'scene_03',
    allowedDependencySlotIds: ['scene_02'],
    /** 默认首稿。要测编辑清单的用例用 overrides 传一份基线进来 */
    revisionBase: null,
    skill: FAKE_SKILL,
    taskInput: { premise: '前提', tone: '克制' },
    toolReadablePrivateInputIds: [],
    readPrivateTaskInput: () => null,
    gate,
    trace: new TraceWriter(tracePort, 'task_1'),
    completion,
    structure: new FakeStructurePort(OUTLINE, CONTENTS),
    onSubmitted: () => {
      gate.close();
      submitted.count += 1;
    },
    onRejected: () => undefined,
    ...overrides,
  };
  return { ctx, trace: tracePort, gate, completion, submitted };
}

const call = (name: string, args: unknown): ProviderToolCall => ({
  id: 'call_1',
  name,
  argumentsJson: JSON.stringify(args),
});

const narrativeSource = [
  '01、开端', '甲看见门。',
  '02', '甲乙争执很多很多。',
  '03. 发现', '甲发现旧信。',
  '04', '乙否认。',
  '05', '甲追问来龙去脉。',
  '06', '乙终于承认。',
  '07', '两人作出选择。',
  '08、结局', '甲离开旧城很久很久。',
].join('\n');

function preparedNarrativeSubmission() {
  const prepared = prepareNarrativeAnswerContract(narrativeSource);
  if (!prepared.ok) throw new Error('test source must prepare');
  return {
    kind: 'narrative-plan' as const,
    version: 2 as const,
    contract: prepared.contract,
    storyBudget: { minHan: 800, targetHan: 1000, maxHan: 1200 },
  };
}

function narrativeAnswer() {
  const priorities = ['P1', 'bridge', 'P0', 'P1', 'bridge', 'P0', 'P1', 'P0'] as const;
  return {
    units: priorities.map((priority, index) => ({
      sourceSectionRef: `source-section-${String(index + 1).padStart(2, '0')}`,
      title: `第${index + 1}节`,
      change: { from: `状态${index}`, to: `状态${index + 1}` },
      priority,
      mode: index === 1 ? 'fast-summary' as const : 'conflict-scene' as const,
      capacity: {
        dialogueTurns: index === 1 ? 0 : 2,
        actionFeedbackLoops: 1,
        cognitionTurns: index === 2 ? 1 : 0,
        aftermathBeats: index === 7 ? 1 : 0,
      },
      cast: index === 1 ? [] : ['甲', '乙'],
      objective: `目标${index + 1}`,
      conflict: `冲突${index + 1}`,
      endState: `结束${index + 1}`,
      informationControl: index === 2 ? '暂不揭示旧信来源' : null,
    })),
  };
}

describe('buildToolset', () => {
  it('挂满 TOOL_NAMES 的全部工具，且不多挂', () => {
    const { ctx } = makeContext();
    const names = buildToolset(ctx).map((t) => t.name);
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('给模型的 tool definition 的 JSON Schema 来自 Zod，不是手写的', () => {
    const { ctx } = makeContext();
    const definitions = toProviderTools(buildToolset(ctx));
    const readSlot = definitions.find((d) => d.name === 'read_slot');
    expect(readSlot?.parameters).toMatchObject({
      type: 'object',
      properties: { slotId: { type: 'string' } },
      required: ['slotId'],
    });
    // discriminatedUnion 必须被展开成 anyOf，否则模型拿不到两种提交形状
    const complete = definitions.find((d) => d.name === 'complete_assignment');
    expect(Array.isArray((complete?.parameters as { anyOf?: unknown[] }).anyOf)).toBe(true);
  });

  it('contract Assignment 只暴露 submit_answer，schema 不含系统已知协议字段', () => {
    const { ctx } = makeContext({ preparedSubmission: preparedNarrativeSubmission() });
    const definitions = toProviderTools(buildToolset(ctx));
    const names = definitions.map((definition) => definition.name);

    expect(names).toContain('submit_answer');
    expect(names).not.toContain('complete_assignment');
    const submit = definitions.find((definition) => definition.name === 'submit_answer');
    const serialized = JSON.stringify(submit?.parameters);
    expect(serialized).toContain('sourceSectionRef');
    expect(serialized).not.toMatch(/slotId|taskId|operation|priorityId|expansion|budget/);
  });

  it('submit_answer 编译业务答案并以系统目标保存兼容 Markdown', async () => {
    const { ctx, completion, submitted, trace } = makeContext({
      targetSlotId: 'story_outline',
      preparedSubmission: preparedNarrativeSubmission(),
    });
    const tools = buildToolset(ctx);

    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('submit_answer', narrativeAnswer()),
    );

    expect(result.isError).toBe(false);
    expect(submitted.count).toBe(1);
    expect(completion.submissions).toHaveLength(1);
    expect(completion.submissions[0]).toMatchObject({
      operation: 'fill_slot',
      targetSlotId: 'story_outline',
      domainArtifact: {
        kind: 'narrative-plan',
        version: 2,
        json: expect.any(String),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      payload: { kind: 'slot_content', slotId: 'story_outline' },
    });
    const payload = completion.submissions[0]?.payload;
    expect(payload?.kind).toBe('slot_content');
    if (payload?.kind !== 'slot_content') return;
    expect(payload.content).toContain('重点：P1 P001');
    expect(payload.content).toContain('展开：轻过渡');
    expect(JSON.stringify(trace.records)).not.toContain(narrativeSource);
    expect(trace.kinds('assignment_submitted')[0]?.payload).toMatchObject({
      kind: 'narrative-plan',
      version: 2,
      unitCount: 8,
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      weightProfile: 'i0-three-mode-v1',
      sourceSegmentation: 'preserve-numbered-sections',
      expansionPolicy: 'source-length-quantiles-v1',
      priorityCounts: { P0: 3, P1: 3, bridge: 2 },
      capacityTotals: {
        dialogueTurns: 14,
        actionFeedbackLoops: 8,
        cognitionTurns: 1,
        aftermathBeats: 1,
      },
    });
  });
});

describe('read_task_input', () => {
  it('省略 field 只返回公开字段；显式点名才能读取模板授权的私有字段，且 trace 不记录正文', async () => {
    const secret = '仅供本次任务使用的私有原文';
    const { ctx, trace } = makeContext({
      toolReadablePrivateInputIds: ['source_text'],
      readPrivateTaskInput: (fieldId) => fieldId === 'source_text' ? secret : null,
    });
    const tools = buildToolset(ctx);

    const all = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', {}),
    );
    expect(all.isError).toBe(false);
    expect(all.content).toContain('前提');
    expect(all.content).not.toContain('source_text');
    expect(all.content).not.toContain(secret);

    const explicit = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', { field: 'source_text' }),
    );
    expect(explicit).toMatchObject({ isError: false, content: `【source_text】\n${secret}` });
    expect(JSON.stringify(trace.records)).not.toContain(secret);
  });

  it('未授权私有字段失败关闭，不向模型暴露该字段可用', async () => {
    const secret = '不可读取的私有正文';
    const { ctx } = makeContext({
      readPrivateTaskInput: () => secret,
    });
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', { field: 'source_text' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('可用字段：premise, tone');
    expect(result.content).not.toContain(secret);
  });

  it('继承属性不是公开任务字段，显式读取必须失败关闭', async () => {
    const { ctx } = makeContext({ taskInput: { premise: '公开前提' } });
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', { field: 'toString' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_INPUT_INVALID');
    expect(result.content).toContain('可用字段：premise');
  });

  it('省略 field 返回全部；指定不存在的 field 报错并列出可用公开字段', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const all = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', {}),
    );
    expect(all.isError).toBe(false);
    expect(all.content).toContain('前提');
    expect(all.content).toContain('克制');

    const missing = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_task_input', { field: 'nope' }),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('premise');
    expect(missing.content).toContain('tone');
  });
});

describe('read_skill_section', () => {
  it('读到的是快照里的章节，并写 skill_section_read', async () => {
    const { ctx, trace } = makeContext();
    const tools = buildToolset(ctx);
    const ok = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_skill_section', { sectionId: 'S6' }),
    );
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain('检查字数与禁用表达');
    expect(trace.kinds('skill_section_read')).toHaveLength(1);
    expect(trace.kinds('skill_section_read')[0]?.payload?.['sectionId']).toBe('S6');
  });

  it('不存在的章节 → SKILL_SECTION_NOT_FOUND，且列出可读章节', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_skill_section', { sectionId: 'S9' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('SKILL_SECTION_NOT_FOUND');
    expect(result.content).toContain('S1, S6');
  });
});

describe('read_structure_outline', () => {
  it('create_structure 时不可用（结构尚不存在）', async () => {
    const { ctx } = makeContext({ operation: 'create_structure', targetSlotId: null });
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      { id: 'c', name: 'read_structure_outline', argumentsJson: '' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_NOT_ALLOWED');
  });

  it('fill_slot 时返回树形概要，标出当前槽位且不含任何正文', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      { id: 'c', name: 'read_structure_outline', argumentsJson: '' },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('← 当前槽位');
    expect(result.content).toContain('依赖: scene_02');
    // 概要绝不能带正文，否则依赖白名单就有了旁路
    expect(result.content).not.toContain('第二场的正文');
  });

  it('renderOutline 按 sortOrder 而不是数组顺序排列', () => {
    const reversed = [OUTLINE[0]!, OUTLINE[2]!, OUTLINE[1]!];
    const text = renderOutline(reversed, 'scene_03');
    expect(text.indexOf('scene_02')).toBeLessThan(text.indexOf('scene_03'));
  });

  /*
   * 概要要带上每个内容槽位的 instruction——那是结构 Agent 写下的「本槽位要完成什么」。
   *
   * 这是横向视野的**唯一**来源：填 scene_02 时，它自己的 instruction 在提示词里，
   * 上游的成稿能用 read_slot 读，但**下游还没写的那些槽位打算干什么**，
   * 只有这里能看到。少了它，两个场景各编各的，人物就会前后不一致
   * （`outline-writing/SKILL.md` S1 讲的正是这件事）。
   */
  it('renderOutline 带上内容槽位的 instruction，容器的不带', () => {
    const text = renderOutline(OUTLINE, 'scene_02');
    expect(text).toContain('目标：');
    expect(text).toContain(OUTLINE[1]!.instruction);
    // 看得见**别的**槽位的目标，这条才是横向视野
    expect(text).toContain(OUTLINE[2]!.instruction);
    // 容器不产出内容，它的 instruction 对下游没有可执行含义
    expect(text).not.toContain('整章容器');
  });

  /*
   * instruction 可以是多行的（实测结构 Agent 写过分行清单）。原样渲染会让后续行
   * 顶到最左边，看起来像树的下一个节点——缩进树的层级信息就被它破坏了。
   */
  it('多行 instruction 折成单行，不破坏树的缩进', () => {
    const multiline: OutlineSlot = { ...OUTLINE[1]!, instruction: '第一行\n  第二行\n第三行' };
    const text = renderOutline([OUTLINE[0]!, multiline], null);
    const lines = text.split('\n');
    expect(lines.filter((l) => l.includes('第二行'))).toHaveLength(1);
    expect(text).toContain('第一行 第二行 第三行');
  });

  // 概要绝不能带正文：那会让依赖白名单有旁路。instruction 是规划不是正文，
  // 两者的区别正是这条断言要守住的边界。
  it('带 instruction 但仍然不带正文', () => {
    const text = renderOutline(OUTLINE, null);
    expect(text).not.toContain('第二场的正文');
  });
});

describe('read_slot 的依赖白名单（REQ FR-CTX-003）', () => {
  it('白名单内可读', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_slot', { slotId: 'scene_02' }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('第二场的正文');
  });

  it('白名单外一律拒绝，即使那个槽位真的存在', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_slot', { slotId: 'scene_01' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_NOT_ALLOWED');
    expect(result.content).toContain('可读取：scene_02');
  });

  it('白名单内但没有正文 → SLOT_NOT_READY，而不是返回空串', async () => {
    const { ctx } = makeContext({ allowedDependencySlotIds: ['scene_01'] });
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('read_slot', { slotId: 'scene_01' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('SLOT_NOT_READY');
  });
});

describe('分发器（D-18 的实现陷阱）', () => {
  it('参数不是合法 JSON → TOOL_INPUT_INVALID，不中断', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      { id: 'c', name: 'read_slot', argumentsJson: '{"slotId": ' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_INPUT_INVALID');
  });

  it('参数过不了 Zod → TOOL_INPUT_INVALID，且带上具体字段', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('report_work', { type: 'celebration', summary: '' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_INPUT_INVALID');
    expect(result.content).toContain('type');
  });

  it('非 ForgeError 一律向上冒泡，不被吞成工具结果', async () => {
    const { ctx } = makeContext();
    const tools = buildToolset(ctx).map((tool) =>
      tool.name === 'read_slot'
        ? { ...tool, invoke: async (): ReturnType<typeof tool.invoke> => { throw new TypeError('实现 bug'); } }
        : tool,
    );
    await expect(
      dispatchToolCall({ tools, trace: ctx.trace, executionId: 'exec_1' }, call('read_slot', { slotId: 'scene_02' })),
    ).rejects.toThrow(TypeError);
  });
});

describe('SubmissionGate（D-11）', () => {
  it('关闭后每个工具的第一行都拦住', async () => {
    const { ctx, gate } = makeContext();
    const tools = buildToolset(ctx);
    gate.close();
    for (const tool of tools) {
      await expect(tool.invoke(argsFor(tool.name))).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    }
  });

  it('提交成功后 onSubmitted 被调用一次', async () => {
    const { ctx, submitted, completion } = makeContext();
    const tools = buildToolset(ctx);
    const result = await dispatchToolCall(
      { tools, trace: ctx.trace, executionId: 'exec_1' },
      call('complete_assignment', { kind: 'slot_content', slotId: 'scene_03', content: '正文' }),
    );
    expect(result.isError).toBe(false);
    expect(submitted.count).toBe(1);
    expect(completion.submissions).toHaveLength(1);
  });

  it('assertOpen 抛的是 ForgeError（分发器据此判断该不该吞）', () => {
    const gate = new SubmissionGate();
    gate.close();
    expect(() => gate.assertOpen('read_slot')).toThrow(ForgeError);
    // 幂等
    expect(() => gate.close()).not.toThrow();
  });
});

/** 各工具的一组合法参数，用于「闸门关闭后一律被拒」的遍历断言 */
function argsFor(name: string): unknown {
  switch (name) {
    case 'read_task_input':
      return {};
    case 'read_skill_section':
      return { sectionId: 'S1' };
    case 'read_structure_outline':
      return {};
    case 'read_slot':
      return { slotId: 'scene_02' };
    case 'report_work':
      return { type: 'plan', summary: '计划' };
    default:
      return { kind: 'slot_content', slotId: 'scene_03', content: '正文' };
  }
}
