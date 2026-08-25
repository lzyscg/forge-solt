/**
 * 执行轨迹时间线。筛选分组直接取自契约 `TRACE_FILTER_GROUPS`（§13.2，只影响展示不改变数据）。
 * actor 徽章配色：System 中性 / Agent 强调 / Tool 浅灰 / Skill 描边；
 * 失败类 kind（validation_failed / assignment_failed / late_result_rejected）走红。
 * 时间戳按服务端 `createdAt` 原样显示（不本地推算，§10.3④）。自动跟随 + 「回到最新」（§13.4）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  TRACE_FILTER_GROUPS,
  type TraceEvent,
  type TraceFilterGroup,
  type TraceActor,
} from '@shared/trace.ts';
import { formatClock } from '../lib/format.ts';

const GROUP_LABEL: Record<TraceFilterGroup, string> = {
  all: '全部',
  work: '工作说明',
  skill: 'Skill',
  tool: '工具',
  output: '输出',
  system: '系统',
};

const ACTOR_STYLE: Record<TraceActor, { bg: string; fg: string; bd: string; label: string }> = {
  system: { bg: 'var(--color-neutral-200)', fg: 'var(--color-neutral-800)', bd: 'var(--color-neutral-400)', label: 'System' },
  agent: { bg: 'var(--color-accent-100)', fg: 'var(--color-accent-800)', bd: 'var(--color-accent)', label: 'Agent' },
  tool: { bg: 'var(--color-neutral-100)', fg: 'var(--color-neutral-700)', bd: 'var(--color-neutral-300)', label: 'Tool' },
  skill: { bg: 'transparent', fg: 'var(--color-accent-700)', bd: 'var(--color-accent-300)', label: 'Skill' },
};

const FAILURE_KINDS = new Set(['validation_failed', 'assignment_failed', 'late_result_rejected']);

export function TraceTimeline({ traces, emptyNote }: { traces: TraceEvent[]; emptyNote?: string | undefined }) {
  const [group, setGroup] = useState<TraceFilterGroup>('all');
  const [openEvents, setOpenEvents] = useState<Record<string, boolean>>({});
  const [following, setFollowing] = useState(true);
  const [pending, setPending] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = traces.filter((e) => (TRACE_FILTER_GROUPS[group] as readonly string[]).includes(e.kind));

  // 新事件到达且未跟随 → 累计 pending（只看 traces 总量，切换筛选不计数）
  //
  // 计的必须是**新增条数**，靠一个 ref 记住上次看到的总量算差值。
  // 原来这里是无条件 `p + 1`，两处都错：
  //   1. `following` 也在依赖里，用户一往上滚 effect 就重跑一次，
  //      于是没有任何新事件也会立刻冒出「有 1 条新事件」——一个凭空捏造的数字；
  //   2. 一次推来三条也只 +1，用户点「回到最新」时以为只错过一条。
  // 差值为 0 时不动，顺带让「following 变化」这条重跑自然变成空操作。
  const seenCountRef = useRef(traces.length);
  useEffect(() => {
    const added = traces.length - seenCountRef.current;
    seenCountRef.current = traces.length;
    if (added > 0 && !following) setPending((p) => p + added);
  }, [traces.length, following]);

  // 自动跟随：在底部时新事件/筛选变化 → 滚到底并清零
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (following) {
      el.scrollTop = el.scrollHeight;
      setPending(0);
    }
  }, [visible.length, following]);

  return (
    <>
      <div style={{ flex: 'none', display: 'flex', gap: 4, padding: '0 16px 10px', borderBottom: '1px solid var(--color-divider)', overflowX: 'auto' }}>
        {(Object.keys(GROUP_LABEL) as TraceFilterGroup[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroup(g)}
            style={{
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${group === g ? 'var(--color-accent)' : 'transparent'}`,
              background: 'transparent',
              color: group === g ? 'var(--color-accent-700)' : 'var(--color-neutral-600)',
              whiteSpace: 'nowrap',
            }}
          >
            {GROUP_LABEL[g]}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="fc-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setFollowing(atBottom);
          if (atBottom) setPending(0);
        }}
        style={{ flex: 1, minHeight: 0, padding: '14px 16px 40px' }}
      >
        {visible.length === 0 ? (
          <div style={{ padding: '28px 14px', textAlign: 'center', fontSize: 12.5, lineHeight: 1.8, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
            {emptyNote ?? '暂无符合当前筛选的事件。'}
          </div>
        ) : (
          visible.map((ev) => (
            <TraceNode
              key={ev.sequence}
              event={ev}
              open={openEvents[`${ev.sequence}`] === true}
              onToggle={() => setOpenEvents((s) => ({ ...s, [`${ev.sequence}`]: !(s[`${ev.sequence}`] === true) }))}
            />
          ))
        )}
      </div>

      {!following && pending > 0 ? (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '8px 16px',
            borderTop: '1px solid var(--color-divider)',
            background: 'var(--color-accent-100)',
            color: 'var(--color-accent-800)',
          }}
        >
          <span style={{ fontSize: 12 }}>{`有 ${String(pending)} 条新事件`}</span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            onClick={() => {
              setFollowing(true);
              const el = scrollRef.current;
              if (el !== null) el.scrollTop = el.scrollHeight;
            }}
          >
            回到最新
          </button>
        </div>
      ) : null}
    </>
  );
}

function TraceNode({ event, open, onToggle }: { event: TraceEvent; open: boolean; onToggle: () => void }) {
  const failure = FAILURE_KINDS.has(event.kind);
  const a = ACTOR_STYLE[event.actor];
  const badge = failure ? { bg: 'var(--color-danger-bg)', fg: 'var(--color-danger)', bd: 'var(--color-danger)', label: 'Error' } : a;
  const bar = failure ? 'var(--color-danger)' : a.bd;
  const hasDetail = event.payload !== null;

  return (
    <div
      onClick={() => {
        if (hasDetail) onToggle();
      }}
      style={{ borderLeft: `2px solid ${bar}`, padding: '10px 0 12px 12px', marginBottom: 10, cursor: hasDetail ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 10,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 2,
            background: badge.bg,
            color: badge.fg,
            border: `1px solid ${event.actor === 'skill' || failure ? badge.bd : 'transparent'}`,
          }}
        >
          {badge.label}
        </span>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 13.5, color: failure ? 'var(--color-danger)' : 'var(--color-text)' }}>
          {event.title}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
          {formatClock(event.createdAt)}
        </span>
      </div>
      <div
        style={
          event.kind === 'public_output_chunk'
            ? { fontSize: 13.5, lineHeight: 1.9, color: 'var(--color-text)', borderLeft: '2px solid var(--color-accent-300)', paddingLeft: 10, textAlign: 'justify' }
            : { fontSize: 12.5, lineHeight: 1.8, color: 'var(--color-neutral-700)', textWrap: 'pretty' }
        }
      >
        {event.summary}
      </div>
      {open && event.payload !== null ? (
        <div
          style={{
            marginTop: 8,
            borderTop: '1px dashed var(--color-divider)',
            paddingTop: 8,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            lineHeight: 1.8,
            color: 'var(--color-neutral-700)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </div>
      ) : null}
    </div>
  );
}
