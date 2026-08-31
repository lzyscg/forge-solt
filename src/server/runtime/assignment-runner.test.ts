/**
 * Runtime 收敛行为的集成测试（§7.6 / §8 / D-04 / D-11 / AC-008 / AC-010 / AC-011 / AC-014）。
 *
 * 全部用内存假实现驱动：无网络、无数据库。每条断言都指向一个**会因实现变坏而变红**的
 * 事实，而不是「某方法被调用过」。
 */

import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import { UserStopSignal } from './abort-reasons.ts';
import { AssignmentRunner } from './assignment-runner.ts';
import type { Assignment, AssignmentOutcome } from './assignment-runner.ts';
import { NO_SUBMISSION_RETRY_APPEND } from './agent-runtime.ts';
import { FakeProvider } from './provider/fake.ts';
import type { FakeProviderScript } from './provider/fake.ts';
import { VALID_STRUCTURE } from './provider/invalid-structures.ts';
import { ProviderRegistry } from './provider/provider-registry.ts';
import { FAKE_SKILL, FakeCompletionPort, FakeStructurePort, FakeTracePort } from './test-doubles.ts';
import type { CompletionOutcome, OutlineSlot, SlotContentView } from './ports.ts';

const API_KEY = 'sk-forge-test-secret-value';

const CONFIG: ProviderConfig = {
  providers: [
    {
      id: 'fake',
      name: 'Fake Provider',
      kind: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'FORGE_TEST_KEY',
      models: ['fake-model'],
    },
  ],
  aliases: { main: [{ provider: 'fake', model: 'fake-model' }] },
  defaults: {
    timeoutMs: 180000,
    maxRetries: 2,
    concurrentSlots: 1,
    rateLimitBackoff: { strategy: 'exponential', initialMs: 1, maxMs: 4, maxAttempts: 5 },
  },
};

interface Harness {
  runner: AssignmentRunner;
  trace: FakeTracePort;
  completion: FakeCompletionPort;
  provider: FakeProvider;
  controller: AbortController;
  run: (overrides?: Partial<Assignment>) => Promise<AssignmentOutcome>;
}

function harness(options: {
  turns?: FakeProviderScript[];
  rateLimitTimes?: number;
  completionOutcomes?: CompletionOutcome[];
  outline?: OutlineSlot[];
  contents?: Record<string, SlotContentView>;
  aliases?: ProviderConfig['aliases'];
  env?: NodeJS.ProcessEnv;
}): Harness {
  const provider = new FakeProvider({
    ...(options.turns === undefined ? {} : { turns: options.turns }),
    ...(options.rateLimitTimes === undefined ? {} : { rateLimitTimes: options.rateLimitTimes }),
  });
  const registry = new ProviderRegistry({
    config: options.aliases === undefined ? CONFIG : { ...CONFIG, aliases: options.aliases },
    env: options.env ?? { FORGE_TEST_KEY: API_KEY },
    adapterFactory: () => provider,
  });
  const trace = new FakeTracePort();
  const completion = new FakeCompletionPort(...(options.completionOutcomes ?? []));
  const structure = new FakeStructurePort(options.outline ?? [], options.contents ?? {});
  const runner = new AssignmentRunner({
    registry,
    trace,
    completion,
    structure,
    rateLimitBackoff: CONFIG.defaults.rateLimitBackoff,
  });
  const controller = new AbortController();

  const base: Assignment = {
    taskId: 'task_1',
    executionId: 'exec_1',
    executionToken: 'token-plaintext',
    operation: 'fill_slot',
    targetSlotId: 'scene_03',
    /** 这批用例全是首稿，没有可编辑的上一稿 */
    revisionBase: null,
    modelAlias: 'main',
    systemText: '你是一个 Agent。',
    userText: '写 scene_03。',
    maxToolCalls: 10,
    maxTokens: 4096,
    timeoutMs: 5000,
    allowedDependencySlotIds: ['scene_02'],
    skill: FAKE_SKILL,
    taskInput: { premise: '一个关于耳机的故事', tone: '克制' },
    controller,
  };

  return {
    runner,
    trace,
    completion,
    provider,
    controller,
    run: (overrides = {}) => runner.run({ ...base, ...overrides }),
  };
}

const submitContent = { slotId: 'scene_03', content: '她戴上耳机。' };

describe('AssignmentRunner 收敛分支', () => {
  it('submitted：提交成功 → succeeded，且载荷与 Token 原样透传', async () => {
    const h = harness({ turns: [{ submitContent }] });
    const outcome = await h.run();

    expect(outcome.kind).toBe('succeeded');
    expect(h.completion.submissions).toHaveLength(1);
    const submitted = h.completion.submissions[0];
    expect(submitted?.executionToken).toBe('token-plaintext');
    expect(submitted?.payload).toEqual({ kind: 'slot_content', ...submitContent });
    expect(h.trace.kinds('assignment_submitted')).toHaveLength(1);
  });

  it('no_submission：只说话不提交 → ASSIGNMENT_OUTPUT_INVALID + noSubmission（AC-014）', async () => {
    const h = harness({ turns: [{ emitText: ['我已经完成了这个槽位。'], neverSubmit: true }] });
    const outcome = await h.run();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('ASSIGNMENT_OUTPUT_INVALID');
    expect(outcome.noSubmission).toBe(true);
    expect(outcome.consumesRetry).toBe(true);
    expect(h.completion.submissions).toHaveLength(0);
    // 重试文案是 noSubmission 唯一的下游用途，确保它没被写空
    expect(NO_SUBMISSION_RETRY_APPEND).toContain('complete_assignment');
  });

  it('max_tokens：输出超长且未提交 → PROVIDER_ERROR', async () => {
    const h = harness({ turns: [{ emitText: ['很长很长'], stopReason: 'max_tokens' }] });
    const outcome = await h.run();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('PROVIDER_ERROR');
    expect(outcome.message).toContain('长度上限');
    expect(outcome.noSubmission).toBe(false);
  });

  it('工具超限：超出 maxToolCalls → MAX_TOOL_CALLS_EXCEEDED，且后续工具不再执行', async () => {
    const h = harness({
      turns: [
        {
          callTools: [
            { name: 'report_work', args: { type: 'plan', summary: '第一次' } },
            { name: 'report_work', args: { type: 'plan', summary: '第二次' } },
          ],
          submitContent,
        },
      ],
    });
    const outcome = await h.run({ maxToolCalls: 1 });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('MAX_TOOL_CALLS_EXCEEDED');
    // 第一次 report_work 成功、第二次触顶、提交根本没轮到
    expect(h.trace.kinds('work_plan')).toHaveLength(1);
    expect(h.completion.submissions).toHaveLength(0);
  });

  it('未知工具名：不中断循环，转成工具错误结果（D-11）', async () => {
    const h = harness({
      turns: [
        { callTools: [{ name: 'read_slott', args: { slotId: 'scene_02' } }] },
        { submitContent },
      ],
    });
    const outcome = await h.run();

    // 拼错的工具名没有吃掉这次 attempt：第二轮照样提交成功
    expect(outcome.kind).toBe('succeeded');
    const rejected = h.trace.kinds('tool_call_completed').filter((r) => r.payload?.['ok'] === false);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload?.['code']).toBe('TOOL_NOT_ALLOWED');
    expect(rejected[0]?.payload?.['toolName']).toBe('read_slott');
  });

  it('cancelled：用户停止 → cancelled，且 abort 真的打断了循环（AC-011）', async () => {
    const h = harness({ turns: [{ hangMs: 3000, submitContent }] });
    const startedAt = Date.now();
    setTimeout(() => h.controller.abort(new UserStopSignal()), 20);
    const outcome = await h.run();

    expect(outcome.kind).toBe('cancelled');
    // 若 abort 没有传播，这里要等满 3 秒。留足余量，但远小于 hangMs
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(h.completion.submissions).toHaveLength(0);
  });

  it('timeout：超时 → PROVIDER_TIMEOUT 且消耗重试配额（AC-010）', async () => {
    const h = harness({ turns: [{ hangMs: 3000, submitContent }] });
    const startedAt = Date.now();
    const outcome = await h.run({ timeoutMs: 30 });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('PROVIDER_TIMEOUT');
    expect(outcome.consumesRetry).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('别名解析不出来 → MODEL_ALIAS_UNRESOLVED，且**不**消耗重试配额', async () => {
    const h = harness({ turns: [{ submitContent }], aliases: {} });
    const outcome = await h.run();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('MODEL_ALIAS_UNRESOLVED');
    expect(outcome.consumesRetry).toBe(false);
    expect(outcome.provider).toBeNull();
  });
});

describe('限流退避（D-04 / §8.5）', () => {
  it('429 在同一个 Execution 内退避重发：不新建 attempt，写 provider_retry', async () => {
    const h = harness({ turns: [{ submitContent }], rateLimitTimes: 2 });
    const outcome = await h.run();

    expect(outcome.kind).toBe('succeeded');
    expect(h.trace.kinds('provider_retry')).toHaveLength(2);
    // assignment_started 每次 run() 只写一条——它是「有没有新建 Execution / 递增 attempt」
    // 在 trace 上的唯一可观测标志。变成 3 条就说明退避被错误地做成了重试
    expect(h.trace.kinds('assignment_started')).toHaveLength(1);
    // Provider 一共被调了 3 次（2 次 429 + 1 次成功），而 Assignment 只跑了一遍
    expect(h.provider.observations).toHaveLength(3);
  });

  it('退避次数耗尽 → PROVIDER_RATE_LIMITED 冒出来', async () => {
    // maxAttempts = 5，这里让它一直 429
    const h = harness({ turns: [{ submitContent }], rateLimitTimes: 99 });
    const outcome = await h.run();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('PROVIDER_RATE_LIMITED');
    expect(h.trace.kinds('provider_retry')).toHaveLength(4); // 最后一次不再退避，直接抛
  });
});

describe('提交边界（D-11 / AC-008）', () => {
  it('提交之后的工具调用被拒，但循环仍收敛为成功', async () => {
    const h = harness({
      turns: [
        {
          callTools: [
            { name: 'complete_assignment', args: { kind: 'slot_content', ...submitContent } },
            { name: 'report_work', args: { type: 'completion', summary: '我已完成' } },
          ],
        },
      ],
    });
    const outcome = await h.run();

    expect(outcome.kind).toBe('succeeded');
    expect(h.completion.submissions).toHaveLength(1);
    const rejected = h.trace.kinds('tool_call_completed').filter((r) => r.payload?.['ok'] === false);
    expect(rejected.map((r) => r.payload?.['code'])).toEqual(['TOOL_NOT_ALLOWED']);
    // 闸门关闭后 report_work 不得留下 work_completion trace
    expect(h.trace.kinds('work_completion')).toHaveLength(0);
  });

  it('提交后到达的 text delta 被丢弃（D-11）', async () => {
    const h = harness({
      turns: [
        { callTools: [{ name: 'complete_assignment', args: { kind: 'slot_content', ...submitContent } }] },
        { emitText: ['提交之后又说的话'] },
      ],
    });
    await h.run();
    expect(h.trace.outputText).not.toContain('提交之后又说的话');
  });

  it('提交到错误的 slotId 被拒（AC-008），且给出正确的 slotId', async () => {
    const h = harness({ turns: [{ submitWrongSlot: 'scene_01' }, { submitContent }] });
    const outcome = await h.run();

    expect(outcome.kind).toBe('succeeded');
    // 被拒的那次没有进入 CompletionPort——拦在事务之前
    expect(h.completion.submissions).toHaveLength(1);
    expect(h.completion.submissions[0]?.payload).toEqual({ kind: 'slot_content', ...submitContent });
    const rejected = h.trace.kinds('tool_call_completed').filter((r) => r.payload?.['ok'] === false);
    expect(rejected[0]?.payload?.['code']).toBe('SLOT_TARGET_MISMATCH');
  });

  it('fill_slot 的 Assignment 提交结构 → ASSIGNMENT_OUTPUT_INVALID（越权而非参数错）', async () => {
    const h = harness({ turns: [{ submitStructure: VALID_STRUCTURE }] });
    const outcome = await h.run();

    expect(outcome.kind).toBe('failed');
    expect(h.completion.submissions).toHaveLength(0);
    const rejected = h.trace.kinds('tool_call_completed').filter((r) => r.payload?.['ok'] === false);
    expect(rejected[0]?.payload?.['code']).toBe('ASSIGNMENT_OUTPUT_INVALID');
  });
});

describe('结构校验失败的反馈（D-13）', () => {
  it('被拒后模型可在同一轮循环内改对，不消耗 attempt', async () => {
    const violations = [
      {
        rule: 'DEPENDENCY_ON_CONTAINER' as const,
        message: 'scene_01 依赖 chapter',
        agentHint: '请改为引用具体的内容槽位，或删除该依赖。',
        slotIds: ['scene_01'],
      },
    ];
    const h = harness({
      turns: [
        { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
        { submitStructure: VALID_STRUCTURE },
      ],
      completionOutcomes: [
        { ok: false, code: 'STRUCTURE_INVALID', message: '结构未通过校验', violations },
      ],
    });
    const outcome = await h.run({ operation: 'create_structure', targetSlotId: null });

    expect(outcome.kind).toBe('succeeded');
    expect(h.completion.submissions).toHaveLength(2);
    expect(h.trace.kinds('validation_failed')).toHaveLength(1);
    // agentHint（可执行）必须出现在回给模型的工具结果里；message（给人看的）不够
    const toolMessage = h.provider.observations
      .flatMap((o) => o.messages)
      .find((m) => m.role === 'tool' && m.isError);
    expect(toolMessage?.role === 'tool' ? toolMessage.content : '').toContain(
      '请改为引用具体的内容槽位',
    );
  });

  it('被拒且模型放弃 → 报被拒的错误码与违规列表，而不是 ASSIGNMENT_OUTPUT_INVALID', async () => {
    const violations = [
      {
        rule: 'NO_CONTENT_SLOT' as const,
        message: '没有内容槽位',
        agentHint: '请至少添加一个内容类型的槽位。',
        slotIds: [],
      },
    ];
    const h = harness({
      turns: [{ invalidStructure: 'NO_CONTENT_SLOT' }, { emitText: ['我放弃了'] }],
      completionOutcomes: [
        { ok: false, code: 'STRUCTURE_INVALID', message: '结构未通过校验', violations },
      ],
    });
    const outcome = await h.run({ operation: 'create_structure', targetSlotId: null });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('STRUCTURE_INVALID');
    expect(outcome.noSubmission).toBe(false);
    expect(outcome.violations).toEqual(violations);
  });
});

describe('密钥与隐藏推理不外流（REQ §13）', () => {
  it('API Key 不出现在任何 trace / delta / 提交载荷里', async () => {
    const h = harness({
      turns: [
        {
          emitText: ['正文'],
          callTools: [{ name: 'read_task_input', args: {} }],
          submitContent,
        },
      ],
    });
    await h.run();

    const dumped = JSON.stringify({
      records: h.trace.records,
      deltas: h.trace.deltas,
      submissions: h.completion.submissions,
    });
    expect(dumped).not.toContain(API_KEY);
    // 反向验证：这段 dump 确实包含了本次运行的内容，否则上一条断言可能只是因为 dump 是空的
    expect(dumped).toContain('assignment_started');
    expect(dumped).toContain('正文');
  });

  it('ResolvedModel.apiKey 不可枚举，JSON.stringify 带不出来', () => {
    const registry = new ProviderRegistry({
      config: CONFIG,
      env: { FORGE_TEST_KEY: API_KEY },
      adapterFactory: () => new FakeProvider(),
    });
    const resolved = registry.resolve('main');
    expect(resolved.apiKey).toBe(API_KEY); // 读得到
    expect(JSON.stringify(resolved)).not.toContain(API_KEY); // 但漏不出去
    expect(Object.keys(resolved)).not.toContain('apiKey');
  });
});
