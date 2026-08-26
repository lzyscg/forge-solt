/**
 * 返修上下文装配与隐藏推理剥离（D-31 / AC-R-014）。
 *
 * 返修轮的 fill_slot execution，其 DeterministicContext 在原有四项之外追加：
 * 1. 上一轮 Agent 的公开输出（已剥离隐藏推理）
 * 2. 上一轮读过哪些依赖槽位（只存 ID，内容装配时现取——FR-CTX-005）
 * 3. 上一轮提交的正文
 * 4. 通过引文校验的 findings（带判据 ID + 引文 + 问题说明）
 *
 * 装配是纯函数：同一输入逐字同输出。
 *
 * 隐藏推理剥离（AC-R-014 / REQ §13 / NFR-005）：
 * reasoning_content 绝不许进任何 DB 列，也不得出现在返修上下文中。
 *
 * **这条约束真正的落点不在本文件**，说清楚以免下一个人误判它的分量：
 *
 * 0. 真正承重的是**根本没有读取路径**：`openai-compatible.ts` 只把 `delta.content`
 *    累进 `assistantText`，隐藏推理没有任何一行代码去读它。
 * 1. 第一道——同文件的 `StreamChunkSchema` **不声明** `reasoning_content`，
 *    zod 默认剥离未声明键，于是它连内存对象都进不去。
 *    这一道是**防止有人不小心写出读取路径**，不是它自己在挡：
 *    只把这个字段加进 schema（别的都不动），下面那条端到端用例**不会红**（已实测）；
 * 2. 第二道——`shared/trace.ts` 的 `FORBIDDEN_PAYLOAD_KEY_PATTERN` 把
 *    `reasoning* / thinking / chain_of_thought` 一类键名拉黑，命中即写 trace 失败，
 *    所以从 trace 重建返修上下文时，payload 里不可能存在隐藏推理字段；
 * 3. 第三道（本文件的 `stripReasoning`）——**纵深防御**。
 *    application 层构造 `RawAssistantTurn` 时 `reasoningContent` 恒为 undefined，
 *    因此把本函数改坏并不会让 R3 的任何集成断言变红（已实测确认）。
 *    它存在的价值是：万一将来某个 adapter 改成把推理并进 content 之外的字段透传，
 *    这里有一个明确的、有类型的收口点，而不是四处 grep。
 *
 * 真正守住整条链路的是 `tests/integration/r3-context-continuity.test.ts` 里那条
 * 端到端用例——真 adapter、真 SSE 帧、真 `reasoning_content`，
 * 断言返修轮的 `context_json` 一个字都不含它。
 * 它拦的是**真实的回归**：把 adapter 改成 `reasoning_content + content` 一起累进
 * `assistantText`（即第 0 条那个「读取路径」被写出来），它会红（已实测）。
 * 反过来，只动 schema 或只改坏 `stripReasoning` 都不会红——
 * 这两道是纵深，不是证明。
 */

import type { RawFinding } from './review-evidence.ts';

/**
 * 上一轮 assistant 轮次的结构化记录（剥离前）。
 *
 * 参照 openai-compatible.ts 里 reasoning 响应的字段形状：
 * DeepSeek reasoner 型号在 delta.reasoning_content 里回思维链。
 * Provider adapter 的 Zod schema 不声明该字段，于是它连内存对象都进不去。
 * 但在进入返修上下文之前，仍需一个显式的 domain 层剥离函数——
 * 这是「用函数而非自觉」来保证 reasoning_content 不外流的落点。
 */
export interface RawAssistantTurn {
  /** 可见内容（文本与工具调用序列化后的文本） */
  readonly content: string;
  /** 隐藏推理字段（reasoning models 的 reasoning_content），可能不存在 */
  readonly reasoningContent?: string;
}

/**
 * 从 Provider 响应中剥离隐藏推理字段，只保留可见内容。
 *
 * AC-R-014（REQ §13 / NFR-005）：reasoning_content 绝不许进任何 DB 列，
 * 也不得出现在返修上下文中。
 *
 * **本函数是第三道网，不是第一道**（见文件头的三道网清单）。
 * 现有调用方喂进来的 `reasoningContent` 恒为 undefined，因为前两道已经把它挡在外面。
 * 别把它当成「reasoning 不外流」的证明——那个证明在端到端用例里。
 *
 * 剥离在进入 renderRevisionContext 之前完成：本函数拿到的该是「待剥离的原始轮次」，
 * 产出的 string 直接进 PriorRound.visibleOutput。
 */
export function stripReasoning(turn: RawAssistantTurn): string {
  // 显式忽略 reasoningContent——它是隐藏推理，绝不可进返修上下文（AC-R-014）
  return turn.content;
}

/** 上一轮的返修相关数据 */
export interface PriorRound {
  /** 上一轮 Agent 的公开输出（已剥离，干净的） */
  readonly visibleOutput: string;
  /** 只存 ID——绝不存工具结果副本（FR-CTX-005） */
  readonly readSlotIds: readonly string[];
  /** 上一轮提交的正文 */
  readonly submittedContent: string;
  /** 已通过引文校验的 findings */
  readonly findings: readonly RawFinding[];
}

/**
 * 装配返修上下文文本段，注入 fill_slot 的 DeterministicContext。
 *
 * 纯函数：同一输入逐字同输出。读过的依赖槽位内容从 dependencyContents 现取
 * （FR-CTX-005：只记 ID，内容装配时现取，不存副本）。
 *
 * readSlotIds 里的 ID 若不在 dependencyContents 里则跳过（确定性的缺失处理）。
 */
export function renderRevisionContext(
  prior: PriorRound,
  dependencyContents: ReadonlyMap<string, string>,
): string {
  const sections: string[] = [];

  sections.push('=== 上一轮公开输出 ===');
  sections.push(prior.visibleOutput);

  // 只记 ID，内容现取——不存副本（FR-CTX-005）
  // 遍历顺序只按 readSlotIds，不依赖 dependencyContents 的 Map 插入顺序——
  // 输出顺序必须可复现，与调用方构造 Map 的顺序无关（「补 2」反证过）。
  // ID 不在 dependencyContents 里则跳过（确定性的缺失处理）
  const depEntries: string[] = [];
  for (const slotId of prior.readSlotIds) {
    const content = dependencyContents.get(slotId);
    if (content !== undefined) {
      depEntries.push(`${slotId}:\n${content}`);
    }
  }
  if (depEntries.length > 0) {
    sections.push('=== 依赖槽位内容 ===');
    sections.push(depEntries.join('\n\n'));
  }

  sections.push('=== 上一稿正文 ===');
  sections.push(prior.submittedContent);

  if (prior.findings.length > 0) {
    sections.push('=== 审核意见 ===');
    const findingLines = prior.findings.map(
      (f) => `判据 ${f.criterionId} 引文「${f.quote}」 问题：${f.problem}`,
    );
    sections.push(findingLines.join('\n'));
  }

  return sections.join('\n\n');
}
