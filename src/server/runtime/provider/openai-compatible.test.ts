/**
 * OpenAI 兼容适配器测试（§7.3 / D-17）。
 *
 * 重点全部落在文档点名「最容易出 bug」的地方：流式 tool call 的跨分片累积、
 * 中止语义、429 的处理，以及隐藏推理不外流。
 */

import { describe, expect, it, vi } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { DroppedChunkSummary } from './openai-compatible.ts';
import type { ProviderRunTurnInput, ProviderToolCall } from './provider-adapter.ts';

const encoder = new TextEncoder();

function sseStream(frames: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** 先吐 frames，之后一直挂着，直到 signal 中止才再动一下 */
function hangingStream(signal: AbortSignal, frames: readonly string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      const frame = frames[index];
      if (frame !== undefined) {
        index += 1;
        controller.enqueue(encoder.encode(frame));
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    },
  });
}

const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function adapterWith(response: () => Response): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    baseUrl: 'https://example.test/v1/',
    providerId: 'fake',
    fetchImpl: (async () => response()) as unknown as typeof fetch,
    now: () => 1_000_000,
  });
}

function turnInput(overrides: Partial<ProviderRunTurnInput> = {}): ProviderRunTurnInput {
  return {
    model: 'm',
    apiKey: 'sk-secret',
    system: '系统提示',
    messages: [{ role: 'user', content: '你好' }],
    tools: [{ name: 'read_slot', description: '读', parameters: { type: 'object' } }],
    maxTokens: 128,
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    onToolCall: async (call) => ({ toolCallId: call.id, content: 'ok', isError: false }),
    ...overrides,
  };
}

describe('流式文本', () => {
  it('逐段推 delta，finish_reason=stop → end_turn', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            data({ choices: [{ delta: { content: '她戴上' } }] }),
            data({ choices: [{ delta: { content: '耳机。' } }] }),
            data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            'data: [DONE]\n\n',
          ]),
          { status: 200 },
        ),
    );
    const deltas: string[] = [];
    const result = await adapter.runTurn(turnInput({ onTextDelta: (d) => deltas.push(d) }));

    expect(deltas).toEqual(['她戴上', '耳机。']);
    expect(result.stopReason).toBe('end_turn');
    const assistant = result.appendMessages[0];
    expect(assistant?.role === 'assistant' ? assistant.content : '').toBe('她戴上耳机。');
  });

  it('隐藏推理（reasoning_content）不进入任何输出（REQ §13）', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            data({ choices: [{ delta: { reasoning_content: '用户其实想要……' } }] }),
            data({ choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] }),
          ]),
          { status: 200 },
        ),
    );
    const deltas: string[] = [];
    const result = await adapter.runTurn(turnInput({ onTextDelta: (d) => deltas.push(d) }));

    expect(deltas).toEqual(['正文']);
    expect(JSON.stringify(result)).not.toContain('用户其实想要');
  });

  it('finish_reason=length → max_tokens', async () => {
    const adapter = adapterWith(
      () => new Response(sseStream([data({ choices: [{ delta: {}, finish_reason: 'length' }] })]), { status: 200 }),
    );
    expect((await adapter.runTurn(turnInput())).stopReason).toBe('max_tokens');
  });

  it('坏掉的单帧不让整轮失败', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            'data: {不是 JSON\n\n',
            data({ choices: [{ delta: { content: '仍然收到' }, finish_reason: 'stop' }] }),
          ]),
          { status: 200 },
        ),
    );
    const deltas: string[] = [];
    const result = await adapter.runTurn(turnInput({ onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(['仍然收到']);
    expect(result.stopReason).toBe('end_turn');
  });
});

/**
 * Q-26：分片被丢弃必须留下信号。
 *
 * 这一组守的不是「解析对不对」，而是「解析不对的时候你能不能知道」。
 * 之前的行为是 `parseChunk` 失败即 continue——不报错、不计数、不留痕，
 * 于是 schema 与真实响应对不上的唯一表现是**数据凭空少一块**。
 * 接入 OpenCode Go 时就是这样：40 次工具调用参数全空，
 * 靠「只有无参工具能成功」这个分布反推才找到根因。
 */
describe('分片丢弃的可见性（Q-26）', () => {
  const collect = async (frames: string[]): Promise<DroppedChunkSummary[]> => {
    const seen: DroppedChunkSummary[] = [];
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.test/v1',
      providerId: 'fake',
      onDroppedChunk: (info) => seen.push(info),
      fetchImpl: (async () => new Response(sseStream(frames), { status: 200 })) as unknown as typeof fetch,
    });
    await adapter.runTurn(turnInput({}));
    return seen;
  };

  it('schema 对不上时报出字段路径与 code', async () => {
    // index 是必填的 number，这里给字符串——模拟「下一个 Provider 的字段差异」
    const seen = await collect([
      data({ choices: [{ delta: { tool_calls: [{ index: 'zero', function: { name: 'x' } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.droppedFrames).toBe(1);
    const keys = [...(seen[0]?.reasons.keys() ?? [])];
    expect(keys.some((k) => k.includes('choices.0.delta.tool_calls.0.index'))).toBe(true);
    expect(keys.some((k) => k.startsWith('schema:'))).toBe(true);
  });

  it('JSON 都解析不出来时也报，且与 schema 不符区分开', async () => {
    const seen = await collect(['data: {not json at all\n', data({ choices: [{ delta: {}, finish_reason: 'stop' }] })]);

    expect(seen[0]?.droppedFrames).toBe(1);
    expect([...(seen[0]?.reasons.keys() ?? [])].some((k) => k.startsWith('json:'))).toBe(true);
  });

  it('按形状归并，不逐条刷屏', async () => {
    // 同一种坏形状来 3 次，应当是「一个原因 ×3」而不是三条记录
    const bad = data({ choices: [{ delta: { tool_calls: [{ index: 'zero' }] } }] });
    const seen = await collect([bad, bad, bad, data({ choices: [{ delta: {}, finish_reason: 'stop' }] })]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.droppedFrames).toBe(3);
    expect(seen[0]?.reasons.size).toBe(1);
    expect([...(seen[0]?.reasons.values() ?? [])][0]).toBe(3);
  });

  it('一切正常时不报——否则这个信号会因为噪音被忽略', async () => {
    const seen = await collect([
      data({ choices: [{ delta: { content: '正文' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(seen).toEqual([]);
  });

  /**
   * REQ §13：诊断信息要进日志，而分片里可能有 `reasoning_content` 与正文。
   * 判断标准：这条描述拿给外人看，不该能还原出模型写了什么。
   */
  it('上报内容不含任何分片正文（只有字段路径与类型）', async () => {
    const secret = '这是模型的隐藏推理不该出现在日志里';
    const seen = await collect([
      data({
        choices: [{ delta: { content: secret, tool_calls: [{ index: 'zero' }] }, reasoning_content: secret }],
      }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);

    const serialized = JSON.stringify({ ...seen[0], reasons: [...(seen[0]?.reasons.entries() ?? [])] });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('reasoning');
  });
});

describe('流式 tool call 累积（§7.3 点名的高危处）', () => {
  /**
   * 「id/name 只在首片出现」有**两种**表达方式，两种都必须接住：
   *   DeepSeek 官方 → 字段缺省
   *   OpenCode Go   → 显式 `"name": null`
   *
   * 之前 schema 写的是 `.optional()`，只接住前者。后者会让 schema 校验失败，
   * 而 `parseChunk` 失败即 continue——**整个分片连同 arguments 碎片被静默丢弃**，
   * 拼出来是空串。上层现象是「模型只会发空参数的工具调用」，
   * 唯一能成功的是不需要参数的工具，没有任何报错指向 schema。
   *
   * 这条是接入 OpenCode Go 时真实踩到的，40 次 read_skill_section 全部
   * 「参数不合法：sectionId: Required」。
   */
  it('续传分片用 name:null 表达（OpenCode Go 形状）时，arguments 不能丢', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            data({
              choices: [
                { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_slot', arguments: '' } }] } },
              ],
            }),
            // ↓ 关键：name 与 id 是显式 null，不是缺省
            data({
              choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"slot' } }] } }],
            }),
            data({
              choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: 'Id":"s1"}' } }] } }],
            }),
            data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          ]),
          { status: 200 },
        ),
    );

    const seen: ProviderToolCall[] = [];
    await adapter.runTurn(
      turnInput({
        onToolCall: async (c) => {
          seen.push(c);
          return { toolCallId: c.id, content: 'ok', isError: false };
        },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('call_a');
    expect(seen[0]?.name).toBe('read_slot');
    // 这一行是判据：schema 拒绝 null 时它会是 ''
    expect(seen[0]?.argumentsJson).toBe('{"slotId":"s1"}');
  });

  it('id/name 只在首片出现，arguments 跨片拼接', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            data({
              choices: [
                { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_slot', arguments: '{"slot' } }] } },
              ],
            }),
            data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"sce' } }] } }] }),
            data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ne_02"}' } }] } }] }),
            data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          ]),
          { status: 200 },
        ),
    );
    const seen: ProviderToolCall[] = [];
    const result = await adapter.runTurn(
      turnInput({
        onToolCall: async (c) => {
          seen.push(c);
          return { toolCallId: c.id, content: '正文', isError: false };
        },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('call_a');
    expect(seen[0]?.name).toBe('read_slot');
    // 中途 parse 必然失败，只有拼完才是合法 JSON——这条断言就是在验证「拼完了」
    expect(JSON.parse(seen[0]?.argumentsJson ?? '')).toEqual({ slotId: 'scene_02' });
    expect(result.stopReason).toBe('tool_use');
    expect(result.appendMessages.map((m) => m.role)).toEqual(['assistant', 'tool']);
  });

  it('一轮内多个 tool call 按 index 分开，且都被分发', async () => {
    const adapter = adapterWith(
      () =>
        new Response(
          sseStream([
            data({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 1, id: 'b', function: { name: 'report_work', arguments: '{"b":1}' } },
                      { index: 0, id: 'a', function: { name: 'read_task_input', arguments: '{"a":1}' } },
                    ],
                  },
                },
              ],
            }),
            data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          ]),
          { status: 200 },
        ),
    );
    const names: string[] = [];
    await adapter.runTurn(
      turnInput({
        onToolCall: async (c) => {
          names.push(c.name);
          return { toolCallId: c.id, content: 'ok', isError: false };
        },
      }),
    );
    // 按 index 排序而不是按到达顺序
    expect(names).toEqual(['read_task_input', 'report_work']);
  });
});

describe('错误与中止', () => {
  it('429 抛 PROVIDER_RATE_LIMITED 并带上 Retry-After（适配器内不重试）', async () => {
    const adapter = adapterWith(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    );
    const error = await adapter.runTurn(turnInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe('PROVIDER_RATE_LIMITED');
    const { rateLimitRetryAfterMs } = await import('./rate-limit.ts');
    expect(rateLimitRetryAfterMs(error)).toBe(7000);
  });

  it('非 2xx → PROVIDER_ERROR，且错误信息里没有密钥', async () => {
    const adapter = adapterWith(() => new Response('bad request body', { status: 400 }));
    const error = await adapter.runTurn(turnInput()).catch((e: unknown) => e);
    expect((error as ForgeError).code).toBe('PROVIDER_ERROR');
    expect((error as ForgeError).message).toContain('400');
    expect(JSON.stringify((error as ForgeError).message)).not.toContain('sk-secret');
  });

  it('读流途中中止 → 返回 aborted 而不是抛异常（§7.3）', async () => {
    const controller = new AbortController();
    const adapter = adapterWith(
      () =>
        new Response(hangingStream(controller.signal, [data({ choices: [{ delta: { content: '开头' } }] })]), {
          status: 200,
        }),
    );
    setTimeout(() => controller.abort(), 10);
    const result = await adapter.runTurn(turnInput({ signal: controller.signal }));

    expect(result.stopReason).toBe('aborted');
    // 中止时不回灌半截 assistant 消息，避免污染重试上下文
    expect(result.appendMessages).toEqual([]);
  });

  it('signal 已中止时直接返回 aborted，连请求都不发', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.test/v1',
      providerId: 'fake',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter.runTurn(turnInput({ signal: controller.signal }));
    expect(result.stopReason).toBe('aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('请求构造', () => {
  it('system 作为首条消息，tool 结果用 role=tool，密钥只出现在 Authorization 头', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.test/v1',
      providerId: 'fake',
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(sseStream([data({ choices: [{ delta: {}, finish_reason: 'stop' }] })]), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await adapter.runTurn(
      turnInput({
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_slot', argumentsJson: '{}' }] },
          { role: 'tool', toolCallId: 'a', toolName: 'read_slot', content: '不允许', isError: true },
        ],
      }),
    );

    const sent = captured as unknown as { url: string; init: RequestInit };
    expect(sent.url).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(String(sent.init.body)) as { messages: { role: string; content?: string }[] };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toBe('系统提示');
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body.messages[3]?.content).toContain('[错误]');
    // 密钥不得出现在请求体里
    expect(String(sent.init.body)).not.toContain('sk-secret');
    expect((sent.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-secret');
  });

  /**
   * 回灌的 `arguments` 必须是合法 JSON 文本（§7.3）。
   *
   * 这不是理论问题：接入 OpenCode Go 首跑就踩了——模型给 `read_skill_section`
   * 发了一个参数为空的 tool call（trace 里 `argumentsLength: 0`），
   * 分发器正确拒绝，但我们把 `arguments: ""` 原样回灌，网关回 400
   * 「Assistant tool call function.arguments must be valid JSON」。
   *
   * 致命之处在于那条消息**留在对话历史里**：之后每次重试都带着它、
   * 以完全相同的方式失败，任务卡在 running 无限重试。
   * DeepSeek 官方容忍空串，所以 M4–M7 全程没暴露过。
   */
  describe('assistant tool_calls 的 arguments 归一化', () => {
    const captureBody = async (argumentsJson: string): Promise<string> => {
      let body = '';
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: 'https://example.test/v1',
        providerId: 'fake',
        fetchImpl: (async (_url: string, init: RequestInit) => {
          body = String(init.body);
          return new Response(sseStream([data({ choices: [{ delta: {}, finish_reason: 'stop' }] })]), { status: 200 });
        }) as unknown as typeof fetch,
      });
      await adapter.runTurn(
        turnInput({
          messages: [
            { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_slot', argumentsJson }] },
            { role: 'tool', toolCallId: 'a', toolName: 'read_slot', content: '参数不合法', isError: true },
          ],
        }),
      );
      const parsed = JSON.parse(body) as {
        messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[];
      };
      const assistant = parsed.messages.find((m) => m.role === 'assistant');
      return assistant?.tool_calls?.[0]?.function.arguments ?? '';
    };

    it('空参数回灌成 {}，而不是空串', async () => {
      expect(await captureBody('')).toBe('{}');
      expect(await captureBody('   ')).toBe('{}');
    });

    it('截断/畸形的 JSON 也回灌成 {}', async () => {
      expect(await captureBody('{"slotId":"sce')).toBe('{}');
      expect(await captureBody('not json at all')).toBe('{}');
    });

    it('合法 JSON 原样回灌，不做任何改写', async () => {
      expect(await captureBody('{"slotId":"scene_02"}')).toBe('{"slotId":"scene_02"}');
      // 键序与空白也不许动：回灌内容与模型产出必须逐字一致
      expect(await captureBody('{ "b":2, "a":1 }')).toBe('{ "b":2, "a":1 }');
    });

    /**
     * 反证方向：归一化只能发生在序列化边界。若在累积器里就补成 `{}`，
     * 分发器将看不到「模型没给参数」，`sectionId: Required` 这条正确反馈就没了。
     * 这里确认累积器仍然把原始空串交出来。
     */
    it('累积器仍保留模型的原始产出（空串不被提前补成 {}）', async () => {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: 'https://example.test/v1',
        providerId: 'fake',
        fetchImpl: (async () =>
          new Response(
            sseStream([
              data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_slot' } }] } }] }),
              data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            ]),
            { status: 200 },
          )) as unknown as typeof fetch,
      });

      const seen: string[] = [];
      await adapter.runTurn(
        turnInput({
          onToolCall: async (call) => {
            seen.push(call.argumentsJson);
            return { toolCallId: call.id, toolName: call.name, content: '拒绝', isError: true };
          },
        }),
      );

      expect(seen).toEqual(['']);
    });
  });
});
