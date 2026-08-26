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
 * 本文件提供 domain 层的纯剥离函数，测试用仿真实 Provider 响应的夹具走完整链路。
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
 * 也不得出现在返修上下文中。本函数是这条约束的 domain 层落点。
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
