// @vitest-environment jsdom
/**
 * 换任务时，工作台不得带着上一个任务的状态（路由 `remountDeps` 的判据）。
 *
 * 走的是**真实路由树 + 真实组件 + 真实 react-query**，只替掉两样浏览器能力：
 * `fetch`（换成按路径应答的桩）与 `EventSource`（jsdom 没有）。
 * 把工作台本身也换成替身的话，测到的就是替身而不是那条不变量。
 *
 * 判据选在「B 的轨迹能不能显示」上，因为它是这个 bug 唯一会露头的地方：
 * trace 的 sequence 每任务从 1 起，跨任务复用状态时 B 的事件会被按 sequence
 * 静默去重掉——不报错、不白屏，只是时间线是错的。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter, createMemoryHistory } from '@tanstack/react-router';
import type { ExecutionView, TaskDetail } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import { routeTree } from '../router.tsx';

// ---------------------------------------------------------------- 夹具数据

function makeExecution(taskId: string, id: string): ExecutionView {
  return {
    id,
    taskId,
    operation: 'create_structure',
    targetSlotId: null,
    agentId: 'structure_designer',
    agentName: '结构设计 Agent',
    skillId: 'chapter-structure',
    skillVersion: '1.0.0',
    modelAlias: 'structure',
    provider: 'fake',
    model: 'fake-model',
    attemptNumber: 1,
    status: 'running',
    contextHash: 'ctx',
    promptHash: 'pr',
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    error: null,
  };
}

function makeTask(id: string, name: string): TaskDetail {
  return {
    id,
    name,
    templateId: 'zhihu-chapter',
    templateName: '知乎章节',
    status: 'running',
    phase: 'structure',
    presentation: { tone: 'run', state: '正在创建结构', detail: '' },
    doneSlots: 0,
    totalSlots: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    input: { chapter_packet: '输入' },
    snapshotHash: 'sha256:abc',
    slots: [],
    stepper: (['input', 'structure', 'slots', 'assembly', 'done'] as const).map((key) => ({
      key,
      label: key,
      state: 'todo' as const,
      summary: '',
      owner: key === 'structure' || key === 'slots' ? ('agent' as const) : ('system' as const),
    })),
    activeExecution: null,
    plannedAssignment: null,
    queuePosition: null,
    artifact: null,
    error: null,
  };
}

/**
 * 两个任务，各自一条 sequence=1 的轨迹。
 * sequence 刻意相同——那正是真实情况（每任务独立从 1 起），也正是 bug 的触发条件。
 */
const FIXTURES: Record<string, { task: TaskDetail; execution: ExecutionView; trace: TraceEvent }> = {
  'task-a': {
    task: makeTask('task-a', '第一章'),
    execution: makeExecution('task-a', 'exec-a'),
    trace: {
      id: 'trace-a',
      taskId: 'task-a',
      executionId: 'exec-a',
      sequence: 1,
      actor: 'agent',
      kind: 'work_plan',
      title: 'A 任务的事件',
      summary: 'A 的摘要',
      payload: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  },
  'task-b': {
    task: makeTask('task-b', '第二章'),
    execution: makeExecution('task-b', 'exec-b'),
    trace: {
      id: 'trace-b',
      taskId: 'task-b',
      executionId: 'exec-b',
      sequence: 1,
      actor: 'agent',
      kind: 'work_plan',
      title: 'B 任务的事件',
      summary: 'B 的摘要',
      payload: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  },
};

// ------------------------------------------------------------ 浏览器能力桩

/** jsdom 没有 EventSource。这里只需要它能被 new 出来并接受监听器 */
class StubEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {
    /* 本用例不推实时事件，时间线全部来自 REST 种子 */
  }
  close(): void {
    /* noop */
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按路径应答。命中不了的路径直接抛，避免「桩少写一个端点」被当成产品 bug */
function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
  const path = url.split('?')[0] ?? '';

  if (path === '/api/providers') return Promise.resolve(json({ providers: [], aliases: [], defaults: null }));

  const match = /^\/api\/tasks\/([^/]+)(\/.*)?$/.exec(path);
  if (match !== null) {
    const fixture = FIXTURES[decodeURIComponent(match[1] ?? '')];
    if (fixture === undefined) throw new Error(`夹具里没有任务 ${String(match[1])}`);
    const tail = match[2] ?? '';
    if (tail === '') return Promise.resolve(json(fixture.task));
    if (tail === '/executions') return Promise.resolve(json([fixture.execution]));
    if (tail === '/traces') return Promise.resolve(json({ events: [fixture.trace], nextAfter: null }));
  }
  throw new Error(`测试桩没有覆盖 ${url}`);
}

// -------------------------------------------------------------------- 用例

let restoreEventSource: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const previous = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  restoreEventSource = () => {
    (globalThis as { EventSource?: unknown }).EventSource = previous;
  };
});

afterEach(() => {
  cleanup();
  restoreEventSource?.();
  vi.unstubAllGlobals();
});

describe('工作台换任务', () => {
  it('从 /tasks/task-a 走到 /tasks/task-b，显示的是 B 的轨迹', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/tasks/task-a'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText('A 任务的事件');

    await router.navigate({ to: '/tasks/$taskId', params: { taskId: 'task-b' } });

    // 复用组件实例时，B 的 sequence=1 会被 A 留下的 sequence=1 去重掉，
    // 时间线要么空、要么还是 A 的——两种都在这一条断言下变红。
    await waitFor(() => {
      expect(screen.getByText('B 任务的事件')).toBeTruthy();
    });
    expect(screen.queryByText('A 任务的事件')).toBeNull();
  });
});
