/**
 * Trace 脱敏（REQ §13 / §3.3）。
 *
 * 这几条测试守的是 Runtime 最危险的一条边：它手里同时有 API Key、
 * 模型隐藏推理与 Provider 原始响应，而 trace 会原样出现在前端页面上。
 */

import { describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { FakeTracePort } from './test-doubles.ts';
import { TraceWriter } from './trace-writer.ts';

function writer(): { w: TraceWriter; port: FakeTracePort } {
  const port = new FakeTracePort();
  return { w: new TraceWriter(port, 'task_1'), port };
}

const base = {
  executionId: 'exec_1',
  actor: 'system' as const,
  kind: 'assignment_started' as const,
  title: '开始执行',
  summary: 'fill_slot',
};

describe('TraceWriter', () => {
  it('干净的 payload 正常写入', () => {
    const { w, port } = writer();
    w.write({ ...base, payload: { modelAlias: 'main', provider: 'deepseek' } });
    expect(port.records).toHaveLength(1);
    expect(port.records[0]?.payload).toEqual({ modelAlias: 'main', provider: 'deepseek' });
  });

  it('顶层命中黑名单 → 抛错且一条都不写', () => {
    const { w, port } = writer();
    expect(() => w.write({ ...base, payload: { apiKey: 'sk-leak' } })).toThrow(ForgeError);
    expect(port.records).toHaveLength(0);
  });

  it('嵌套在 Provider 原始响应里的隐藏推理同样被拦（递归黑名单）', () => {
    const { w, port } = writer();
    expect(() =>
      w.write({ ...base, payload: { raw: { choices: [{ delta: { reasoning_content: '……' } }] } } }),
    ).toThrow(/脱敏/);
    expect(port.records).toHaveLength(0);
  });

  it('payload 为 null 时不做校验，也不写成 {}', () => {
    const { w, port } = writer();
    w.write({ ...base, payload: null });
    expect(port.records[0]?.payload).toBeNull();
  });

  it('delta 原样转给端口，由端口负责聚合成 chunk（§7.7）', () => {
    const { w, port } = writer();
    w.delta('exec_1', '她');
    w.delta('exec_1', '戴上耳机');
    expect(port.outputText).toBe('她戴上耳机');
    // Runtime 不落库，只转发——落库与否是端口的事
    expect(port.records).toHaveLength(0);
  });
});
