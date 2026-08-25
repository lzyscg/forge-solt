/**
 * 任务工作台数据中枢（§9.4 / §10.3）。
 *
 * - 任务/执行记录走 react-query（权威状态永远来自 REST）。
 * - 时间线：首次挂载先 `GET …/traces` 拉全量作种子（**SSE 首连不补发历史**），
 *   之后 SSE `trace` 事件按 `sequence` 去重、升序追加。
 * - 流式正文：SSE `delta` 追加进按 executionId 键控的本地缓冲（不进 react-query）。
 * - `state` 事件**只做失效通知**：invalidate 任务/执行查询，不增量维护状态。
 * - 断线（§18.11）：置 `connectionLost`，保留最后权威状态，**不标失败**；
 *   EventSource 自动重连（浏览器自带 Last-Event-ID），onopen 后先校准。
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SseDeltaEventSchema,
  type ExecutionView,
  type TaskDetail,
} from '@shared/contracts.ts';
import { TraceEventSchema, type TraceEvent } from '@shared/trace.ts';
import { getTask, getExecutions, getTraces, streamUrl } from '../api/tasks.ts';

export interface WorkbenchData {
  task: TaskDetail | undefined;
  taskError: unknown;
  isTaskLoading: boolean;
  executions: ExecutionView[];
  traces: TraceEvent[];
  /** 取某 execution 的流式累计正文 */
  streamText: (executionId: string) => string;
  connectionLost: boolean;
}

export function useWorkbench(taskId: string): WorkbenchData {
  const queryClient = useQueryClient();
  const taskQuery = useQuery({ queryKey: ['task', taskId], queryFn: () => getTask(taskId) });
  const execQuery = useQuery({
    queryKey: ['task', taskId, 'executions'],
    queryFn: () => getExecutions(taskId),
  });

  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // 首连不补发历史 → 先 REST 拉全量作种子
    void (async () => {
      const all: TraceEvent[] = [];
      let after: number | undefined;
      for (;;) {
        const page = await getTraces(taskId, after === undefined ? { limit: 500 } : { after, limit: 500 });
        all.push(...page.events);
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      }
      if (!cancelled) setTraces((prev) => mergeTraces(prev, all));
    })();

    const es = new EventSource(streamUrl(taskId));
    es.onopen = () => {
      setConnectionLost(false);
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    };
    es.onerror = () => setConnectionLost(true);
    es.addEventListener('trace', (e) => {
      const ev = TraceEventSchema.parse(JSON.parse((e as MessageEvent<string>).data));
      if (!cancelled) setTraces((prev) => mergeTraces(prev, [ev]));
    });
    es.addEventListener('delta', (e) => {
      const d = SseDeltaEventSchema.parse(JSON.parse((e as MessageEvent<string>).data));
      if (!cancelled) setBuffers((prev) => ({ ...prev, [d.executionId]: (prev[d.executionId] ?? '') + d.text }));
    });
    es.addEventListener('state', () => {
      if (cancelled) return;
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['task', taskId, 'executions'] });
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [taskId, queryClient]);

  return {
    task: taskQuery.data,
    taskError: taskQuery.error,
    isTaskLoading: taskQuery.isPending,
    executions: execQuery.data ?? [],
    traces,
    streamText: (executionId) => buffers[executionId] ?? '',
    connectionLost,
  };
}

function mergeTraces(prev: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  const seen = new Set(prev.map((p) => p.sequence));
  const merged = [...prev];
  for (const ev of incoming) {
    if (!seen.has(ev.sequence)) {
      seen.add(ev.sequence);
      merged.push(ev);
    }
  }
  return merged.sort((a, b) => a.sequence - b.sequence);
}
