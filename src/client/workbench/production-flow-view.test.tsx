// @vitest-environment jsdom
/**
 * 右栏「生产过程」视图的组件级用例。
 *
 * 走真实的 `RightPanel` + 真实 react-query，只把 `fetch` 换成按路径应答的桩。
 * 断言集中在三件**最容易在实现里被磨掉**的事上，它们都是措辞纪律（D-30）
 * 而不是布局：
 *
 * 1. 折叠的未检出判据必须报出条数与编号，不许默默隐藏；
 * 2. 失败的执行不算进「未检出」——它连裁决都没有；
 * 3. 展开一条未检出的判据，写的是「这一次调用没有报出」，不是「通过」。
 *
 * 反证纪律（规矩 3.4）：把这三处任意一处改回「省事的写法」，对应用例必须变红。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SlotFlowView, SlotView, TaskDetail } from '@shared/contracts.ts';
import { RightPanel } from './RightPanel.tsx';

const SLOT_ID = 'scene_01';

/** 10 条判据：只有 S2 检出问题，S7 那次调用失败，其余 8 条未检出 */
function makeFlow(): SlotFlowView {
  const criteria = Array.from({ length: 10 }, (_, i) => ({
    id: `S${String(i + 1)}`,
    title: `第 ${String(i + 1)} 条判据`,
  }));

  const node = (id: string, index: number) => ({
    executionId: `exec-${id}`,
    attemptNumber: index + 2,
    status: 'succeeded' as const,
    inputTokens: 8170,
    outputTokens: 803,
    durationMs: 8400,
    error: null,
  });

  const reviews = criteria.map((criterion, index) => {
    if (criterion.id === 'S2') {
      return {
        ...node(criterion.id, index),
        criterionId: 'S2',
        criterionTitle: criterion.title,
        criterionInferred: false,
        verdict: 'revise' as const,
        findings: [{ quote: '他知道。', problem: '心理解释代替了可见行动' }],
      };
    }
    if (criterion.id === 'S7') {
      return {
        ...node(criterion.id, index),
        status: 'failed' as const,
        error: {
          code: 'ASSIGNMENT_OUTPUT_INVALID' as const,
          message: 'Agent 未通过 complete_assignment 提交结果',
          location: `slot:${SLOT_ID}`,
          action: null,
        },
        criterionId: 'S7',
        criterionTitle: criterion.title,
        criterionInferred: true,
        verdict: null,
        findings: [],
      };
    }
    return {
      ...node(criterion.id, index),
      criterionId: criterion.id,
      criterionTitle: criterion.title,
      criterionInferred: false,
      verdict: 'no_finding' as const,
      findings: [],
    };
  });

  return {
    slotId: SLOT_ID,
    calls: 11,
    inputTokens: 84823,
    outputTokens: 9135,
    criteria,
    rounds: [
      {
        round: 0,
        fills: [
          {
            executionId: 'exec-fill-1',
            attemptNumber: 1,
            status: 'succeeded',
            inputTokens: 3123,
            outputTokens: 1105,
            durationMs: 12500,
            error: null,
          },
        ],
        reviews,
        firedCount: 1,
        // 10 条判据里，1 条检出、1 条失败，未检出的是 8 条——**不是 9 条**
        cleanCount: 8,
        settlement: {
          round: 0,
          kind: 'review_revise',
          title: '审核检出问题，进入返修',
          summary: `槽位 ${SLOT_ID} 第 1 次返修`,
          createdAt: '2026-08-27T10:05:00.000Z',
        },
      },
    ],
    ending: null,
  };
}

function makeSlot(): SlotView {
  return {
    id: SLOT_ID,
    type: 'scene',
    typeName: '场景段',
    parentId: 'chapter',
    order: 0,
    depth: 1,
    path: ['chapter', SLOT_ID],
    instruction: '写第一场',
    dependsOn: [],
    contentBearing: true,
    includeInArtifact: true,
    status: 'reviewing',
    revisionRound: 0,
    reviewExhausted: false,
    presentation: { tone: 'run', state: '审核中', detail: '' },
    blockedBy: [],
    charCount: 1282,
    producer: null,
    error: null,
  };
}

function makeTask(slot: SlotView): TaskDetail {
  return {
    id: 'task-1',
    name: '流程视图',
    templateId: 'review-chapter',
    templateName: '带审核的章节',
    status: 'running',
    phase: 'slots',
    presentation: { tone: 'run', state: '生产中', detail: '' },
    doneSlots: 0,
    totalSlots: 1,
    updatedAt: '2026-08-27T10:00:00.000Z',
    input: {},
    snapshotHash: 'sha256:abc',
    slots: [slot],
    stepper: [],
    activeExecution: null,
    plannedAssignment: null,
    queuePosition: null,
    artifact: null,
    error: null,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url.endsWith('/flow')) return Promise.resolve(json(makeFlow()));
      throw new Error(`测试桩没有覆盖 ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/*
 * 不用 `@testing-library/user-event`：那是一个额外依赖，而这里需要的只有
 * 「点一下」和「按 Esc」两种动作，`fireEvent` 足够且不引入新的依赖面。
 */
function click(text: string | RegExp): void {
  fireEvent.click(screen.getByText(text));
}

function renderPanel(): void {
  const slot = makeSlot();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RightPanel
        task={makeTask(slot)}
        subject={{ kind: 'content', slot, execution: null }}
        traces={[]}
        executions={[]}
        showBackToCurrent={false}
        onBackToCurrent={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function openFlow(): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: '生产过程' }));
  await screen.findByText('审核 第 1 轮');
}

describe('右栏「生产过程」视图', () => {
  it('默认是产物视图，切到生产过程才拉流程数据', async () => {
    renderPanel();
    // 切之前一次请求都不该发：流程接口比槽位详情贵，不该为没打开的视图付钱
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    await openFlow();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  /*
   * 乙方案的全部理由：10 条判据时，成行的只有「检出」与「失败」这两条，
   * 其余 8 条塌成一行摘要。判据从 4 条改到 10 条，轮高不变。
   */
  it('只有检出与失败成行，未检出的收进摘要行', async () => {
    renderPanel();
    await openFlow();

    expect(screen.getByText('检出 1')).toBeTruthy();
    expect(screen.getByText('第 2 条判据')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('第 7 条判据')).toBeTruthy();

    // 其余 8 条不成行
    expect(screen.queryByText('第 4 条判据')).toBeNull();
    expect(screen.queryByText('第 9 条判据')).toBeNull();
  });

  /*
   * 摘要行必须**报出条数**。隐藏而不报数，读起来就是「其余都通过了」——
   * 那是 D-30 明令禁止的说法。编号也要给，否则读者不知道少了哪几条。
   */
  it('摘要行报出条数与编号，且条数不含失败的那次', async () => {
    renderPanel();
    await openFlow();

    // 8 而不是 9：S7 那次调用失败，它没有裁决，不能算成「未检出」
    expect(screen.getByText('另 8 条未检出')).toBeTruthy();
    expect(screen.queryByText('另 9 条未检出')).toBeNull();

    // 编号列到 5 个为止，首尾都留着，让人看得出跨度
    expect(screen.getByText('S1、S3、S4、S5…S10')).toBeTruthy();
  });

  it('点摘要行展开成完整行，行上写「收起这 8 条」', async () => {
    renderPanel();
    await openFlow();

    click('另 8 条未检出');
    expect(screen.getByText('第 4 条判据')).toBeTruthy();
    expect(screen.getByText('第 9 条判据')).toBeTruthy();
    expect(screen.getByText('收起这 8 条')).toBeTruthy();
  });

  /*
   * 展开一条未检出的判据，措辞不得是「通过」「合格」「已校验」（D-30）。
   * 这一次调用没报出问题，不等于正文在这条判据下没问题——两者差着一整个
   * 「S2 连着三轮都在报，每轮引的还是不同的句子」的实测教训。
   */
  it('展开未检出的判据，写的是「这一次调用没有报出」而不是「通过」', async () => {
    renderPanel();
    await openFlow();

    click('另 8 条未检出');
    click('第 4 条判据');

    const verdict = await screen.findByText(/这一次调用没有报出/);
    expect(verdict.textContent).toContain('这不等于这条判据下的正文没有问题');
    expect(verdict.textContent).not.toContain('通过');
  });

  it('展开检出的判据，显示逐字引文与问题说明', async () => {
    renderPanel();
    await openFlow();

    click('第 2 条判据');
    expect(await screen.findByText('他知道。')).toBeTruthy();
    expect(screen.getByText('心理解释代替了可见行动')).toBeTruthy();
  });

  /*
   * 失败的节点展开后必须同时说清两件事：为什么失败，以及**它照样花了钱**。
   * 只写错误码会让人以为那是一次不计成本的重试。
   */
  it('展开失败的节点，显示错误码与「token 照样计费」', async () => {
    renderPanel();
    await openFlow();

    click('第 7 条判据');
    expect(await screen.findByText(/ASSIGNMENT_OUTPUT_INVALID/)).toBeTruthy();
    expect(screen.getByText(/token 照样计费/)).toBeTruthy();
    // criterionInferred：判据是推出来的，界面不得把它当核实过的事实
    expect(screen.getByText(/判据由派发顺序推得/)).toBeTruthy();
  });

  it('系统结算成行，措辞不含「通过」', async () => {
    renderPanel();
    await openFlow();
    const settlement = screen.getByText('审核检出问题，进入返修');
    expect(settlement.textContent).not.toContain('通过');
  });

  /*
   * 收口（`ending`）与最后一轮的 `settlement` 在正常数据下是**同一条事件**。
   * 两处都无条件画，「返修次数用尽，按现状完成」会连着出现两次，
   * 读起来像是它耗尽了两回——真数据上跑出来的第一个缺陷就是这个。
   */
  it('收口就是最后一轮的结算时只画一次，不重复', async () => {
    const flow = makeFlow();
    const settlement = {
      round: 0,
      kind: 'revision_budget_exhausted' as const,
      title: '返修次数用尽，按现状完成',
      summary: '',
      createdAt: '2026-08-27T10:05:00.000Z',
    };
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        json({
          ...flow,
          rounds: [{ ...flow.rounds[0], settlement }],
          ending: settlement,
        }),
      ),
    );

    renderPanel();
    await openFlow();
    expect(screen.getAllByText('返修次数用尽，按现状完成')).toHaveLength(1);
  });

  it('非内容槽位没有视图切换——容器没有「轮次」这回事', () => {
    const container: SlotView = { ...makeSlot(), id: 'chapter', contentBearing: false };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RightPanel
          task={makeTask(container)}
          subject={{ kind: 'container', slot: container }}
          traces={[]}
          executions={[]}
          showBackToCurrent={false}
          onBackToCurrent={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('tab', { name: '生产过程' })).toBeNull();
  });

  it('Esc 收起展开的节点', async () => {
    renderPanel();
    await openFlow();

    click('第 2 条判据');
    await screen.findByText('他知道。');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('他知道。')).toBeNull();
    });
  });
});
