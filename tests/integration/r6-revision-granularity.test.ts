/**
 * R6 返修粒度验收（D-61 / D-62 / D-64 / D-65，
 * 设计见 `notes/REVISION-GRANULARITY-DESIGN-V0.1.md`）。
 *
 * 全程无网络（FakeProvider）、库在内存里，其余每一层都是产品代码。
 *
 * ── 这几条用例各自钉的是什么 ────────────────────────────────────
 *
 * 这个特性的**全部意义**是一句话：没写进编辑清单的段落，在机械上不可能被改。
 * 而它成立需要三件事同时为真，缺一条整个特性就退化成「又一句更长的提示词」——
 * 而提示词这条路已经被实测证伪（`context-builder.ts` 里本来就写着
 * 「未被指出问题的部分保持原样」，实测同一次返修改了 72.8% 的正文）：
 *
 * 1. 返修轮**拒收**整篇正文（否则模型照旧整篇提交，什么都没变）；
 * 2. 编辑清单**真的只改被点名处**（端到端读库里的 content_text，不是读单测）；
 * 3. 撞墙之后系统**会降级**（否则撞上 D-26「任务永不因审核卡死」）。
 *
 * 单测在 `src/server/domain/slot-edits.test.ts`，那里测的是纯函数。
 * 这里测的是**接线**：工具层拿不拿得到返修基线、降级由谁触发、正文最后长什么样。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createEngineHarness,
  sceneText,
  outlineText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  type EngineHarness,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

/** 第 0 稿。开头那句独一无二，好用来当编辑锚点，也好断言「它没被动过」 */
const DRAFT_0 = sceneText('第一稿');
/** 第 0 稿里除锚点之外的部分——所有「没被点名的段落」的代表 */
const UNTOUCHED = '她推开门，雨声灌了进来。';

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function run(scripts: readonly FakeProviderScript[]): EngineHarness {
  harness = createEngineHarness({ provider: new FakeProvider({ turns: scripts }) });
  return harness;
}

async function start(h: EngineHarness): Promise<string> {
  const created = await h.snapshots.createTask({
    templateId: 'review-chapter',
    name: 'R6 返修粒度',
    input: INPUT,
  });
  h.lifecycle.dispatch('start', created.task.id);
  return created.task.id;
}

/** 跑到 scene_01 第 0 轮审核入口 */
function toFirstReview(): FakeProviderScript[] {
  return [
    { submitStructure: VALID_STRUCTURE },
    { submitContent: { slotId: 'outline', content: outlineText() } },
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
    { submitContent: { slotId: 'scene_01', content: DRAFT_0 } },
  ];
}

/** 第 0 轮：S1 检出（引文逐字真实，过得了引文闸门），S2 未检出 → 结算为返修 */
function firstRoundFires(): FakeProviderScript[] {
  return [
    {
      submitReview: {
        slotId: 'scene_01',
        verdict: 'revise',
        findings: [{ criterionId: 'S1', quote: '第一稿。', problem: '开头没有承接上一场' }],
      },
    },
    { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
  ];
}

const cleanRound: FakeProviderScript[] = [
  { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
  { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
];

/** scene_02 与其审核，把任务跑到底 */
function tail(): FakeProviderScript[] {
  return [
    { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
    { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
  ];
}

describe('R6 返修粒度', () => {
  it('D-61：编辑清单只改被点名处，未点名的段落逐字不变', async () => {
    const h = run([
      ...toFirstReview(),
      ...firstRoundFires(),
      {
        submitEdits: {
          slotId: 'scene_01',
          edits: [{ oldText: '第一稿。', newText: '承接上一场的雨。' }],
        },
      },
      ...cleanRound,
      ...tail(),
    ]);
    const taskId = await start(h);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('completed');
    expect(slot.revisionRound).toBe(1);

    // 被点名的那一处改了
    expect(slot.contentText).toContain('承接上一场的雨。');
    expect(slot.contentText).not.toContain('第一稿。');
    /*
     * 没被点名的部分**逐字**不变——这一条是整个特性存在的理由。
     * 断言写成「把第 0 稿里锚点之后的全部内容原样比对」，而不是抽查一句：
     * 抽查过得了「模型把其余部分同义替换了一遍」这种漂移，而那正是要防的东西。
     */
    expect(slot.contentText).toBe(DRAFT_0.replace('第一稿。', '承接上一场的雨。'));
    expect(slot.contentText).toContain(UNTOUCHED);

    /*
     * prompt 侧的凭据：返修轮真的在要编辑清单，而**那句被实测证伪的话已经不在了**。
     * 少了这一条，服务端可以正确实现契约、而 prompt 还在教模型交整篇——
     * 表现是每次返修都先被拒一次、白烧半轮预算。
     */
    const revisionTurn = h.provider.observations.find((o) =>
      o.messages.some((m) => typeof m.content === 'string' && m.content.includes('【返修】第 1 轮')),
    );
    expect(revisionTurn).toBeDefined();
    const revisionPrompt = revisionTurn!.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(revisionPrompt).toContain('slot_edits');
    expect(revisionPrompt).toContain('这一轮不提交完整正文');
    expect(revisionPrompt).not.toContain('未被指出问题的部分保持原样，然后提交完整正文');
  });

  it('D-64：编辑条数与覆盖字数进 trace，「改了 1 处」与「重写整篇」在事后分得开', async () => {
    const h = run([
      ...toFirstReview(),
      ...firstRoundFires(),
      {
        submitEdits: {
          slotId: 'scene_01',
          edits: [{ oldText: '第一稿。', newText: '承接上一场的雨。' }],
        },
      },
      ...cleanRound,
      ...tail(),
    ]);
    const taskId = await start(h);
    await h.engine.drain();

    const submitted = h.uow.repositories.traces
      .listByTask(taskId)
      .filter((e) => e.kind === 'assignment_submitted');
    const edited = submitted.filter((e) => e.summary.includes('定点编辑'));
    expect(edited).toHaveLength(1);
    expect(edited[0]?.summary).toContain('1 条定点编辑');
    // 首稿那几次不该被记成编辑
    expect(submitted.length).toBeGreaterThan(1);
  });

  /**
   * D-61 的支点。少了这条断言，「提示词要求编辑清单、工具照收整篇」
   * 这种退化会悄无声息地发生，而那正是本特性要取代的状态。
   */
  it('未降级的返修轮拒收整篇正文，该次尝试失败', async () => {
    const h = run([
      ...toFirstReview(),
      ...firstRoundFires(),
      /*
       * 返修轮第 1 次尝试：违约提交整篇 → 工具层拒。
       *
       * 被拒**不会**立刻让执行失败：`complete-assignment.ts` 刻意把错误抛回
       * 工具循环，让模型在同一次执行里改正后重提（省一次 attempt）。
       * 所以这里紧跟一条「只说话不提交」的脚本，本次执行才会以 no_submission 收敛，
       * 从而进入第 2 次尝试——那一次系统已降级。
       */
      { submitContent: { slotId: 'scene_01', content: sceneText('违约整篇') } },
      { emitText: ['我再想想。'], neverSubmit: true },
      // 第 2 次尝试（系统已降级）：整篇放行
      { submitContent: { slotId: 'scene_01', content: sceneText('降级后整篇') } },
      ...cleanRound,
      ...tail(),
    ]);
    const taskId = await start(h);
    await h.engine.drain();

    const fills = h.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'fill_slot' && e.targetSlotId === 'scene_01')
      .sort((a, b) => a.attemptNumber - b.attemptNumber);

    // 首稿 1 次 + 返修轮 2 次（第 1 次违约被拒，第 2 次降级后成功）
    expect(fills).toHaveLength(3);
    expect(fills[1]?.status).toBe('failed');
    expect(fills[2]?.status).toBe('succeeded');

    // D-65：降级之后整篇提交被接受，槽位正常完成，任务没有卡死（D-26）
    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('completed');
    expect(slot.contentText).toBe(sceneText('降级后整篇'));
    // 被拒那一稿一个字都没进库
    expect(slot.contentText).not.toContain('违约整篇');
  });

  it('首稿不接受编辑清单（没有上一稿可引），并告知改用整篇', async () => {
    const h = run([
      { submitStructure: VALID_STRUCTURE },
      { submitContent: { slotId: 'outline', content: outlineText() } },
      { submitContent: { slotId: 'title', content: TITLE_TEXT } },
      // scene_01 首稿就交编辑清单 → 应当被拒
      { submitEdits: { slotId: 'scene_01', edits: [{ oldText: '任意', newText: '任意' }] } },
      // 重试：老实交整篇
      { submitContent: { slotId: 'scene_01', content: DRAFT_0 } },
      ...cleanRound,
      ...tail(),
    ]);
    const taskId = await start(h);
    await h.engine.drain();

    const fills = h.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'fill_slot' && e.targetSlotId === 'scene_01')
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
    /*
     * 被拒之后模型在**同一次执行里**改交整篇并成功——这是 `complete-assignment.ts`
     * 刻意的设计（省一次 attempt），所以这一条断言的不是「执行失败」，
     * 而是「拒绝确实发生过，且被拒的那份没进库」。
     */
    /*
     * 被拒之后模型在**同一次执行里**改交整篇并成功——这是 `complete-assignment.ts`
     * 刻意的设计（省一次 attempt），所以断言的不是「执行失败」，
     * 而是「拒绝确实发生过、被拒的那份没进库、且这件事在轨迹上看得见」。
     */
    expect(fills).toHaveLength(1);
    expect(fills[0]?.status).toBe('succeeded');

    const precheckRejections = h.uow.repositories.traces
      .listByTask(taskId)
      .filter((e) => e.kind === 'validation_failed' && e.title === '提交被预检拒绝');
    expect(precheckRejections).toHaveLength(1);
    expect(precheckRejections[0]?.summary).toContain('首稿');
    expect(h.uow.repositories.slots.getOrThrow(taskId, 'scene_01').contentText).toBe(DRAFT_0);
  });

  it('D-62：oldText 对不上就整份退回，上一稿一个字都不动', async () => {
    const h = run([
      ...toFirstReview(),
      ...firstRoundFires(),
      // 返修轮第 1 次：引了一句上一稿里不存在的话
      {
        submitEdits: {
          slotId: 'scene_01',
          edits: [{ oldText: '这句话上一稿里根本没有', newText: 'X' }],
        },
      },
      // 同上：被拒后本次执行要无话可说，才会进入下一次尝试
      { emitText: ['我再想想。'], neverSubmit: true },
      // 第 2 次（已降级）：老实交整篇
      { submitContent: { slotId: 'scene_01', content: sceneText('第二稿') } },
      ...cleanRound,
      ...tail(),
    ]);
    const taskId = await start(h);
    await h.engine.drain();

    const fills = h.uow.repositories.executions
      .listByTask(taskId)
      .filter((e) => e.operation === 'fill_slot' && e.targetSlotId === 'scene_01')
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
    expect(fills[1]?.status).toBe('failed');
    expect(fills[1]?.errorCode).toBe('ASSIGNMENT_OUTPUT_INVALID');
    expect(h.uow.repositories.slots.getOrThrow(taskId, 'scene_01').contentText).toBe(
      sceneText('第二稿'),
    );
  });
});
