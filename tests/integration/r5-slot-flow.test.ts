/**
 * 生产流程读接口（`GET /api/tasks/:id/slots/:slotId/flow`）的验收。
 *
 * `production-flow.test.ts` 已经用手造的输入把折轮规则钉死了。这里要答的是另一个问题：
 * **真跑一遍，喂给那个纯函数的东西对不对**。三处最容易接错、且单测永远发现不了：
 *
 * 1. 判据表要从**任务冻结的快照**解，不是从磁盘上的 SKILL.md 现读；
 * 2. 结算事件的归属要同时看 `executionId IS NULL` 与 `payload.slotId`——
 *    `review_no_finding` 这个 kind 被用了两次，只按 kind 筛会把逐条判据的结果
 *    也当成结算；
 * 3. 失败的审核执行在 `slot_reviews` 里没有行，必须仍然出现在流程里。
 *
 * 全程无网络（FakeProvider）、库在内存里，其余每一层都是产品代码。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createEngineHarness,
  sceneText,
  outlineText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  type EngineHarness,
  sceneEditsTo,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

/** 必须是 sceneText 里的**逐字**片段，否则会被 D-11 的引文闸门丢掉 */
const QUOTE = '她推开门，雨声灌了进来。';

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function createHarness(reviews: readonly FakeProviderScript[]): EngineHarness {
  harness = createEngineHarness({
    provider: new FakeProvider({
      turns: [
        { submitStructure: VALID_STRUCTURE },
        { submitContent: { slotId: 'outline', content: outlineText() } },
        { submitContent: { slotId: 'title', content: TITLE_TEXT } },
        { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
        ...reviews,
      ],
    }),
  });
  return harness;
}

async function run(h: EngineHarness): Promise<string> {
  const created = await h.snapshots.createTask({
    templateId: 'review-chapter',
    name: '流程视图',
    input: INPUT,
  });
  h.lifecycle.dispatch('start', created.task.id);
  await h.engine.drain();
  return created.task.id;
}

const clean = { submitReview: { slotId: 'scene_01', verdict: 'no_finding' as const } };
const fired = {
  submitReview: {
    slotId: 'scene_01',
    verdict: 'revise' as const,
    findings: [{ criterionId: 'S2', quote: QUOTE, problem: '心理解释代替了可见行动' }],
  },
};

describe('槽位生产流程读接口', () => {
  it('一稿即过：一轮、判据表来自冻结快照、收口是「未检出问题」', async () => {
    const h = createHarness([clean, clean]);
    const taskId = await run(h);

    const flow = h.tasks.getSlotFlow(taskId, 'scene_01');

    // 判据表：fixture 的 scene-review 有 S1、S2 两条，顺序即书写顺序。
    // 条数不写死在产品里——r5-criteria-scale 那条测试用 10 条判据证过同一件事。
    expect(flow.criteria).toEqual([
      { id: 'S1', title: expect.any(String) },
      { id: 'S2', title: expect.any(String) },
    ]);
    expect(flow.criteria[0]?.title).not.toBe('');

    expect(flow.rounds).toHaveLength(1);
    const round = flow.rounds[0];
    expect(round?.fills).toHaveLength(1);
    expect(round?.reviews.map((r) => r.criterionId)).toEqual(['S1', 'S2']);
    expect(round?.firedCount).toBe(0);
    expect(round?.cleanCount).toBe(2);

    // 判据全名从快照解出来，不是前端拿 ID 拼的
    expect(round?.reviews[0]?.criterionTitle).toBe(flow.criteria[0]?.title);
    expect(round?.reviews.every((r) => !r.criterionInferred)).toBe(true);

    // 收口。措辞由 trace 的 title 决定，这里连同 D-30 一起钉：不得出现「通过」
    expect(flow.ending?.kind).toBe('review_no_finding');
    expect(flow.ending?.round).toBe(0);
    expect(flow.ending?.title).not.toContain('通过');

    expect(flow.rounds.filter((r) => r.settlement !== null)).toHaveLength(1);
  });

  /*
   * 这条钉的是 `listSettlements` 里 `execution_id IS NULL` 那半个条件。
   *
   * 它单独成一条用例、且断言直接打在仓储上，是因为**从流程视图那一头断言不出来**：
   * 逐条判据的 trace 恰好没有 `revisionRound` 这个键，于是即使把过滤条件拆掉，
   * 它们也会在 `settlementsOf` 里被「读不出轮号就跳过」顺手滤掉，流程视图照样正确。
   * 我第一版就是在流程视图上写反证的，改坏产品代码，测试全绿——
   * 绿的原因与被测的保护毫无关系。
   *
   * 换句话说：现在有两道防线，而只有靠后那道在真正起作用。
   * 前面这道防的是「以后有人往逐条判据的 payload 里加了 revisionRound」，
   * 那一天到来时，得有东西在这里红。
   */
  it('结算事件的识别同时要 kind 与 executionId IS NULL', async () => {
    const h = createHarness([clean, clean]);
    const taskId = await run(h);

    const settlements = h.uow.repositories.traces.listSettlements(taskId);
    const sameKind = h.uow.repositories.traces
      .listByTask(taskId, { limit: 1000 })
      .filter((event) => event.kind === 'review_no_finding');

    // 同一个 kind 在库里出现了 3 次：2 条逐条判据的结果 + 1 条整轮结算
    expect(sameKind).toHaveLength(3);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.executionId).toBeNull();
  });

  it('检出问题走返修：两轮，findings 带逐字引文，第 1 轮结算是「进入返修」', async () => {
    const h = createHarness([
      clean, // 第 0 轮 S1
      fired, // 第 0 轮 S2 → 检出
      sceneEditsTo('scene_01', '第一场', '第一场改'), // 第 2 稿（R6：返修轮走编辑清单）
      clean, // 第 1 轮 S1
      clean, // 第 1 轮 S2
    ]);
    const taskId = await run(h);

    const flow = h.tasks.getSlotFlow(taskId, 'scene_01');

    expect(flow.rounds).toHaveLength(2);
    expect(flow.rounds[0]?.firedCount).toBe(1);
    expect(flow.rounds[0]?.cleanCount).toBe(1);
    expect(flow.rounds[0]?.settlement?.kind).toBe('review_revise');

    // 引文必须是原文里真有的那一句：通不过 D-11 的引文校验就不会落库，
    // 这条断言同时守着「界面上引的是正文里的话，不是模型编的」
    const finding = flow.rounds[0]?.reviews.find((r) => r.findings.length > 0)?.findings[0];
    expect(finding?.quote).toBe(QUOTE);
    expect(finding?.problem).toBe('心理解释代替了可见行动');

    // 第 2 稿是新一轮的填槽，不是第 1 轮的重试
    expect(flow.rounds[1]?.fills).toHaveLength(1);
    expect(flow.rounds[1]?.round).toBe(1);
    expect(flow.rounds[1]?.firedCount).toBe(0);

    expect(flow.ending?.kind).toBe('review_no_finding');
    expect(flow.ending?.round).toBe(1);

    // 两稿两轮审核，调用次数是实打实的 6 次；token 从 execution 上求和
    expect(flow.calls).toBe(6);
    expect(flow.inputTokens).toBeGreaterThan(0);
  });

  /*
   * 失败的审核执行必须留在图上。
   *
   * 它在 `slot_reviews` 里没有行（`settleReview` 只在有裁决时插行），
   * 任何「join slot_reviews 拿判据」的实现都会让它凭空消失——而它恰恰是
   * 最该被看见的一次：产出丢了，token 照样计费。
   */
  it('审核执行失败：节点仍在流程里，判据靠推断，且不算进「未检出」', async () => {
    const h = createHarness([
      clean, // S1
      { neverSubmit: true }, // S2 第一次：只说话不提交 → 执行失败
      clean, // S2 重试
    ]);
    const taskId = await run(h);

    const flow = h.tasks.getSlotFlow(taskId, 'scene_01');
    const round = flow.rounds[0];

    expect(round?.reviews).toHaveLength(3);

    const failedNode = round?.reviews.find((r) => r.status === 'failed');
    expect(failedNode).toBeDefined();
    expect(failedNode?.verdict).toBeNull();
    expect(failedNode?.error).not.toBeNull();
    // 库里查不到它的判据，只能按派发指针推——界面据此不把推测当事实展示
    expect(failedNode?.criterionId).toBe('S2');
    expect(failedNode?.criterionInferred).toBe(true);

    // 失败那次既不算检出也不算未检出：并进 cleanCount 就等于在界面上说
    // 「这条判据看过了，没问题」，而它连裁决都没有（D-30）
    expect(round?.cleanCount).toBe(2);
    expect(round?.firedCount).toBe(0);
    // 反面：把失败算进去会是 3
    expect(round?.cleanCount).not.toBe(round?.reviews.length);
  });

  it('任务不存在时不返回空流程，而是 404 语义的错误', async () => {
    const h = createHarness([clean, clean]);
    await run(h);
    expect(() => h.tasks.getSlotFlow('no-such-task', 'scene_01')).toThrowError(/不存在/);
  });

  it('槽位没有审核绑定时判据表为空，流程只有填槽节点', async () => {
    const h = createHarness([clean, clean]);
    const taskId = await run(h);

    // outline 是 chapter_outline 类型，模板没给它 reviewSlotByType 绑定（D-27 合法默认）
    const flow = h.tasks.getSlotFlow(taskId, 'outline');
    expect(flow.criteria).toEqual([]);
    expect(flow.rounds).toHaveLength(1);
    expect(flow.rounds[0]?.reviews).toEqual([]);
    expect(flow.rounds[0]?.fills).toHaveLength(1);
    expect(flow.ending).toBeNull();
  });
});
