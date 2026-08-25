/**
 * Provider 适配器契约（§7.3）。
 *
 * 一个 adapter 只回答一个问题：「给定 system / messages / tools，跑完**一轮**，
 * 期间把 text delta 推出来、把 tool call 交给回调处理，然后告诉我为什么停下来。」
 * 多轮循环、工具权限、提交边界、重试配额——全部不在这一层。
 *
 * 三条必须守住的语义：
 *
 * 1. **中止不抛异常**（§7.3）。`signal.aborted` 后取消读流并返回
 *    `{ stopReason: 'aborted' }`。抛异常会与超时/取消的错误处理路径混淆，
 *    而那两条路径的收敛结果（failed vs cancelled）完全不同。
 * 2. **429 不在适配器内重试**。直接抛 `PROVIDER_RATE_LIMITED`，退避由
 *    `AssignmentRunner` 统一处理（§8.5），这样退避期间也能被 stop 中止。
 * 3. **API Key 只出现在请求头**。不进返回值、不进错误 message、不进任何日志。
 */

import type { ToolName } from '@shared/tools.ts';

/**
 * 与 Provider 无关的消息形状。
 *
 * 刻意不用 OpenAI 或 Anthropic 任何一家的 wire 格式：两家对 tool call 的表达
 * （`role:'tool'` 多条 vs `tool_result` content block）差异足够大，
 * 让循环层持有其中一家的形状，等于把另一家的适配写成一堆 if。
 * 转换是 adapter 的职责。
 */
export type ProviderMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls: readonly ProviderToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      /** 工具返回的是错误结果（D-11 / §7.5）。适配器可据此选择更醒目的表达 */
      readonly isError: boolean;
    };

/**
 * 模型发起的一次工具调用。
 *
 * `name` 是 `string` 而不是 `ToolName`——**这是刻意的**。模型输出是不可信输入，
 * 把它的类型写成 `ToolName` 等于在类型层面假装模型不会拼错工具名，
 * 而 D-11 明确要求分发器兜住未知工具名并抛 `TOOL_NOT_ALLOWED`。
 * 收窄发生在分发器里，不在这里。
 *
 * `argumentsJson` 同理是原始字符串：流式拼接出来的 JSON 可能根本解析不了，
 * 解析与 Zod 校验都属于分发器。
 */
export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ProviderToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** 给模型的工具定义。`parameters` 是 JSON Schema，由 `tool-schema.ts` 从 Zod 派生 */
export interface ProviderToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type ProviderStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted';

export interface ProviderTurnResult {
  readonly stopReason: ProviderStopReason;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /**
   * 本轮结束后应追加到 `messages` 的内容（assistant 回复 + 各 tool 结果）。
   *
   * **文档补正（M3-A）**：§7.3 的 `ProviderTurnResult` 只有 `stopReason` 与 `usage`，
   * 而 §7.6 的循环写的是 `messages.push(...buildToolResultMessages(turn))`——
   * 那个函数无法实现：`turn` 里既没有 assistant 消息也没有工具结果，
   * 而这两样只有 adapter 手里有（tool call 的 id 是 Provider 分配的）。
   * 因此把「本轮该追加什么」作为 turn 的产出返回，循环层原样 push 即可。
   * 详见报告与 §7.3 的修订。
   */
  readonly appendMessages: readonly ProviderMessage[];
}

export interface ProviderRunTurnInput {
  readonly model: string;
  /** 只用于构造 Authorization 头。任何实现都不得把它写进返回值或日志 */
  readonly apiKey: string;
  readonly system: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly onTextDelta: (delta: string) => void;
  readonly onToolCall: (call: ProviderToolCall) => Promise<ProviderToolResult>;
}

export interface ProviderAdapter {
  /** 适配器种类，与 `providers.yaml` 的 `kind` 对应 */
  readonly kind: 'openai-compatible' | 'anthropic' | 'fake';
  runTurn(input: ProviderRunTurnInput): Promise<ProviderTurnResult>;
  /**
   * 连通性探测（D-03 的 `POST /api/providers/:id/probe`）。
   * 可选：不实现的适配器由 Registry 归为「无法探测」，而不是伪造一个 ok。
   */
  probe?(input: { model: string; apiKey: string; signal: AbortSignal }): Promise<void>;
}
