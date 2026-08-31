/**
 * 右栏 Agent 工作面板：头部 / 执行轨迹 / 生产信息 三块共用同一个 `PanelSubject`，
 * 子组件**不再判断** `task.phase` / `slot.contentBearing`（§10.3②）。
 * 轨迹按 subject 收敛（容器/输入 → 空 + 解释，槽位/结构 → 该 execution 的事件）。
 * 容器分支不显示 Producer/耗时（§10.3③）。技术详情见 §13.5。
 *
 * ## 两个视图
 *
 * 「产物」是原来那套（轨迹流水 + 生产信息）；「生产过程」把同一批事件折成流向图，
 * 见 `ProductionFlow.tsx`。切换出现在**被逐条判据审过**的 subject 上：
 * 内容槽位，以及绑了结构审核的根容器。判据见 `canFlow`。
 */

import { useEffect, useState } from 'react';
import type { PanelSubject } from './panel-subject.ts';
import type { TaskDetail, ExecutionView } from '@shared/contracts.ts';
import type { TraceEvent } from '@shared/trace.ts';
import { TraceTimeline } from './TraceTimeline.tsx';
import { ProductionFlow } from './ProductionFlow.tsx';
import { formatDurationMs, formatClock } from '../lib/format.ts';

interface RightPanelProps {
  task: TaskDetail;
  subject: PanelSubject;
  traces: TraceEvent[];
  executions: ExecutionView[];
  showBackToCurrent: boolean;
  onBackToCurrent: () => void;
}

interface SummaryRow {
  k: string;
  v: string;
  sub: string;
}

/** 按 subject 收敛轨迹，并给出 subject 专属的空态说明 */
function scopeTraces(
  subject: PanelSubject,
  executions: ExecutionView[],
  traces: TraceEvent[],
): { list: TraceEvent[]; note?: string | undefined } {
  switch (subject.kind) {
    /*
     * 容器**可能有轨迹**：R5 的结构审核就把根容器当作审核目标，
     * 一轮四条判据各一次 execution，`targetSlotId` 就是这个容器。
     *
     * 这里原来硬编码返回空列表 + 一句「容器槽位没有 Agent 工作轨迹」。
     * 结构审核接上之后那句话就成了假话，而且它藏起来的是**用户真金白银付过的
     * 四次模型调用**——界面上看不出这棵结构被审过，更看不出它为什么被打回重来。
     * 归属方式与 content 分支同源（execution 归属 + 结算事件按 payload.slotId 认领），
     * 理由见那里。
     */
    case 'container': {
      const ids = new Set(executions.filter((e) => e.targetSlotId === subject.slot.id).map((e) => e.id));
      const list = traces.filter((t) =>
        t.executionId !== null
          ? ids.has(t.executionId)
          : t.payload !== null && t.payload['slotId'] === subject.slot.id,
      );
      return {
        list,
        // 没有轨迹是合法默认（D-27：不绑审核）。这句话此时才是真的
        note:
          list.length === 0
            ? '容器槽位不创建 Fill Slot Assignment，本模板也没有给它绑定结构审核，因此没有 Agent 工作轨迹。'
            : undefined,
      };
    }
    /*
     * 「输入」这一格收 D-70 的 provider_pinned。
     *
     * 它是**任务级**事件：不属于任何槽位、任何 execution、任何阶段，
     * 因此在别的分支里一个家都没有——落到 assembly 会被那条三选一的过滤丢掉，
     * 落到 structure 会被 `executionId !== null` 丢掉。真让它无家可归的后果是
     * 「已降级到按量付费的 Provider」写进了库却在界面上完全隐形，
     * 而那恰恰是最不该看不见的一条。
     *
     * 归到这里是因为时机同源：pin 与冻结输入是任务创建时的同一个瞬间决定的。
     * 与上面 container 分支同一个教训——加了新事件就得同时改那句 note，
     * 否则界面会用一句已经不成立的话把它盖住。
     */
    case 'input': {
      const list = traces.filter((t) => t.kind === 'provider_pinned');
      return {
        list,
        note:
          list.length === 0
            ? '冻结任务输入由系统在创建任务时保存，不涉及 Agent 工作，因此没有轨迹。'
            : undefined,
      };
    }
    case 'structure': {
      const ids = new Set(executions.filter((e) => e.operation === 'create_structure').map((e) => e.id));
      const list = traces.filter((t) => t.executionId !== null && ids.has(t.executionId));
      return { list, note: list.length === 0 ? '结构设计尚未产生工作轨迹。' : undefined };
    }
    case 'assembly': {
      const list = traces.filter(
        (t) => t.kind === 'assembly_started' || t.kind === 'artifact_created' || (t.executionId === null && t.kind === 'task_state_changed'),
      );
      return { list, note: list.length === 0 ? '组装是系统确定性动作，暂无轨迹。' : undefined };
    }
    case 'content': {
      const ids = new Set(executions.filter((e) => e.targetSlotId === subject.slot.id).map((e) => e.id));
      /*
       * R2 的**审核结算**事件（「审核检出问题，进入返修」「审核未检出问题，槽位完成」）
       * 是 `executionId === null` 的：它们收口的是一整轮判据，不属于其中任何一次
       * execution。只按 execution 归属过滤，会把这两条整轮里最该被看见的事件丢掉——
       * 界面上只剩逐条判据的结果，看不到「所以这一轮到底怎么判的」。
       * 它们靠 payload.slotId 归属槽位，这里按它认领。
       */
      const list = traces.filter((t) =>
        t.executionId !== null
          ? ids.has(t.executionId)
          : t.payload !== null && t.payload['slotId'] === subject.slot.id,
      );
      if (list.length === 0 && subject.slot.presentation.tone === 'wait') {
        return { list: [], note: '该槽位尚未创建 Assignment，因此没有工作轨迹。系统不会为未开始的槽位展示虚假执行记录。' };
      }
      return { list, note: list.length === 0 ? '该槽位暂无工作轨迹。' : undefined };
    }
  }
}

function summarize(
  subject: PanelSubject,
  task: TaskDetail,
  executions: readonly ExecutionView[],
): { kindLabel: string; title: string; sentence: string; heading: string; rows: SummaryRow[] } {
  switch (subject.kind) {
    case 'container': {
      const children = task.slots.filter((s) => s.contentBearing);
      /*
       * 根容器绑了结构审核时，它**有** Assignment（每条判据一次），
       * 而且它的 status 是被审核结算推动的，不是「提交时置为 completed」。
       * 两种情形的每一行都不一样，所以整块分开写而不是拼字符串——
       * 拼出来的句子在其中一种情形下总会读着别扭或干脆是假的。
       *
       * 判据是「这个容器**有没有 Assignment**」，不是 `revisionRound > 0`：
       * 后者只在被打回重来过时才为真，而一棵一次就审过的结构 revisionRound 也是 0，
       * 那正是最常见的情形——用它判会把「审过且干净」显示成「从来没审过」。
       */
      const reviewed = executions.some((e) => e.targetSlotId === subject.slot.id);
      if (reviewed) {
        return {
          kindLabel: 'Assignment',
          title: '根容器 · 结构审核',
          sentence: `${subject.slot.id} 不承载正文，被审的是它底下那棵树：每个内容槽位的目标写清楚了没有。审核在任何槽位开工之前跑完，检出问题就整棵树重新设计。`,
          heading: '槽位属性',
          rows: [
            { k: 'Actor', v: 'Agent', sub: '一条判据一次调用' },
            { k: 'contentBearing', v: 'false', sub: '被审的是子槽位的目标' },
            { k: '子槽位', v: `${String(children.length)} 个`, sub: '决定组装层级与顺序' },
            { k: '重新设计', v: `${String(subject.slot.revisionRound)} 次`, sub: '审核检出问题的轮数' },
          ],
        };
      }
      return {
        kindLabel: '无 Assignment',
        title: '容器槽位',
        sentence: `${subject.slot.id} 的 contentBearing 为 false，不创建 Fill Slot Assignment；本模板也没有给它绑定结构审核，因此没有 Agent 工作轨迹。它的状态不参与调度与组装。`,
        heading: '槽位属性',
        rows: [
          { k: 'Actor', v: 'System', sub: '状态不参与调度' },
          { k: 'contentBearing', v: 'false', sub: '不承载正文' },
          { k: '子槽位', v: `${String(children.length)} 个`, sub: '决定组装层级与顺序' },
          { k: 'Assignment', v: '—', sub: '容器槽位不创建' },
        ],
      };
    }
    case 'input':
      return {
        kindLabel: 'System',
        title: '任务输入',
        sentence: '任务创建时，系统冻结了模板、Agent、Skill 与用户输入。冻结后的输入在整个任务运行期间不再变化，此处没有 Agent 工作。',
        heading: '系统信息',
        rows: [
          { k: 'Actor', v: 'System', sub: '创建任务时冻结' },
          { k: 'Template', v: task.templateName, sub: '' },
          { k: 'snapshotHash', v: task.snapshotHash, sub: '运行期不再读取源文件' },
          { k: '输入字段', v: `${String(Object.keys(task.input).length)} 项`, sub: '' },
        ],
      };
    case 'assembly':
      return {
        kindLabel: 'System',
        title: '系统组装',
        sentence: '系统按结构顺序确定性组装产物，此阶段没有 Agent 参与创作。',
        heading: '系统信息',
        rows: [
          { k: 'Actor', v: 'System', sub: '确定性组装' },
          { k: 'Assembler', v: 'markdown_concat_v1', sub: '不调用模型' },
          { k: '输入', v: `${String(task.slots.filter((s) => s.contentBearing).length)} 个内容槽位`, sub: '深度优先顺序' },
          { k: '输出', v: task.artifact?.fileName ?? '—', sub: task.artifact?.mediaType ?? '' },
        ],
      };
    case 'structure': {
      const exec = subject.execution;
      return {
        kindLabel: exec !== null && exec.status === 'running' ? '当前工作' : exec !== null ? '历史工作记录' : '计划工作',
        title: '创建结构',
        sentence: 'structure_designer 使用结构设计 Skill 创建本次任务的具体结构。',
        heading: '本次工作指派',
        rows: [
          { k: 'Operation', v: 'create_structure', sub: '创建具体结构' },
          { k: 'Target', v: task.id, sub: '本次任务的结构' },
          { k: 'Attempt', v: exec !== null ? `${String(exec.attemptNumber)} 次` : '—', sub: exec?.status ?? '' },
          { k: '状态', v: exec?.status ?? '等待启动', sub: '' },
        ],
      };
    }
    case 'content': {
      const { slot, execution } = subject;
      if (slot.producer !== null) {
        return {
          kindLabel: '历史工作记录',
          title: `${slot.id} 的生产过程`,
          sentence: `${slot.producer.agentName} 完成了 ${slot.id}，内容已原子保存。`,
          heading: '生产来源',
          rows: [
            { k: 'Agent', v: slot.producer.agentName, sub: '' },
            { k: 'Skill', v: slot.producer.skillId, sub: `v${slot.producer.skillVersion}` },
            { k: 'Execution', v: slot.producer.executionId, sub: 'succeeded' },
            { k: '耗时', v: formatDurationMs(slot.producer.durationMs), sub: '' },
          ],
        };
      }
      if (execution !== null) {
        return {
          kindLabel: '当前工作',
          title: '进行中',
          sentence: `${execution.agentName} 正在填充 ${slot.id}。`,
          heading: '本次工作指派',
          rows: [
            { k: 'Agent', v: execution.agentName, sub: '' },
            { k: 'Skill', v: execution.skillId, sub: `v${execution.skillVersion}` },
            { k: 'Operation', v: 'fill_slot', sub: '填充槽位' },
            { k: 'Attempt', v: `${String(execution.attemptNumber)} 次`, sub: execution.status },
          ],
        };
      }
      const planned = task.plannedAssignment;
      return {
        kindLabel: '计划工作',
        title: subject.slot.blockedBy.length > 0 ? '尚未创建 Assignment' : '等待系统调度',
        sentence:
          subject.slot.blockedBy.length > 0
            ? `待 ${subject.slot.blockedBy.join('、')} 完成后，系统将指派 Agent 填充 ${slot.id}。`
            : `依赖已满足，系统将按深度优先顺序指派 Agent 填充 ${slot.id}。`,
        heading: '本次工作指派',
        rows: [
          { k: 'Agent', v: planned?.agentName ?? '—', sub: '' },
          { k: 'Skill', v: planned?.skillId ?? '—', sub: '' },
          { k: 'Operation', v: 'fill_slot', sub: subject.slot.blockedBy.length > 0 ? '尚未创建' : '填充槽位' },
          { k: 'Target', v: slot.id, sub: slot.typeName },
        ],
      };
    }
  }
}

export function RightPanel({ task, subject, traces, executions, showBackToCurrent, onBackToCurrent }: RightPanelProps) {
  const s = summarize(subject, task, executions);
  const scoped = scopeTraces(subject, executions, traces);
  const techExec = subject.kind === 'content' ? subject.execution : subject.kind === 'structure' ? subject.execution : null;

  const [view, setView] = useState<PanelView>('artifact');
  /*
   * 谁有「生产过程」可看，判据是**它有没有被逐条判据审过**，不是它的 kind。
   *
   * 这里原来写死 `kind === 'content'`，理由是「容器、输入、组装、结构都没有『轮次』
   * 这回事，给它们一个切不出东西的开关只会让人白点一次」。那句话在 R5 之前是对的，
   * 之后就成了假的：根容器现在正是结构审核的对象，有判据表、有逐条裁决、
   * 有返修轮次，`/slots/:id/flow` 对它返回的是一份完整的流程
   * （实测 4 条判据、4 次调用、36k input）。挡住它的只有这一行。
   *
   * 用「有没有 Assignment」而不是「是不是根容器」：没绑结构审核的模板里，
   * 根容器确实什么都没有，那时开关照旧不出现——与 `summarize` 那边同一个判据。
   */
  const canFlow =
    subject.kind === 'content' ||
    (subject.kind === 'container' && executions.some((e) => e.targetSlotId === subject.slot.id));
  // 切到没有流程可言的 subject 时退回产物视图。
  // 不退的话，切回来之前面板是空的，而用户并没有主动切过视图。
  useEffect(() => {
    if (!canFlow) setView('artifact');
  }, [canFlow]);
  const showFlow = canFlow && view === 'flow';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ flex: 'none', padding: '18px 20px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 10,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                padding: '2px 6px',
                borderRadius: 2,
                border: '1px solid var(--color-accent)',
                color: 'var(--color-accent-700)',
              }}
            >
              {s.kindLabel}
            </span>
            <h5 style={{ margin: 0, fontSize: 15 }}>{s.title}</h5>
          </div>
          {showBackToCurrent ? (
            <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onBackToCurrent}>
              返回当前工作
            </button>
          ) : null}
        </div>
      </div>

      {canFlow ? <ViewSwitch view={view} onChange={setView} /> : null}

      {showFlow ? (
        <ProductionFlow taskId={task.id} slotId={subject.slot.id} traces={traces} />
      ) : (
        <>
          <TraceTimeline traces={scoped.list} emptyNote={scoped.note} />

      <div
        className="fc-scroll"
        style={{
          flex: 'none',
          maxHeight: '42%',
          borderTop: '1px solid var(--color-divider)',
          background: 'color-mix(in srgb, var(--color-surface) 42%, transparent)',
        }}
      >
        <div style={{ padding: '14px 20px 10px', fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>
          {s.heading}
        </div>
        <div style={{ padding: '0 20px 18px' }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.75, color: 'var(--color-neutral-800)', textWrap: 'pretty' }}>{s.sentence}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', marginTop: 16 }}>
            {s.rows.map((r) => (
              <div key={r.k}>
                <div style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>{r.k}</div>
                <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>{r.v}</div>
                {r.sub !== '' ? <div style={{ fontSize: 11, color: 'var(--color-neutral-500)', marginTop: 1 }}>{r.sub}</div> : null}
              </div>
            ))}
          </div>
          {techExec !== null ? <TechDetails exec={techExec} snapshotHash={task.snapshotHash} /> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type PanelView = 'artifact' | 'flow';

const VIEW_LABEL: Record<PanelView, string> = { artifact: '产物', flow: '生产过程' };

function ViewSwitch({ view, onChange }: { view: PanelView; onChange: (next: PanelView) => void }) {
  return (
    <div
      role="tablist"
      style={{ flex: 'none', display: 'flex', gap: 2, padding: '0 14px', borderBottom: '1px solid var(--color-divider)' }}
    >
      {(Object.keys(VIEW_LABEL) as PanelView[]).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={view === key}
          onClick={() => onChange(key)}
          style={{
            appearance: 'none',
            background: 'none',
            border: 0,
            borderBottom: `2px solid ${view === key ? 'var(--color-accent)' : 'transparent'}`,
            font: 'inherit',
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: 12.5,
            color: view === key ? 'var(--color-text)' : 'var(--color-neutral-600)',
            padding: '11px 10px 9px',
            cursor: 'pointer',
          }}
        >
          {VIEW_LABEL[key]}
        </button>
      ))}
    </div>
  );
}

/** 技术详情（§13.5，默认折叠）。token 恒为 null 时渲染「—」，不写成「0」（Q-18）。 */
function TechDetails({ exec, snapshotHash }: { exec: ExecutionView; snapshotHash: string }) {
  const [open, setOpen] = useState(false);
  const tokens = exec.inputTokens === null || exec.outputTokens === null ? '—' : `${String(exec.inputTokens)} in / ${String(exec.outputTokens)} out`;
  const rows: [string, string][] = [
    ['execution', exec.id],
    ['operation', exec.operation],
    ['provider', exec.provider],
    ['model', `${exec.modelAlias} → ${exec.model}`],
    ['contextHash', exec.contextHash],
    ['promptHash', exec.promptHash],
    ['snapshotHash', snapshotHash],
    ['tokens', tokens],
    ['startedAt', exec.startedAt !== null ? formatClock(exec.startedAt) : '—'],
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--color-accent-700)', display: 'flex', alignItems: 'center', gap: 5 }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
        {open ? '收起技术详情' : '技术详情'}
      </button>
      {open ? (
        <div
          style={{
            marginTop: 10,
            borderTop: '1px solid var(--color-divider)',
            paddingTop: 10,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '4px 14px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            lineHeight: 1.7,
            color: 'var(--color-neutral-700)',
          }}
        >
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <div style={{ color: 'var(--color-neutral-500)' }}>{k}</div>
              <div style={{ overflowWrap: 'anywhere' }}>{v}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
