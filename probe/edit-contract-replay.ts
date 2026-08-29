/**
 * 「返修提交编辑清单」这个契约，模型配不配合（`notes/REVISION-GRANULARITY-DESIGN-V0.1.md` §6）。
 *
 * ── 它要答的三个问题 ────────────────────────────────────────────
 *
 * 1. 模型能不能产出**逐字命中当前正文**的 `oldText`（D-62）；
 * 2. 换成编辑清单之后，**附带改动率**降不降；
 * 3. 模型有多少次**拒绝配合**（对不上、整篇塞进一条编辑、干脆走整篇提交）。
 *
 * 第 3 项是设计文档里点名的最大未知。引文闸门 14/14 是旁证不是直证——
 * 那是「引一句」，这是「引一句并改写它」。
 *
 * ── 重建的 prompt 是不是当年那一份，不靠我说 ──────────────────
 *
 * 历史库里存着每次返修的 `context_json` 与 `context_hash`。这里从库里把
 * `FillSlotContextInput` 重建出来、调**生产的 `buildContext`**，
 * 然后拿算出来的 `contextHash` 与库里那一列**逐字对账**。对不上就跳过并报出来，
 * 绝不拿一份「大概差不多」的 prompt 去测。
 *
 * 对账覆盖的是 D-12 那份语义输入（执行包、槽位目标、依赖正文、Skill 版本与注入章节、
 * 全部往轮旧稿与 findings、校验参数）。**没覆盖**的只有两处，都不影响本次结论：
 * 结构概要（由当前槽位树渲染，这三个任务期间没换过树）与「第 n 次尝试」那句话。
 *
 * ── 相对生产的**唯一**改动 ────────────────────────────────────
 *
 * 把 userText 里那段返修提交约定（「……然后提交完整正文」）换成编辑清单约定，
 * 并把工具换成只接受 edits 的那一个。改动前后的原文都打进结果 JSON，可核对。
 *
 * 用法（对副本跑，不要直接开 data/ 下的库）：
 *   cp data/forge-core.sqlite /tmp/copy.sqlite
 *   npx tsx --env-file=.env probe/edit-contract-replay.ts /tmp/copy.sqlite --dry-run
 *   npx tsx --env-file=.env probe/edit-contract-replay.ts /tmp/copy.sqlite
 *
 * 结果写 `probe/results-edit-contract.json`，不覆盖 probe/ 下任何既有文件。
 */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createEngineHarness } from '../tests/fixtures/engine.ts';
import { buildContext } from '../src/server/application/context-builder.ts';
import { deriveMaxTokens } from '../src/server/application/production-engine.ts';
import type { PriorRound } from '../src/server/domain/revision-context.ts';
import { OpenAiCompatibleAdapter } from '../src/server/runtime/provider/openai-compatible.ts';
import type { ProviderToolCall } from '../src/server/runtime/provider/provider-adapter.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DB_PATH = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
/** `--only 149773d9/scene1_call#0,...` 只重放指定的几次，用来补跑失败的那些 */
const ONLY_AT = process.argv.indexOf('--only');
const ONLY = ONLY_AT === -1 ? null : new Set((process.argv[ONLY_AT + 1] ?? '').split(','));
const MODEL = 'deepseek-v4-flash';
const BASE_URL = 'https://api.deepseek.com/v1';
/** 生产的 runAgentLoop 上限更高；这里够跑完「想一轮 → 提交一轮」就行 */
const MAX_TURNS = 4;

if (DB_PATH === undefined) throw new Error('用法：edit-contract-replay.ts <db 副本路径> [--dry-run]');

// ---------------------------------------------------------------------------
// 归一化：与 domain/review-evidence.ts 的 normalizeForComparison 同源。
// 两边不一致，这里算出来的「逐字命中」就不是引文闸门认的那个。
// ---------------------------------------------------------------------------
const QUOTE_PATTERN = /[“”„«»‘’"'＂＇]/g;
const WHITESPACE_PATTERN = /\s+/g;
const normalize = (t: string): string => t.replace(QUOTE_PATTERN, '"').replace(WHITESPACE_PATTERN, '');

/** 生产返修段里那两句，原文见 context-builder.ts 的 renderFillSlotRevision */
const PRODUCTION_SUBMIT_LINES = [
  '请针对尚未解决的问题定点修改，未被指出问题的部分保持原样，然后提交完整正文。',
  '注意：往轮已经改好的地方不要改回去。',
].join('\n');

/** 换上去的编辑清单约定（D-61…D-63、D-65） */
const EDIT_CONTRACT = [
  '请针对尚未解决的问题定点修改。**这一轮不提交完整正文，提交一份编辑清单。**',
  '',
  '调用 complete_assignment，参数形如：',
  '{"kind":"slot_edits","edits":[{"oldText":"要被替换掉的原文","newText":"替换成什么"}]}',
  '',
  '规则：',
  '1. oldText 必须**逐字**出现在上一轮那份正文里，一个字都不能差（标点、语气词都算）。',
  '   系统会用代码逐字核对，对不上的整份退回。',
  '2. oldText 必须在正文里**唯一**。可能出现多处时，把它加长到唯一为止。',
  '3. 没有写进清单的段落**原样保留**，不需要你重复一遍。',
  '4. 你可以修改没有被判据点名的地方（比如为了衔接通顺），但**必须把它写成一条编辑**——',
  '   不允许悄悄改动。',
  '5. 一条编辑的 oldText 不得超过上一稿的一半。整篇需要重排时，',
  '   改用 {"kind":"slot_content","content":"完整正文"} 提交，这会被记为整篇重写。',
].join('\n');

// ---------------------------------------------------------------------------

interface Replay {
  label: string;
  round: number;
  contextHashMatched: boolean;
  /** 模型选了哪条路：编辑清单 / 整篇重写（D-65 退路）/ 没提交 */
  submission: 'slot_edits' | 'slot_content' | 'none';
  editCount: number;
  /** oldText 逐字对不上的条数 */
  unmatched: number;
  /** oldText 在正文里不唯一的条数 */
  ambiguous: number;
  /** oldText 超过上一稿一半的条数 */
  oversized: number;
  applied: boolean;
  /** 编辑覆盖的全部字数（含被 finding 点名的、本来就该改的部分） */
  changedChars: number;
  /** 其中**不与任何引文重叠**的字数。这一项才与历史那张表的「附带改动」同口径 */
  collateralChars: number;
  oldChars: number;
  /** 历史上那次返修的附带改动率，用来对照 */
  historicalCollateralPct: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 走了几个 turn。首版只跑 1 个，把截断读成了「拒绝配合」 */
  turns: number;
  /** 最后一轮的 stopReason。`max_tokens` = 被上限截断，不是模型不肯提交 */
  lastStopReason: string | null;
  error: string | null;
}

async function main(): Promise<void> {
  // 接副本库。harness 只用来拿装配好的 uow/snapshots 与同一套迁移，
  // 它的 FakeProvider 一次都不会被调到——真请求由下面的 adapter 直接发。
  const h = createEngineHarness({
    dbPath: DB_PATH,
    templatesDir: path.join(REPO_ROOT, 'templates'),
    skillsDir: path.join(REPO_ROOT, 'skills'),
  });
  const { db, uow, snapshots } = h;

  const revised = db
    .prepare(
      `SELECT task_id, slot_id FROM slots WHERE revision_round > 0 AND content_text IS NOT NULL
        ORDER BY task_id, slot_id`,
    )
    .all() as { task_id: string; slot_id: string }[];

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!DRY_RUN && (apiKey === undefined || apiKey === '')) throw new Error('DEEPSEEK_API_KEY 未设置');
  const real = new OpenAiCompatibleAdapter({ baseUrl: BASE_URL, providerId: 'deepseek' });

  const results: Replay[] = [];

  for (const { task_id: taskId, slot_id: slotId } of revised) {
    const snapshot = snapshots.readSnapshot(taskId);
    const slots = uow.repositories.slots.listByTask(taskId);
    const targetSlot = slots.find((s) => s.slotId === slotId);
    if (targetSlot === undefined) continue;

    const slotType = snapshot.compiled.slotTypes.find((t) => t.id === targetSlot.type);
    const binding = snapshot.compiled.bindings.fillSlotByType[targetSlot.type];
    if (slotType === undefined || binding === undefined) continue;
    const skill = snapshot.skills[binding.skillId];
    const agent = snapshot.compiled.agents.find((a) => a.id === binding.agentId);
    if (skill === undefined || agent === undefined) continue;

    const execs = db
      .prepare(
        `SELECT context_json, context_hash FROM executions
          WHERE task_id=? AND target_slot_id=? AND operation='fill_slot' AND status='succeeded'
          ORDER BY attempt_number`,
      )
      .all(taskId, slotId) as { context_json: string; context_hash: string }[];

    for (const exec of execs) {
      const stored = JSON.parse(exec.context_json) as {
        // 首稿这一列是 null（不是 undefined）——canonicalJson 会把它写出来
        revision: { round: number; priorRounds: PriorRound[] } | null;
        dependencies: { slotId: string; content: string }[];
      };
      if (stored.revision === null || stored.revision === undefined) continue; // 首稿，不是返修

      const built = buildContext({
        operation: 'fill_slot',
        snapshot,
        agent,
        skill,
        attemptNumber: 1,
        maxAttempts: binding.maxRetries + 1,
        slots,
        targetSlot,
        slotType,
        dependencies: stored.dependencies,
        retry: null,
        revision: { round: stored.revision.round, priorRounds: stored.revision.priorRounds },
      });

      const matched = built.contextHash === exec.context_hash;
      const priorRounds = stored.revision.priorRounds;
      const lastDraft = priorRounds[priorRounds.length - 1]?.submittedContent ?? '';
      const label = `${taskId.slice(0, 8)}/${slotId}`;
      const roundIndex = stored.revision.round - 1;
      if (ONLY !== null && !ONLY.has(`${label}#${String(roundIndex)}`)) continue;

      const base: Replay = {
        label,
        round: roundIndex,
        contextHashMatched: matched,
        submission: 'none',
        editCount: 0,
        unmatched: 0,
        ambiguous: 0,
        oversized: 0,
        applied: false,
        changedChars: 0,
        collateralChars: 0,
        oldChars: normalize(lastDraft).length,
        historicalCollateralPct: 0,
        inputTokens: null,
        outputTokens: null,
        turns: 0,
        lastStopReason: null,
        error: null,
      };

      if (!matched) {
        base.error = '重建的 contextHash 与库里对不上，跳过——不拿近似的 prompt 去测';
        results.push(base);
        continue;
      }

      if (!built.userText.includes(PRODUCTION_SUBMIT_LINES)) {
        base.error = 'context-builder 里那段返修提交约定的原文变了，本探针的替换失效';
        results.push(base);
        continue;
      }
      const userText = built.userText.replace(PRODUCTION_SUBMIT_LINES, EDIT_CONTRACT);

      if (DRY_RUN) {
        console.log(`\n===== ${label} 第 ${String(roundIndex)} 轮 · contextHash ✅ 对上 =====`);
        console.log(`上一稿 ${String(base.oldChars)} 字，本轮 findings ${String(
          priorRounds[priorRounds.length - 1]?.findings.length ?? 0,
        )} 条`);
        console.log(EDIT_CONTRACT.split('\n').slice(0, 4).join('\n'));
        results.push(base);
        continue;
      }

      let submitted: { kind?: string; edits?: { oldText: string; newText: string }[] } | null = null;
      try {
        /*
         * **多轮循环，参数照生产。**
         *
         * 首版这里只跑一个 turn、maxTokens 给了 8000，结果 10 次里 6 次「没提交」——
         * 而生产走的是 `runAgentLoop`（多轮），maxTokens 由 `deriveMaxTokens(slotType)`
         * 派生（场景槽 = 16384）。平均输出 7170 token、上限 8000，那 6 次多半是被我
         * 截断在半路，不是模型拒绝配合。把一个探针自己的缺陷读成模型的行为，
         * 是这一轮最该防的错。
         */
        const messages: { role: 'user' | 'assistant'; content: string }[] = [
          { role: 'user', content: userText },
        ];
        let turn = null as Awaited<ReturnType<typeof real.runTurn>> | null;
        for (let i = 0; i < MAX_TURNS && submitted === null; i += 1) {
          turn = await real.runTurn({
          model: MODEL,
          apiKey: apiKey as string,
          system: built.systemText,
          messages,
          tools: [
            {
              name: 'complete_assignment' as never,
              description: '提交本轮工作成果。返修轮请提交编辑清单。',
              parameters: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['slot_edits', 'slot_content'] },
                  edits: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
                      required: ['oldText', 'newText'],
                    },
                  },
                  content: { type: 'string' },
                },
                required: ['kind'],
              },
            },
          ],
          // 与生产同源：deriveMaxTokens(slotType)，场景槽 = 16384
          maxTokens: deriveMaxTokens(slotType),
          signal: AbortSignal.timeout(180000),
          onTextDelta: () => undefined,
          onToolCall: async (call: ProviderToolCall) => {
            // adapter 给的是 argumentsJson 字符串，不是解析好的对象。
            // 解不出来也算一种「拒绝配合」——如实记下，别当成没提交。
            try {
              submitted = JSON.parse(call.argumentsJson) as typeof submitted;
            } catch {
              submitted = { kind: 'unparseable' } as typeof submitted;
            }
            return { toolCallId: call.id, content: '已收到', isError: false };
          },
          });
          base.inputTokens = (base.inputTokens ?? 0) + (turn.usage?.inputTokens ?? 0);
          base.outputTokens = (base.outputTokens ?? 0) + (turn.usage?.outputTokens ?? 0);
          base.turns = i + 1;
          base.lastStopReason = turn.stopReason;
          // 把本轮该追加的消息接上，下一轮才是接着说而不是重头说。
          // `appendMessages` 在 max_tokens 那条分支上可能是 undefined——
          // 首版没兜住，4 次被截断的重放全部崩在这里，还被我读成了「没提交」。
          for (const m of turn.appendMessages ?? []) {
            const content = (m as { content?: unknown }).content;
            if (typeof content === 'string' && content !== '') {
              messages.push({ role: 'assistant', content });
            }
          }
          if (turn.stopReason === 'max_tokens' && submitted === null) {
            // 被上限截断：像生产那样再给一轮，并明确要求它直接提交，别重讲一遍
            messages.push({
              role: 'user',
              content: '你上一轮的输出被长度上限截断了。请**不要**重述正文，直接调用 complete_assignment 提交编辑清单。',
            });
          }
          // 说完了又没提交，再问一轮也不会变——生产的循环同样以 end_turn 收口
          if (turn.stopReason === 'end_turn' && submitted === null) break;
        }
      } catch (error) {
        base.error = error instanceof Error ? error.message.slice(0, 200) : String(error);
        results.push(base);
        continue;
      }

      if (submitted === null || submitted === undefined) {
        base.error = '模型没有调用 complete_assignment';
        results.push(base);
        continue;
      }

      const kind = (submitted as { kind?: string }).kind;
      if (kind === 'unparseable') {
        base.error = '工具入参不是合法 JSON';
        results.push(base);
        continue;
      }
      if (kind !== 'slot_edits' && kind !== 'slot_content') {
        base.error = `kind 不在契约里：${String(kind)}`;
        results.push(base);
        continue;
      }
      if (kind === 'slot_content') {
        base.submission = 'slot_content'; // D-65 退路
        results.push(base);
        continue;
      }

      base.submission = 'slot_edits';
      const edits = (submitted as { edits?: { oldText: string; newText: string }[] }).edits ?? [];
      base.editCount = edits.length;

      const normDraft = normalize(lastDraft);
      let applied = lastDraft;
      let ok = true;
      for (const edit of edits) {
        const normOld = normalize(edit.oldText);
        const first = normDraft.indexOf(normOld);
        if (normOld === '' || first === -1) {
          base.unmatched += 1;
          ok = false;
          continue;
        }
        if (normDraft.indexOf(normOld, first + 1) !== -1) {
          base.ambiguous += 1;
          ok = false;
        }
        if (normOld.length * 2 > normDraft.length) base.oversized += 1;
        // 应用到原文而非归一化文本：归一化删了空白，回填不回去
        if (applied.includes(edit.oldText)) applied = applied.replace(edit.oldText, edit.newText);
      }
      base.applied = ok && base.oversized === 0;
      base.changedChars = edits.reduce((n, e) => n + normalize(e.oldText).length, 0);

      /*
       * **可比口径。** 历史那张表算的是「附带改动」= 改了但没被 finding 点名的字数；
       * 这里若拿「编辑覆盖的全部字数」去比，等于拿「含该改的」比「不含该改的」，
       * 数字会虚高。所以这里也只数**不与任何引文重叠**的编辑。
       */
      const quotes = (priorRounds[priorRounds.length - 1]?.findings ?? [])
        .map((f) => normalize(f.quote))
        .filter((q) => q !== '');
      base.collateralChars = edits.reduce((n, e) => {
        const o = normalize(e.oldText);
        const flagged = quotes.some((q) => o.includes(q) || q.includes(o));
        return flagged ? n : n + o.length;
      }, 0);
      results.push(base);
    }
  }

  // 历史对照：把 revision-granularity 那张表的数字贴进来对齐（同一批返修）
  const HISTORICAL: Record<string, number> = {
    '149773d9/scene1_call#0': 12.0,
    '149773d9/scene2_files#0': 5.7,
    'be335ae4/scene1#0': 7.3,
    'be335ae4/scene1#1': 16.3,
    'be335ae4/scene3#0': 24.2,
    'd4fda471/scene_001#0': 14.4,
    'd4fda471/scene_003#0': 72.8,
    'd4fda471/scene_003#1': 3.1,
    'd4fda471/scene_004#0': 9.1,
    'd4fda471/scene_004#1': 42.2,
  };
  for (const r of results) r.historicalCollateralPct = HISTORICAL[`${r.label}#${String(r.round)}`] ?? 0;

  if (!DRY_RUN) {
    // --only 的补跑不许覆盖整跑的结果——那次就是这么把 v2 的 10 条冲成 4 条的
    writeFileSync(
      path.join(
        REPO_ROOT,
        ONLY === null ? 'probe/results-edit-contract.json' : 'probe/results-edit-contract-partial.json',
      ),
      JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), editContract: EDIT_CONTRACT, results }, null, 2),
    );
  }

  console.log('\n=== 汇总 ===');
  const usable = results.filter((r) => r.contextHashMatched);
  console.log(`contextHash 对上 ${String(usable.length)}/${String(results.length)} 次返修`);
  if (DRY_RUN) {
    console.log('[dry-run] 未发出任何请求。');
    return;
  }
  const asEdits = usable.filter((r) => r.submission === 'slot_edits');
  const fellBack = usable.filter((r) => r.submission === 'slot_content');
  const none = usable.filter((r) => r.submission === 'none');
  console.log(`提交编辑清单 ${String(asEdits.length)} · 走整篇退路 ${String(fellBack.length)} · 没提交 ${String(none.length)}`);
  console.log(
    `编辑清单里：oldText 对不上 ${String(asEdits.reduce((n, r) => n + r.unmatched, 0))} 条 · ` +
      `不唯一 ${String(asEdits.reduce((n, r) => n + r.ambiguous, 0))} 条 · ` +
      `超过半篇 ${String(asEdits.reduce((n, r) => n + r.oversized, 0))} 条`,
  );
  console.log(`整份可应用 ${String(asEdits.filter((r) => r.applied).length)}/${String(asEdits.length)}`);
  console.log('\n每次返修：**附带改动**对照（同口径：都只数没被 finding 点名的部分）');
  for (const r of usable) {
    const now = r.oldChars > 0 ? (r.collateralChars / r.oldChars) * 100 : 0;
    const all = r.oldChars > 0 ? (r.changedChars / r.oldChars) * 100 : 0;
    console.log(
      `  ${r.label}#${String(r.round)}  历史 ${r.historicalCollateralPct.toFixed(1)}%  → ` +
        `本次 ${now.toFixed(1)}%（编辑共覆盖 ${all.toFixed(1)}%，${String(r.editCount)} 条，` +
        `${String(r.turns)} turn/${r.lastStopReason ?? '—'}）` +
        (r.error === null ? '' : `  ⚠ ${r.error}`),
    );
  }
  console.log(
    `\ntoken：${String(usable.reduce((n, r) => n + (r.inputTokens ?? 0), 0))} in / ` +
      `${String(usable.reduce((n, r) => n + (r.outputTokens ?? 0), 0))} out`,
  );
}

await main();
