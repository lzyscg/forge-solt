/**
 * R5：结构审核（`bindings.reviewStructure` → `skills/structure-review`）的重来回路。
 *
 * 跑的是**仓库里那份生产模板与生产 Skill**（`templates/` + `skills/`），不是
 * `tests/fixtures`：这次改动全落在那两份真文件上，用夹具测等于测 R2 已经证明过的
 * 引擎，而「结构审核到底绑没绑上、判据是不是四条」一个字都验不到。
 *
 * 结构审核与槽位审核共用同一条流水线，但**返修动作完全不同**：槽位返修是重写一段
 * 正文，结构返修是把整棵树换掉。所以下面这四件事各自会以不同的方式坏掉：
 *
 * 1. **重来回路本身**——新树替换旧树，且新根**继承**旧根的轮次。不继承的话
 *    `settleReview` 每次都拿到 0，结构会无限重来（D-26 的收口失效）。
 * 2. **顺序**——结构必须在任何槽位开工**之前**审完。这是这个功能的全部理由：
 *    等场景写完再发现结构错了，写作 token 已经花光了。
 * 3. **上限就是 3**——写在模板里的数字若没生效，只会表现成多花几轮的钱，不报错。
 * 4. **审计线索**——重来只删外键逼着删的那些审核行，同名槽位的历史留着。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createEngineHarness,
  sceneText,
  TITLE_TEXT,
  waitFor,
  type EngineHarness,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

/** 真模板的四条结构判据 */
const CRITERIA = ['S1', 'S2', 'S3', 'S4'];

/**
 * 第 1 版：`scene_02` 的目标没写「停在哪里」，违反 S1。
 *
 * 引文闸门（D-11）要求逐字命中**渲染后的结构概要**，而概要里这段 instruction
 * 原样出现在「目标：」后面。所以下面的 `BAD_GOAL` 可以直接当引文用。
 */
const BAD_GOAL = '让监视的存在从暗处浮出，老周句句闪烁';
const GOOD_GOAL = '让监视的存在从暗处浮出，老周句句闪烁，停在通话被截断、林越盯着听筒的那一刻';

/** 生产模板下的一份合法结构。`title` 依赖全部场景（S3 第 2 条） */
function tree(sceneTwoGoal: string): { rootSlotId: string; slots: unknown[] } {
  return {
    rootSlotId: 'chapter',
    slots: [
      { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '本章容器', dependsOn: [] },
      {
        id: 'title',
        type: 'title',
        parentId: 'chapter',
        order: 0,
        instruction: '概括全章，停在让读者想点开的悬念上',
        dependsOn: ['scene_01', 'scene_02'],
      },
      {
        id: 'scene_01',
        type: 'scene',
        parentId: 'chapter',
        order: 1,
        instruction: '林越冒雨赴约，通过反复确认凭证建立孤注一掷，停在他推门与老周目光相接',
        dependsOn: [],
      },
      {
        id: 'scene_02',
        type: 'scene',
        parentId: 'chapter',
        order: 2,
        instruction: sceneTwoGoal,
        dependsOn: ['scene_01'],
      },
    ],
  };
}

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

const clean = (slotId: string): FakeProviderScript => ({
  submitReview: { slotId, verdict: 'no_finding' as const },
});

/** 一条命中 S1 的检出。quote 必须逐字出现在渲染后的结构概要里 */
const firedOnMissingStop = (): FakeProviderScript => ({
  submitReview: {
    slotId: 'chapter',
    verdict: 'revise' as const,
    findings: [{ criterionId: 'S1', quote: BAD_GOAL, problem: '这条目标没写这一场停在哪里，下一场无从衔接' }],
  },
});

/** 一轮结构审核：四条判据，第 1 条按需检出 */
function structureRound(fired: boolean): FakeProviderScript[] {
  return CRITERIA.map((id) => (fired && id === 'S1' ? firedOnMissingStop() : clean('chapter')));
}

/**
 * 结构审完之后，剩下的槽位一路顺跑到底所需的脚本。
 *
 * 生产顺序是依赖序而不是文档序：`title` 依赖两个场景，所以它最后写。
 * 脚本喂完了引擎不会停，它会把「没有下一条应答」当成执行失败并重试，
 * 任务最终 failed——所以每条用例末尾都断言任务 completed，把这条兜住。
 */
function tailAfterStructure(): FakeProviderScript[] {
  return [
    { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
    ...CRITERIA.map(() => clean('scene_01')),
    { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    ...CRITERIA.map(() => clean('scene_02')),
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
  ];
}

function run(turns: readonly FakeProviderScript[]): EngineHarness {
  harness = createEngineHarness({
    provider: new FakeProvider({ turns: [...turns] }),
    templatesDir: path.join(REPO_ROOT, 'templates'),
    skillsDir: path.join(REPO_ROOT, 'skills'),
  });
  return harness;
}

async function start(h: EngineHarness): Promise<string> {
  const created = await h.snapshots.createTask({
    templateId: 'zhihu-chapter',
    name: '结构审核',
    input: INPUT,
  });
  h.lifecycle.dispatch('start', created.task.id);
  await h.engine.drain();
  return created.task.id;
}

describe('结构审核', () => {
  it('检出缺停点 → 整棵树重来 → 第 2 版干净 → 开始填槽', async () => {
    const h = run([
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      { submitStructure: tree(GOOD_GOAL) },
      ...structureRound(false),
      ...tailAfterStructure(),
    ]);
    const taskId = await start(h);

    const root = h.uow.repositories.slots.getOrThrow(taskId, 'chapter');
    // 轮次继承到了新树的根上。若没继承，这里是 0，而结构会一直有预算重来
    expect(root.revisionRound).toBe(1);
    expect(root.status).toBe('completed');
    expect(root.reviewExhausted).toBe(false);

    // 库里是第 2 版，不是被检出的那一版
    expect(h.uow.repositories.slots.getOrThrow(taskId, 'scene_02').instruction).toBe(GOOD_GOAL);

    /*
     * `slot_reviews` 里**只剩重来那一轮**：整树替换时旧树的槽位没了，
     * 指向它们的审核行必须跟着删（外键不是 DEFERRABLE，
     * 而根在「删光再插回」的两条语句之间确实不存在）。
     */
    const rows = h.uow.repositories.slotReviews.listBySlot(taskId, 'chapter');
    expect(rows.map((r) => r.criterionId)).toEqual(CRITERIA);
    expect(rows.every((r) => r.round === 1 && r.verdict === 'no_finding')).toBe(true);

    /*
     * 而第 0 轮那次检出**没有丢**——它在 trace 里，连引文带问题描述。
     *
     * 这一条是上面那次删除得以成立的全部依据。哪天有人把审核结果改成只写
     * `slot_reviews`（比如觉得 trace 的 payload 太大想瘦身），
     * 结构重来就会变成一次**无痕**的返工：库里看不出重来过，也看不出为什么。
     */
    const traces = h.uow.repositories.traces.listByTask(taskId, { limit: 2000 });
    const fired = traces.find((t) => t.kind === 'review_revise' && t.executionId !== null);
    const findings = fired?.payload?.['findings'] as { quote?: string }[] | undefined;
    expect(findings?.[0]?.quote).toBe(BAD_GOAL);

    expect(h.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
  });

  /*
   * 顺序：结构审完结算之前，一个槽位都不许开工。
   *
   * 这是整个功能的理由。顺序反了的话，场景会照着一棵还没审的树往下写，
   * 等结构被判重来时写作 token 已经花掉了——而那正是「在上游拦住」要省的钱。
   */
  it('结构审完并结算之后，第一个槽位才开工', async () => {
    const h = run([
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      { submitStructure: tree(GOOD_GOAL) },
      ...structureRound(false),
      ...tailAfterStructure(),
    ]);
    const taskId = await start(h);

    const traces = h.uow.repositories.traces.listByTask(taskId, { limit: 2000 });
    // 结构的收口结算：execution_id 为 null，payload.structure 为 true
    const settled = traces.find(
      (t) => t.executionId === null && t.kind === 'review_no_finding' && t.payload?.['structure'] === true,
    );
    /*
     * 第一次**填槽**的工作分配。payload 的键是 targetSlotId 而不是 slotId：
     * 结算事件用 slotId，工作分配事件用 targetSlotId。
     *
     * 必须把根槽位排除掉：结构审核的 execution 也是有 targetSlotId 的
     * （就是根 `chapter`）。第一版没排，找到的是第一次结构审核，
     * 于是断言变成「结算在自己之前」——一条永远为假的比较，
     * 红得莫名其妙，红的是测试不是产品。
     */
    const firstFill = traces.find(
      (t) =>
        t.kind === 'assignment_created' &&
        typeof t.payload?.['targetSlotId'] === 'string' &&
        t.payload['targetSlotId'] !== 'chapter',
    );

    expect(settled).toBeDefined();
    expect(firstFill).toBeDefined();
    expect(settled?.sequence).toBeLessThan(firstFill?.sequence ?? -1);

    /*
     * 反证的另一半：**重来那一轮也没有任何槽位开过工**。
     *
     * 只断言「结算在填槽之前」是不够的——第 0 版的树被检出时若已经填过槽，
     * 上面那条仍然成立（结算指的是第 1 轮那次），而白花的钱已经花了。
     * 填槽的 execution 一条都不该早于结构审核的最后一条。
     */
    const executions = h.uow.repositories.executions.listByTask(taskId);
    const fills = executions.filter((e) => e.operation === 'fill_slot');
    const structureOps = executions.filter((e) => e.operation === 'create_structure');
    expect(structureOps).toHaveLength(2); // 第 0 版 + 重来那一版
    expect(fills).toHaveLength(3); // 两个场景 + 标题，一次都没多
    expect(h.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
  });

  /*
   * 结构审到最后一条判据时被打断，恢复之后必须**结算**，不能空转。
   *
   * 这是「根容器停在 pending」这条路径上最坏的一种：四条判据都已经有记录了，
   * 调度器给出的是 `review_settle`，而 `clearReview` 的 WHERE 里带着
   * `status = 'reviewing'`——根停在 pending 时那是一次 0 行更新。
   * 状态不动，下一轮又选中同一个根，任务在这里**永远转下去**，
   * 而它在界面上与「正在生产」一模一样（文件头第 2 条纪律要防的就是这个）。
   *
   * 中间那一步（把根改回 pending）是**手写的**，因为要精确落在
   * 「四条判据都有记录、结算还没发生」这个缝里，而真去 stop 一次的话，
   * 那两件事在 tick 循环里是背靠背的，撞不撞得进去要看运气。
   * 手写的正是恢复路径会留下的状态：`cancelReview` 只动 status，不动审核行。
   */
  it('审到最后一条判据时被打断：恢复后结算收口，不空转', async () => {
    const h = run([
      { submitStructure: tree(GOOD_GOAL) },
      ...structureRound(false),
      { hangMs: 60000 }, // 挂在第一次填槽上，好让任务停得下来
      ...tailAfterStructure(),
    ]);
    const created = await h.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: '结构审核被打断',
      input: INPUT,
    });
    const taskId = created.task.id;
    // 刻意**不** await drain：那一挂是 60 秒，等它排空就等于等它跑完
    h.lifecycle.dispatch('start', taskId);

    // 结构已经审完并结算，任务正卡在第一次填槽上
    await waitFor(() => h.uow.repositories.slots.get(taskId, 'chapter')?.status === 'completed');
    h.lifecycle.stop(taskId);
    await h.engine.drain();

    // 造出恢复路径留下的那个状态：审核行还在（第 0 轮四条），根却回到了 pending
    h.db.prepare("UPDATE slots SET status = 'pending' WHERE task_id = ? AND slot_id = 'chapter'").run(taskId);
    expect(h.uow.repositories.slotReviews.listByRound(taskId, 'chapter', 0)).toHaveLength(4);

    h.lifecycle.dispatch('resume', taskId);
    await h.engine.drain();

    // 收口了：根回到 completed，且**没有重跑一轮判据**（仍是 4 行、仍是第 0 轮）。
    // 重跑的话这里会变成 8 行——那是另一种坏法：不空转了，但每次恢复白花四次调用。
    expect(h.uow.repositories.slots.getOrThrow(taskId, 'chapter').status).toBe('completed');
    const rows = h.uow.repositories.slotReviews.listBySlot(taskId, 'chapter');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.round === 0)).toBe(true);
  }, 30000);

  /*
   * `maxRevisionRounds: 3` —— 结构最多重来三次，第 4 版仍被检出就按现状继续。
   *
   * D-26：任务永不因审核卡死。上限没生效的表现是无限重来（每一版都被检出、
   * 每一版都还有预算），任务永远走不到填槽——而它在界面上与「正在生产」一模一样。
   */
  it('第 4 版仍被检出时按现状继续填槽，不开第 5 版', async () => {
    const h = run([
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      { submitStructure: tree(BAD_GOAL) },
      ...structureRound(true),
      ...tailAfterStructure(),
    ]);
    const taskId = await start(h);

    const root = h.uow.repositories.slots.getOrThrow(taskId, 'chapter');
    // `reviewExhausted` 放在第一条断言：它是「上限就是 3」的**直接编码**。
    // 上限若被改成 5，第 3 轮结算不会判耗尽，引擎转去要第 5 版，
    // 后面的断言会跟着一起塌——那时报错指向的是级联结果而不是原因。
    expect(root.reviewExhausted).toBe(true);
    expect(root.status).toBe('completed');
    expect(root.revisionRound).toBe(3);

    // 反面：上限若是 4 或更大，这里会有第 5 版的 create_structure。
    // 不看 slot_reviews 的轮号：整树替换每次都会把往轮的行删掉（外键），
    // 库里只剩最后一轮，数不出「一共重来了几次」。execution 是只增的，数得出。
    const structureOps = h.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'create_structure');
    expect(structureOps).toHaveLength(4); // 第 0 版 + 三次重来

    // D-26：重来用尽也不许把任务卡死，它照现状把正文写完
    expect(h.uow.repositories.tasks.getOrThrow(taskId).status).toBe('completed');
  });
});
