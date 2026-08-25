/**
 * TraceService —— §5.5 的两段式与 §7.7 的输出缓冲。
 *
 * 这个文件里最重要的一条是「回滚时 published 为空」。它是 §5.5 那段话的全部意义：
 * 事务回滚而 trace 已经推出去，UI 会显示一个从未发生的事件。
 * 若哪天有人把 publish 挪进事务回调里，库里照样回滚干净，只有这条断言会红。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { SseDeltaEvent } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import { createTestEnv, dumpAll, seedTask, type TestEnv } from '../../../tests/fixtures/db.ts';
import type { FlushScheduler, TracePublisher, TraceService } from './trace-service.ts';
import { createTraceService } from './trace-service.ts';

let env: TestEnv;
afterEach(() => env?.close());

class Boom extends Error {}

interface Harness {
  traces: TraceService;
  published: TraceEvent[];
  deltas: SseDeltaEvent[];
  flushes: (() => void)[];
}

function harness(options: { maxChunkChars?: number } = {}): Harness {
  env = createTestEnv();
  seedTask(env);
  const published: TraceEvent[] = [];
  const deltas: SseDeltaEvent[] = [];
  const flushes: (() => void)[] = [];
  const publisher: TracePublisher = {
    publishTrace: (_taskId, event) => published.push(event),
    publishDelta: (_taskId, event) => deltas.push(event),
  };
  const scheduler: FlushScheduler = {
    schedule(fn) {
      flushes.push(fn);
      return () => {
        const index = flushes.indexOf(fn);
        if (index >= 0) flushes.splice(index, 1);
      };
    },
  };
  const traces = createTraceService({
    uow: env.uow,
    publisher,
    scheduler,
    ...(options.maxChunkChars === undefined ? {} : { maxChunkChars: options.maxChunkChars }),
  });
  return { traces, published, deltas, flushes };
}

const draft = (summary: string) =>
  ({
    taskId: 'task-1',
    executionId: null,
    actor: 'system',
    kind: 'task_state_changed',
    title: '状态变化',
    summary,
  }) as const;

describe('§5.5：事务内 insert，事务返回后 publish', () => {
  it('提交成功：库里与 SSE 各拿到同一批事件，sequence 在事务内递增', () => {
    const { traces, published } = harness();
    traces.runWithTraces((_repos, trace) => {
      trace.record(draft('第一条'));
      trace.record(draft('第二条'));
    });

    expect(env.uow.repositories.traces.listByTask('task-1').map((e) => e.sequence)).toEqual([1, 2]);
    expect(published.map((e) => e.summary)).toEqual(['第一条', '第二条']);
  });

  it('事务回滚：全库逐字节不变，且一条 SSE 都没推出去', () => {
    const { traces, published } = harness();
    const before = dumpAll(env.db);

    expect(() =>
      traces.runWithTraces((repos, trace) => {
        trace.record(draft('这条不该被看见'));
        repos.tasks.update('task-1', { status: 'failed' });
        throw new Boom('中途失败');
      }),
    ).toThrow(Boom);

    expect(dumpAll(env.db)).toEqual(before);
    expect(published).toEqual([]);
  });

  it('上一次失败的事件不会串到下一次成功的推送里', () => {
    const { traces, published } = harness();
    expect(() =>
      traces.runWithTraces((_repos, trace) => {
        trace.record(draft('失败批次'));
        throw new Boom('x');
      }),
    ).toThrow(Boom);

    traces.emit(draft('成功批次'));
    expect(published.map((e) => e.summary)).toEqual(['成功批次']);
  });

  it('REQ §13：payload 命中脱敏黑名单时写入失败，且什么都不留', () => {
    const { traces, published } = harness();
    const before = dumpAll(env.db);

    expect(() =>
      traces.emit({
        ...draft('带密钥的事件'),
        // 嵌套在 provider 原始响应里是最常见的事故形态
        payload: { response: { headers: { authorization: 'Bearer sk-xxx' } } },
      }),
    ).toThrow();

    expect(dumpAll(env.db)).toEqual(before);
    expect(published).toEqual([]);
  });

  it('REQ §13：模型隐藏推理同样进不去', () => {
    const { traces } = harness();
    expect(() =>
      traces.emit({ ...draft('推理'), payload: { reasoning: '我先想一想……' } }),
    ).toThrow();
  });
});

describe('§7.7：SSE 推 delta，数据库存 chunk', () => {
  it('delta 实时推但不落库；缓冲区未满时也不落库', () => {
    const { traces, deltas } = harness({ maxChunkChars: 1000 });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '她戴上耳机，' });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '雨声被隔开。' });

    expect(deltas.map((d) => d.text)).toEqual(['她戴上耳机，', '雨声被隔开。']);
    // 逐 token 落库正是 §7.7 要禁止的事
    expect(env.uow.repositories.traces.listByTask('task-1')).toEqual([]);
  });

  it('延迟刷盘：一次落一条 public_output_chunk，正文在 payload 里', () => {
    const { traces, flushes, published } = harness({ maxChunkChars: 1000 });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '她戴上耳机，' });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '雨声被隔开。' });

    expect(flushes).toHaveLength(1); // 每段缓冲只排一次队，不是每个 delta 排一次
    flushes[0]?.();

    const events = env.uow.repositories.traces.listByTask('task-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('public_output_chunk');
    expect(events[0]?.payload).toEqual({ text: '她戴上耳机，雨声被隔开。', chars: 12 });
    expect(published).toHaveLength(1);
  });

  it('缓冲区达到阈值立即落盘，不等定时器', () => {
    const { traces, flushes } = harness({ maxChunkChars: 8 });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '一二三四五六七八九' });

    expect(env.uow.repositories.traces.listByTask('task-1')).toHaveLength(1);
    expect(flushes).toHaveLength(0);
  });

  it('D-11：闸门关闭后 discardOutput 丢弃缓冲，不写 trace', () => {
    const { traces } = harness({ maxChunkChars: 1000 });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '提交之后还在说的话' });
    traces.discardOutput('exec-1');
    traces.flushAll();

    expect(env.uow.repositories.traces.listByTask('task-1')).toEqual([]);
  });

  it('flushAll 把尾巴落干净，且不会重复落第二次', () => {
    const { traces } = harness({ maxChunkChars: 1000 });
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '尾巴' });
    traces.flushAll();
    traces.flushAll();

    expect(env.uow.repositories.traces.listByTask('task-1')).toHaveLength(1);
  });

  it('空 delta 不推也不缓冲', () => {
    const { traces, deltas, flushes } = harness();
    traces.bufferOutput({ taskId: 'task-1', executionId: 'exec-1', delta: '' });
    expect(deltas).toEqual([]);
    expect(flushes).toEqual([]);
  });
});
