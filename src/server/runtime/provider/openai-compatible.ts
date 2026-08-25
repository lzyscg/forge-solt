/**
 * OpenAI 兼容适配器（D-17：P0 唯一必需的 adapter，DeepSeek 走它）。
 *
 * 三处最容易出 bug 的地方，逐一说明为什么这么写：
 *
 * 1. **流式 tool call 的累积**（§7.3）。`choices[0].delta.tool_calls[]` 的每个元素带
 *    `index`，而 `id` 与 `function.name` **通常只在第一个片段出现**，后续片段只有
 *    `arguments` 的字符串碎片。所以状态必须按 index 存，name/id 只在首次见到时写入，
 *    arguments 按到达顺序拼接。中途 `JSON.parse` 必然失败——拼完再交给分发器解析。
 *
 * 2. **中止不抛异常**（§7.3）。`signal.aborted` 后取消读流并 `return { stopReason: 'aborted' }`。
 *    fetch 自身因 abort 抛出的 `AbortError` 也在这里被吞掉转成同一个返回值——
 *    否则同一个中止会因为发生在「请求阶段」还是「读流阶段」而走两条不同的错误路径。
 *
 * 3. **隐藏推理绝不外流**（REQ §13 / 本轮硬要求 7）。DeepSeek 的 reasoner 型号会在
 *    `delta.reasoning_content` 里回思维链。本文件的 Zod schema **不声明这个字段**，
 *    zod 默认剥离未声明键，于是它连内存对象都进不去，更不可能被推给 SSE 或写进 trace。
 *    这是「用 schema 而不是用自觉」来保证的：不声明就拿不到。
 */

import { z } from 'zod';
import { ForgeError } from '@shared/errors.ts';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderRunTurnInput,
  ProviderStopReason,
  ProviderToolCall,
  ProviderToolResult,
  ProviderTurnResult,
} from './provider-adapter.ts';
import { parseRetryAfter, rateLimited } from './rate-limit.ts';

/**
 * 流式分片的契约。
 *
 * 模型输出是不可信输入（本轮硬要求 8）：所有从网络回来的 JSON 都过这里。
 * 注意这里**刻意不写** `reasoning_content` / `reasoning`——见文件头第 3 条。
 */
const StreamToolCallDeltaSchema = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const StreamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(StreamToolCallDeltaSchema).optional(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
    })
    .nullish(),
});

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  providerId: string;
  /** 注入点只为测试替换 fetch；生产恒用全局 fetch */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;

  readonly #baseUrl: string;
  readonly #providerId: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: OpenAiCompatibleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#providerId = options.providerId;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async runTurn(input: ProviderRunTurnInput): Promise<ProviderTurnResult> {
    if (input.signal.aborted) return abortedTurn();

    const body = {
      model: input.model,
      stream: true,
      // 没有它 DeepSeek 的流式响应不带 usage，`executions.input_tokens` 就永远是 null
      stream_options: { include_usage: true },
      max_tokens: input.maxTokens,
      messages: [{ role: 'system', content: input.system }, ...input.messages.map(toWireMessage)],
      tools: input.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
    };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 密钥的唯一去处。它不进 body、不进错误 message、不进 trace
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) return abortedTurn();
      throw new ForgeError(
        'PROVIDER_ERROR',
        `请求 Provider 失败：${error instanceof Error ? error.message : String(error)}`,
        `provider:${this.#providerId}`,
        null,
        error,
      );
    }

    if (response.status === 429) {
      throw rateLimited(
        'Provider 返回 429，已触发限流',
        parseRetryAfter(response.headers.get('retry-after'), this.#now()),
        this.#providerId,
      );
    }
    if (!response.ok) {
      // 只读 body 文本作为诊断。请求头（含密钥）不在这里，也不把 Response 挂进 cause
      const detail = await safeReadText(response);
      throw new ForgeError(
        'PROVIDER_ERROR',
        `Provider 返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
        `provider:${this.#providerId}`,
      );
    }
    if (response.body === null) {
      throw new ForgeError('PROVIDER_ERROR', 'Provider 返回了空响应体', `provider:${this.#providerId}`);
    }

    return await this.#consumeStream(response.body, input);
  }

  async #consumeStream(
    stream: ReadableStream<Uint8Array>,
    input: ProviderRunTurnInput,
  ): Promise<ProviderTurnResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let assistantText = '';
    let finishReason: string | null = null;
    let usage: ProviderTurnResult['usage'] = null;
    let buffer = '';
    let aborted = false;

    try {
      for (;;) {
        if (input.signal.aborted) {
          aborted = true;
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分帧。最后一段可能是半帧，留在 buffer 里等下一次读取
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const payload = extractData(frame);
          if (payload === null) continue;
          if (payload === '[DONE]') {
            finishReason ??= 'stop';
            continue;
          }
          const chunk = parseChunk(payload);
          if (chunk === null) continue;

          if (chunk.usage != null) {
            usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
          }
          const choice = chunk.choices?.[0];
          if (choice === undefined) continue;
          if (choice.finish_reason != null) finishReason = choice.finish_reason;

          const text = choice.delta?.content;
          if (typeof text === 'string' && text !== '') {
            assistantText += text;
            input.onTextDelta(text);
          }
          for (const delta of choice.delta?.tool_calls ?? []) {
            accumulate(toolCalls, delta);
          }
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        aborted = true;
      } else {
        throw new ForgeError(
          'PROVIDER_ERROR',
          `读取 Provider 流失败：${error instanceof Error ? error.message : String(error)}`,
          `provider:${this.#providerId}`,
          null,
          error,
        );
      }
    } finally {
      // 中止时必须真的取消读流，否则连接会挂到超时为止（§7.3）
      await reader.cancel().catch(() => undefined);
    }

    if (aborted) return abortedTurn();

    const calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]): ProviderToolCall => ({
        id: call.id,
        name: call.name,
        argumentsJson: call.argumentsJson,
      }));

    if (calls.length > 0) {
      const results: ProviderToolResult[] = [];
      for (const call of calls) {
        // 串行分发：一个 turn 内的多个 tool call 共用同一个 SubmissionGate 与
        // 调用计数，并发执行会让「提交后还剩几个调用」变成竞态
        results.push(await input.onToolCall(call));
      }
      return {
        stopReason: 'tool_use',
        usage,
        appendMessages: [
          { role: 'assistant', content: assistantText, toolCalls: calls },
          ...results.map(
            (result): ProviderMessage => ({
              role: 'tool',
              toolCallId: result.toolCallId,
              toolName: calls.find((c) => c.id === result.toolCallId)?.name ?? '',
              content: result.content,
              isError: result.isError,
            }),
          ),
        ],
      };
    }

    return {
      stopReason: mapFinishReason(finishReason),
      usage,
      appendMessages: [{ role: 'assistant', content: assistantText, toolCalls: [] }],
    };
  }

  /** 最小连通性探测：1 token 的非流式请求。只判「能不能通」，不判模型质量 */
  async probe(input: { model: string; apiKey: string; signal: AbortSignal }): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: input.signal,
    });
    if (response.status === 429) {
      throw rateLimited(
        '探测时被限流',
        parseRetryAfter(response.headers.get('retry-after'), this.#now()),
        this.#providerId,
      );
    }
    if (!response.ok) {
      throw new ForgeError(
        'PROVIDER_UNAVAILABLE',
        `探测失败：HTTP ${response.status}`,
        `provider:${this.#providerId}`,
      );
    }
  }
}

// ---------------------------------------------------------------- 内部工具

function abortedTurn(): ProviderTurnResult {
  // 中止时不追加任何消息：这一轮的产出不完整，回灌半截 assistant 消息
  // 会污染重试时的上下文
  return { stopReason: 'aborted', usage: null, appendMessages: [] };
}

function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return message.toolCalls.length === 0
        ? { role: 'assistant', content: message.content }
        : {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          };
    case 'tool':
      // OpenAI 协议没有「工具失败」的表达位，错误只能作为普通结果文本回去。
      // 加前缀是为了让模型一眼看出这次调用没成功——否则它常把错误消息当数据用
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.isError ? `[错误] ${message.content}` : message.content,
      };
  }
}

/** 一帧里可能有多行（`event:` / `data:` / 注释）。只取 data 行并按 SSE 规范拼接 */
function extractData(frame: string): string | null {
  const lines = frame.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice('data:'.length).trimStart()).join('\n');
}

function parseChunk(payload: string): z.infer<typeof StreamChunkSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    // 单帧坏了不该整轮失败：后续帧仍可能带来 finish_reason 与完整的 tool call。
    // 真正的「什么都没解析出来」会在收敛时表现为 end_turn 且无提交，走 no_submission
    return null;
  }
  const parsed = StreamChunkSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function accumulate(
  acc: Map<number, ToolCallAccumulator>,
  delta: z.infer<typeof StreamToolCallDeltaSchema>,
): void {
  const existing = acc.get(delta.index) ?? { id: '', name: '', argumentsJson: '' };
  acc.set(delta.index, {
    // id 与 name 只在第一个片段出现；后来的空值不能把已拿到的值覆盖掉
    id: existing.id === '' ? (delta.id ?? '') : existing.id,
    name: existing.name === '' ? (delta.function?.name ?? '') : existing.name,
    argumentsJson: existing.argumentsJson + (delta.function?.arguments ?? ''),
  });
}

function mapFinishReason(reason: string | null): ProviderStopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      // 包括 'stop' / null / 未知值。未知值按自然结束处理是安全的一侧：
      // 循环会因为没有提交而走 no_submission，最坏结果是消耗一次重试配额，
      // 而不是把一次没有提交的执行当成成功
      return 'end_turn';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
