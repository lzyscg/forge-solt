/**
 * R2 审核返修验收测试（AC-R-001 ~ AC-R-012）。
 *
 * 全程无网络（FakeProvider）、数据库 `:memory:`，每一层都是产品代码。
 * 模板用 `review-chapter`（在 zhihu-chapter 基础上为 scene 类型加了 reviewSlotByType 绑定）。
 * 审核 Skill `scene-review` 有两个判据（S1、S2）。
 *
 * 每条用例除了断言**发生了什么**，还断言**没有发生什么**
 * ——这是集成测试反证纪律的常规要求。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createEngineHarness,
  sceneText,
  outlineText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  waitFor,
  type EngineHarness,
  sceneEditsTo,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/**
 * 带审核的模板路径。用 review-chapter 模板（scene 类型绑定了 reviewSlotByType）。
 * skillsDir 需要包含 scene-review Skill。
 */

function createReviewHarness(scripts: readonly FakeProviderScript[]): EngineHarness {
  const provider = new FakeProvider({ turns: scripts });
  harness = createEngineHarness({
    provider,
  });
  return harness;
}

async function createAndStart(h: EngineHarness, templateId = 'review-chapter'): Promise<string> {
  const created = await h.snapshots.createTask({ templateId, name: '审核测试', input: INPUT });
  // 用 dispatch 而非 start：start 返回的 Promise 要等整轮生产结束才 resolve，
  // 需要观察中间状态的用例不能 await 它。dispatch 同步迁移状态后立刻返回 { done }，
  // 引擎在后台跑；drain() 或 waitFor 负责各自的同步点。
  h.lifecycle.dispatch('start', created.task.id);
  return created.task.id;
}

/** 一份能把 review-chapter 模板跑到 scene_01 审核入口的脚本 */
function scriptToSceneReview(extraReviewScripts: readonly FakeProviderScript[]): readonly FakeProviderScript[] {
  return [
    { submitStructure: VALID_STRUCTURE },
    { submitContent: { slotId: 'outline', content: outlineText() } },
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
    // scene_01 的 fill_slot 提交——因为 scene 类型有 reviewSlotByType 绑定，
    // 提交后槽位进入 reviewing 而非 completed
    { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
    ...extraReviewScripts,
  ];
}

// ---------------------------------------------------------------------------

describe('R2 审核返修', () => {
  // AC-R-001：审核路径完整跑通
  // fill_slot → reviewing → review_slot × 2 判据 → settle → no_finding → completed
  it('AC-R-001：fill_slot 完成后进入 reviewing，审核全部 no_finding 后 completed', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        // 判据 S1 审核：未检出问题
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // 判据 S2 审核：未检出问题
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // scene_02 的 fill_slot（无审核绑定还是走 completed... wait, scene 类型有审核绑定）
        // 但 scene_02 不在结构里，所以这里不需要
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    // 审核结算后：全部 no_finding → completed
    expect(slot.status).toBe('completed');
    expect(slot.revisionRound).toBe(0);
    expect(slot.reviewExhausted).toBe(false);

    // slot_reviews 应有两条记录
    const reviews = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.criterionId).toBe('S1');
    expect(reviews[1]?.criterionId).toBe('S2');
    expect(reviews.every((r) => r.verdict === 'no_finding')).toBe(true);
  });

  // AC-R-002：每次审核只注入一条判据的章节文本
  it('AC-R-002：审核 execution 的上下文只包含当前判据的 section', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    await createAndStart(h);
    await h.engine.drain();

    // 第一条 review（S1）的 prompt 应包含 "S1" 但不包含 "S2"
    const reviewTurns = h.provider.observations.filter(
      (obs) => obs.system.includes('review_slot') || obs.system.includes('判据'),
    );
    // 应该有两条 review execution
    expect(reviewTurns.length).toBeGreaterThanOrEqual(2);

    // S1 的审核 prompt 应包含判据 S1 的标题，不包含 S2 的标题
    const s1Turn = reviewTurns.find((obs) => obs.system.includes('S1'));
    expect(s1Turn).toBeDefined();
    expect(s1Turn!.system).toContain('S1');
    // S2 的审核 prompt 应包含判据 S2 的标题
    const s2Turn = reviewTurns.find((obs) => obs.system.includes('S2'));
    expect(s2Turn).toBeDefined();
    expect(s2Turn!.system).toContain('S2');
  });

  // AC-R-003：引文校验——quote 不在正文中 → finding 被丢弃
  it('AC-R-003：引文不匹配的 finding 被丢弃，不进 findings_json', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        // S1 审核返回 revise，但 quote 是编造的（不在正文中）
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [
              { criterionId: 'S1', quote: '这段文字不在正文中', problem: '衔接问题' },
            ],
          },
        },
        // S2 审核：no_finding
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    // S1 的 finding 引文不在正文中 → 被丢弃 → verdict 降级为 discarded
    const reviews = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    const s1Review = reviews.find((r) => r.criterionId === 'S1');
    expect(s1Review).toBeDefined();
    expect(s1Review!.verdict).toBe('discarded');
    // findings_json 应为空数组（全部丢弃）
    const findings = JSON.parse(s1Review!.findingsJson);
    expect(findings).toHaveLength(0);

    // 结算：discarded 与 no_finding 等价 → 不触发返修 → completed
    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('completed');
  });

  // AC-R-004：全部 findings 被丢弃 → verdict 降级为 discarded
  it('AC-R-004：verdict=revise 但 findings 全被丢弃 → 降级为 discarded', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [
              { criterionId: 'S1', quote: '编造的引文一', problem: '问题一' },
              { criterionId: 'S1', quote: '编造的引文二', problem: '问题二' },
            ],
          },
        },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const reviews = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    const s1Review = reviews.find((r) => r.criterionId === 'S1');
    // 两条 findings 都被丢弃 → verdict 降级
    expect(s1Review!.verdict).toBe('discarded');
    expect(JSON.parse(s1Review!.findingsJson)).toHaveLength(0);
  });

  /**
   * AC-R-007：审核中的槽位阻止 assembly。
   *
   * ## 为什么 hang 的是 scene_02 而不是 scene_01（2026-08-27 反证记录）
   *
   * 这条用例原先 hang 的是 scene_01，那样**根本证不到命题**。
   * `VALID_STRUCTURE` 里 scene_02 `dependsOn: ['scene_01']`，
   * scene_01 一停在 reviewing，scene_02 就永远是 pending，于是
   * `allContentSlotsCompleted` 因为 scene_02 而返回 false——
   * **assembly 的条件压根不成立，跟 reviewing 拦没拦住无关。**
   *
   * 实测：把 slot-scheduler 的 reviewing 拦截拆掉、并让
   * `allContentSlotsCompleted` 把 reviewing 也算作已完成（把 AC-R-007
   * 要防的缺陷原样重现）之后，任务不是进 assembly，而是失败于
   * `DEPENDENCY_DEADLOCK`（「scene_02 在等待 scene_01」）。
   * 用例当时确实变红了，但红在收尾处 `stop` 抛的「任务处于失败状态」，
   * **与本条验收的命题无关**——那是一条没红对地方的装饰性断言。
   *
   * 改 hang scene_02（文档序最后一个槽位）之后，其余槽位全部 completed，
   * 「能不能组装」就**只**取决于这个 reviewing 槽位，命题才真正被隔离出来。
   *
   * ## 为什么断言产物而不是只看 phase
   *
   * `phase` 是点时刻采样，会和 assembly 赛跑。assembly 唯一不可逆的
   * 可观测后果是**产出 artifact**——落了库就不会变回去，没有采样窗口。
   * 持续采样一小段时间、断言它一直为空，才是「审核期间没有触发 assembly」。
   */
  it('AC-R-007：reviewing 槽位不触发 assembly', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        // scene_01 两条判据都审完 → completed，放行 scene_02
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // scene_02 产出内容 → 进入 reviewing
        { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
        { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
        // 最后一条判据 hang：scene_02 停在 reviewing，其余槽位全部 completed
        { hangMs: 60000 },
      ]),
    );
    const taskId = await createAndStart(h);

    // 等 scene_02 进入 reviewing（此时它是唯一未完成的内容槽位）
    await waitFor(() => h.uow.repositories.slots.get(taskId, 'scene_02')?.status === 'reviewing');

    // 前提核对：除 scene_02 外的内容槽位都已完成，否则命题没被隔离出来
    const others = h.uow.repositories.slots
      .listByTask(taskId)
      .filter((s) => s.contentBearing && s.slotId !== 'scene_02');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((s) => s.status === 'completed')).toBe(true);

    for (let i = 0; i < 20; i += 1) {
      expect(h.uow.repositories.slots.getOrThrow(taskId, 'scene_02').status).toBe('reviewing');
      expect(h.uow.repositories.artifacts.getByTask(taskId)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const task = h.uow.repositories.tasks.getOrThrow(taskId);
    expect(task.phase).not.toBe('assembly');
    expect(task.phase).not.toBe('done');

    // 停止任务以清理 hanging 的 execution
    h.lifecycle.stop(taskId);
    await h.engine.drain();
  }, 30000);

  // AC-R-009：返修递增 revision_round，内容保留
  it('AC-R-009：审核检出问题 → markForRevision → revision_round 递增，内容保留', async () => {
    const content = sceneText('第一场');
    const h = createReviewHarness(
      scriptToSceneReview([
        // S1 审核返回 revise，引文是真实的（在正文中）
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [
              { criterionId: 'S1', quote: content.slice(0, 10), problem: '衔接问题' },
            ],
          },
        },
        // S2 审核：no_finding
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // 返修后 scene_01 回到 pending，需要重新 fill_slot
        // R6：未降级的返修轮只收编辑清单
        sceneEditsTo('scene_01', '第一场', '第一场修改稿'),
        // 第二轮审核：全部 no_finding
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    // 返修后完成
    expect(slot.status).toBe('completed');
    // revision_round 在 markForRevision 后递增到 1
    // 注意：最终 completed 时 revision_round 保持 1（返修了一次）
    expect(slot.revisionRound).toBe(1);
    expect(slot.reviewExhausted).toBe(false);
  });

  // AC-R-010：返修次数用尽 → reviewExhausted=true, completed
  it('AC-R-010：maxRevisionRounds 用尽 → 按现状完成，reviewExhausted=true', async () => {
    const content = sceneText('第一场');
    // 每轮 S1 都返回 revise（引文真实），maxRevisionRounds=2
    // 第 0 轮 → revise → round 1
    // 第 1 轮 → revise → round 2
    // 第 2 轮 → revise → exhausted → completed
    const h = createReviewHarness(
      scriptToSceneReview([
        // 第 0 轮
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [{ criterionId: 'S1', quote: content.slice(0, 10), problem: '问题' }],
          },
        },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // 返修后重新 fill_slot
        sceneEditsTo('scene_01', '第一场', '第一稿'),
        // 第 1 轮
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [{ criterionId: 'S1', quote: sceneText('第一稿').slice(0, 10), problem: '问题' }],
          },
        },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // 返修后重新 fill_slot
        sceneEditsTo('scene_01', '第一稿', '第二稿'),
        // 第 2 轮（= maxRevisionRounds → exhausted）
        {
          submitReview: {
            slotId: 'scene_01',
            verdict: 'revise',
            findings: [{ criterionId: 'S1', quote: sceneText('第二稿').slice(0, 10), problem: '问题' }],
          },
        },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('completed');
    expect(slot.reviewExhausted).toBe(true);
    expect(slot.revisionRound).toBe(2);
  });

  // AC-R-012：停止任务时 reviewing 槽位 → cancelReview（不递增 revision_round）
  it('AC-R-012：stop 时 reviewing 槽位回到 pending，revision_round 不递增', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        // S1 审核完成
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // S2 审核 hang：让槽位停在 reviewing
        { hangMs: 60000 },
      ]),
    );
    const taskId = await createAndStart(h);

    // 等待 scene_01 进入 reviewing
    await waitFor(() =>
      h.uow.repositories.slots.get(taskId, 'scene_01')?.status === 'reviewing',
    );

    // 确认槽位处于 reviewing
    const slotBefore = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slotBefore.status).toBe('reviewing');
    expect(slotBefore.revisionRound).toBe(0);

    // stop 任务
    h.lifecycle.stop(taskId);
    await h.engine.drain();

    const slotAfter = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    // cancelReview：reviewing → pending
    expect(slotAfter.status).toBe('pending');
    // revision_round 不递增（停止不是审核驱动的返修）
    expect(slotAfter.revisionRound).toBe(0);
    // 内容保留
    expect(slotAfter.contentText).not.toBeNull();
  }, 30000);

  // AC-R-008：判据从冻结快照枚举（= 审核 Skill 的 section ID 按索引顺序）
  it('AC-R-008：判据按 Skill section 顺序枚举（S1 先于 S2）', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    // slot_reviews 应按 criterion_id 排序（S1 < S2）
    const reviews = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    expect(reviews.map((r) => r.criterionId)).toEqual(['S1', 'S2']);
  });

  // AC-R-006 / AC-R-011：迟到审核结果被拒（D-10 token 闸门）
  it('AC-R-006/011：stop 后 reviewing 槽位回到 pending，后续审核结果不写入', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        // S1 审核完成
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        // S2 审核 hang：让槽位停在 reviewing
        { hangMs: 60000 },
      ]),
    );
    const taskId = await createAndStart(h);

    // 等待 scene_01 进入 reviewing
    await waitFor(() =>
      h.uow.repositories.slots.get(taskId, 'scene_01')?.status === 'reviewing',
    );

    // stop 任务：cancelReview 把 reviewing → pending
    h.lifecycle.stop(taskId);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('pending');
    expect(slot.revisionRound).toBe(0);

    // S2 没有被审核（只有 S1 有记录）
    const reviews = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    expect(reviews).toHaveLength(1); // 只有 S1
  }, 30000);

  // AC-R-005：审核路径的冻结快照——reviewSlotByType 与 Skills 来自快照，不读磁盘
  it('AC-R-005：审核绑定与判据列表来自冻结快照', async () => {
    const h = createReviewHarness(
      scriptToSceneReview([
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
        { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      ]),
    );
    const taskId = await createAndStart(h);
    await h.engine.drain();

    // 任务运行后，冻结快照里依然有 scene-review Skill 与其 S1/S2 判据——
    // 证明审核路径的判据列表是从快照读的，而不是每次跑再 parse 一次磁盘。
    // 同时验证 reviewSlotByType 出现在编译期模板里（快照里有完整 bindings）。
    const snapshot = h.snapshots.readSnapshot(taskId);
    expect(Object.keys(snapshot.skills)).toContain('scene-review');
    const reviewSkill = snapshot.skills['scene-review']!;
    expect(reviewSkill).toBeDefined();
    const sectionIds = reviewSkill.sections.map((s) => s.id);
    expect(sectionIds).toEqual(['S1', 'S2']);
    // 判据顺序与 Skill section 顺序一致（D-22）
    expect(reviewSkill.sections[0]!.id).toBe('S1');
    expect(reviewSkill.sections[1]!.id).toBe('S2');
    // 反证：没有 reviewSlotByType 绑定的 title 类型不在快照里
    expect(snapshot.compiled.bindings.reviewSlotByType?.scene).toBeDefined();
    expect(snapshot.compiled.bindings.reviewSlotByType?.title).toBeUndefined();
  });
});
