/**
 * 结构审核召回：**直接往引擎里注入一棵坏树**，看四条判据抓不抓得到。
 *
 * ── 为什么不沿用 `run-r4-regression.mjs` 那种「自己拼 prompt 打 API」的写法 ──
 *
 * R4 那条回归自己装配 prompt，因为它要复现 R0.5 的对照条件。这里不行：
 * 结构审核的 prompt 里有**渲染后的结构概要**，而渲染规则、判据注入、
 * 引文闸门全在 `context-builder.ts` 与 `review-evidence.ts` 里。
 * 手拼一份出来，测的就不是生产里真正发出去的那份，**召回数字不转移**。
 *
 * 所以这里跑的是**真引擎**（`createEngineHarness` + 仓库里的 templates/ 与 skills/），
 * 只把结构审核那几次调用放给真模型，其余全部走 FakeProvider：
 *
 *   结构设计 Agent  → FakeProvider（直接吐出我造的坏树，这是本探针的全部意义）
 *   结构审核 Agent  → **真模型**（要测的就是它）
 *   写作 / 场景审核 → 够不着：脚本只有一条，审完就耗尽，任务失败收场
 *
 * 「审完就让它失败」是刻意的省钱设计：结构审核发生在第一个槽位开填之前，
 * 此时写作 token 一个都还没花，四条裁决已经落库。再往下跑没有任何信息增量，
 * 只有账单。任务最终 `failed`，**这不是 bug，是这条探针的正常终态**。
 *
 * ── 路由靠什么区分 ──
 *
 * `adapterFactory` 是按 ProviderEntry 给的，而 harness 把所有条目指向同一个
 * adapter，所以按条目分不开。这里改按 **system prompt 里结构审核 Agent 的
 * systemInstruction** 分流——它逐字来自 `templates/zhihu-chapter/template.yaml`。
 * 模板里那句话改了，这里会**一次真调用都不发**，末尾的 `realCalls === 4`
 * 断言当场炸掉，而不是悄悄测了个空。
 *
 * 用法：
 *   npx tsx probe/bad-tree-recall.ts --dry-run   # 不发任何请求，只打印会送出去的树
 *   npx tsx probe/bad-tree-recall.ts             # 真跑，6 棵树 × 4 条判据 = 24 次调用，花钱
 *   npx tsx probe/bad-tree-recall.ts --only S2-b # 只跑一棵
 *
 * 不覆盖 probe/ 下任何既有文件：结果写 `probe/results-bad-tree.json`。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createEngineHarness } from '../tests/fixtures/engine.ts';
import { FakeProvider } from '../src/server/runtime/provider/fake.ts';
import { OpenAiCompatibleAdapter } from '../src/server/runtime/provider/openai-compatible.ts';
import type {
  ProviderAdapter,
  ProviderRunTurnInput,
  ProviderTurnResult,
} from '../src/server/runtime/provider/provider-adapter.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
// indexOf 找不到时返回 -1，直接 +1 会取到 argv[0]（node 的路径）当成变体名
const ONLY_AT = process.argv.indexOf('--only');
const ONLY = ONLY_AT === -1 ? undefined : process.argv[ONLY_AT + 1];

const PACKET = readFileSync(path.join(REPO_ROOT, 'probe/bad-tree-packet.txt'), 'utf8');

/** 逐字取自 template.yaml 的 structure_reviewer.systemInstruction */
const REVIEWER_MARK = '你负责按指定判据检查章节结构里各槽位的目标';

const MODEL = 'deepseek-v4-flash';
const BASE_URL = 'https://api.deepseek.com/v1';

// ---------------------------------------------------------------------------
// 六棵树。**基线树是干净的，每个变体只动一处**——单变量，否则说不清是哪条判据
// 抓到了什么。每条 instruction 都要能通过 19 条确定性校验（校验管形式，判据管中文）。
// ---------------------------------------------------------------------------

interface Slot {
  id: string;
  type: string;
  parentId: string | null;
  order: number;
  instruction: string;
  dependsOn: string[];
}

/** 干净基线：执行包点名的六件事全部有落点，每场三件事齐全，相邻停点接得上 */
function baseSlots(): Slot[] {
  return [
    { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '本章容器', dependsOn: [] },
    {
      id: 'scene_01',
      type: 'scene',
      parentId: 'chapter',
      order: 1,
      instruction:
        '陈律师当众宣读遗嘱，四房的反应在这一场里全部呈现；周桂芳自始至终没有出声，' +
        '要让读者注意到这份安静。停在陈律师念完最后一行、正厅里没有人接话的静场。',
      dependsOn: [],
    },
    {
      id: 'scene_02',
      type: 'scene',
      parentId: 'chapter',
      order: 2,
      instruction:
        '接住上一场的静场。沈明川拿照顾老太太起居的日常细节作软性证据，与沈明月要尽快脱手祖宅的' +
        '立场正面冲突；沈明远在争执里放了一次那段带杂音的录音，杂音盖住的是哪一句不点破。' +
        '周桂芳仍然不开口。停在沈明月把中介的名片推到桌心、没有人去拿的那一刻。',
      dependsOn: ['scene_01'],
    },
    {
      id: 'scene_03',
      type: 'scene',
      parentId: 'chapter',
      order: 3,
      instruction:
        '接住桌心那张没人拿的名片，四房散到偏厅各自缓神。陈律师单独把沈明远叫到廊下，' +
        '指出遗嘱的签名日期与老太太的住院记录对不上，这一幕不能当众发生。' +
        '停在沈明远把遗嘱按在膝上、一句话没回的时候。',
      dependsOn: ['scene_02'],
    },
    {
      id: 'scene_04',
      type: 'scene',
      parentId: 'chapter',
      order: 4,
      instruction:
        '接住廊下那句没回的话，四房回到正厅继续争。周桂芳在全场争执里始终没开口，' +
        '直到最后她开口，执行包指定这句必须原样出现、一个字都不能改：' +
        '"晓晓的学费，你们谁管"，争执因此停下。' +
        '结尾留下一个下一章可以直接承接的状态：分家会没有结论，但四房各自去做了一件事。',
      dependsOn: ['scene_03'],
    },
    {
      id: 'title',
      type: 'title',
      parentId: 'chapter',
      order: 5,
      instruction: '概括全章，题眼落在一场没有结论的分家会上',
      dependsOn: ['scene_01', 'scene_02', 'scene_03', 'scene_04'],
    },
  ];
}

function withInstruction(slotId: string, instruction: string): Slot[] {
  return baseSlots().map((s) => (s.id === slotId ? { ...s, instruction } : s));
}

interface Variant {
  id: string;
  /** 期望命中的判据。空数组 = 期望四条全不报 */
  expect: string[];
  planted: string;
  slots: Slot[];
}

const VARIANTS: Variant[] = [
  {
    id: 'clean',
    expect: [],
    planted: '无。控制组，量的是误报',
    slots: baseSlots(),
  },
  {
    id: 'S1',
    expect: ['S1'],
    planted: 'scene_02 写了发生什么与冲突什么，但**没写停在哪里**',
    slots: withInstruction(
      'scene_02',
      '接住上一场的静场。沈明川拿照顾老太太起居的日常细节作软性证据，与沈明月要尽快脱手祖宅的' +
        '立场正面冲突；沈明远在争执里放了一次那段带杂音的录音，杂音盖住的是哪一句不点破。' +
        '周桂芳仍然不开口。',
    ),
  },
  {
    id: 'S2-a',
    expect: ['S2'],
    planted: 'scene_02 里塞了两句**结构 Agent 自拟**的对白（执行包里没有这两句）',
    slots: withInstruction(
      'scene_02',
      '接住上一场的静场。沈明川说"这三年是谁端的药、谁半夜爬起来翻的身？"，' +
        '沈明月回"端药抵不了一间房，账要算清楚"，两人正面冲突；' +
        '沈明远在争执里放了一次那段带杂音的录音，杂音盖住的是哪一句不点破。周桂芳仍然不开口。' +
        '停在沈明月把中介的名片推到桌心、没有人去拿的那一刻。',
    ),
  },
  {
    /*
     * **与 clean 是同一棵树，不是第六个变体。** 如实标注，别当成独立样本。
     *
     * 它同时干两件事：
     * 1. S2 例外的检验——基线树 scene_04 里本来就转述了执行包第 5 条**逐字指定、
     *    要求原样出现**的那句台词。今天刚给 S2 加的例外若没生效，S2 会在这里报，
     *    而 finding 的引文会直接指向那句「晓晓的学费，你们谁管」，一眼可辨。
     * 2. 同输入跑两次的一致性检查——四条裁决与 clean 那次是否一样。
     *    不一样就说明单次结果的可重复性有问题，上面所有召回数字都要打折看。
     */
    id: 'clean-repeat',
    expect: [],
    planted: '与 clean 同一棵树。查 S2 例外是否生效，兼做同输入两跑的一致性检查',
    slots: baseSlots(),
  },
  {
    id: 'S3',
    expect: ['S3'],
    planted:
      'scene_02 停在「名片推到桌心」，scene_03 开场却已是三天后祖宅挂牌，' +
      '中间「分家会怎么散的」没有任何槽位承载',
    slots: withInstruction(
      'scene_03',
      '三天后，祖宅门口挂上了待售的牌子。陈律师在牌子底下拦住沈明远，' +
        '指出遗嘱的签名日期与老太太的住院记录对不上，这一幕不能当众发生。' +
        '停在沈明远把遗嘱按在膝上、一句话没回的时候。',
    ),
  },
  {
    id: 'S4',
    expect: ['S4'],
    planted:
      '执行包第 6 条要求「结尾必须留下一个具体的、下一章可以直接承接的状态」，' +
      'scene_04 把它拿掉了（停点还在，但停的是一个封闭的静场，不是可承接的状态）',
    slots: withInstruction(
      'scene_04',
      '接住廊下那句没回的话，四房回到正厅继续争。周桂芳在全场争执里始终没开口，' +
        '直到最后她开口，执行包指定这句必须原样出现、一个字都不能改：' +
        '"晓晓的学费，你们谁管"，争执因此停下。' +
        '停在正厅安静下来、没有人先起身的那一刻。',
    ),
  },
];

// ---------------------------------------------------------------------------

interface Result {
  variant: string;
  expect: string[];
  planted: string;
  fired: string[];
  discarded: string[];
  verdicts: { criterionId: string; verdict: string; quote: string | null; problem: string | null }[];
  /** Agent 循环的 turn 数，**不是判据条数**——一条判据要好几个 turn */
  realCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** 这棵树一共被审了几轮。>1 说明结构重投失败、旧树被留下重审（见预算闸的注释） */
  roundsSeen: number;
  /** 审核执行的成败。失败的执行不写 slot_reviews，只看裁决表会把失败读成「未检出」 */
  executions: { attempt: number; status: string; errorCode: string | null; errorMessage: string | null }[];
}

async function runVariant(variant: Variant): Promise<Result> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === '') throw new Error('DEEPSEEK_API_KEY 未设置');

  const real = new OpenAiCompatibleAdapter({ baseUrl: BASE_URL, providerId: 'deepseek' });
  // 脚本只有一条：吐出这棵树。审完之后脚本耗尽，任务失败收场——见文件头。
  const fake = new FakeProvider({
    turns: [{ submitStructure: { rootSlotId: 'chapter', slots: variant.slots } }],
  });

  let realCalls = 0;
  /*
   * **花钱的闸门，按「第 0 轮已出几条裁决」关，不按调用次数关。**
   *
   * 首跑我按调用次数关，关错了：一次 runTurn 是 Agent 循环的**一个 turn**，
   * 而一次审核执行要好几个 turn（先 read_structure_outline，再 complete_assignment）。
   * 「4 次调用」于是在**第一条判据**就把闸关了，S2/S3/S4 一次都没被评到，
   * 而裁决表里看起来就是「未检出」——和真的未检出长得一模一样。
   *
   * 关闸的理由本身仍然成立：一棵树会被审 3 轮（脚本耗尽后结构重投失败，
   * `StructureService.submit` 要新提案通过校验才替换，失败就留着旧树重审）。
   * 第 0 轮四条裁决齐了之后，后面两轮是同一棵树的重复测量，只烧钱不加信息。
   */
  let round0Done: () => boolean = () => false;
  const hybrid: ProviderAdapter = {
    kind: 'openai-compatible',
    async runTurn(input: ProviderRunTurnInput): Promise<ProviderTurnResult> {
      if (!input.system.includes(REVIEWER_MARK)) return fake.runTurn(input);
      if (round0Done()) throw new Error('PROBE_BUDGET_REACHED：第 0 轮四条判据已出裁决，后续不发真请求');
      // 兜底，防止某条判据一直失败重试把账单跑飞。正常一棵树在 20 turn 以内
      if (realCalls >= 40) throw new Error('PROBE_BUDGET_REACHED：turn 数超过兜底上限 40');
      realCalls += 1;
      // model 与 apiKey 换成真的：harness 的 FAKE_PROVIDERS 里是假模型名。
      // apiKey 只经过这一行，不进日志、不进返回值（REQ §13 / NFR-005）。
      return real.runTurn({ ...input, model: MODEL, apiKey });
    },
  };

  const h = createEngineHarness({
    adapter: hybrid,
    templatesDir: path.join(REPO_ROOT, 'templates'),
    skillsDir: path.join(REPO_ROOT, 'skills'),
  });

  try {
    const created = await h.snapshots.createTask({
      templateId: 'zhihu-chapter',
      name: `坏树召回 ${variant.id}`,
      input: { chapter_packet: PACKET },
    });
    round0Done = (): boolean =>
      h.uow.repositories.slotReviews
        .listBySlot(created.task.id, 'chapter')
        .filter((r) => r.round === 0).length >= 4;

    h.lifecycle.dispatch('start', created.task.id);
    await h.engine.drain();

    const rows = h.uow.repositories.slotReviews.listBySlot(created.task.id, 'chapter');
    // 只取第 0 轮：后面的轮次要么被上面的预算闸拦掉，要么是同一棵树的重复测量
    const round0 = rows.filter((r) => r.round === 0);
    const roundsSeen = new Set(rows.map((r) => r.round)).size;

    /*
     * 审核执行的成败。**没有这一段，一次「四条判据全未检出」和
     * 「三条判据的调用根本没成功」在结果里长得一模一样**——首跑就踩了这个坑：
     * 真调用 4 次，slot_reviews 里只有 1 行，差额全在失败的执行里。
     */
    const execs = h.db
      .prepare(
        `SELECT attempt_number, status, error_code, error_message, input_tokens, output_tokens
           FROM executions
          WHERE task_id = ? AND operation = 'review_slot' ORDER BY started_at`,
      )
      .all(created.task.id) as {
      attempt_number: number;
      status: string;
      error_code: string | null;
      error_message: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }[];
    const verdicts = round0.map((r) => {
      const findings = JSON.parse(r.findingsJson) as { quote: string; problem: string }[];
      const first = findings[0];
      return {
        criterionId: r.criterionId,
        verdict: r.verdict,
        quote: first?.quote ?? null,
        problem: first?.problem ?? null,
      };
    });
    return {
      variant: variant.id,
      expect: variant.expect,
      planted: variant.planted,
      fired: round0.filter((r) => r.verdict === 'revise').map((r) => r.criterionId),
      // `discarded` = 模型报了问题但引文逐字对不上，被闸门丢掉（D-11）。
      // 它既不是检出也不是未检出，混进任何一边都会把数字讲歪。
      discarded: round0.filter((r) => r.verdict === 'discarded').map((r) => r.criterionId),
      verdicts,
      realCalls,
      roundsSeen,
      inputTokens: execs.reduce((n, e) => n + (e.input_tokens ?? 0), 0),
      outputTokens: execs.reduce((n, e) => n + (e.output_tokens ?? 0), 0),
      executions: execs.map((e) => ({
        attempt: e.attempt_number,
        status: e.status,
        errorCode: e.error_code,
        errorMessage: e.error_message?.slice(0, 160) ?? null,
      })),
    };
  } finally {
    h.close();
  }
}

async function main(): Promise<void> {
  const targets = ONLY === undefined ? VARIANTS : VARIANTS.filter((v) => v.id === ONLY);
  if (targets.length === 0) throw new Error(`--only ${String(ONLY)} 没匹配到任何变体`);

  if (DRY_RUN) {
    for (const v of targets) {
      console.log(`\n=== ${v.id} · 期望 ${v.expect.length === 0 ? '全不报' : v.expect.join(',')} ===`);
      console.log(`植入：${v.planted}`);
      for (const s of v.slots) if (s.type !== 'chapter') console.log(`  ${s.id}: ${s.instruction}`);
    }
    console.log(`\n[dry-run] 未发出任何请求。真跑将是 ${String(targets.length * 4)} 次调用。`);
    return;
  }

  const results: Result[] = [];
  for (const v of targets) {
    process.stdout.write(`跑 ${v.id} …`);
    const r = await runVariant(v);
    results.push(r);
    // 判据是否**全部被评过**：不是 4 条裁决，说明有判据的调用根本没成功，
    // 而没成功和「未检出」在裁决表里长得一样。这是首跑踩过的坑，钉死在这里。
    const graded = r.verdicts.length;
    console.log(
      ` 裁决 ${String(graded)}/4${graded === 4 ? '' : ' ⚠ 有判据没评到，本行数字不可信'}` +
        ` · 检出 [${r.fired.join(',') || '无'}] · 期望 [${r.expect.join(',') || '无'}]` +
        (r.discarded.length > 0 ? ` · 引文被丢弃 [${r.discarded.join(',')}]` : '') +
        ` · ${String(r.realCalls)} turn / ${String(r.inputTokens)} in`,
    );
  }

  const out = path.join(REPO_ROOT, 'probe/results-bad-tree.json');
  writeFileSync(out, JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), results }, null, 2));

  console.log('\n=== 汇总 ===');
  let hit = 0;
  let planted = 0;
  let falsePositives = 0;
  for (const r of results) {
    for (const c of r.expect) {
      planted += 1;
      if (r.fired.includes(c)) hit += 1;
    }
    falsePositives += r.fired.filter((c) => !r.expect.includes(c)).length;
  }
  console.log(`召回：${String(hit)}/${String(planted)} 条植入的缺陷被抓到`);
  console.log(`误报：${String(falsePositives)} 条（检出了没有植入的判据）`);
  console.log(`结果已写入 ${out}`);

  console.log(
    `token：${String(results.reduce((n, r) => n + r.inputTokens, 0))} in / ` +
      `${String(results.reduce((n, r) => n + r.outputTokens, 0))} out`,
  );

  const incomplete = results.filter((r) => r.verdicts.length !== 4);
  if (incomplete.length > 0) {
    console.log(
      `\n⚠ ${String(incomplete.length)} 个变体没有拿到 4 条裁决——有判据的调用没成功。` +
        `失败的执行不写 slot_reviews，会被读成「未检出」。上面的召回数字不可信，` +
        `先看 results-bad-tree.json 里的 executions。` +
        `（若所有变体都是 0 条，多半是 template.yaml 的 structure_reviewer.systemInstruction 改了，` +
        `REVIEWER_MARK 对不上，一次真请求都没发出去。）`,
    );
    process.exitCode = 1;
  }
}

await main();
