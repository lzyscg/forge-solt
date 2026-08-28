/**
 * `deriveSlotFlow` 的用例。
 *
 * 这层是纯投影，最容易写出「看起来对」的测试：造一条顺风数据，断言轮数等于 2，绿了。
 * 但这个函数的全部难点都在**不顺**的形状上——失败的执行没有 slot_reviews 行、
 * 填槽自身会重试、结算事件不属于任何一次 execution。所以下面每一组用例都对着
 * `production-flow.ts` 文件头那两条推导规则，且大多带一条「按错误规则会得出什么」
 * 的反面断言。
 */

import { describe, expect, it } from 'vitest';
import type { Execution } from './types.ts';
import {
  deriveSlotFlow,
  type FlowCriterion,
  type FlowReviewRecord,
  type FlowSettlement,
} from './production-flow.ts';

const CRITERIA: readonly FlowCriterion[] = [
  { id: 'S1', title: '首段需衔接前一场景的结尾状态' },
  { id: 'S2', title: '通过可见行动推进' },
  { id: 'S3', title: '不与骨架撞设定' },
  { id: 'S4', title: '「停在哪里」必须兑现' },
];

let seq = 0;

/**
 * 造一条 execution。
 *
 * `attemptNumber` 不给默认自增值而是必填：这个函数的排序完全靠它，
 * 让每条用例把顺序**显式写出来**，才能在读测试时看出「第 3 次尝试是审核不是填槽」。
 */
function exec(attemptNumber: number, patch: Partial<Execution> = {}): Execution {
  seq += 1;
  return {
    id: `e${String(seq)}`,
    taskId: 't1',
    operation: 'fill_slot',
    targetSlotId: 'scene_01',
    agentId: 'a',
    skillId: 's',
    skillVersion: '1.0.0',
    tokenHash: 'h',
    contextHash: 'ch',
    promptHash: 'ph',
    modelAlias: 'writer',
    provider: 'p',
    model: 'm',
    attemptNumber,
    status: 'succeeded',
    inputTokens: 100,
    outputTokens: 10,
    startedAt: '2026-08-27T10:00:00.000Z',
    finishedAt: '2026-08-27T10:00:12.500Z',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-27T10:00:00.000Z',
    ...patch,
  };
}

function review(attemptNumber: number, patch: Partial<Execution> = {}): Execution {
  return exec(attemptNumber, { operation: 'review_slot', ...patch });
}

function record(
  executionId: string,
  criterionId: string,
  findings: { quote: string; problem: string }[] = [],
): FlowReviewRecord {
  return {
    criterionId,
    executionId,
    verdict: findings.length > 0 ? 'revise' : 'no_finding',
    findings,
  };
}

function settlement(round: number, kind: FlowSettlement['kind']): FlowSettlement {
  return { round, kind, title: kind, summary: '', createdAt: '2026-08-27T10:05:00.000Z' };
}

/** 只给必填项的调用壳，让每条用例只写它关心的那一两个字段 */
function derive(input: {
  executions: readonly Execution[];
  reviews?: readonly FlowReviewRecord[];
  criteria?: readonly FlowCriterion[];
  settlements?: readonly FlowSettlement[];
}) {
  return deriveSlotFlow({
    slotId: 'scene_01',
    executions: input.executions,
    reviews: input.reviews ?? [],
    criteria: input.criteria ?? CRITERIA,
    settlements: input.settlements ?? [],
  });
}

describe('deriveSlotFlow', () => {
  describe('取数与排序', () => {
    it('只收本槽位的执行，别的槽位与结构执行都不进来', () => {
      const flow = derive({
        executions: [
          exec(1),
          exec(1, { targetSlotId: 'scene_02' }),
          exec(1, { targetSlotId: null, operation: 'create_structure' }),
        ],
      });
      expect(flow.calls).toBe(1);
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.fills).toHaveLength(1);
    });

    /*
     * 顺序取自 attempt_number 而不是 created_at。
     *
     * 两条理由，缺一条这个断言都立不住：
     * 1. `executions.listByTask` 是 `ORDER BY created_at DESC`——**倒序**。
     *    直接拿它的结果折轮次，第一条会是最后一次尝试，整张图前后颠倒。
     * 2. attempt_number 由 `latestAttempt` 取全槽位（跨 operation）的 MAX 再 +1，
     *    并有 UNIQUE 约束兜底，是库层唯一强制单调的序列；created_at 只是时间戳，
     *    同一毫秒内的两条谁先谁后没有任何保证。
     */
    it('按 attemptNumber 升序折，不依赖入参顺序', () => {
      const first = exec(1);
      const second = review(2);
      const flow = derive({
        executions: [second, first], // 入参故意倒着给，模拟 listByTask 的 DESC
        reviews: [record(second.id, 'S1')],
      });
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.fills.map((f) => f.executionId)).toEqual([first.id]);
      expect(flow.rounds[0]?.reviews.map((r) => r.executionId)).toEqual([second.id]);
    });

    it('token 求和把 null 当 0，不让一条没记账的执行把总数变成 NaN', () => {
      const flow = derive({
        executions: [
          exec(1, { inputTokens: 3123, outputTokens: 1105 }),
          exec(2, { inputTokens: null, outputTokens: null }),
        ],
      });
      expect(flow.inputTokens).toBe(3123);
      expect(flow.outputTokens).toBe(1105);
      expect(flow.calls).toBe(2);
    });
  });

  describe('耗时', () => {
    it('起止都有就是差值', () => {
      const flow = derive({ executions: [exec(1)] });
      expect(flow.rounds[0]?.fills[0]?.durationMs).toBe(12500);
    });

    // 运行中的执行给 null 而不是「现在 - startedAt」：domain 不读时钟（AC-013 确定性）。
    // 要显示「已耗时 8s」是调用方的事，那一层有 now 可注入。
    it('还在跑（无 finishedAt）给 null，不去读时钟', () => {
      const flow = derive({ executions: [exec(1, { status: 'running', finishedAt: null })] });
      expect(flow.rounds[0]?.fills[0]?.durationMs).toBeNull();
    });

    it('还没开始（无 startedAt）给 null', () => {
      const flow = derive({
        executions: [exec(1, { status: 'created', startedAt: null, finishedAt: null })],
      });
      expect(flow.rounds[0]?.fills[0]?.durationMs).toBeNull();
    });
  });

  describe('切轮（规则 1）', () => {
    it('一次填槽 + 一次审核 = 一轮', () => {
      const fill = exec(1);
      const rev = review(2);
      const flow = derive({ executions: [fill, rev], reviews: [record(rev.id, 'S1')] });
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.round).toBe(0);
    });

    it('审核之后再出现填槽 = 返修，开新一轮', () => {
      const r1Fill = exec(1);
      const r1Rev = review(2);
      const r2Fill = exec(3);
      const flow = derive({
        executions: [r1Fill, r1Rev, r2Fill],
        reviews: [record(r1Rev.id, 'S1', [{ quote: '引', problem: '问题' }])],
      });
      expect(flow.rounds).toHaveLength(2);
      expect(flow.rounds[0]?.fills.map((f) => f.executionId)).toEqual([r1Fill.id]);
      expect(flow.rounds[1]?.fills.map((f) => f.executionId)).toEqual([r2Fill.id]);
      expect(flow.rounds[1]?.round).toBe(1);
    });

    /*
     * 这条是规则 1 后半句的存在理由，也是我第一版写错的地方。
     *
     * 填槽自身失败（超时、没调提交工具）会作为**新的 execution** 重试，于是槽位上出现
     * 连续两次 fill_slot。按「遇 fill 即开新轮」会切出两轮，而第一轮里一条审核都没有——
     * 界面上凭空多一轮「审核 0 次」，读的人只能理解成「这一轮审核被跳过了」。
     */
    it('填槽失败重试：连续两次 fill 仍属同一轮，不许切出空轮', () => {
      const failed = exec(1, { status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: '超时' });
      const retried = exec(2);
      const rev = review(3);
      const flow = derive({
        executions: [failed, retried, rev],
        reviews: [record(rev.id, 'S1')],
      });
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.fills.map((f) => f.executionId)).toEqual([failed.id, retried.id]);
      // 反面：按错误规则会是 2 轮，且第 0 轮 reviews 为空
      expect(flow.rounds.filter((r) => r.reviews.length === 0)).toHaveLength(0);
    });

    it('失败的填槽把错误码带进节点，界面才画得出失败', () => {
      const failed = exec(1, {
        status: 'failed',
        errorCode: 'ASSIGNMENT_OUTPUT_INVALID',
        errorMessage: 'Agent 未通过 complete_assignment 提交结果',
      });
      const node = derive({ executions: [failed] }).rounds[0]?.fills[0];
      expect(node?.status).toBe('failed');
      expect(node?.errorCode).toBe('ASSIGNMENT_OUTPUT_INVALID');
      expect(node?.errorMessage).toBe('Agent 未通过 complete_assignment 提交结果');
    });

    // 槽位刚进 reviewing、填槽已完成但一条判据都还没跑完时的形状。
    it('只有审核没有填槽也能成轮（不该抛，也不该丢）', () => {
      const rev = review(5);
      const flow = derive({ executions: [rev], reviews: [record(rev.id, 'S1')] });
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.fills).toHaveLength(0);
      expect(flow.rounds[0]?.reviews).toHaveLength(1);
    });

    it('一条执行都没有时返回空流程，不是抛错', () => {
      const flow = derive({ executions: [] });
      expect(flow.rounds).toEqual([]);
      expect(flow.calls).toBe(0);
      expect(flow.ending).toBeNull();
    });
  });

  describe('判据归属（规则 2）', () => {
    it('有 slot_reviews 行时按库里的事实取，不标推断', () => {
      const rev = review(2);
      const node = derive({
        executions: [exec(1), rev],
        reviews: [record(rev.id, 'S2', [{ quote: '他知道。', problem: '心理解释' }])],
      }).rounds[0]?.reviews[0];

      expect(node?.criterionId).toBe('S2');
      expect(node?.criterionTitle).toBe('通过可见行动推进');
      expect(node?.criterionInferred).toBe(false);
      expect(node?.verdict).toBe('revise');
      expect(node?.findings).toEqual([{ quote: '他知道。', problem: '心理解释' }]);
    });

    /*
     * 失败的审核执行**在库里查无判据**：`executions` 没有 criterion_id 列，
     * `settleReview` 也只在有裁决时才插 slot_reviews 行。
     *
     * 于是它的判据只能推：指针只被「有行的那些」推进，失败的那次沿用当前值——
     * 因为 `findNextCriterion` 找的是「本轮还没有 slot_reviews 行」的第一条判据，
     * 失败没写行，所以引擎下一次派发的还是同一条。这条用例把这个推导钉死；
     * `criterionInferred: true` 是给界面的标记，让它别把推测当事实展示。
     */
    it('失败的审核执行：判据靠指针推，指针不因它前移', () => {
      const fill = exec(1);
      const ok1 = review(2);
      const fail1 = review(3, {
        status: 'failed',
        errorCode: 'ASSIGNMENT_OUTPUT_INVALID',
        errorMessage: 'Agent 未通过 complete_assignment 提交结果',
      });
      /*
       * **必须连着失败两次**，一次证不了任何事。
       *
       * 只失败一次时，「指针不前移」与「指针照常前移」给出的结果完全相同：
       * 成功的那些判据 ID 取自 slot_reviews（库里的事实压过推断），
       * 而唯一被推断的那一条恰好落在两种算法的交点上。
       * 我第一版就是只写了一次失败——把产品里的 `if (record !== undefined)`
       * 删掉，测试照样全绿。第二次失败才让两条算法分叉：
       * 正确的仍推 S2，错误的会推到 S3 上去。
       */
      const fail2 = review(4, {
        status: 'failed',
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: '超时',
      });
      const ok2 = review(5);

      const nodes = derive({
        executions: [fill, ok1, fail1, fail2, ok2],
        // 两次失败都没有行；重试成功的 ok2 拿到的仍然是 S2
        reviews: [record(ok1.id, 'S1'), record(ok2.id, 'S2')],
      }).rounds[0]?.reviews;

      expect(nodes?.map((n) => n.criterionId)).toEqual(['S1', 'S2', 'S2', 'S2']);
      expect(nodes?.map((n) => n.criterionInferred)).toEqual([false, true, true, false]);
      // 失败那条没有裁决，也没有 findings——它既不是「检出」也不是「未检出」
      expect(nodes?.[1]?.verdict).toBeNull();
      expect(nodes?.[1]?.findings).toEqual([]);
    });

    /*
     * 指针越界：本轮已有 4 条判据都写了行，却还有第 5 次审核执行没有行
     * （只会在数据损坏或引擎改了派发规则时发生）。
     * 给空串而不是崩——投影层因为数据缺一角就抛，代价是整个右栏打不开。
     */
    it('指针越界时给空判据 ID，不抛', () => {
      const fill = exec(1);
      const done = CRITERIA.map((_, i) => review(i + 2));
      const orphan = review(6, { status: 'failed', errorCode: 'PROVIDER_ERROR', errorMessage: 'x' });
      const nodes = derive({
        executions: [fill, ...done, orphan],
        reviews: done.map((e, i) => record(e.id, CRITERIA[i]?.id ?? '')),
      }).rounds[0]?.reviews;

      expect(nodes).toHaveLength(5);
      expect(nodes?.[4]?.criterionId).toBe('');
      expect(nodes?.[4]?.criterionTitle).toBeNull();
      expect(nodes?.[4]?.criterionInferred).toBe(true);
    });

    // 判据表来自任务冻结的快照，而 slot_reviews 是历史行。改了 SKILL.md 之后
    // 重跑同一任务不会发生，但快照与行不一致时标题必须给 null 而不是编一个。
    it('库里的判据 ID 不在判据表里时，标题给 null', () => {
      const rev = review(2);
      const node = derive({
        executions: [exec(1), rev],
        reviews: [record(rev.id, 'S9')],
      }).rounds[0]?.reviews[0];
      expect(node?.criterionId).toBe('S9');
      expect(node?.criterionTitle).toBeNull();
    });

    it('判据表为空（该槽位类型没绑审核）时不崩', () => {
      const flow = derive({ executions: [exec(1)], criteria: [] });
      expect(flow.rounds).toHaveLength(1);
      expect(flow.rounds[0]?.reviews).toHaveLength(0);
    });
  });

  describe('检出 / 未检出计数（D-30）', () => {
    it('检出的按条计，未检出的按条计', () => {
      const fill = exec(1);
      const revs = CRITERIA.map((_, i) => review(i + 2));
      const round = derive({
        executions: [fill, ...revs],
        reviews: [
          record(revs[0]?.id ?? '', 'S1', [{ quote: 'a', problem: 'x' }]),
          record(revs[1]?.id ?? '', 'S2', [{ quote: 'b', problem: 'y' }, { quote: 'c', problem: 'z' }]),
          record(revs[2]?.id ?? '', 'S3'),
          record(revs[3]?.id ?? '', 'S4'),
        ],
      }).rounds[0];

      // firedCount 数的是**判据条数**不是 findings 条数：S2 报了 2 处仍算 1 条判据
      expect(round?.firedCount).toBe(2);
      expect(round?.cleanCount).toBe(2);
    });

    /*
     * 失败的执行既不进 firedCount 也不进 cleanCount。
     *
     * 把它并进 cleanCount 是最省事的写法（`findings.length === 0` 一句话），
     * 也是最坏的写法：界面上的摘要行会写成「另 3 条未检出」，而其中一条
     * 根本没有裁决——那是在对着一次失败的调用说「这条判据看过了，没问题」。
     * D-30 管的正是这种「措辞比事实更漂亮」。
     */
    it('失败的审核执行不算未检出，也不算检出', () => {
      const fill = exec(1);
      const ok = review(2);
      const failed = review(3, { status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: '超时' });
      const round = derive({
        executions: [fill, ok, failed],
        reviews: [record(ok.id, 'S1')],
      }).rounds[0];

      expect(round?.reviews).toHaveLength(2);
      expect(round?.cleanCount).toBe(1); // 不是 2
      expect(round?.firedCount).toBe(0);
    });
  });

  describe('结算与收口', () => {
    /*
     * 结算按自己的 round 归位，不按在数组里的位置。
     *
     * 入参故意倒着给：调用方要从几百条轨迹里筛出这几条，能保证的只有
     * 「事件都在」，保证不了「顺序对」。按位置对的写法在这条用例下会把
     * 「进入返修」贴到最后一轮上——界面会显示成「跑完还要再返修」。
     */
    it('结算按 round 归位，与入参顺序无关', () => {
      const flow = derive({
        executions: [exec(1), review(2), exec(3), review(4)],
        settlements: [settlement(1, 'review_no_finding'), settlement(0, 'review_revise')],
      });
      expect(flow.rounds[0]?.settlement?.kind).toBe('review_revise');
      expect(flow.rounds[1]?.settlement?.kind).toBe('review_no_finding');
    });

    it('还在跑的那一轮没有结算，给 null 而不是借上一轮的', () => {
      const flow = derive({
        executions: [exec(1), review(2), exec(3)],
        settlements: [settlement(0, 'review_revise')],
      });
      expect(flow.rounds[1]?.settlement).toBeNull();
    });

    it('轮号最大的那条是终态时给 ending', () => {
      const flow = derive({
        executions: [exec(1), review(2), exec(3), review(4)],
        settlements: [settlement(1, 'review_no_finding'), settlement(0, 'review_revise')],
      });
      expect(flow.ending?.kind).toBe('review_no_finding');
    });

    it('返修预算耗尽也是终态（D-26：任务永不因审核卡死）', () => {
      const flow = derive({
        executions: [exec(1), review(2)],
        settlements: [settlement(0, 'revision_budget_exhausted')],
      });
      expect(flow.ending?.kind).toBe('revision_budget_exhausted');
    });

    // 「进入返修」不是收口：它后面还有下一稿。把它当 ending 会让界面在
    // 槽位还在生产时就画出终点。
    it('最新一条是 review_revise 时 ending 为 null——那不是终点', () => {
      const flow = derive({
        executions: [exec(1), review(2), exec(3)],
        settlements: [settlement(0, 'review_revise')],
      });
      expect(flow.ending).toBeNull();
    });

    it('一条结算都没有时 ending 为 null', () => {
      const flow = derive({ executions: [exec(1)] });
      expect(flow.ending).toBeNull();
    });
  });
});
