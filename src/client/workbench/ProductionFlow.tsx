/**
 * 右栏「生产过程」视图：把一个槽位的执行序列画成一条流向图。
 *
 * 与「产物」视图共用同一个槽位、同一批数据，区别只在**组织方式**：
 * 产物答「产出是什么」，这里答「产出经历了什么」。
 *
 * ## 为什么默认只显示检出问题的判据
 *
 * 判据条数由审核 Skill 定义，改一次 SKILL.md 就可能从 4 条变成 10 条。
 * 每条判据都摊成一行，返修三轮就是 30 行，而其中通常只有 1~2 行有内容——
 * 有用的信息被没用的行按比例稀释掉了。
 *
 * 所以：检出问题的成行，未检出的收进一条摘要行。摘要行**必须报出条数与编号**
 * （「另 9 条未检出 · S1、S3、S4…S10」），不许默默隐藏——隐藏而不报数，
 * 读起来就是「其余都通过了」，那正是 D-30 明令禁止的说法。
 *
 * ## 三条措辞纪律（D-30）
 *
 * 1. 折叠的数量必须说出来；
 * 2. 失败的执行**不算进「未检出」**——它连裁决都没有，并进去等于在界面上说
 *    「这条判据看过了，没问题」；
 * 3. 展开一条未检出的判据，写的是「这一次调用没有报出」，不是「通过」。
 *
 * ## 节点内部的运行过程从哪来
 *
 * 不另发请求：工作台本来就持有全量轨迹（`useWorkbench` 的 traces），
 * 这里按 executionId 挑。骨架接口刻意不带明细——一个槽位的轨迹实测 685 条 /
 * 81.7 KB，跟着骨架一起返回就是把面板变成第二个 firehose。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FlowNodeView, FlowReviewNodeView, FlowRoundView, SlotFlowView } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import { getSlotFlow } from '../api/tasks.ts';
import { ApiError } from '../api/http.ts';
import { formatDurationMs } from '../lib/format.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** 摘要行里最多列几个编号，超出后中间省略。10 条判据时列成一行也读不完 */
const MAX_IDS_SHOWN = 5;

interface Props {
  taskId: string;
  slotId: string;
  /** 工作台已持有的全量轨迹，用于展开节点时取运行过程 */
  traces: TraceEvent[];
}

export function ProductionFlow({ taskId, slotId, traces }: Props) {
  const query = useQuery({
    queryKey: ['task', taskId, 'slot', slotId, 'flow'],
    queryFn: () => getSlotFlow(taskId, slotId),
  });

  const [open, setOpen] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 展开/收起前记下的锚点，布局完成后据此把滚动位置补回去 */
  const anchorRef = useRef<{ key: string; top: number } | null>(null);

  // 切换槽位时收起一切：上一个槽位展开到第 3 轮，换过来还停在那个位置是纯噪音
  useEffect(() => {
    setOpen(null);
    setFolded({});
  }, [slotId]);

  // Esc 收起。展开区可能很长，滚到中间时那个 sticky 的「收起」按钮还在视野里，
  // 但键盘应当同样能出去
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /*
   * 展开一个节点会把它下面的所有内容往下推；收起则往上收。不补偿的话，
   * 收起第 3 轮的某一条，视线会突然跳到第 1 轮——用户以为自己滚错了。
   * 做法是记下被点那一行在视口里的位置，重排后把差值加回 scrollTop。
   */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor === null) return;
    const scroller = scrollRef.current;
    const row = scroller?.querySelector(`[data-key="${anchor.key}"]`);
    if (scroller == null || row == null) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  });

  const anchorOn = (key: string): void => {
    const row = scrollRef.current?.querySelector(`[data-key="${key}"]`);
    anchorRef.current = row == null ? null : { key, top: row.getBoundingClientRect().top };
  };

  const toggle = (key: string): void => {
    anchorOn(key);
    setOpen((current) => (current === key ? null : key));
  };

  const toggleFold = (key: string): void => {
    anchorOn(key);
    setOpen(null);
    setFolded((current) => ({ ...current, [key]: current[key] !== true }));
  };

  if (query.isPending) return <Note text="加载生产过程…" />;
  if (query.error !== null) {
    return (
      <Note
        text={
          query.error instanceof ApiError
            ? query.error.error.message
            : '生产过程加载失败，请稍后重试'
        }
      />
    );
  }

  const flow = query.data;
  if (flow.rounds.length === 0) {
    return <Note text="该槽位还没有执行记录。系统不会为未开始的槽位画出虚假的生产过程。" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <FlowHeader flow={flow} />
      <div ref={scrollRef} className="fc-scroll" style={{ flex: 1, minHeight: 0, padding: '6px 0 40px' }}>
        <div style={{ position: 'relative', paddingLeft: 34 }}>
          <span
            aria-hidden
            style={{ position: 'absolute', left: 17, top: 14, bottom: 14, width: 1, background: 'var(--color-divider)' }}
          />
          {flow.rounds.map((round) => (
            <Round
              key={round.round}
              round={round}
              traces={traces}
              open={open}
              folded={folded[`fold-${String(round.round)}`] === true}
              onToggle={toggle}
              onToggleFold={() => toggleFold(`fold-${String(round.round)}`)}
            />
          ))}
          {/*
            收口在绝大多数情况下**就是最后一轮的结算**，那一条已经由 Round 画过了。
            无条件再画一遍，「返修次数用尽，按现状完成」会连着出现两次——
            读起来像是它耗尽了两回。只有当收口的轮号对不上任何一轮时才补画，
            那种情况只会在数据缺角时出现，而那时宁可多一行也不能把结论吞掉。
          */}
          {flow.ending !== null &&
          !flow.rounds.some((round) => round.settlement?.round === flow.ending?.round) ? (
            <Settlement kind={flow.ending.kind} title={flow.ending.title} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FlowHeader({ flow }: { flow: SlotFlowView }) {
  const criteria =
    flow.criteria.length === 0
      ? '无审核绑定'
      : `${String(flow.criteria.length)} 条判据`;
  return (
    <div
      style={{
        flex: 'none',
        padding: '0 16px 11px',
        borderBottom: '1px solid var(--color-divider)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>{criteria}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontFamily: MONO,
          fontSize: 10.5,
          color: 'var(--color-neutral-500)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {`${String(flow.calls)} 次调用 · ${tokens(flow.inputTokens)} → ${tokens(flow.outputTokens)}`}
      </span>
    </div>
  );
}

function Round({
  round,
  traces,
  open,
  folded,
  onToggle,
  onToggleFold,
}: {
  round: FlowRoundView;
  traces: TraceEvent[];
  open: string | null;
  folded: boolean;
  onToggle: (key: string) => void;
  onToggleFold: () => void;
}) {
  // 未检出 = 有裁决且没有 findings。失败的（verdict 为 null）不在其中——
  // 把它并进来就是在说「这条判据看过了没问题」，而它连裁决都没有。
  const clean = round.reviews.filter((r) => r.verdict !== null && r.findings.length === 0);
  const shown = round.reviews.filter((r) => !clean.includes(r));
  const elapsed = round.reviews.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);

  return (
    <>
      {round.fills.map((fill, index) => (
        <FillNode
          key={fill.executionId}
          node={fill}
          label={fillLabel(round.round, index)}
          traces={traces}
          open={open === fill.executionId}
          onToggle={() => onToggle(fill.executionId)}
        />
      ))}

      {round.reviews.length > 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '12px 16px 5px 0',
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: 'var(--color-neutral-500)',
          }}
        >
          <span>{`审核 第 ${String(round.round + 1)} 轮`}</span>
          <span style={{ flex: 1, height: 1, background: 'var(--color-divider)' }} />
          <span style={{ letterSpacing: '.04em', textTransform: 'none', fontVariantNumeric: 'tabular-nums' }}>
            {`${String(round.reviews.length)} 次 · ${formatDurationMs(elapsed)}`}
          </span>
        </div>
      ) : null}

      {shown.map((node) => (
        <ReviewNode
          key={node.executionId}
          node={node}
          traces={traces}
          open={open === node.executionId}
          onToggle={() => onToggle(node.executionId)}
        />
      ))}

      {clean.length > 0 ? (
        <>
          {folded
            ? clean.map((node) => (
                <ReviewNode
                  key={node.executionId}
                  node={node}
                  traces={traces}
                  open={open === node.executionId}
                  onToggle={() => onToggle(node.executionId)}
                  muted
                />
              ))
            : null}
          <FoldRow
            foldKey={`fold-${String(round.round)}`}
            count={clean.length}
            ids={clean.map((r) => r.criterionId)}
            folded={folded}
            onToggle={onToggleFold}
          />
        </>
      ) : null}

      {round.settlement !== null ? (
        <Settlement kind={round.settlement.kind} title={round.settlement.title} />
      ) : null}
    </>
  );
}

/**
 * 未检出判据的摘要行。
 *
 * 条数与编号都要出现在行上：只写「另 9 条」读者不知道少了哪几条，
 * 什么都不写则读起来就是「其余都通过了」。超过 5 个编号时中间省略，
 * 但**首尾都保留**，让人能看出跨度。
 */
function FoldRow({
  foldKey,
  count,
  ids,
  folded,
  onToggle,
}: {
  foldKey: string;
  count: number;
  ids: string[];
  folded: boolean;
  onToggle: () => void;
}) {
  const summary =
    ids.length > MAX_IDS_SHOWN
      ? `${ids.slice(0, MAX_IDS_SHOWN - 1).join('、')}…${ids[ids.length - 1] ?? ''}`
      : ids.join('、');
  return (
    <button
      type="button"
      data-key={foldKey}
      onClick={onToggle}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        textAlign: 'left',
        appearance: 'none',
        background: 'none',
        border: 0,
        font: 'inherit',
        padding: '7px 16px 7px 0',
        cursor: 'pointer',
        color: 'var(--color-neutral-600)',
      }}
    >
      <span aria-hidden style={{ fontSize: 9, width: 9, color: 'var(--color-neutral-500)' }}>
        {folded ? '▾' : '▸'}
      </span>
      <span style={{ fontSize: 12.5 }}>
        {folded ? `收起这 ${String(count)} 条` : `另 ${String(count)} 条未检出`}
      </span>
      {folded ? null : (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: 'var(--color-neutral-500)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summary}
        </span>
      )}
    </button>
  );
}

function FillNode({
  node,
  label,
  traces,
  open,
  onToggle,
}: {
  node: FlowNodeView;
  label: string;
  traces: TraceEvent[];
  open: boolean;
  onToggle: () => void;
}) {
  const failed = node.status === 'failed';
  return (
    <NodeShell nodeKey={node.executionId} open={open} failed={failed} onToggle={onToggle}
      head={
        <>
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 600,
              fontSize: 14,
              color: failed ? 'var(--color-danger)' : 'var(--color-text)',
            }}
          >
            {label}
          </span>
          {failed ? <Pill tone="danger">失败</Pill> : null}
        </>
      }
      meta={node}
      body={<NodeBody node={node} traces={traces} label={label} onClose={onToggle} />}
    />
  );
}

function ReviewNode({
  node,
  traces,
  open,
  onToggle,
  muted = false,
}: {
  node: FlowReviewNodeView;
  traces: TraceEvent[];
  open: boolean;
  onToggle: () => void;
  muted?: boolean;
}) {
  const failed = node.verdict === null;
  const fired = node.findings.length > 0;
  return (
    <NodeShell nodeKey={node.executionId} open={open} failed={failed} onToggle={onToggle}
      head={
        <>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--color-neutral-500)', flex: 'none', minWidth: 19 }}>
            {node.criterionId === '' ? '—' : node.criterionId}
          </span>
          <span
            style={{
              fontSize: 13,
              color: muted ? 'var(--color-neutral-600)' : 'var(--color-text)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.criterionTitle ?? '（该判据不在任务冻结的 Skill 快照里）'}
          </span>
          {failed ? (
            <Pill tone="danger">失败</Pill>
          ) : fired ? (
            <Pill tone="danger">{`检出 ${String(node.findings.length)}`}</Pill>
          ) : (
            <Pill tone="muted">未检出</Pill>
          )}
        </>
      }
      meta={node}
      body={<NodeBody node={node} traces={traces} label={`判据 ${node.criterionId}`} onClose={onToggle} />}
    />
  );
}

/** 节点外壳：左侧圆点 + 可点的行 + 展开区。三种节点只是 head/body 不同 */
function NodeShell({
  nodeKey,
  open,
  failed,
  onToggle,
  head,
  meta,
  body,
}: {
  nodeKey: string;
  open: boolean;
  failed: boolean;
  onToggle: () => void;
  head: React.ReactNode;
  meta: FlowNodeView;
  body: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: -22,
          top: 14,
          width: 7,
          height: 7,
          borderRadius: '50%',
          boxSizing: 'border-box',
          background: open ? 'var(--color-accent)' : failed ? 'var(--color-danger-bg)' : 'var(--color-bg)',
          border: `1.5px solid ${open ? 'var(--color-accent)' : failed ? 'var(--color-danger)' : 'var(--color-neutral-400)'}`,
        }}
      />
      <button
        type="button"
        data-key={nodeKey}
        aria-expanded={open}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'block',
          textAlign: 'left',
          appearance: 'none',
          background: open ? 'var(--color-surface)' : 'none',
          border: 0,
          borderLeft: open ? '2px solid var(--color-accent)' : '2px solid transparent',
          // 展开时整行向左顶到脊线上，再用 paddingLeft 把文字推回原位。
          // 四个方向必须全写长写法：简写的 `padding` 会连同这里的 paddingLeft
          // 一起覆盖掉，展开的行会缩回去 32px——React 也会为此发警告。
          marginLeft: open ? -34 : 0,
          paddingTop: 8,
          paddingRight: 16,
          paddingBottom: 8,
          paddingLeft: open ? 32 : 0,
          font: 'inherit',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>{head}</span>
        <span
          style={{
            display: 'flex',
            gap: 9,
            marginTop: 2,
            fontFamily: MONO,
            fontSize: 10,
            color: 'var(--color-neutral-500)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>{meta.durationMs === null ? '进行中' : formatDurationMs(meta.durationMs)}</span>
          <span style={{ marginLeft: 'auto' }}>
            {meta.inputTokens === null || meta.outputTokens === null
              ? '未记账'
              : `${tokens(meta.inputTokens)} → ${tokens(meta.outputTokens)}`}
          </span>
        </span>
      </button>
      {open ? (
        <div
          style={{
            background: 'var(--color-surface)',
            borderLeft: '2px solid var(--color-accent)',
            marginLeft: -34,
            paddingLeft: 32,
            paddingRight: 16,
            paddingBottom: 14,
          }}
        >
          {body}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 展开区。
 *
 * 顶部那条「收起」是 sticky 的：展开一次审核调用，运行过程加上引文能有两三屏，
 * 滚到中间时若没有随行的出口，唯一的办法是往回滚到行头。
 */
function NodeBody({
  node,
  traces,
  label,
  onClose,
}: {
  node: FlowNodeView | FlowReviewNodeView;
  traces: TraceEvent[];
  label: string;
  onClose: () => void;
}) {
  const mine = traces.filter((t) => t.executionId === node.executionId);
  const chunks = mine.filter((t) => t.kind === 'public_output_chunk');
  const steps = collapseChunks(mine, chunks.length);
  const visibleOutput = chunks.map(chunkText).join('');
  const review = 'criterionId' in node ? node : null;

  return (
    <>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          background: 'var(--color-surface)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 0',
          borderBottom: '1px solid var(--color-divider)',
          marginBottom: 10,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-600)' }}>
          {label}
        </span>
        {review !== null && review.criterionInferred ? (
          <span style={{ fontSize: 10.5, color: 'var(--color-neutral-500)' }}>判据由派发顺序推得，非库中记录</span>
        ) : null}
        {/*
          展开区能有两三屏（这一段模型可见输出实测 1697 字符）。滚到中间时若没有
          随行的出口，唯一的办法是往回滚到行头——所以这条是 sticky 的，
          并把 Esc 一并写在按钮上，免得快捷键成为只有实现者知道的秘密。
        */}
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: 'auto',
            appearance: 'none',
            background: 'none',
            border: '1px solid var(--color-divider)',
            borderRadius: 3,
            font: 'inherit',
            fontSize: 10.5,
            lineHeight: 1.5,
            color: 'var(--color-neutral-600)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          收起
          <kbd style={{ fontFamily: MONO, fontSize: 9.5, opacity: 0.65, marginLeft: 3 }}>Esc</kbd>
        </button>
      </div>

      <Section>运行过程</Section>
      {steps.length === 0 ? (
        <Muted>这次调用没有留下轨迹。</Muted>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.95 }}>
          {steps.map((step) => (
            <li key={step.key} style={{ position: 'relative', paddingLeft: 13 }}>
              <span aria-hidden style={{ position: 'absolute', left: 0, top: '.72em', width: 4, height: 1, background: 'var(--color-neutral-400)' }} />
              {step.text}
            </li>
          ))}
        </ul>
      )}

      {visibleOutput === '' ? null : (
        <>
          <Section>{`模型可见输出 · ${String(visibleOutput.length)} 字符`}</Section>
          <Clamp text={visibleOutput} />
        </>
      )}

      {node.error !== null ? (
        <>
          <Section>失败原因</Section>
          <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--color-danger)' }}>
            {`${node.error.code} · ${node.error.message}`}
          </div>
          {/* 这一句是这个视图存在的理由之一：失败不等于没花钱 */}
          <Muted>产出丢失，这次调用的 token 照样计费。</Muted>
        </>
      ) : review === null ? null : review.findings.length > 0 ? (
        <>
          <Section>{`检出 ${String(review.findings.length)} 处`}</Section>
          {review.findings.map((finding, index) => (
            <div
              key={`${finding.quote}-${String(index)}`}
              style={{
                borderTop: index === 0 ? 0 : '1px solid var(--color-divider)',
                paddingTop: index === 0 ? 0 : 9,
                marginTop: index === 0 ? 0 : 9,
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  color: 'var(--color-text)',
                  borderLeft: '2px solid var(--color-danger)',
                  paddingLeft: 9,
                  marginBottom: 5,
                }}
              >
                {finding.quote}
              </div>
              <div style={{ fontSize: 11.5, lineHeight: 1.7, color: 'var(--color-neutral-700)' }}>{finding.problem}</div>
            </div>
          ))}
        </>
      ) : (
        <>
          <Section>判定</Section>
          {/* 不写「通过」。这条调用只证明它没报出问题，不证明正文在这条判据下没问题 */}
          <Muted>未检出问题。这不等于这条判据下的正文没有问题，只表示这一次调用没有报出。</Muted>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * 把连续的 `public_output_chunk` 压成一行。
 *
 * 轨迹面板给每个 chunk 发一张卡片，一个槽位因此能到 685 条——正是那个数字
 * 促成了这个视图。这里把它们合并成「正文流式输出 · N 段」，插在第一个 chunk
 * 出现的位置上，前后事件的顺序不动。
 */
function collapseChunks(events: TraceEvent[], chunkCount: number): { key: string; text: string }[] {
  const steps: { key: string; text: string }[] = [];
  let collapsed = false;
  for (const event of events) {
    if (event.kind === 'public_output_chunk') {
      if (collapsed) continue;
      collapsed = true;
      steps.push({ key: `chunks-${String(event.sequence)}`, text: `正文流式输出 · ${String(chunkCount)} 段` });
      continue;
    }
    steps.push({
      key: String(event.sequence),
      text: event.summary === '' ? event.title : `${event.title} · ${event.summary}`,
    });
  }
  return steps;
}

/**
 * 取一段流式输出的**原文**。
 *
 * 必须读 `payload.text` 而不是 `summary`：后者是轨迹卡片的显示用摘要，
 * 每段都在 40 字左右被截断加省略号。拼 summary 得到的是一段每隔几十字
 * 就断一次的碎文，而头上还挂着「N 字符」——那个数字会是假的。
 * 真数据上一眼就能看出来：`I'll review the scene1 slot according to…explanation). Let me…`。
 */
function chunkText(event: TraceEvent): string {
  const text = event.payload?.['text'];
  return typeof text === 'string' ? text : event.summary;
}

/** 长文本先夹到 4 行，点开才全展。模型的可见输出动辄两千字符 */
function Clamp({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.8,
          color: 'var(--color-neutral-700)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          borderLeft: '1px solid var(--color-divider)',
          paddingLeft: 11,
          ...(full
            ? {}
            : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
        }}
      >
        {text}
      </div>
      {full ? null : (
        <button
          type="button"
          onClick={() => setFull(true)}
          style={{
            appearance: 'none',
            background: 'none',
            border: 0,
            font: 'inherit',
            fontSize: 11,
            color: 'var(--color-accent-700)',
            cursor: 'pointer',
            padding: '5px 0 0 12px',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          展开全文
        </button>
      )}
    </>
  );
}

/** 系统结算行。菱形节点 + 一句话，不可展开——它不对应任何一次调用 */
function Settlement({ kind, title }: { kind: string; title: string }) {
  const exhausted = kind === 'revision_budget_exhausted';
  const done = kind === 'review_no_finding';
  const color = exhausted ? 'var(--color-neutral-600)' : done ? 'var(--color-accent-700)' : 'var(--color-neutral-700)';
  return (
    <div style={{ position: 'relative', padding: '9px 16px 9px 0', fontSize: 12, color }}>
      <span
        aria-hidden
        style={{ position: 'absolute', left: -21, top: 14, width: 6, height: 6, background: color, transform: 'rotate(45deg)' }}
      />
      {title}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'danger' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      style={{
        flex: 'none',
        fontFamily: MONO,
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 2,
        background: tone === 'danger' ? 'var(--color-danger-bg)' : 'transparent',
        color: tone === 'danger' ? 'var(--color-danger)' : 'var(--color-neutral-500)',
      }}
    >
      {children}
    </span>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: 'var(--color-neutral-500)',
        margin: '14px 0 5px',
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-neutral-600)' }}>{children}</div>;
}

function Note({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, padding: '28px 20px', textAlign: 'center', fontSize: 12.5, lineHeight: 1.8, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
      {text}
    </div>
  );
}

/** 「第 2 稿」；同一轮里的第二次填槽是重试，不是新一稿 */
function fillLabel(round: number, index: number): string {
  return index === 0 ? `填槽 · 第 ${String(round + 1)} 稿` : `填槽 · 第 ${String(round + 1)} 稿重试`;
}

function tokens(n: number): string {
  return n.toLocaleString('en-US');
}
