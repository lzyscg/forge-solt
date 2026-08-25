/**
 * Agent 工具循环（§7.6）。
 *
 * 这一层只负责「跑到停为止」，不负责重试、不负责写 Execution 状态、不认识数据库。
 * 它有且只有六种收敛方式，每一种都必须有测试（M3 完成判据）：
 *
 *   submitted      complete_assignment 成功 → 闸门关闭
 *   aborted        超时或用户停止（§8.2 / §8.3）
 *   no_submission  模型自然结束却没提交（AC-014）
 *   max_tokens     输出超长且未提交
 *   工具超限        MAX_TOOL_CALLS_EXCEEDED 向上抛出，中断循环
 *   未知工具名      **不**中断循环——它是工具错误结果，模型能自己改对
 *
 * 最后两条是一对：前者必须炸，后者必须不炸。把未知工具名也做成中断，
 * 会让一次拼写错误吃掉一整个 attempt；把工具超限做成错误结果，
 * 会让一个反复调 `read_skill_section` 的模型一直烧 token 直到超时。
 */

import { ForgeError } from '@shared/errors.ts';
import type {
  ProviderMessage,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderToolResult,
  ProviderTurnResult,
} from './provider/provider-adapter.ts';
import type { SubmissionGate } from './submission-gate.ts';
import type { TraceWriter } from './trace-writer.ts';
import { dispatchToolCall } from './tools/index.ts';
import type { ToolDefinition } from './tools/index.ts';

/**
 * 重试时追加到 User Message 的固定文案（§7.6）。
 *
 * 导出而不是内联，是因为**拼这段文案的是 ContextBuilder，判定要不要拼的是 Runtime**。
 * 两边各写一份的话，改了一处忘了另一处的表现是「重试时模型收到的还是原样提示」，
 * 而这种失败看起来跟模型能力不足一模一样。
 */
export const NO_SUBMISSION_RETRY_APPEND = [
  '【上一次未产出结果】',
  '你上一次的工作没有调用 complete_assignment，因此没有任何内容被保存。',
  '请在完成思考后，务必调用 complete_assignment 提交结果。',
].join('\n');

/**
 * 已绑定 model / apiKey 的一次 turn 调用。
 *
 * 循环层拿不到 apiKey——它由 `AssignmentRunner` 在闭包里绑好（REQ §13）。
 * 顺带的好处是限流退避可以在这一层之外包一圈，循环层完全不必知道有退避这回事。
 */
export type TurnRunner = (input: {
  system: string;
  messages: readonly ProviderMessage[];
  tools: readonly ProviderToolDefinition[];
  maxTokens: number;
  signal: AbortSignal;
  onTextDelta: (delta: string) => void;
  onToolCall: (call: ProviderToolCall) => Promise<ProviderToolResult>;
}) => Promise<ProviderTurnResult>;

export interface AgentLoopInput {
  readonly executionId: string;
  readonly systemText: string;
  readonly userText: string;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export interface AgentLoopDeps {
  readonly runTurn: TurnRunner;
  readonly tools: readonly ToolDefinition[];
  readonly providerTools: readonly ProviderToolDefinition[];
  readonly gate: SubmissionGate;
  readonly trace: TraceWriter;
}

export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LoopResult =
  | { kind: 'submitted'; usage: LoopUsage | null; toolCalls: number }
  | { kind: 'aborted'; usage: LoopUsage | null; toolCalls: number }
  | { kind: 'no_submission'; usage: LoopUsage | null; toolCalls: number }
  | { kind: 'failed'; code: 'PROVIDER_ERROR'; message: string; usage: LoopUsage | null; toolCalls: number };

export async function runAgentLoop(input: AgentLoopInput, deps: AgentLoopDeps): Promise<LoopResult> {
  const messages: ProviderMessage[] = [{ role: 'user', content: input.userText }];
  let toolCalls = 0;
  let usage: LoopUsage | null = null;

  for (;;) {
    const turn = await deps.runTurn({
      system: input.systemText,
      messages,
      tools: deps.providerTools,
      maxTokens: input.maxTokens,
      signal: input.signal,
      onTextDelta: (delta) => {
        // D-11：提交之后到达的 text delta 一律丢弃——不写 trace，不推 SSE。
        // 用户看到「提交成功」之后又冒出新正文，会以为产物还在变
        if (deps.gate.isClosed) return;
        deps.trace.delta(input.executionId, delta);
      },
      onToolCall: async (call) => {
        toolCalls += 1;
        if (toolCalls > input.maxToolCalls) {
          // 抛出而不是返回错误结果：这是唯一一种「模型不可能自己修好」的工具错误，
          // 再给它一次机会只是多烧一次调用
          throw new ForgeError(
            'MAX_TOOL_CALLS_EXCEEDED',
            `本次工作的工具调用次数已达上限 ${input.maxToolCalls}`,
          );
        }
        return await dispatchToolCall(
          { tools: deps.tools, trace: deps.trace, executionId: input.executionId },
          call,
        );
      },
    });

    usage = mergeUsage(usage, turn.usage);

    // 顺序即优先级：提交成功压倒一切。提交会立刻 abort（D-11），
    // 若先判 aborted，每一次成功提交都会被判成中止
    if (deps.gate.isClosed) return { kind: 'submitted', usage, toolCalls };
    if (turn.stopReason === 'aborted') return { kind: 'aborted', usage, toolCalls };
    if (turn.stopReason === 'end_turn') return { kind: 'no_submission', usage, toolCalls };
    if (turn.stopReason === 'max_tokens') {
      return {
        kind: 'failed',
        code: 'PROVIDER_ERROR',
        message: '模型输出超出长度上限且未完成提交',
        usage,
        toolCalls,
      };
    }

    messages.push(...turn.appendMessages);
  }
}

/** usage 累加。Provider 按轮返回，一次 Assignment 可能跑很多轮 */
function mergeUsage(current: LoopUsage | null, incoming: LoopUsage | null): LoopUsage | null {
  if (incoming === null) return current;
  if (current === null) return { ...incoming };
  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
  };
}
