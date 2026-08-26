/**
 * FakeProvider（§11.2）。
 *
 * 存在的理由是 §11.1 那一行：Runtime 集成测试要覆盖**全部 AC**，且「无网络、可控时序」。
 * 因此这里的每个字段都对应一条要被证明的运行时行为，而不是「方便造数据」。
 *
 * 与文档 §11.2 的差异（已在 §11.2 同步修订，见报告）：
 * - `invalidStructure` 从 4 个字符串字面量扩成 `StructureRuleId`（18 个），
 *   夹具见 `invalid-structures.ts`——Q-05 记的就是这个缺口。
 * - 新增 `stopReason`：§7.6 的收敛分支里有 `max_tokens`，原清单没有任何办法触发它，
 *   于是那条分支在集成层不可测。
 * - `callTools[].name` 是 `string` 而不是 `ToolName`：D-11 要求分发器兜住**拼错的工具名**，
 *   而一个 `ToolName` 类型的字段根本没法表达「拼错」。
 * - `throwError` 收窄为 `ErrorCode`（原文写的就是 ErrorCode，此处只是落实）。
 */

import { ForgeError } from '@shared/errors.ts';
import type { ErrorCode } from '@shared/errors.ts';
import type { StructureRuleId } from '@server/domain/structure-validation.ts';
import { sleepAbortable } from '../abort-reasons.ts';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderRunTurnInput,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderToolResult,
  ProviderTurnResult,
} from './provider-adapter.ts';
import { rateLimited } from './rate-limit.ts';
import { INVALID_STRUCTURES } from './invalid-structures.ts';

export interface FakeToolCall {
  /** 刻意是 string：要能表达「模型拼错了工具名」这种输入 */
  readonly name: string;
  readonly args: unknown;
}

/** 单轮脚本。一次 `runTurn` 消费一条 */
export interface FakeProviderScript {
  // ---- 基础 ----
  readonly emitText?: readonly string[];
  readonly callTools?: readonly FakeToolCall[];
  readonly submitStructure?: { rootSlotId: string; slots: readonly unknown[] };
  readonly submitContent?: { slotId: string; content: string };
  /** R2：提交审核结果（complete_assignment kind=review_result） */
  readonly submitReview?: {
    slotId: string;
    verdict: 'no_finding' | 'revise';
    findings?: readonly { criterionId: string; quote: string; problem: string }[];
  };

  // ---- 异常模拟 ----
  /** 挂起，用于测超时。等待可被 abort 打断 */
  readonly hangMs?: number;
  readonly throwError?: ErrorCode;
  /** 只说话不提交（测 no_submission / AC-014）。纯语义标记，不改变行为 */
  readonly neverSubmit?: boolean;
  /** 提交到别的槽位（测 AC-008 的 SLOT_TARGET_MISMATCH） */
  readonly submitWrongSlot?: string;
  /** 延迟提交（测 AC-011 迟到结果）。**刻意不检查 abort**，见 #dispatch 的注释 */
  readonly submitAfterDelayMs?: number;
  /** 非法结构变体，按校验规则取值。夹具见 invalid-structures.ts */
  readonly invalidStructure?: StructureRuleId;
  /** 无工具调用时的收敛原因。默认 end_turn */
  readonly stopReason?: 'end_turn' | 'max_tokens';
}

export interface FakeProviderOptions {
  /** 多轮脚本，按序消费。用完后一律返回 end_turn（安全终止，不会把循环挂死） */
  readonly turns?: readonly FakeProviderScript[];
  /** 前 N 次 `runTurn` 抛 429。**不消费 turns**——限流发生在请求发出之前 */
  readonly rateLimitTimes?: number;
  readonly retryAfterMs?: number | null;
}

/** 供测试断言的观测数据。刻意不含 apiKey——连记录都不记，避免测试文件里出现密钥 */
export interface FakeTurnObservation {
  readonly system: string;
  readonly messages: readonly ProviderMessage[];
  readonly toolNames: readonly string[];
  readonly maxTokens: number;
}

export class FakeProvider implements ProviderAdapter {
  readonly kind = 'fake' as const;

  #turns: FakeProviderScript[];
  #rateLimitRemaining: number;
  #retryAfterMs: number | null;
  #callId = 0;

  /** 每次 runTurn 的入参快照。测试用它证明 system/tools 确实被送到了 Provider */
  readonly observations: FakeTurnObservation[] = [];

  constructor(options: FakeProviderOptions = {}) {
    this.#turns = [...(options.turns ?? [])];
    this.#rateLimitRemaining = options.rateLimitTimes ?? 0;
    this.#retryAfterMs = options.retryAfterMs ?? null;
  }

  /** 单轮脚本的糖，对应 §11.2 示例里的 `fake.script({...})` */
  script(script: FakeProviderScript): this {
    this.#turns.push(script);
    return this;
  }

  get remainingTurns(): number {
    return this.#turns.length;
  }

  async runTurn(input: ProviderRunTurnInput): Promise<ProviderTurnResult> {
    this.observations.push({
      system: input.system,
      messages: [...input.messages],
      toolNames: input.tools.map((t: ProviderToolDefinition) => t.name),
      maxTokens: input.maxTokens,
    });

    if (this.#rateLimitRemaining > 0) {
      this.#rateLimitRemaining -= 1;
      throw rateLimited('FakeProvider 模拟 429', this.#retryAfterMs, 'fake');
    }

    if (input.signal.aborted) return aborted();

    const script = this.#turns.shift();
    if (script === undefined) {
      // 脚本耗尽 = 模型没话说了。返回 end_turn 而不是继续循环，
      // 否则一个写漏了的测试会挂到超时才失败，看不出真正的原因
      return { stopReason: 'end_turn', usage: null, appendMessages: [] };
    }

    if (script.hangMs !== undefined) {
      await sleepAbortable(script.hangMs, input.signal);
      if (input.signal.aborted) return aborted();
    }

    if (script.throwError !== undefined) {
      throw new ForgeError(script.throwError, `FakeProvider 模拟错误：${script.throwError}`);
    }

    let text = '';
    for (const delta of script.emitText ?? []) {
      if (input.signal.aborted) return aborted();
      text += delta;
      input.onTextDelta(delta);
    }

    const calls = this.#buildCalls(script);
    if (calls.length === 0) {
      return {
        stopReason: script.stopReason ?? 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        appendMessages: [{ role: 'assistant', content: text, toolCalls: [] }],
      };
    }

    if (script.submitAfterDelayMs !== undefined) {
      await sleepAbortable(script.submitAfterDelayMs, input.signal);
      // **刻意不在这里 return aborted()**：本字段模拟的正是「Provider 没理会 abort，
      // 结果还是来了」。迟到结果必须真的到达工具层，才能证明 D-10 的条件 UPDATE
      // 拦住了它（AC-011）。一个乖乖响应 abort 的 fake 无法证明这件事。
    }

    const results: ProviderToolResult[] = [];
    for (const call of calls) {
      results.push(await input.onToolCall(call));
    }

    return {
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 50 },
      appendMessages: [
        { role: 'assistant', content: text, toolCalls: calls },
        ...results.map(
          (result, i): ProviderMessage => ({
            role: 'tool',
            toolCallId: result.toolCallId,
            toolName: calls[i]?.name ?? '',
            content: result.content,
            isError: result.isError,
          }),
        ),
      ],
    };
  }

  #buildCalls(script: FakeProviderScript): ProviderToolCall[] {
    const calls: ProviderToolCall[] = [];
    for (const call of script.callTools ?? []) {
      calls.push(this.#call(call.name, call.args));
    }

    if (script.invalidStructure !== undefined) {
      calls.push(
        this.#call('complete_assignment', {
          kind: 'structure',
          ...INVALID_STRUCTURES[script.invalidStructure],
        }),
      );
    } else if (script.submitStructure !== undefined) {
      calls.push(this.#call('complete_assignment', { kind: 'structure', ...script.submitStructure }));
    }

    if (script.submitWrongSlot !== undefined) {
      calls.push(
        this.#call('complete_assignment', {
          kind: 'slot_content',
          slotId: script.submitWrongSlot,
          content: '提交到了错误的槽位',
        }),
      );
    } else if (script.submitContent !== undefined) {
      calls.push(this.#call('complete_assignment', { kind: 'slot_content', ...script.submitContent }));
    }

    // R2：审核结果提交
    if (script.submitReview !== undefined) {
      calls.push(
        this.#call('complete_assignment', {
          kind: 'review_result',
          slotId: script.submitReview.slotId,
          verdict: script.submitReview.verdict,
          findings: script.submitReview.findings ?? [],
        }),
      );
    }

    return calls;
  }

  #call(name: string, args: unknown): ProviderToolCall {
    this.#callId += 1;
    return { id: `fake_call_${this.#callId}`, name, argumentsJson: JSON.stringify(args) };
  }
}

function aborted(): ProviderTurnResult {
  return { stopReason: 'aborted', usage: null, appendMessages: [] };
}
