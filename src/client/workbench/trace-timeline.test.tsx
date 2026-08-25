// @vitest-environment jsdom
/**
 * 时间线的「有 N 条新事件」计数（UX §13.4）。
 *
 * 这个数字是用户唯一的「我错过了多少」判据。它错了不会报错、不会白屏，
 * 只会让人以为自己漏看了东西——所以它必须被钉死，而不是靠眼看一眼觉得差不多。
 *
 * jsdom 里 `scrollHeight` / `clientHeight` 恒为 0，`onScroll` 算出来永远是「在底部」。
 * 因此下面用 `defineProperty` 造出一个真实的滚动几何，再触发 scroll——
 * 不造的话测的是「jsdom 的默认零值」，而不是自动跟随逻辑。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import type { TraceEvent } from '@shared/trace.ts';
import { TraceTimeline } from './TraceTimeline.tsx';

// 本仓库没开 `globals: true`（各处都显式 import vitest），
// 而 @testing-library 的自动清理挂在全局 afterEach 上——不开就不生效。
// 不显式清理的话，上一条用例的 DOM 会留在 body 里，
// `screen` 是全局查询，于是第二条用例的 getByText 会「找到多个」。
afterEach(cleanup);

function makeTrace(sequence: number): TraceEvent {
  return {
    id: `trace-${String(sequence)}`,
    taskId: 'task-1',
    executionId: 'exec-1',
    sequence,
    actor: 'agent',
    kind: 'work_progress',
    title: `事件 ${String(sequence)}`,
    summary: '摘要',
    payload: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 把滚动条挪到非底部并触发 scroll，等价于用户往上翻 */
function scrollAwayFromBottom(container: HTMLElement): void {
  const scroller = container.querySelector('.fc-scroll');
  if (scroller === null) throw new Error('找不到轨迹滚动容器');
  Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
  fireEvent.scroll(scroller);
}

describe('TraceTimeline 的新事件计数', () => {
  it('仅仅向上滚动、没有新事件时，不出现「有 N 条新事件」', () => {
    const { container } = render(<TraceTimeline traces={[makeTrace(1)]} />);

    scrollAwayFromBottom(container);

    // 停止自动跟随本身**不是**一条新事件。原实现把 `following` 也放进了
    // 同一个 effect 的依赖里且无条件 +1，于是一滚动就凭空冒出「有 1 条新事件」。
    expect(screen.queryByText(/条新事件/)).toBeNull();
    // 「回到最新」是与计数同一个条幅里的按钮，一并确认它没被带出来
    expect(screen.queryByText('回到最新')).toBeNull();
  });

  it('一次到达 3 条时报「3 条」，不是「1 条」', () => {
    const { container, rerender } = render(<TraceTimeline traces={[makeTrace(1)]} />);

    scrollAwayFromBottom(container);
    rerender(<TraceTimeline traces={[makeTrace(1), makeTrace(2), makeTrace(3), makeTrace(4)]} />);

    // 计数必须是**新增条数**，不是「渲染过几次」。原实现每次 effect 只 +1，
    // 一次推三条也只报一条，用户点「回到最新」时会以为只错过了一条。
    expect(screen.getByText('有 3 条新事件')).toBeTruthy();
  });

  it('点「回到最新」后恢复跟随并清零', () => {
    const { container, rerender } = render(<TraceTimeline traces={[makeTrace(1)]} />);

    scrollAwayFromBottom(container);
    rerender(<TraceTimeline traces={[makeTrace(1), makeTrace(2)]} />);
    expect(screen.getByText('有 1 条新事件')).toBeTruthy();

    fireEvent.click(screen.getByText('回到最新'));
    expect(screen.queryByText(/条新事件/)).toBeNull();
  });
});
