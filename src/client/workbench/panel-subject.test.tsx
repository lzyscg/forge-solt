// @vitest-environment jsdom
/**
 * PanelSubject 五分支判据的测试（M6 完成判据之一）。
 *
 * 两层：
 *  1. 纯函数 `determinePanelSubject` 的五分支（判据本身）；
 *  2. 组件层：渲染消费 `PanelSubject` 的 `RightPanel`，断言每个分支的区分性内容。
 *
 * 反证纪律（规矩 3.4）：把某分支判据改坏，对应用例必须变红。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ExecutionView, SlotView, StepperKey, TaskDetail } from '@shared/contracts.ts';
import { determinePanelSubject } from './panel-subject.ts';
import { RightPanel } from './RightPanel.tsx';

// 没开 `globals: true`，@testing-library 的自动清理不生效。
// 眼下每条用例断言的文案恰好互不相同所以没炸，但那是巧合不是保证——
// 下一条用例只要与前一条共用一个词，就会「找到多个元素」。
afterEach(cleanup);

function makeSlot(o: Partial<SlotView> = {}): SlotView {
  return {
    id: 'scene_01',
    type: 'scene',
    typeName: '场景段',
    parentId: 'chapter',
    order: 0,
    depth: 1,
    path: ['chapter', 'scene_01'],
    instruction: '测试指令',
    dependsOn: [],
    contentBearing: true,
    includeInArtifact: true,
    status: 'pending',
    revisionRound: 0,
    reviewExhausted: false,
    presentation: { tone: 'idle', state: '可生产', detail: '' },
    blockedBy: [],
    charCount: null,
    producer: null,
    error: null,
    ...o,
  };
}

function makeExecution(o: Partial<ExecutionView> = {}): ExecutionView {
  return {
    id: 'exec-1',
    taskId: 'task-1',
    operation: 'fill_slot',
    targetSlotId: 'scene_01',
    agentId: 'writer',
    agentName: '章节写作 Agent',
    skillId: 'scene-writing',
    skillVersion: '1.0.0',
    modelAlias: 'main',
    provider: 'deepseek',
    model: 'deepseek-chat',
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
    ...o,
  };
}

function makeStepper() {
  const defs: { key: StepperKey; owner: 'system' | 'agent' }[] = [
    { key: 'input', owner: 'system' },
    { key: 'structure', owner: 'agent' },
    { key: 'slots', owner: 'agent' },
    { key: 'assembly', owner: 'system' },
    { key: 'done', owner: 'system' },
  ];
  return defs.map((d) => ({ key: d.key, label: d.key, state: 'todo' as const, summary: '', owner: d.owner }));
}

function makeTask(o: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 'task-1',
    name: '测试任务',
    templateId: 'tpl',
    templateName: '测试模板',
    status: 'running',
    phase: 'slots',
    presentation: { tone: 'run', state: '正在填充 Slot', detail: '' },
    doneSlots: 0,
    totalSlots: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    input: { chapter_packet: '冻结输入' },
    snapshotHash: 'sha256:abc',
    slots: [],
    stepper: makeStepper(),
    activeExecution: null,
    plannedAssignment: null,
    queuePosition: null,
    artifact: null,
    error: null,
    ...o,
  };
}

describe('determinePanelSubject 纯判据（五分支）', () => {
  it('选中容器槽位 → container', () => {
    const container = makeSlot({ id: 'chapter', contentBearing: false });
    const task = makeTask({ slots: [container] });
    const s = determinePanelSubject(task, 'chapter', null, []);
    expect(s.kind).toBe('container');
  });

  it('选中内容槽位 → content', () => {
    const slot = makeSlot({ id: 'scene_01' });
    const task = makeTask({ slots: [slot] });
    const s = determinePanelSubject(task, 'scene_01', null, []);
    expect(s.kind).toBe('content');
  });

  it('Stepper 焦点 input → input', () => {
    const s = determinePanelSubject(makeTask(), null, 'input', []);
    expect(s.kind).toBe('input');
  });

  it('Stepper 焦点 assembly → assembly', () => {
    const s = determinePanelSubject(makeTask(), null, 'assembly', []);
    expect(s.kind).toBe('assembly');
  });

  it('phase=structure 且无选择 → structure', () => {
    const exec = makeExecution({ operation: 'create_structure', targetSlotId: null });
    const task = makeTask({ phase: 'structure' });
    const s = determinePanelSubject(task, null, null, [exec]);
    expect(s.kind).toBe('structure');
  });
});

describe('RightPanel 组件按 subject 分支渲染', () => {
  const noop = () => {};

  it('container 分支：显示「容器槽位」且不伪造 Producer', () => {
    const container = makeSlot({ id: 'chapter', contentBearing: false });
    const task = makeTask({ slots: [container] });
    render(<RightPanel task={task} subject={{ kind: 'container', slot: container }} traces={[]} executions={[]} showBackToCurrent={false} onBackToCurrent={noop} />);
    expect(screen.getByText('容器槽位')).toBeTruthy();
    expect(screen.getByText('无 Assignment')).toBeTruthy();
  });

  it('input 分支：显示「任务输入」', () => {
    const task = makeTask();
    render(<RightPanel task={task} subject={{ kind: 'input' }} traces={[]} executions={[]} showBackToCurrent={false} onBackToCurrent={noop} />);
    expect(screen.getByText('任务输入')).toBeTruthy();
  });

  it('assembly 分支：显示「系统组装」', () => {
    const task = makeTask();
    render(<RightPanel task={task} subject={{ kind: 'assembly' }} traces={[]} executions={[]} showBackToCurrent={false} onBackToCurrent={noop} />);
    expect(screen.getByText('系统组装')).toBeTruthy();
  });

  it('structure 分支：显示「创建结构」', () => {
    const task = makeTask();
    render(<RightPanel task={task} subject={{ kind: 'structure', execution: null }} traces={[]} executions={[]} showBackToCurrent={false} onBackToCurrent={noop} />);
    expect(screen.getByText('创建结构')).toBeTruthy();
  });

  it('content 分支（运行中）：显示「进行中」', () => {
    const slot = makeSlot({ id: 'scene_01', status: 'running' });
    const exec = makeExecution({ targetSlotId: 'scene_01', status: 'running' });
    const task = makeTask({ slots: [slot], activeExecution: exec });
    render(<RightPanel task={task} subject={{ kind: 'content', slot, execution: exec }} traces={[]} executions={[]} showBackToCurrent={false} onBackToCurrent={noop} />);
    expect(screen.getByText('进行中')).toBeTruthy();
  });
});
