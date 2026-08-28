/**
 * 生产流程投影：把一个槽位的执行序列折成「轮」。
 *
 * 右栏的产物视图答「产出是什么」，这一层答「产出经历了什么」。两者读的是同一批
 * execution 与 trace，区别只在组织方式——所以这里是**纯投影，不新增任何持久化**。
 *
 * 与 `presentation.ts` 同一条纪律：呈现在服务端算，前端只渲染不判断。
 * 纯函数、零 IO、不读时钟——运行中的执行耗时为 null，由调用方决定要不要补。
 *
 * ── 两条推导规则，都不是拍脑袋定的 ──────────────────────────────
 *
 * 1. **轮次不落库，从执行序列推。**
 *    `slot_reviews.round` 存了轮次，但**失败的审核执行不写 slot_reviews**
 *    （`settleReview` 只在有裁决时插行），直接 join 会让失败凭空消失。
 *    改为：一次 `fill_slot` **且本轮已经出现过 review** 时开新一轮。
 *    「已经出现过 review」这个条件是必须的——填槽自身失败会重试，
 *    连续两次 fill 属于同一轮，少了这个条件会多算出一轮空轮。
 *
 * 2. **失败执行的判据 ID 是推出来的，库里没存。**
 *    `executions` 表没有 criterion_id 列，判据只存在 `slot_reviews` 里。
 *    推法：本轮 review 执行按 attempt 顺序走，成功的那次消费掉当前判据并前移指针，
 *    失败的那次**不前移**——因为 `findNextCriterion` 找的是「没有 slot_reviews 行」
 *    的第一条判据，失败没写行，所以下一次派发的还是同一条。
 *
 *    这条推导的正确性**建立在 `findNextCriterion` 的行为上**，而那个行为没有任何
 *    地方强制。真正的解法是给 executions 加一列 criterion_id，让数据自解释；
 *    在那之前，`production-flow.test.ts` 里有一条用例专门钉住这个推导。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type { ExecutionStatus } from '@shared/contracts.ts';
import { SLOT_TERMINAL_KINDS, type TraceKind } from '@shared/trace.ts';
import type { Execution } from './types.ts';

// ---------- 输入 ----------

export type ReviewVerdict = 'no_finding' | 'revise' | 'discarded';

/** 判据表，取自任务冻结的审核 Skill 快照。顺序即 SKILL.md 的书写顺序 */
export interface FlowCriterion {
  readonly id: string;
  readonly title: string;
}

export interface FlowFinding {
  readonly quote: string;
  readonly problem: string;
}

/** `slot_reviews` 的一行，findings 已由调用方解析 */
export interface FlowReviewRecord {
  readonly criterionId: string;
  readonly executionId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly FlowFinding[];
}

/**
 * 系统结算事件（`execution_id IS NULL` 的那些）。
 * 它收口的是一整轮判据，不属于其中任何一次 execution——
 * 这正是 R2 那次界面缺陷的成因，见 `RightPanel.tsx` 里 scopeTraces 的注释。
 */
export interface FlowSettlement {
  /**
   * 它收口的是哪一轮。取自 trace payload 里写着的 `revisionRound`，**不靠位置猜**。
   *
   * 早先这里是「第 i 条结算归第 i 轮」。那个写法把「结算与轮次一一对应且同序」
   * 变成了调用方必须遵守的隐含契约，而调用方要从几百条轨迹里筛出这几条，
   * 顺序恰恰是它最容易搞错的东西。既然事件自己写着轮号，就按轮号对。
   */
  readonly round: number;
  readonly kind: TraceKind;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface SlotFlowInput {
  readonly slotId: string;
  /** 整个任务的执行，函数自己按 targetSlotId 筛 */
  readonly executions: readonly Execution[];
  readonly reviews: readonly FlowReviewRecord[];
  /** 该槽位类型绑定的审核 Skill 判据；没有审核绑定时为空数组 */
  readonly criteria: readonly FlowCriterion[];
  /** 该槽位的轮次结算事件。顺序无关，按各自的 `round` 归位 */
  readonly settlements: readonly FlowSettlement[];
}

// ---------- 输出 ----------

export interface FlowNode {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly status: ExecutionStatus;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** 运行中为 null——domain 不读时钟 */
  readonly durationMs: number | null;
  readonly errorCode: ErrorCode | null;
  readonly errorMessage: string | null;
}

export interface FlowReviewNode extends FlowNode {
  readonly criterionId: string;
  readonly criterionTitle: string | null;
  /** 判据 ID 是从 slot_reviews 读到的还是推出来的。推出来的那些不该当成事实展示 */
  readonly criterionInferred: boolean;
  /** 失败执行没有裁决 */
  readonly verdict: ReviewVerdict | null;
  readonly findings: readonly FlowFinding[];
}

export interface FlowRound {
  readonly round: number;
  /** 同一轮里可能有多次填槽（前面的失败重试过） */
  readonly fills: readonly FlowNode[];
  readonly reviews: readonly FlowReviewNode[];
  /** 检出了问题的判据数 */
  readonly firedCount: number;
  /** 未检出的判据数——默认折叠的就是这些，数量必须说出来（D-30） */
  readonly cleanCount: number;
  /** 本轮的系统结算；槽位还在跑时为 null */
  readonly settlement: FlowSettlement | null;
}

export interface SlotFlow {
  readonly slotId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rounds: readonly FlowRound[];
  /** 全流程的收口（完成 / 返修次数用尽）。还在跑时为 null */
  readonly ending: FlowSettlement | null;
}

const TERMINAL_KINDS: ReadonlySet<string> = new Set(SLOT_TERMINAL_KINDS);

function durationOf(execution: Execution): number | null {
  if (execution.startedAt === null || execution.finishedAt === null) return null;
  return Date.parse(execution.finishedAt) - Date.parse(execution.startedAt);
}

function nodeOf(execution: Execution): FlowNode {
  return {
    executionId: execution.id,
    attemptNumber: execution.attemptNumber,
    status: execution.status,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    durationMs: durationOf(execution),
    errorCode: execution.errorCode,
    errorMessage: execution.errorMessage,
  };
}

/** 可变的在建轮次。对外返回的是只读形状，这个不出这个文件 */
interface RoundDraft {
  fills: Execution[];
  reviews: Execution[];
}

/**
 * 切轮：一次 `fill_slot` **且本轮已出现过 review** 时开新一轮。
 * 见文件头规则 1——少了后半个条件，填槽重试会被误算成新一轮。
 */
function splitRounds(executions: readonly Execution[]): RoundDraft[] {
  const rounds: RoundDraft[] = [];
  let current: RoundDraft | null = null;

  for (const execution of executions) {
    const isFill = execution.operation === 'fill_slot';
    if (current === null || (isFill && current.reviews.length > 0)) {
      current = { fills: [], reviews: [] };
      rounds.push(current);
    }
    if (isFill) current.fills.push(execution);
    else current.reviews.push(execution);
  }
  return rounds;
}

/**
 * 给本轮的 review 执行配判据。见文件头规则 2。
 *
 * 指针只在「这次执行有 slot_reviews 行」时前移；失败的那次沿用当前判据，
 * 因为引擎下一次派发的还是它。
 */
function attachCriteria(
  reviews: readonly Execution[],
  byExecution: ReadonlyMap<string, FlowReviewRecord>,
  criteria: readonly FlowCriterion[],
  titleOf: ReadonlyMap<string, string>,
): FlowReviewNode[] {
  const nodes: FlowReviewNode[] = [];
  let cursor = 0;

  for (const execution of reviews) {
    const record = byExecution.get(execution.id);
    // 判据 ID 优先取库里的事实；取不到（执行失败，没写 slot_reviews）才按指针推。
    // 指针也越界时给空串而不是崩——投影层不该因为数据缺角就让整个页面打不开。
    const inferredId = criteria[cursor]?.id ?? '';
    const criterionId = record?.criterionId ?? inferredId;

    nodes.push({
      ...nodeOf(execution),
      criterionId,
      criterionTitle: titleOf.get(criterionId) ?? null,
      criterionInferred: record === undefined,
      verdict: record?.verdict ?? null,
      findings: record?.findings ?? [],
    });

    if (record !== undefined) cursor += 1;
  }
  return nodes;
}

/**
 * 把一个槽位的生产过程折成流程。
 *
 * 不做的事：不读正文、不拼提示词、不碰 trace 明细。节点内部的运行过程按需另取——
 * 一个槽位的 trace 可以有几百条（实测 scene1 是 685 条 / 81.7 KB），
 * 跟着流程骨架一起返回等于把面板变成第二个 firehose。
 */
export function deriveSlotFlow(input: SlotFlowInput): SlotFlow {
  const mine = input.executions
    .filter((e) => e.targetSlotId === input.slotId)
    .slice()
    .sort((a, b) => a.attemptNumber - b.attemptNumber);

  const byExecution = new Map(input.reviews.map((r) => [r.executionId, r]));
  const titleOf = new Map(input.criteria.map((c) => [c.id, c.title]));
  const settlementOf = new Map(input.settlements.map((s) => [s.round, s]));

  const rounds = splitRounds(mine).map((draft, index): FlowRound => {
    const reviews = attachCriteria(draft.reviews, byExecution, input.criteria, titleOf);
    return {
      round: index,
      fills: draft.fills.map(nodeOf),
      reviews,
      firedCount: reviews.filter((r) => r.findings.length > 0).length,
      // 只数「有裁决且没检出」的。失败执行既不算通过也不算检出——
      // 把它并进 cleanCount 就等于在界面上说「这条判据看过了没问题」，那是假话。
      cleanCount: reviews.filter((r) => r.verdict !== null && r.findings.length === 0).length,
      settlement: settlementOf.get(index) ?? null,
    };
  });

  // 收口取**轮号最大**的那一条，不是数组里的最后一个：后者要求调用方保证顺序。
  let last: FlowSettlement | null = null;
  for (const item of input.settlements) {
    if (last === null || item.round > last.round) last = item;
  }

  return {
    slotId: input.slotId,
    calls: mine.length,
    inputTokens: mine.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0),
    outputTokens: mine.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0),
    rounds,
    ending: last !== null && TERMINAL_KINDS.has(last.kind) ? last : null,
  };
}
