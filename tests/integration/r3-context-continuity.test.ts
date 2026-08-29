/**
 * R3 上下文连续性验收测试（AC-R-013 ~ AC-R-017）。
 *
 * 全程无网络、数据库 `:memory:`（重建那一条用真文件），每一层都是产品代码。
 *
 * 两条不对称的规则在这里同时被守住（D-31 / D-32）：
 * **填槽连续、审核无状态**。任何一条测试都同时断言「发生了什么」与「没发生什么」，
 * 因为这两条各自的失效方式恰好是对方的成功样子。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@server/domain/canonical.ts';
import { collectPriorRounds } from '@server/application/revision-source.ts';
import type { Execution } from '@server/domain/types.ts';
import type { PriorRound } from '@server/domain/revision-context.ts';
import {
  createEngineHarness,
  createTempDbPath,
  sceneText,
  outlineText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  waitFor,
  type EngineHarness,
  sceneEditsTo,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';
import { OpenAiCompatibleAdapter } from '@server/runtime/provider/openai-compatible.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

/** 第 0 稿。返修上下文里必须原样出现它 */
const DRAFT_0 = sceneText('第一稿');
/** 第 1 稿（返修后） */
const DRAFT_1 = sceneText('第二稿');

/** 审核检出的问题说明。刻意造得独一无二，好用来断言「哪里有它、哪里没有它」 */
const PROBLEM_0 = '首段没有承接骨架里第一场留下的悬置状态（第零轮检出）';
/** Agent 上一轮的公开工作说明 */
const PLAN_0 = '我打算先读骨架，再从债主推门那一刻切入。';
/** Agent 上一轮的可见输出（text delta） */
const SAID_0 = '先看看骨架里第一场的目标。';

const harnesses: EngineHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});

function track(h: EngineHarness): EngineHarness {
  harnesses.push(h);
  return h;
}

async function createAndStart(h: EngineHarness): Promise<string> {
  const created = await h.snapshots.createTask({
    templateId: 'review-chapter',
    name: 'R3 上下文连续性',
    input: INPUT,
  });
  h.lifecycle.dispatch('start', created.task.id);
  return created.task.id;
}

/**
 * 跑到 scene_01 第 0 轮审核入口的公共脚本。
 *
 * scene_01 那一轮刻意做满三件事：吐一段可见文本、发一条 report_work、读一次依赖槽位。
 * 这三件正是 D-31 要在下一轮重建出来的东西——脚本里不做，测试就只是在测空集。
 */
function scriptToFirstReview(): FakeProviderScript[] {
  return [
    { submitStructure: VALID_STRUCTURE },
    { submitContent: { slotId: 'outline', content: outlineText() } },
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
    {
      emitText: [SAID_0],
      callTools: [
        { name: 'read_slot', args: { slotId: 'outline' } },
        { name: 'report_work', args: { type: 'plan', summary: PLAN_0 } },
      ],
      submitContent: { slotId: 'scene_01', content: DRAFT_0 },
    },
  ];
}

/** 第 0 轮审核：S1 检出问题（引文真实），S2 未检出 → 结算为返修 */
function firstRoundReviewScripts(): FakeProviderScript[] {
  return [
    {
      submitReview: {
        slotId: 'scene_01',
        verdict: 'revise',
        findings: [{ criterionId: 'S1', quote: DRAFT_0.slice(0, 12), problem: PROBLEM_0 }],
      },
    },
    { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
  ];
}

/** 第 1 轮之后一路跑完（scene_01 返修稿 + 两条判据 + scene_02 + 两条判据） */
function tailScripts(): FakeProviderScript[] {
  return [
    sceneEditsTo('scene_01', '第一稿', '第二稿'),
    { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
    { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
    { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
    { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
  ];
}

function fakeHarness(scripts: readonly FakeProviderScript[], dbPath?: string): EngineHarness {
  return track(
    createEngineHarness({
      provider: new FakeProvider({ turns: scripts }),
      ...(dbPath === undefined ? {} : { dbPath }),
    }),
  );
}

/** 某个槽位的 fill_slot execution，按创建序 */
function fillSlotExecutions(h: EngineHarness, taskId: string, slotId: string): Execution[] {
  return h.uow.repositories.executions
    .listByTask(taskId)
    .filter((e) => e.operation === 'fill_slot' && e.targetSlotId === slotId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
}

function reviewExecutions(h: EngineHarness, taskId: string, slotId: string): Execution[] {
  return h.uow.repositories.executions
    .listByTask(taskId)
    .filter((e) => e.operation === 'review_slot' && e.targetSlotId === slotId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
}

/** `executions.context_json` 里返修段的形状（= `StructuredContextInput.revision`） */
interface StoredRevision {
  round: number;
  priorRounds: {
    visibleOutput: string;
    readSlotIds: string[];
    submittedContent: string;
    findings: { criterionId: string; quote: string; problem: string }[];
  }[];
}

/** `PriorRound[]` → 与 `canonicalJson` 落库后同形，好做逐字比对 */
function normalize(rounds: readonly PriorRound[]): StoredRevision['priorRounds'] {
  return rounds.map((prior) => ({
    visibleOutput: prior.visibleOutput,
    readSlotIds: [...prior.readSlotIds],
    submittedContent: prior.submittedContent,
    findings: prior.findings.map((f) => ({
      criterionId: f.criterionId,
      quote: f.quote,
      problem: f.problem,
    })),
  }));
}

/** `needle` 在 `haystack` 里出现了几次。用来抓「同一段正文印了两遍」 */
function occurrencesOf(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function contextJsonOf(h: EngineHarness, execution: Execution): string {
  const json = h.uow.repositories.executions.getContextJson(execution.id);
  if (json === null) throw new Error(`execution ${execution.id} 没有 context_json`);
  return json;
}

// ---------------------------------------------------------------------------

describe('R3 上下文连续性（D-31 / D-32）', () => {
  // AC-R-013：返修轮的 context_json 含上一轮对话轮次与上一稿正文
  it('AC-R-013：返修轮 context_json 含上一轮公开输出、读过的槽位 ID、上一稿正文与 findings', async () => {
    const h = fakeHarness([...scriptToFirstReview(), ...firstRoundReviewScripts(), ...tailScripts()]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const fills = fillSlotExecutions(h, taskId, 'scene_01');
    expect(fills).toHaveLength(2);
    const revision = fills[1]!;

    const contextJson = contextJsonOf(h, revision);
    const parsed = JSON.parse(contextJson) as { revision: StoredRevision | null };

    expect(parsed.revision).not.toBeNull();
    expect(parsed.revision!.round).toBe(1);
    // 第 1 轮返修 → 只有第 0 轮一份历史
    expect(parsed.revision!.priorRounds).toHaveLength(1);
    const round0 = parsed.revision!.priorRounds[0]!;
    // 上一轮 Agent 的对话轮次：它说的话 + 它发的 report_work
    expect(round0.visibleOutput).toContain(SAID_0);
    expect(round0.visibleOutput).toContain(PLAN_0);
    // 只记读过的槽位 ID，不存正文副本（FR-CTX-005）
    expect(round0.readSlotIds).toEqual(['outline']);
    // 依赖正文一个字都不该被复制进语义输入里的返修段
    expect(JSON.stringify(parsed.revision)).not.toContain(outlineText());
    // 上一稿正文
    expect(round0.submittedContent).toBe(DRAFT_0);
    // 通过引文校验的 findings
    expect(round0.findings).toHaveLength(1);
    expect(round0.findings[0]!.problem).toBe(PROBLEM_0);

    // 「从库里读出该 execution 即可完整复现输入」——那一列与 context_hash 必须逐字对应
    expect(sha256Hex(contextJson)).toBe(revision.contextHash);

    // 首稿那一轮不该有返修段（跨槽位/跨轮次不许串味）
    const firstJson = JSON.parse(contextJsonOf(h, fills[0]!)) as { revision: unknown };
    expect(firstJson.revision).toBeNull();
  });

  /**
   * `context_json` 里 `revision` 那一段的**键名是对外契约，不是实现细节**。
   *
   * ## 先说清楚它**不是**唯一的防线（2026-08-27 实测）
   *
   * 把产品代码里的 `submittedContent` 改名成 `draftText`（写入端 context-builder、
   * 读取端 revision-source、类型 revision-context 三处同时改）之后，
   * 本文件已有的 **AC-R-013、D-31 第 2 轮、FR-CTX-005 三条一起红**——
   * 它们靠类型断言逐个取键名，改名就取不到。**机械层面的检测早就在了。**
   *
   * 本条新增的只有两样，都很窄：
   *   1. `criterionId` 与 `quote` 这两个 finding 键，全仓库只有这里钉死
   *      （AC-R-013 只断言到 `problem`）；
   *   2. `Object.keys().sort()` 是**全等**，所以还能抓住「悄悄多加一个键」，
   *      而不只是改名——多加的键会进 `context_hash`，让同一份语义输入换了指纹。
   *
   * ## 真正的价值在下面这段说明，不在断言本身
   *
   * 上面那三条红了之后，最顺手的「修法」是把测试里的字面量跟着改一遍，然后绿。
   * **那一步就是事故本身**：库里**已经存在的老行**还是老键名，新的读取端认不出来，
   * `earlierRoundsOf` 的六条容错分支把它降级成「没有更早的轮次」——
   * **不抛错、不留痕、任务照常跑完**，只是返修 Agent 突然不记得第 0 轮了。
   * 那正是 D-31 开头写下的失效场景：第 2 轮把第 0 轮修好的地方改回去，
   * 白烧一轮预算（总共只有两轮），而且事后无从查起。
   *
   * 所以这条断言存在的意义，是**在红的那一刻把「该怎么办」摆在改的人眼前**。
   *
   * ## 这条断言红了怎么办
   *
   * **不要改这里的字面量让它变绿。**改了就等于把上面那件事放行了。
   * 要改形状，同时做三件事：
   *   1. 给 `revision` 加版本号（读到「没有版本号」按现在这版解，老行才不失效）；
   *   2. 让 `earlierRoundsOf` 遇到不认识的版本时**留痕**（发一条 trace 说
   *      「本轮少读了 N 轮历史」），而不是静默返回空数组；
   *   3. 再回来更新这里的字面量，并把新键名也钉死。
   *
   * 键名在这里**必须写成字面量**，不能从 `StoredRevision` 类型推导：
   * 从类型推导的话，改名会让类型和断言一起变，这条断言就永远不会红。
   */
  it('context_json 的 revision 形状被钉死（改形状会让老任务静默丢历史）', async () => {
    const h = fakeHarness([...scriptToFirstReview(), ...firstRoundReviewScripts(), ...tailScripts()]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const revision = fillSlotExecutions(h, taskId, 'scene_01')[1]!;
    const parsed = JSON.parse(contextJsonOf(h, revision)) as Record<string, unknown>;

    // 顶层：返修段挂在 `revision` 这个键上
    expect(Object.keys(parsed)).toContain('revision');
    const rev = parsed['revision'] as Record<string, unknown>;
    expect(Object.keys(rev).sort()).toEqual(['priorRounds', 'round']);

    // 每一轮的形状
    const rounds = rev['priorRounds'] as Record<string, unknown>[];
    expect(rounds.length).toBeGreaterThan(0);
    for (const round of rounds) {
      expect(Object.keys(round).sort()).toEqual([
        'findings',
        'readSlotIds',
        'submittedContent',
        'visibleOutput',
      ]);
      for (const finding of round['findings'] as Record<string, unknown>[]) {
        expect(Object.keys(finding).sort()).toEqual(['criterionId', 'problem', 'quote']);
      }
    }

    // 这一轮至少有一条 finding，否则上面那层 for 是空转，等于没断言
    expect((rounds[0]!['findings'] as unknown[]).length).toBeGreaterThan(0);
  });

  // AC-R-013（prompt 侧）：返修段真的进了送给模型的 User Message
  it('AC-R-013：返修轮的 User Message 含返修段，首稿那一轮不含', async () => {
    const h = fakeHarness([...scriptToFirstReview(), ...firstRoundReviewScripts(), ...tailScripts()]);
    await createAndStart(h);
    await h.engine.drain();

    const fillTurns = h.provider.observations.filter(
      (obs) => obs.system.includes('Operation: fill_slot') && obs.system.includes('scene_01'),
    );
    expect(fillTurns).toHaveLength(2);
    const first = String(fillTurns[0]!.messages[0]?.content ?? '');
    const second = String(fillTurns[1]!.messages[0]?.content ?? '');

    expect(first).not.toContain('【返修】');
    expect(second).toContain('【返修】第 1 轮');
    expect(second).toContain(SAID_0);
    expect(second).toContain(PLAN_0);
    expect(second).toContain(DRAFT_0);
    expect(second).toContain(PROBLEM_0);

    // N2：依赖正文由【依赖槽位内容】渲染**恰好一次**，返修段不许再印一遍。
    // `toContain` 在这里是恒真的（那一段无条件渲染），抓不住重复渲染。
    expect(occurrencesOf(second, outlineText())).toBe(1);
    // 返修段保留「上一轮读过哪些槽位」，但只列 ID
    expect(second).toContain('你这一轮读过的依赖槽位：outline');

    // D-30：措辞铁律。返修段不得出现这三种不实陈述
    for (const banned of ['审核通过', '质量合格', '已校验']) {
      expect(second).not.toContain(banned);
    }
  });

  // AC-R-013 / D-31：上下文回溯到第 0 轮，不是只带最近一轮
  it('D-31：第 2 轮的上下文同时含第 0 轮与第 1 轮的 findings 与稿子', async () => {
    const PROBLEM_1 = '心理解释代替了事件，没有可见行动（第一轮检出）';
    const h = fakeHarness([
      ...scriptToFirstReview(),
      ...firstRoundReviewScripts(),
      // 第 1 轮返修稿 → 又被 S2 检出问题 → 第 2 轮
      sceneEditsTo('scene_01', '第一稿', '第二稿'),
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      {
        submitReview: {
          slotId: 'scene_01',
          verdict: 'revise',
          findings: [{ criterionId: 'S2', quote: DRAFT_1.slice(0, 12), problem: PROBLEM_1 }],
        },
      },
      // 第 2 轮返修稿
      sceneEditsTo('scene_01', '第二稿', '第三稿'),
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
      { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
    ]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const fills = fillSlotExecutions(h, taskId, 'scene_01');
    expect(fills).toHaveLength(3);

    const parsed = JSON.parse(contextJsonOf(h, fills[2]!)) as { revision: StoredRevision | null };
    expect(parsed.revision!.round).toBe(2);
    // 第 0 轮与第 1 轮都在，一轮不缺（D-31：「都还在」；代价一节：最多 3 稿）
    expect(parsed.revision!.priorRounds).toHaveLength(2);
    expect(parsed.revision!.priorRounds[0]!.submittedContent).toBe(DRAFT_0);
    expect(parsed.revision!.priorRounds[1]!.submittedContent).toBe(DRAFT_1);
    expect(parsed.revision!.priorRounds[0]!.findings.map((f) => f.problem)).toEqual([PROBLEM_0]);
    expect(parsed.revision!.priorRounds[1]!.findings.map((f) => f.problem)).toEqual([PROBLEM_1]);
    // 第 0 轮的对话轮次也还在——只带一轮时它是第一个消失的
    expect(parsed.revision!.priorRounds[0]!.visibleOutput).toContain(PLAN_0);

    // prompt 侧：第 2 轮的 Agent 同时看得见两轮的问题
    const thirdFill = h.provider.observations.filter(
      (obs) => obs.system.includes('Operation: fill_slot') && obs.system.includes('scene_01'),
    )[2];
    const userText = String(thirdFill!.messages[0]?.content ?? '');
    expect(userText).toContain('【返修】第 2 轮');
    expect(userText).toContain('── 第 0 轮 ──');
    expect(userText).toContain('── 第 1 轮 ──');
    expect(userText).toContain(PROBLEM_0);
    expect(userText).toContain(PROBLEM_1);
    // 「别把上一轮改好的地方改回去」这句话是 D-31 锚定风险的对冲，必须真的在 prompt 里
    expect(userText).toContain('往轮已经改好的地方不要改回去');
  }, 30000);

  // AC-R-013 / FR-CTX-005：清空进程内存后，只凭数据库能重建出逐字相同的上下文
  it('FR-CTX-005：换一个进程内状态全新的实例，重建出的上一轮与库里那一列逐字相同', async () => {
    const temp = createTempDbPath();
    try {
      // 第一段：跑到 scene_01 的返修轮开始生产，然后 stop
      const h = fakeHarness(
        [...scriptToFirstReview(), ...firstRoundReviewScripts(), { hangMs: 60000 }],
        temp.dbPath,
      );
      const taskId = await createAndStart(h);
      await waitFor(() => fillSlotExecutions(h, taskId, 'scene_01').length === 2, 10000);
      h.lifecycle.stop(taskId);
      await h.engine.drain();

      const storedRevision = (
        JSON.parse(contextJsonOf(h, fillSlotExecutions(h, taskId, 'scene_01')[1]!)) as {
          revision: StoredRevision | null;
        }
      ).revision;
      expect(storedRevision).not.toBeNull();

      // 第二段：把第一段整个关掉（进程内存里的一切随之消失），
      // 只留磁盘上的库，再开一个全新实例重建同一段上下文。
      h.close();
      harnesses.splice(harnesses.indexOf(h), 1);

      const fresh = track(createEngineHarness({ dbPath: temp.dbPath }));
      const slot = fresh.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
      expect(slot.revisionRound).toBe(1);

      const rebuilt = collectPriorRounds(fresh.uow.repositories, slot);
      expect(rebuilt).not.toHaveLength(0);
      expect({ round: slot.revisionRound, priorRounds: normalize(rebuilt) }).toEqual(storedRevision);
    } finally {
      temp.cleanup();
    }
  }, 30000);

  // B2：上一轮的重试上下文不得串进返修轮
  it('返修轮的 prompt 不带上一轮的违规回灌，且「第 n 次尝试」是本轮内序号', async () => {
    // 两轮各「只说话不提交」一次 → no_submission → 引擎层重试。
    // 用 no_submission 而不是「正文太短」：内容校验不过是在**同一条 execution 内**
    // 由工具错误结果回给模型的，压根走不到 RetryState，测不到要测的东西。
    const NEVER_SUBMIT: FakeProviderScript = { emitText: ['我再想想怎么开头。'], neverSubmit: true };
    const [structureScript, outlineScript, titleScript, sceneScript] = scriptToFirstReview();
    const [reviseScript, noFindingScript] = firstRoundReviewScripts();
    const h = fakeHarness([
      structureScript!,
      outlineScript!,
      titleScript!,
      NEVER_SUBMIT, // 第 0 轮第 1 次
      sceneScript!, // 第 0 轮第 2 次：成功
      reviseScript!,
      noFindingScript!,
      NEVER_SUBMIT, // 第 1 轮第 1 次
      { submitContent: { slotId: 'scene_01', content: DRAFT_1 } }, // 第 1 轮第 2 次：成功
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
      { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
      { submitReview: { slotId: 'scene_02', verdict: 'no_finding' } },
    ]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const fillTurns = h.provider.observations.filter(
      (obs) => obs.system.includes('Operation: fill_slot') && obs.system.includes('scene_01'),
    );
    // 两轮各 2 次
    expect(fillTurns).toHaveLength(4);

    const round0Retry = String(fillTurns[1]!.messages[0]?.content ?? '');
    const round1First = String(fillTurns[2]!.messages[0]?.content ?? '');
    const round1Retry = String(fillTurns[3]!.messages[0]?.content ?? '');

    // 前提自证：第 0 轮的重试确实回灌了「你上次没提交」，否则下面两条断言测的是空集
    expect(round0Retry).toContain('【上一次未产出结果】');
    expect(round0Retry).toContain('这是第 2 次尝试，共 2 次机会。');

    // 返修轮的**第一次**是新的一轮：上一轮早已过去的重试上下文不许再回灌一遍
    expect(round1First).toContain('【返修】第 1 轮');
    expect(round1First).not.toContain('【上一次未产出结果】');

    // 返修轮的**第二次**该有重试块，但「第 n 次尝试」必须是本轮内序号。
    // 全局 attempt_number 此刻已经是 6（第 0 轮 2 次 + 两条 review 2 次 + 本轮 2 次，
    // 它们共用同一个 target_slot_id 计数器），印出来就是
    // 「这是第 6 次尝试，共 2 次机会」——一个自相矛盾、会让模型以为自己已超额的数字。
    expect(round1Retry).toContain('【返修】第 1 轮');
    expect(round1Retry).toContain('【上一次未产出结果】');
    expect(round1Retry).toContain('这是第 2 次尝试，共 2 次机会。');
    expect(round1Retry).not.toMatch(/这是第 [3-9] 次尝试/);

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('completed');
  }, 30000);

  // AC-R-015：返修后 content_text 与 producer 各列原样保留
  it('AC-R-015：review_revise 后 content_text 与 producer 各列原样保留', async () => {
    const [reviseScript, noFindingScript] = firstRoundReviewScripts();
    const h = fakeHarness([
      ...scriptToFirstReview(),
      // S1 的审核刻意慢 300ms：reviewing 是个瞬时窗口，不撑开它就抓不到基准快照
      { ...reviseScript!, hangMs: 300 },
      noFindingScript!,
      { hangMs: 60000 },
    ]);
    const taskId = await createAndStart(h);

    // 先在 reviewing 期间抓一份基准
    await waitFor(() => h.uow.repositories.slots.get(taskId, 'scene_01')?.status === 'reviewing');
    const before = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(before.contentText).toBe(DRAFT_0);
    expect(before.producer).not.toBeNull();

    // 等返修真的发生（revisionRound 递增）
    await waitFor(() => h.uow.repositories.slots.getOrThrow(taskId, 'scene_01').revisionRound === 1, 10000);
    const after = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(after.contentText).toBe(before.contentText);
    expect(after.producer).toEqual(before.producer);

    h.lifecycle.stop(taskId);
    await h.engine.drain();
  }, 30000);

  // AC-R-015 后半条：resetToPending 与 markForRevision 是两条路径，没有被合并
  it('AC-R-015：resetToPending 对 reviewing 槽位返回 changes = 0（两条路径未被合并）', async () => {
    const h = fakeHarness([
      ...scriptToFirstReview(),
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      { hangMs: 60000 },
    ]);
    const taskId = await createAndStart(h);
    await waitFor(() => h.uow.repositories.slots.get(taskId, 'scene_01')?.status === 'reviewing');

    const changes = h.uow.run((repos) => repos.slots.resetToPending(taskId, 'scene_01'));
    // `AND status = 'running'` 守卫：它对 reviewing 槽位一行都不改
    expect(changes).toBe(0);
    // 而且是安全失败——状态与内容都没被动过
    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.status).toBe('reviewing');
    expect(slot.contentText).toBe(DRAFT_0);

    h.lifecycle.stop(taskId);
    await h.engine.drain();
  }, 30000);

  // AC-R-016：审核 Agent 每轮全新（D-32）
  it('AC-R-016：第 1 轮的 review_slot prompt 与 context_json 都不含往轮审核记录或 verdict', async () => {
    const h = fakeHarness([...scriptToFirstReview(), ...firstRoundReviewScripts(), ...tailScripts()]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    // scene_01 共 4 条 review execution（第 0 轮 2 条 + 第 1 轮 2 条）
    const reviews = reviewExecutions(h, taskId, 'scene_01');
    expect(reviews).toHaveLength(4);

    for (const execution of reviews) {
      const json = contextJsonOf(h, execution);
      // 审核的语义输入里根本没有返修段——不是「碰巧为空」，是恒为 null
      expect((JSON.parse(json) as { revision: unknown }).revision).toBeNull();
      // 往轮检出的问题、往轮的稿子，一个字都不许出现
      expect(json).not.toContain(PROBLEM_0);
      expect(json).not.toContain(PLAN_0);
    }

    // prompt 侧同样断言一遍：context_json 干净不等于送出去的文本干净
    const reviewTurns = h.provider.observations.filter((obs) =>
      obs.system.includes('Operation: review_slot'),
    );
    expect(reviewTurns.length).toBeGreaterThanOrEqual(4);
    const whole = (turn: (typeof reviewTurns)[number]): string =>
      `${turn.system}\n${turn.messages.map((m) => JSON.stringify(m)).join('\n')}`;

    for (const turn of reviewTurns) {
      expect(whole(turn)).not.toContain(PROBLEM_0);
      expect(whole(turn)).not.toContain('【返修】');
    }

    // 第 1 轮的审核（待审正文是第二稿）里，上一稿一个字都不该跟进来。
    // 只对这几轮断言：第 0 轮的待审正文本来就是第一稿，那是它该看的东西。
    const secondRoundTurns = reviewTurns.filter(
      (turn) => turn.system.includes('目标槽位: scene_01') && whole(turn).includes(DRAFT_1),
    );
    expect(secondRoundTurns).toHaveLength(2);
    for (const turn of secondRoundTurns) {
      expect(whole(turn)).not.toContain(DRAFT_0);
    }
  });

  // AC-R-017：返修不消耗故障重试预算
  it('AC-R-017：连续两轮返修后，该槽位仍有完整的 maxRetries 预算', async () => {
    // scene 的 fillSlotByType.maxRetries = 1 → 共 2 次机会
    const [structureScript, outlineScript, titleScript, sceneScript] = scriptToFirstReview();
    const h = fakeHarness([
      structureScript!,
      outlineScript!,
      titleScript!,
      // 第 0 轮先抖一次 Provider 故障，再重试成功。
      // 配额若跨返修轮共享（key 不含 revisionRound），这一次会被一直记着，
      // 于是第 2 轮的**第一次**失败即判耗尽——「返修不消耗 maxRetries」当场失效。
      // 不摆这一次失败，测的就只是「进第 2 轮时计数器碰巧还是 0」。
      { throwError: 'PROVIDER_ERROR' },
      sceneScript!,
      ...firstRoundReviewScripts(),
      // 第 1 轮返修稿
      sceneEditsTo('scene_01', '第一稿', '第二稿'),
      {
        submitReview: {
          slotId: 'scene_01',
          verdict: 'revise',
          findings: [{ criterionId: 'S1', quote: DRAFT_1.slice(0, 12), problem: '第一轮仍未承接' }],
        },
      },
      { submitReview: { slotId: 'scene_01', verdict: 'no_finding' } },
      // 第 2 轮：连续两次 Provider 故障。预算若被返修吃掉，第一次就该耗尽
      { throwError: 'PROVIDER_ERROR' },
      { throwError: 'PROVIDER_ERROR' },
    ]);
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const slot = h.uow.repositories.slots.getOrThrow(taskId, 'scene_01');
    expect(slot.revisionRound).toBe(2);
    expect(slot.status).toBe('failed');
    // 完整预算 = 首次 + 1 次重试。成文原因里的数字就是配额计数器的读数
    expect(slot.errorMessage).toContain('已尝试 2 次');

    // 第 0 轮 2 次（1 失败 + 1 成功）、第 1 轮 1 次、第 2 轮 2 次 = 5 次
    const fills = fillSlotExecutions(h, taskId, 'scene_01');
    expect(fills).toHaveLength(5);

    // 直接对着「第 2 轮用掉了几次机会」断言。
    // 只看 errorMessage 的「已尝试 N 次」是不够的：配额跨轮共享时那个数字
    // 恰好也是 2（第 0 轮 1 次 + 第 2 轮 1 次），断言会绿着放过去。
    const roundOf = (executionId: string): number | null => {
      const json = h.uow.repositories.executions.getContextJson(executionId);
      if (json === null) return null;
      return (JSON.parse(json) as { revision: { round: number } | null }).revision?.round ?? 0;
    };
    expect(fills.filter((e) => roundOf(e.id) === 0)).toHaveLength(2);
    expect(fills.filter((e) => roundOf(e.id) === 1)).toHaveLength(1);
    expect(fills.filter((e) => roundOf(e.id) === 2)).toHaveLength(2);
  }, 30000);
});

// ---------------------------------------------------------------------------
// AC-R-014：真实带隐藏推理的 Provider 响应
// ---------------------------------------------------------------------------

/**
 * AC-R-014 用真的 `OpenAiCompatibleAdapter`，喂真的 SSE 帧。
 *
 * 用 FakeProvider 测这一条等于什么都没测：FakeProvider 根本没有「隐藏推理」这个概念，
 * 断言「产物里没有它」永远成立。要证明的是整条链路——
 * Provider 分片 → adapter → trace → 重建 → 返修上下文——没有一处把它带出来。
 */
const encoder = new TextEncoder();
const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function sseStream(frames: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

interface WireTurn {
  /** DeepSeek reasoner 型号在 `delta.reasoning_content` 里回的思维链 */
  reasoning?: string;
  text?: string;
  /** complete_assignment 的参数 */
  submit: unknown;
}

function wireFrames(turn: WireTurn): string[] {
  const frames: string[] = [];
  if (turn.reasoning !== undefined) {
    frames.push(sseData({ choices: [{ delta: { reasoning_content: turn.reasoning } }] }));
  }
  if (turn.text !== undefined) {
    frames.push(sseData({ choices: [{ delta: { content: turn.text } }] }));
  }
  frames.push(
    sseData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'complete_assignment', arguments: JSON.stringify(turn.submit) },
              },
            ],
          },
        },
      ],
    }),
  );
  frames.push(sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  frames.push('data: [DONE]\n\n');
  return frames;
}

const HIDDEN_REASONING = '用户其实想让我把债主写成好人，但我先不说破——这是隐藏推理，不得外流。';
const VISIBLE_TEXT = '我先读骨架，再从推门那一刻切入。';

describe('AC-R-014：返修上下文中不得出现 reasoning_content', () => {
  it('带隐藏推理的真实 Provider 响应走完整条链路，返修上下文一个字都不含它', async () => {
    const turns: WireTurn[] = [
      { submit: { kind: 'structure', ...VALID_STRUCTURE } },
      { submit: { kind: 'slot_content', slotId: 'outline', content: outlineText() } },
      { submit: { kind: 'slot_content', slotId: 'title', content: TITLE_TEXT } },
      // scene_01 第 0 稿：同一轮里既有隐藏推理，也有可见输出
      {
        reasoning: HIDDEN_REASONING,
        text: VISIBLE_TEXT,
        submit: { kind: 'slot_content', slotId: 'scene_01', content: DRAFT_0 },
      },
      {
        submit: {
          kind: 'review_result',
          slotId: 'scene_01',
          verdict: 'revise',
          findings: [{ criterionId: 'S1', quote: DRAFT_0.slice(0, 12), problem: PROBLEM_0 }],
        },
      },
      { submit: { kind: 'review_result', slotId: 'scene_01', verdict: 'no_finding', findings: [] } },
      // 返修稿。R6：未降级的返修轮只收编辑清单，整篇正文会被工具层当场拒
      {
        submit: {
          kind: 'slot_edits',
          slotId: 'scene_01',
          edits: [{ oldText: '第一稿。', newText: '第二稿。' }],
        },
      },
      { submit: { kind: 'review_result', slotId: 'scene_01', verdict: 'no_finding', findings: [] } },
      { submit: { kind: 'review_result', slotId: 'scene_01', verdict: 'no_finding', findings: [] } },
      { submit: { kind: 'slot_content', slotId: 'scene_02', content: sceneText('第二场') } },
      { submit: { kind: 'review_result', slotId: 'scene_02', verdict: 'no_finding', findings: [] } },
      { submit: { kind: 'review_result', slotId: 'scene_02', verdict: 'no_finding', findings: [] } },
    ];

    let index = 0;
    const sentBodies: string[] = [];
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.test/v1',
      providerId: 'fake',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBodies.push(String(init.body ?? ''));
        const turn = turns[index];
        index += 1;
        // 脚本用完就自然收敛，不要把测试挂到超时
        if (turn === undefined) {
          return new Response(
            sseStream([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] })]),
            { status: 200 },
          );
        }
        return new Response(sseStream(wireFrames(turn)), { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });

    const h = track(createEngineHarness({ adapter }));
    const taskId = await createAndStart(h);
    await h.engine.drain();

    const fills = fillSlotExecutions(h, taskId, 'scene_01');
    expect(fills).toHaveLength(2);

    // 前提自证：这一条测的必须是「有隐藏推理的那一轮」，否则断言是装饰
    const contextJson = contextJsonOf(h, fills[1]!);
    const parsed = JSON.parse(contextJson) as { revision: StoredRevision | null };
    expect(parsed.revision).not.toBeNull();
    expect(parsed.revision!.priorRounds[0]!.visibleOutput).toContain(VISIBLE_TEXT);

    // 返修上下文里没有隐藏推理，一个字都没有
    expect(contextJson).not.toContain(HIDDEN_REASONING);
    expect(contextJson).not.toContain('隐藏推理');

    // 送回 Provider 的那一份 prompt 同样不含它（context_json 干净不等于 prompt 干净）
    const revisionBody = sentBodies.find((body) => body.includes('返修'));
    expect(revisionBody).toBeDefined();
    expect(revisionBody!).not.toContain('隐藏推理');

    // 落库的 trace 也不许带（NFR-005：绝不进任何 DB 列）
    const traces = h.uow.repositories.traces.listByExecution(fills[0]!.id);
    expect(traces.length).toBeGreaterThan(0);
    expect(JSON.stringify(traces)).not.toContain('隐藏推理');
  }, 30000);
});
