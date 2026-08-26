/**
 * 返修上下文的**重建**（R3 / D-31 / FR-CTX-005）。
 *
 * 本文件回答一个问题：**一个刚被打回、正准备重新生产的槽位，此前每一轮发生过什么？**
 * 答案只从数据库取——`trace_events`、`slot_reviews`、`executions.context_json`——
 * 因此它是可重建的：进程内存清空之后，凭数据库与冻结快照能算出逐字相同的上下文。
 *
 * ## 为什么不是「跨 execution 存活的会话对象」
 *
 * D-31 把这一条写成实现约束而不是措辞偏好，四条理由任何一条都足以否决活会话：
 *
 * 1. D-10 的迟到结果防护建立在「1 execution = 1 个带 token 的工作单元」上；
 * 2. D-12 的 `context_hash` / `prompt_hash` 要刻画输入，
 *    而「内存里攒的历史」不在任何一列里，两个 hash 于是不再刻画输入；
 * 3. NFR-005：`reasoning_content` 绝不许进任何 DB 列，所以不能直接存 transcript；
 * 4. §8.6 重启恢复：孤儿 execution 会被扫回 pending，内存里的会话对象已经没了。
 *    **一个撑不过重启的连续性等于没有连续性。**
 *
 * ## 为什么要回溯到第 0 轮，而不是只带上一轮
 *
 * D-31 原文是「它自己的产出、它调过的工具与结果、审核意见，**都还在**」，
 * 代价一节也明说「`context_json` **随轮次增长**（预算 2 轮 ⇒ 最多 3 稿，有界）」。
 * 只带一轮会给出常数大小的上下文，失效场景是真实的：
 * 第 0 轮 S1 指出「首段接不上」→ 改好；第 1 轮 S2 指出「心理解释代替事件」→
 * 第 2 轮的 Agent 已不知道 S1 提过什么，重写首段时可能把 S1 的修复改回去，
 * S1 再检出一次，白烧一轮预算——而「有界 3 稿」这个前提正是为了避免这种循环。
 *
 * ## 旧稿从哪里来：沿 `context_json` 逐轮串起来
 *
 * `slots.content_text` 只有**最新**那一稿（每轮 `commitContentForReview` 覆写），
 * 更早的稿子在 slots 表里已经没有了。但它们并没有丢：
 * 第 r 轮那次 fill_slot 的 `executions.context_json` 里，
 * 存着截至第 r-1 轮的全部 `priorRounds`。于是「本轮的 priorRounds =
 * 上一轮那条 execution 记下的 priorRounds + 上一轮自己这一份」。
 * 每一环都是 DB 列，链条整体仍然满足 FR-CTX-005，且大小随轮次线性增长、有界。
 *
 * ## 只记 ID，不存副本
 *
 * 每一轮读过的依赖槽位只记 ID（来自 `tool_call_completed` 的 payload），
 * 正文不进返修段——它由 `renderDependencies` 在同一条 User Message 里现读现渲染，
 * 那一份才是唯一的真相来源（FR-CTX-005）。存副本会与 `slots.content_text` 漂移，
 * 而且会让同一段正文在一条 prompt 里印两遍。
 */

import type { TraceEvent, TraceKind } from '@shared/trace.ts';
import { stripReasoning } from '@server/domain/revision-context.ts';
import type { PriorRound } from '@server/domain/revision-context.ts';
import type { RawFinding } from '@server/domain/review-evidence.ts';
import type { Slot } from '@server/domain/types.ts';
import type { SlotReview } from '@server/infrastructure/database/repositories/index.ts';

/**
 * `report_work` 的五种 trace kind。
 *
 * 不从 `REPORT_WORK_TRACE_KIND` 取值再转成 Set 是有意的：那张表的键是工具入参的
 * type，值才是 kind；这里要的是「哪些 kind 属于 Agent 的公开工作说明」，
 * 与 `TRACE_FILTER_GROUPS.work` 是同一份清单。
 */
const REPORT_WORK_KINDS: readonly TraceKind[] = [
  'work_understanding',
  'work_plan',
  'work_decision',
  'work_progress',
  'work_completion',
];

/** 本模块需要的仓储能力。收窄到三个方法，测试不必造一整个 UnitOfWork */
export interface RevisionSourceRepos {
  readonly traces: { listByExecution(executionId: string): TraceEvent[] };
  readonly slotReviews: {
    listByRound(taskId: string, slotId: string, round: number): SlotReview[];
  };
  readonly executions: { getContextJson(id: string): string | null };
}

function textOf(payload: TraceEvent['payload']): string | null {
  if (payload === null) return null;
  const value = payload['text'];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readSlotIdOf(payload: TraceEvent['payload']): string | null {
  if (payload === null) return null;
  if (payload['toolName'] !== 'read_slot') return null;
  if (payload['ok'] !== true) return null;
  const slotId = payload['slotId'];
  return typeof slotId === 'string' && slotId !== '' ? slotId : null;
}

/**
 * `slot_reviews.findings_json` → `RawFinding[]`。
 *
 * 库里那一列是**已经通过引文校验**的 findings（AC-R-003），所以这里不再校验一遍；
 * 但它仍是一段从 TEXT 列读回来的字符串，parse 失败必须当成「没有 findings」而不是抛错——
 * 抛错会让一个本可以继续的返修轮把整个任务打成 failed。
 */
function parseFindings(findingsJson: string): RawFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsJson);
  } catch {
    return [];
  }
  return toFindings(parsed);
}

function toFindings(parsed: unknown): RawFinding[] {
  if (!Array.isArray(parsed)) return [];
  const findings: RawFinding[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { criterionId, quote, problem } = item as Record<string, unknown>;
    if (typeof criterionId !== 'string') continue;
    if (typeof quote !== 'string') continue;
    if (typeof problem !== 'string') continue;
    findings.push({ criterionId, quote, problem });
  }
  return findings;
}

/** 从一条 execution 的 `context_json` 里取出它当时记下的 priorRounds（截至它自己那一轮之前） */
function earlierRoundsOf(repos: RevisionSourceRepos, executionId: string): PriorRound[] {
  const json = repos.executions.getContextJson(executionId);
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // 这一列由本系统写入，理论上恒为合法 JSON。真坏了也只是少几轮历史，
    // 不该让一个能继续的返修轮炸掉——降级成「没有更早的轮次」。
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const revision = (parsed as { revision?: unknown }).revision;
  if (typeof revision !== 'object' || revision === null) return [];
  const rounds = (revision as { priorRounds?: unknown }).priorRounds;
  if (!Array.isArray(rounds)) return [];

  const result: PriorRound[] = [];
  for (const item of rounds) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw['visibleOutput'] !== 'string') continue;
    if (typeof raw['submittedContent'] !== 'string') continue;
    const readSlotIds = Array.isArray(raw['readSlotIds'])
      ? raw['readSlotIds'].filter((id): id is string => typeof id === 'string')
      : [];
    result.push({
      visibleOutput: raw['visibleOutput'],
      readSlotIds,
      submittedContent: raw['submittedContent'],
      findings: toFindings(raw['findings']),
    });
  }
  return result;
}

/** 重建单独一轮：那一轮的对话轮次、读过的槽位、提交的正文、该轮的 findings */
function roundOf(
  repos: RevisionSourceRepos,
  slot: Slot,
  executionId: string,
  submittedContent: string,
  round: number,
): PriorRound {
  const turns: string[] = [];
  const readSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();

  // listByExecution 按 sequence 升序返回，于是重建出来的顺序就是当时发生的顺序。
  for (const event of repos.traces.listByExecution(executionId)) {
    if (event.kind === 'public_output_chunk') {
      const text = textOf(event.payload);
      // stripReasoning 在这里是**纵深防御**，不是第一道防线（见 revision-context.ts 的说明）：
      // 隐藏推理在 Provider adapter 的 Zod schema 处就进不了内存，
      // trace payload 的键名黑名单（trace.ts）是第二道。这里是第三道。
      if (text !== null) turns.push(stripReasoning({ content: text }));
      continue;
    }
    if (REPORT_WORK_KINDS.includes(event.kind)) {
      turns.push(stripReasoning({ content: `${event.title}：${event.summary}` }));
      continue;
    }
    if (event.kind === 'tool_call_completed') {
      const slotId = readSlotIdOf(event.payload);
      // 同一个槽位读两次只记一次：重复只会撑大上下文，不增加任何信息
      if (slotId !== null && !seenSlotIds.has(slotId)) {
        seenSlotIds.add(slotId);
        readSlotIds.push(slotId);
      }
    }
  }

  const findings: RawFinding[] = [];
  for (const review of repos.slotReviews.listByRound(slot.taskId, slot.slotId, round)) {
    findings.push(...parseFindings(review.findingsJson));
  }

  return { visibleOutput: turns.join('\n\n'), readSlotIds, submittedContent, findings };
}

/**
 * 重建第 0 … N-1 轮（N = `slot.revisionRound`）。返回空数组表示「这不是一次返修」。
 *
 * 三个空数组分支各有其义，不能合并成一个「差不多就是没有」：
 * - `revisionRound === 0`：首稿，或者 stop / 孤儿恢复回来的 pending
 *   （`cancelReview` 刻意不递增轮次，见 AC-R-012）——都没有上一轮审核意见；
 * - 没有 producer：槽位从未被任何 execution 写过，没有上一轮对话可言；
 * - 没有正文：上一稿丢了，此时装一段「上一稿：（空）」只会误导模型。
 */
export function collectPriorRounds(repos: RevisionSourceRepos, slot: Slot): PriorRound[] {
  if (slot.revisionRound <= 0) return [];
  const producerExecutionId = slot.producer?.executionId ?? null;
  if (producerExecutionId === null) return [];
  const submittedContent = slot.contentText;
  if (submittedContent === null) return [];

  // 上一轮那条 execution 记下的是「截至第 N-2 轮」的历史，
  // 再补上它自己那一轮（第 N-1 轮），就得到完整的 0 … N-1。
  const earlier = earlierRoundsOf(repos, producerExecutionId);
  const latest = roundOf(repos, slot, producerExecutionId, submittedContent, slot.revisionRound - 1);
  return [...earlier, latest];
}
