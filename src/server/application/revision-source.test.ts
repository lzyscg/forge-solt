/**
 * `collectPriorRounds` 的防御性分支（R3 / D-31）。
 *
 * 主路径由 `tests/integration/r3-context-continuity.test.ts` 走真库覆盖。
 * 这里只钉住那些**在真库里造不出来、但真出现时后果很难查**的输入：
 * 首稿、没有 producer、没有正文、`findings_json` 是坏数据，
 * 以及串起更早轮次用的那一列 `context_json` 坏掉。
 *
 * 这些分支的共同要求是「降级，不抛错」：抛错会把一个本可以继续的返修轮
 * 打成 failed，而代价本该只是少几轮历史。
 */

import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@shared/trace.ts';
import type { Slot } from '@server/domain/types.ts';
import type { SlotReview } from '@server/infrastructure/database/repositories/index.ts';
import { collectPriorRounds, type RevisionSourceRepos } from './revision-source.ts';

function slotOf(overrides: Partial<Slot> = {}): Slot {
  return {
    taskId: 'task_1',
    slotId: 'scene_01',
    type: 'scene',
    parentId: 'chapter',
    sortOrder: 0,
    instruction: '雨夜对峙的开场',
    dependsOn: ['outline'],
    contentBearing: true,
    includeInArtifact: true,
    status: 'pending',
    revisionRound: 1,
    reviewExhausted: false,
    contentText: '上一稿正文',
    producer: {
      agentId: 'chapter_writer',
      skillId: 'scene-writing',
      skillVersion: '1.0.0',
      executionId: 'exec_1',
    },
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function reposOf(
  events: readonly TraceEvent[],
  reviews: readonly SlotReview[],
  contextJson: string | null = null,
): RevisionSourceRepos {
  return {
    traces: { listByExecution: () => [...events] },
    slotReviews: { listByRound: () => [...reviews] },
    executions: { getContextJson: () => contextJson },
  };
}

function reviewOf(findingsJson: string): SlotReview {
  return {
    taskId: 'task_1',
    slotId: 'scene_01',
    round: 0,
    criterionId: 'S1',
    executionId: 'exec_review',
    verdict: 'revise',
    findingsJson,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const EMPTY = reposOf([], []);

describe('collectPriorRounds：不是返修就不装返修段', () => {
  it('首稿（revisionRound = 0）返回空数组', () => {
    expect(collectPriorRounds(EMPTY, slotOf({ revisionRound: 0 }))).toEqual([]);
  });

  it('没有 producer（从未被任何 execution 写过）返回空数组', () => {
    expect(collectPriorRounds(EMPTY, slotOf({ producer: null }))).toEqual([]);
  });

  it('没有正文（上一稿丢了）返回空数组，不装一段「（空）」去误导模型', () => {
    expect(collectPriorRounds(EMPTY, slotOf({ contentText: null }))).toEqual([]);
  });
});

describe('collectPriorRounds：findings_json 是从 TEXT 列读回来的，坏数据不许炸', () => {
  const cases: readonly [string, string][] = [
    ['不是合法 JSON', '{ 这不是 JSON'],
    ['不是数组', '{"criterionId":"S1"}'],
    ['数组里混了非对象', '["S1", null, 42]'],
    ['字段类型不对', '[{"criterionId":1,"quote":"q","problem":"p"}]'],
    ['缺 quote', '[{"criterionId":"S1","problem":"p"}]'],
    ['缺 problem', '[{"criterionId":"S1","quote":"q"}]'],
  ];

  for (const [name, findingsJson] of cases) {
    it(`${name} → findings 为空，且返修仍然照常进行`, () => {
      const rounds = collectPriorRounds(reposOf([], [reviewOf(findingsJson)]), slotOf());
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.findings).toEqual([]);
      // 抛错会把一个本可以继续的返修轮打成 failed——这正是这几条要挡住的事
      expect(rounds[0]!.submittedContent).toBe('上一稿正文');
    });
  }

  it('合法 findings 原样取出', () => {
    const rounds = collectPriorRounds(
      reposOf([], [reviewOf('[{"criterionId":"S1","quote":"引文","problem":"问题"}]')]),
      slotOf(),
    );
    expect(rounds[0]!.findings).toEqual([{ criterionId: 'S1', quote: '引文', problem: '问题' }]);
  });
});

describe('collectPriorRounds：沿 context_json 串起更早的轮次（D-31）', () => {
  const chained = (contextJson: string | null) =>
    collectPriorRounds(reposOf([], [], contextJson), slotOf({ revisionRound: 2 }));

  it('把上一轮 execution 记下的 priorRounds 接在前面，本轮那一份在最后', () => {
    const rounds = chained(
      JSON.stringify({
        revision: {
          round: 1,
          priorRounds: [
            {
              visibleOutput: '第 0 轮说的话',
              readSlotIds: ['outline'],
              submittedContent: '第 0 稿',
              findings: [{ criterionId: 'S1', quote: 'q', problem: '第 0 轮的问题' }],
            },
          ],
        },
      }),
    );
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.submittedContent).toBe('第 0 稿');
    expect(rounds[0]!.findings[0]!.problem).toBe('第 0 轮的问题');
    // 最后一份是「上一轮」，正文取自 slots.content_text
    expect(rounds[1]!.submittedContent).toBe('上一稿正文');
  });

  it('readSlotIds 里的非字符串被过滤，缺字段的整条被跳过', () => {
    const rounds = chained(
      JSON.stringify({
        revision: {
          round: 1,
          priorRounds: [
            { visibleOutput: 'ok', readSlotIds: ['a', 7, null], submittedContent: '稿', findings: [] },
            // 下面这些都不成形，一条都不该进来
            null,
            42,
            { readSlotIds: [], submittedContent: '缺 visibleOutput', findings: [] },
            { visibleOutput: '缺 submittedContent', readSlotIds: [], findings: [] },
          ],
        },
      }),
    );
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.readSlotIds).toEqual(['a']);
    expect(rounds[0]!.findings).toEqual([]);
  });

  it('readSlotIds 不是数组时降级成空数组', () => {
    const rounds = chained(
      JSON.stringify({
        revision: {
          round: 1,
          priorRounds: [{ visibleOutput: 'ok', readSlotIds: 'outline', submittedContent: '稿' }],
        },
      }),
    );
    expect(rounds[0]!.readSlotIds).toEqual([]);
  });

  // 这一列由本系统写入，坏成什么样都不该让一个能继续的返修轮炸掉；
  // 代价是少几轮历史，而不是整个任务 failed。
  const degraded: readonly [string, string | null][] = [
    ['没有 context_json', null],
    ['不是合法 JSON', '{ 坏掉的'],
    ['顶层不是对象', '"just a string"'],
    ['顶层是 null', 'null'],
    ['没有 revision 字段', '{"operation":"fill_slot"}'],
    ['revision 是 null（首稿那一轮）', '{"revision":null}'],
    ['revision 不是对象', '{"revision":"nope"}'],
    ['priorRounds 不是数组', '{"revision":{"round":1,"priorRounds":"nope"}}'],
  ];

  for (const [name, contextJson] of degraded) {
    it(`${name} → 只剩本轮那一份，不抛错`, () => {
      const rounds = chained(contextJson);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.submittedContent).toBe('上一稿正文');
    });
  }
});

describe('collectPriorRounds：从 trace 重建对话轮次与读过的槽位', () => {
  const event = (overrides: Partial<TraceEvent>): TraceEvent => ({
    id: 'trace_1',
    taskId: 'task_1',
    executionId: 'exec_1',
    sequence: 1,
    actor: 'agent',
    kind: 'public_output_chunk',
    title: '公开输出',
    summary: '预览',
    payload: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('公开输出与 report_work 都进上一轮，按 trace 顺序', () => {
    const rounds = collectPriorRounds(
      reposOf(
        [
          event({ sequence: 1, payload: { text: '我先看看骨架。' } }),
          event({ sequence: 2, kind: 'work_plan', title: '工作计划', summary: '先读骨架再写' }),
        ],
        [],
      ),
      slotOf(),
    );
    expect(rounds[0]!.visibleOutput).toBe('我先看看骨架。\n\n工作计划：先读骨架再写');
  });

  it('payload 为空或 text 不是字符串的 chunk 被跳过', () => {
    const rounds = collectPriorRounds(
      reposOf(
        [
          event({ sequence: 1, payload: null }),
          event({ sequence: 2, payload: { text: '' } }),
          event({ sequence: 3, payload: { text: 42 } }),
          event({ sequence: 4, payload: { text: '真的输出' } }),
        ],
        [],
      ),
      slotOf(),
    );
    expect(rounds[0]!.visibleOutput).toBe('真的输出');
  });

  it('只收 read_slot 且 ok 的槽位 ID，重复只记一次', () => {
    const toolEvent = (sequence: number, payload: Record<string, unknown>): TraceEvent =>
      event({ sequence, kind: 'tool_call_completed', actor: 'tool', payload });

    const rounds = collectPriorRounds(
      reposOf(
        [
          toolEvent(1, { toolName: 'read_slot', ok: true, slotId: 'outline' }),
          // 同一个槽位读两次
          toolEvent(2, { toolName: 'read_slot', ok: true, slotId: 'outline' }),
          // 被拒的调用不算「读过」
          toolEvent(3, { toolName: 'read_slot', ok: false, slotId: 'title' }),
          // 别的工具的 slotId 不是「读过依赖」
          toolEvent(4, { toolName: 'complete_assignment', ok: true, slotId: 'scene_01' }),
          // 缺 slotId / slotId 不是字符串 / 没有 payload
          toolEvent(5, { toolName: 'read_slot', ok: true }),
          toolEvent(6, { toolName: 'read_slot', ok: true, slotId: 7 }),
          event({ sequence: 7, kind: 'tool_call_completed', actor: 'tool', payload: null }),
        ],
        [],
      ),
      slotOf(),
    );
    expect(rounds[0]!.readSlotIds).toEqual(['outline']);
  });
});
