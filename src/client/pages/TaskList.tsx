/**
 * 任务列表 `/tasks`。
 *
 * 数据：`GET /api/tasks`，轮询 10s（§10.1）。
 * 状态列**不显示裸状态机值**（§14.2）：用 `presentation.state`（业务化文字）+
 * `presentation.detail`（业务事实）+ `presentation.tone` 取色。
 * 筛选是展示层归组（按 status 分桶 + 模板 + 搜索），不是重新推导状态。
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { TaskSummary } from '@shared/contracts.ts';
import { listTasks } from '../api/tasks.ts';
import { ApiError } from '../api/http.ts';
import { StatusDot } from '../components/ui/StatusDot.tsx';
import { ProgressBar } from '../components/ui/ProgressBar.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { FilterChip } from '../components/ui/FilterChip.tsx';
import { toneStyle } from '../components/tone.ts';
import { formatRelative } from '../lib/format.ts';

interface StatusFilter {
  label: string;
  match: (t: TaskSummary) => boolean;
}

const STATUS_FILTERS: StatusFilter[] = [
  { label: '全部', match: () => true },
  { label: '进行中', match: (t) => t.status === 'running' },
  { label: '等待中', match: (t) => t.status === 'ready' || t.status === 'stopped' },
  { label: '已完成', match: (t) => t.status === 'completed' },
  { label: '异常', match: (t) => t.status === 'failed' },
];

export function TaskList() {
  const navigate = useNavigate();
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: () => listTasks(), refetchInterval: 10_000 });
  const [status, setStatus] = useState('全部');
  const [tpl, setTpl] = useState('全部模板');
  const [search, setSearch] = useState('');

  const all = tasksQuery.data ?? [];
  const tplOptions = useMemo(() => ['全部模板', ...Array.from(new Set(all.map((t) => t.templateName)))], [all]);

  const rows = useMemo(() => {
    const bucket = STATUS_FILTERS.find((f) => f.label === status) ?? STATUS_FILTERS[0];
    return all.filter(
      (t) =>
        (bucket !== undefined && bucket.match(t)) &&
        (tpl === '全部模板' || t.templateName === tpl) &&
        (search === '' || t.name.includes(search)),
    );
  }, [all, status, tpl, search]);

  return (
    <>
      <header
        style={{
          flex: 'none',
          padding: '22px 32px 18px',
          borderBottom: '1px solid var(--color-divider)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 24,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 26 }}>生产任务</h3>
          <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
            {`${String(rows.length)} 个任务 · 共 ${String(all.length)}`}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/tasks/new' })}>
            新建任务
          </button>
        </div>
      </header>

      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          flexWrap: 'wrap',
          padding: '13px 32px',
          borderBottom: '1px solid var(--color-divider)',
          background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)',
        }}
      >
        <FilterGroup label="状态" options={STATUS_FILTERS.map((f) => f.label)} value={status} onChange={setStatus} />
        <FilterGroup label="模板" options={tplOptions} value={tpl} onChange={setTpl} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="input"
            placeholder="搜索任务名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ border: 'none', background: 'transparent', padding: '2px 0', width: 148, fontSize: 12.5 }}
          />
        </div>
      </div>

      <div className="fc-scroll" style={{ flex: 1, minHeight: 0 }}>
        {tasksQuery.isPending ? <EmptyState title="加载中…" /> : null}
        {tasksQuery.isError ? (
          <EmptyState title="任务列表加载失败" sub={tasksQuery.error instanceof ApiError ? tasksQuery.error.message : '请稍后重试'} />
        ) : null}

        {tasksQuery.data !== undefined && rows.length === 0 ? (
          <EmptyState title="没有符合条件的任务" sub="调整筛选条件，或新建一个任务。" />
        ) : null}

        {rows.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr>
                <Th style={{ padding: '11px 32px' }}>任务</Th>
                <Th style={{ padding: '11px 16px' }}>当前进展</Th>
                <Th style={{ padding: '11px 16px', width: 168 }}>槽位</Th>
                <Th style={{ padding: '11px 32px', width: 132, textAlign: 'right' }}>更新</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={() => void navigate({ to: `/tasks/${t.id}` })} />
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>
        {label}
      </span>
      {options.map((opt) => (
        <FilterChip key={opt} label={opt} active={value === opt} onClick={() => onChange(opt)} />
      ))}
    </div>
  );
}

function Th({ children, style }: { children: React.ReactNode; style: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        fontSize: 11,
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: 'var(--color-neutral-600)',
        fontWeight: 500,
        borderBottom: '1px solid var(--color-divider)',
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function TaskRow({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const tone = toneStyle(task.presentation.tone);
  return (
    <tr
      onClick={onOpen}
      style={{ cursor: 'pointer', borderBottom: '1px solid var(--color-divider)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent) 5%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <td style={{ padding: '15px 32px', verticalAlign: 'top' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16.5, fontWeight: 600 }}>{task.name}</div>
        <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 4 }}>{task.templateName}</div>
      </td>
      <td style={{ padding: '15px 16px', verticalAlign: 'top' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <StatusDot tone={task.presentation.tone} />
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 14, color: tone.text }}>
            {task.presentation.state}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-neutral-700)', marginTop: 5, textWrap: 'pretty' }}>
          {task.presentation.detail}
        </div>
      </td>
      <td style={{ padding: '15px 16px', verticalAlign: 'top', width: 168 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 17 }}>{task.doneSlots}</span>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}> / {task.totalSlots}</span>
        </div>
        <div style={{ marginTop: 7 }}>
          <ProgressBar done={task.doneSlots} total={task.totalSlots} color={tone.dot} />
        </div>
      </td>
      <td
        style={{
          padding: '15px 32px',
          verticalAlign: 'top',
          width: 132,
          textAlign: 'right',
          fontSize: 12.5,
          color: 'var(--color-neutral-600)',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatRelative(task.updatedAt)}
      </td>
    </tr>
  );
}
