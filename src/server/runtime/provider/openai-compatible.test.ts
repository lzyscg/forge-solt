/**
 * OpenAI 兼容适配器测试（§7.3 / D-17）。
 *
 * 重点全部落在文档点名「最容易出 bug」的地方：流式 tool call 的跨分片累积、
 * 中止语义、429 的处理，以及隐藏推理不外流。
 */

import { describe, expect, it, vi } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
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

describe('流式 tool call 累积（§7.3 点名的高危处）', () => {
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
});
