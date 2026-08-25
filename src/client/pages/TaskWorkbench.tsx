/**
 * 任务工作台 `/tasks/$taskId`（§18 十态、§8 三栏、§10.3 交互）。
 *
 * - 数据中枢 `useWorkbench`（REST + SSE）。
 * - `PanelSubject` 单一判据（右栏三块共用）。
 * - 自动跟随与手动选择互斥（§10.3①）。
 * - 断线只提示、**不标失败**（§18.11）。
 * - **绝不渲染** 原型底部的状态切换调试条。
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from '@tanstack/react-router';
import type { StepperKey, TaskStatus } from '@shared/contracts.ts';
import type { Tone } from '@shared/presentation.ts';
import { useWorkbench } from '../hooks/use-workbench.ts';
import { determinePanelSubject } from '../workbench/panel-subject.ts';
import { taskCommand, getSlotDetail, artifactDownloadUrl } from '../api/tasks.ts';
import { Stepper } from '../workbench/Stepper.tsx';
import { SlotTree } from '../workbench/SlotTree.tsx';
import { ContentViewer } from '../workbench/ContentViewer.tsx';
import { RightPanel } from '../workbench/RightPanel.tsx';
import { ToneChip } from '../components/ui/ToneChip.tsx';
import { ConfirmDialog } from '../components/ui/ConfirmDialog.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { ApiError } from '../api/http.ts';
import { formatRelative } from '../lib/format.ts';

export function TaskWorkbench() {
  const { taskId } = useParams({ from: '/tasks/$taskId' });
  const queryClient = useQueryClient();
  const data = useWorkbench(taskId);
  const task = data.task;

  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [followLive, setFollowLive] = useState(true);
  const [stepperFocus, setStepperFocus] = useState<StepperKey | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [treeW, setTreeW] = useState(300);
  const [panelW, setPanelW] = useState(424);

  const activeSlotId = task?.activeExecution?.targetSlotId ?? null;

  // 自动跟随：直播态下活动槽位变化即切换选择（§10.3①）
  useEffect(() => {
    if (followLive && activeSlotId !== null) {
      setSelectedSlotId(activeSlotId);
      setStepperFocus(null);
    }
  }, [followLive, activeSlotId]);

  const subject = task !== undefined ? determinePanelSubject(task, selectedSlotId, stepperFocus, data.executions) : null;

  // 选中内容槽位的已保存正文
  const wantSlotContent = subject !== null && subject.kind === 'content';
  const slotDetailQuery = useQuery({
    queryKey: ['task', taskId, 'slot', selectedSlotId],
    queryFn: () => getSlotDetail(taskId, selectedSlotId as string),
    enabled: wantSlotContent && selectedSlotId !== null,
  });

  if (data.isTaskLoading) return <EmptyState title="加载中…" />;
  if (task === undefined || subject === null) {
    return <EmptyState title="任务加载失败" sub={data.taskError instanceof ApiError ? data.taskError.message : '请稍后重试'} />;
  }

  const viewingKey: StepperKey =
    selectedSlotId !== null
      ? 'slots'
      : (stepperFocus ?? (task.phase === 'structure' ? 'structure' : task.phase === 'slots' ? 'slots' : task.phase === 'assembly' ? 'assembly' : 'done'));

  const showBackToCurrent = !followLive && activeSlotId !== null && selectedSlotId !== activeSlotId;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
  };

  // 命令端点可能 409/4xx：捕获并展示 PublicError 的 message + action（§18.8），不吞错
  const runCommand = (cmd: 'start' | 'stop' | 'resume' | 'retry') => {
    setCommandError(null);
    taskCommand(taskId, cmd)
      .then(refresh)
      .catch((e: unknown) => {
        if (e instanceof ApiError) {
          setCommandError(e.error.action !== null ? `${e.error.message}（${e.error.action}）` : e.error.message);
        } else {
          setCommandError('操作失败，请稍后重试');
        }
      });
  };

  const onStepperFocus = (key: StepperKey) => {
    if (key === 'slots') {
      const running = task.activeExecution?.targetSlotId ?? null;
      const lastDone = [...task.slots].reverse().find((s) => s.status === 'completed')?.id ?? null;
      setSelectedSlotId(running ?? lastDone);
      setStepperFocus(null);
    } else {
      setStepperFocus(key);
      setSelectedSlotId(null);
    }
  };

  const onSelectSlot = (id: string) => {
    setSelectedSlotId(id);
    setFollowLive(false);
    setStepperFocus(null);
  };

  return (
    <>
      {data.connectionLost ? (
        <div className="fc-connbar">连接已断开，正在重连…（保留最后一次权威状态，不会将任务标记为失败）</div>
      ) : null}

      <WorkbenchHeader
        name={task.name}
        templateName={task.templateName}
        tone={task.presentation.tone}
        stateText={task.presentation.state}
        phaseLabel={phaseLabel(task.phase)}
        updated={formatRelative(task.updatedAt)}
        status={task.status}
        onStart={() => runCommand('start')}
        onStop={() => setStopOpen(true)}
        onResume={() => runCommand('resume')}
        onRetry={() => runCommand('retry')}
        downloadUrl={artifactDownloadUrl(taskId)}
      />

      {commandError !== null ? (
        <div style={{ flex: 'none', padding: '9px 28px', borderBottom: '1px solid var(--color-divider)', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 12.5 }}>
          {commandError}
        </div>
      ) : null}

      {task.error !== null ? (
        <div style={{ flex: 'none', padding: '9px 28px', borderBottom: '1px solid var(--color-divider)', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 12.5 }}>
          {task.error.message}
          {task.error.action !== null ? `（${task.error.action}）` : ''}
        </div>
      ) : null}

      <Stepper steps={task.stepper} completed={task.status === 'completed'} viewingKey={viewingKey} onFocus={onStepperFocus} />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        <div style={{ width: treeW, flex: 'none', display: 'flex' }}>
          <SlotTree
            slots={task.slots}
            selectedId={selectedSlotId}
            hasStructure={task.slots.length > 0}
            emptyNote={
              task.status === 'ready'
                ? '点击“开始生产”后，Structure Agent 将根据任务输入设计内容结构。结构通过校验后，槽位树会一次性出现。'
                : 'Structure Agent 正在根据任务输入设计内容结构。结构通过校验后，槽位树会一次性出现。'
            }
            footnote={task.slots.length > 0 ? '容器槽位不承载正文，也不创建填充 Assignment。' : '结构在校验通过后冻结，P0 不支持生产期间增删槽位。'}
            onSelect={onSelectSlot}
          />
        </div>
        <ResizeHandle onDelta={(d) => setTreeW((w) => clamp(w + d, 232, 460))} side="right" />

        <main className="fc-scroll" style={{ flex: 1, minWidth: 0, padding: '26px 34px 60px' }}>
          <ContentViewer
            task={task}
            subject={subject}
            streamText={data.streamText}
            slotContent={slotDetailQuery.data?.content ?? null}
            onSelectSlot={onSelectSlot}
          />
        </main>

        <ResizeHandle onDelta={(d) => setPanelW((w) => clamp(w - d, 320, 620))} side="left" />
        <div style={{ width: panelW, flex: 'none', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--color-divider)', background: 'var(--color-bg)' }}>
          <RightPanel
            task={task}
            subject={subject}
            traces={data.traces}
            executions={data.executions}
            showBackToCurrent={showBackToCurrent}
            onBackToCurrent={() => {
              setSelectedSlotId(activeSlotId);
              setFollowLive(true);
            }}
          />
        </div>
      </div>

      <ConfirmDialog
        open={stopOpen}
        title="停止当前任务？"
        body="当前正在运行的 Agent 结果即使稍后返回，也不会被保存。已完成的结构槽不会丢失，可稍后继续。"
        list={stopSummary(task.slots)}
        confirmLabel="停止任务"
        onCancel={() => setStopOpen(false)}
        onConfirm={() => {
          setStopOpen(false);
          runCommand('stop');
        }}
      />
    </>
  );
}

function phaseLabel(phase: string): string {
  return phase === 'structure' ? '阶段：创建结构' : phase === 'slots' ? '阶段：槽位生产' : phase === 'assembly' ? '阶段：组装产物' : '阶段：已完成';
}

function stopSummary(slots: { status: string; id: string }[]): string {
  const running = slots.filter((s) => s.status === 'running').map((s) => s.id);
  const done = slots.filter((s) => s.status === 'completed').length;
  const lines = ['当前 Assignment 将被取消'];
  if (running.length > 0) lines.push(`${running.join('、')} 恢复为等待生产`);
  lines.push(`已完成的 ${String(done)} 个槽位保留`);
  return lines.join('\n');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface HeaderProps {
  name: string;
  templateName: string;
  tone: Tone;
  stateText: string;
  phaseLabel: string;
  updated: string;
  status: TaskStatus;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
  onRetry: () => void;
  downloadUrl: string;
}

function WorkbenchHeader(p: HeaderProps) {
  return (
    <header style={{ flex: 'none', padding: '20px 28px 16px', borderBottom: '1px solid var(--color-divider)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <Link to="/tasks" style={{ fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', textDecoration: 'none', color: 'var(--color-neutral-500)' }}>
              生产任务 /
            </Link>
            <h3 style={{ margin: 0, fontSize: 26, letterSpacing: 0 }}>{p.name}</h3>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{p.templateName}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9, fontSize: 12.5 }}>
            <ToneChip tone={p.tone}>{p.stateText}</ToneChip>
            <span style={{ color: 'var(--color-neutral-400)' }}>·</span>
            <span style={{ color: 'var(--color-neutral-700)' }}>{p.phaseLabel}</span>
            <span style={{ color: 'var(--color-neutral-400)' }}>·</span>
            <span style={{ color: 'var(--color-neutral-500)' }}>{p.updated}</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {p.status === 'ready' ? (
            <button type="button" className="btn btn-primary" onClick={p.onStart}>
              开始生产
            </button>
          ) : null}
          {p.status === 'running' ? (
            <button type="button" className="btn btn-primary" onClick={p.onStop}>
              停止
            </button>
          ) : null}
          {p.status === 'stopped' ? (
            <button type="button" className="btn btn-primary" onClick={p.onResume}>
              继续生产
            </button>
          ) : null}
          {p.status === 'failed' ? (
            <button type="button" className="btn btn-primary" onClick={p.onRetry}>
              重试
            </button>
          ) : null}
          {p.status === 'completed' ? (
            <a className="btn btn-primary" href={p.downloadUrl}>
              下载产物
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** 垂直拖拽手柄（三栏可拖拽，§8）。纯鼠标事件，测试无需 ResizeObserver。 */
function ResizeHandle({ onDelta, side }: { onDelta: (dx: number) => void; side: 'left' | 'right' }) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        let last = e.clientX;
        const move = (ev: MouseEvent) => {
          onDelta(ev.clientX - last);
          last = ev.clientX;
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.userSelect = '';
        };
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      style={{ width: 7, cursor: 'col-resize', flex: 'none', zIndex: 16 }}
      title={side === 'right' ? '拖动调整左栏' : '拖动调整右栏'}
    />
  );
}
