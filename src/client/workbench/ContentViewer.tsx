/**
 * 中栏产物工作区。视图由 `PanelSubject` 决定（与右栏同一判据）：
 * input/structure → 任务输入 + 结构说明；content → 槽位目标/依赖/正文/错误；
 * container → 容器说明 + 下级组装顺序；assembly → 组装顺序或最终 Artifact。
 * 正文/产物经 `SafeMarkdown` 渲染（不可信输入，§10.5）。
 */

import { useQuery } from '@tanstack/react-query';
import type { PanelSubject } from './panel-subject.ts';
import type { SlotView, TaskDetail } from '@shared/contracts.ts';
import { SafeMarkdown } from '../components/markdown/SafeMarkdown.tsx';
import { ToneChip } from '../components/ui/ToneChip.tsx';
import { artifactDownloadUrl, getArtifact } from '../api/tasks.ts';
import { IconDownload } from '../components/icons.tsx';

interface ContentViewerProps {
  task: TaskDetail;
  subject: PanelSubject;
  streamText: (executionId: string) => string;
  /** 选中内容槽位的已保存正文（来自 SlotDetail） */
  slotContent: string | null;
  onSelectSlot: (slotId: string) => void;
}

export function ContentViewer({ task, subject, streamText, slotContent, onSelectSlot }: ContentViewerProps) {
  if (subject.kind === 'input' || subject.kind === 'structure') return <InputView task={task} />;
  if (subject.kind === 'assembly') return task.artifact !== null ? <ArtifactView task={task} /> : <AssemblyView task={task} />;
  if (subject.kind === 'container') return <ContainerView task={task} slot={subject.slot} onSelectSlot={onSelectSlot} />;
  return <SlotViewBody task={task} slot={subject.slot} streamText={streamText} slotContent={slotContent} onSelectSlot={onSelectSlot} />;
}

function InputView({ task }: { task: TaskDetail }) {
  const isReady = task.status === 'ready';
  const inputText = Object.entries(task.input)
    .map(([, v]) => v)
    .join('\n\n');
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <h4 style={{ margin: '0 0 4px', fontSize: 21 }}>任务输入</h4>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginBottom: 20 }}>
        创建任务时已冻结 · 快照{' '}
        <span className="mono" style={{ fontSize: 11.5 }}>
          {task.snapshotHash}
        </span>
      </div>
      <div className="card" style={{ padding: '20px 22px', background: 'color-mix(in srgb, var(--color-surface) 45%, transparent)' }}>
        <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-accent-700)' }}>冻结输入</div>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.95, textAlign: 'justify', textWrap: 'pretty', whiteSpace: 'pre-wrap' }}>{inputText}</p>
      </div>
      <div style={{ marginTop: 22 }}>
        <h5 style={{ margin: '0 0 10px', fontSize: 15 }}>{isReady ? '启动后将发生什么' : '结构设计说明'}</h5>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.9, color: 'var(--color-neutral-700)', textAlign: 'justify', maxWidth: 620 }}>
          {isReady
            ? '点击“开始生产”后，系统会创建一次 create_structure 工作指派，由结构设计 Agent 提交结构提案。结构通过确定性校验后才会保存，任何一项校验失败都不会写入部分槽位。'
            : 'Structure Agent 只决定创建哪些槽位、各自承担什么内容职责以及它们之间的依赖；每个槽位由哪个 Agent、哪个 Skill 填充，由模板 Binding 静态决定，Agent 无权更改。'}
        </p>
      </div>
    </div>
  );
}

function ContainerView({ task, slot, onSelectSlot }: { task: TaskDetail; slot: SlotView; onSelectSlot: (id: string) => void }) {
  const children = task.slots.filter((s) => s.parentId === slot.id);
  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 23, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>{slot.id}</h4>
        <span style={{ fontSize: 11.5, padding: '3px 10px', borderRadius: 3, background: 'var(--color-neutral-200)', color: 'var(--color-neutral-800)' }}>容器槽位</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 8 }}>类型：{slot.typeName} · contentBearing：false</div>
      {/*
        原来这里写的是「结构通过校验时，系统直接将它置为 completed」。那句话有两处不实：
        容器落库即 pending 并一直保持 pending（`structure-service.ts` 文件头记过这条
        文案分歧）；而根容器绑了结构审核之后，它的状态是被审核结算推动的，
        期间还会经过 reviewing。措辞受 D-30 约束，不许说得比事实更确定。
      */}
      <p style={{ margin: '22px 0 0', fontSize: 14.5, lineHeight: 1.95, textAlign: 'justify', maxWidth: 640, textWrap: 'pretty' }}>
        {slot.parentId === null
          ? '容器槽位只用于组织结构：它决定子槽位的归属、层级和组装顺序，本身不承载正文，也不会创建 Fill Slot Assignment。作为根容器，它还是结构审核的对象——被审的不是它自己，而是它底下每个内容槽位的目标。'
          : '容器槽位只用于组织结构：它决定子槽位的归属、层级和组装顺序，本身不承载正文，也不会创建 Fill Slot Assignment。它的状态不参与调度，也不影响组装。'}
      </p>
      <hr className="hr" />
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 8 }}>下级内容槽位 · 按此顺序组装</div>
      {children.map((c, i) => (
        <div
          key={c.id}
          onClick={() => onSelectSlot(c.id)}
          style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '9px 0', borderTop: i > 0 ? '1px solid var(--color-divider)' : 'none', cursor: 'pointer' }}
        >
          <span className="mono" style={{ fontSize: 13 }}>
            {c.id}
          </span>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{c.typeName}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-neutral-500)' }}>{c.presentation.state}</span>
        </div>
      ))}
    </div>
  );
}

function AssemblyView({ task }: { task: TaskDetail }) {
  const contentSlots = task.slots.filter((s) => s.contentBearing);
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 23 }}>正在组装最终产物</h4>
      <p style={{ margin: '0 0 22px', fontSize: 13.5, color: 'var(--color-neutral-700)' }}>
        组装器只负责排序、连接和输出文件，不进行任何语义创作。相同结构与相同槽位内容将生成完全相同的文件字节。
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '4px 40px', justifyContent: 'start', marginBottom: 26, fontSize: 13 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>已完成槽位</div>
          <div style={{ fontVariantNumeric: 'tabular-nums' }}>
            {contentSlots.filter((s) => s.status === 'completed').length} / {contentSlots.length}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>Assembler</div>
          <div className="mono" style={{ fontSize: 12.5 }}>
            markdown_concat_v1
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>输出</div>
          <div className="mono" style={{ fontSize: 12.5 }}>
            {task.artifact?.fileName ?? '—'}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 12 }}>确定性组装顺序</div>
      <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--color-divider)', paddingLeft: 20 }}>
        {contentSlots.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '8px 0', borderTop: i > 0 ? '1px solid var(--color-divider)' : 'none' }}>
            <span className="mono" style={{ fontSize: 13 }}>
              {s.id}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
              {s.charCount !== null ? `${String(s.charCount)} 字符` : s.presentation.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactView({ task }: { task: TaskDetail }) {
  const artifact = task.artifact;
  // TaskDetail 里的 artifact.content 恒为 null（避免把整章塞进详情），正文单独拉
  const full = useQuery({
    queryKey: ['task', task.id, 'artifact'],
    queryFn: () => getArtifact(task.id),
    enabled: artifact !== null,
  });
  const content = full.data?.content ?? artifact?.content ?? null;
  if (artifact === null) return null;
  return (
    <div style={{ maxWidth: 740, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h4 style={{ margin: '0 0 6px', fontSize: 23, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>{artifact.fileName}</h4>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {artifact.mediaType} · {formatKb(artifact.byteSize)} · checksum {artifact.checksum}
          </div>
        </div>
        <a className="btn btn-primary" href={artifactDownloadUrl(task.id)}>
          <IconDownload />
          下载产物
        </a>
      </div>
      <div style={{ marginTop: 22, border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: '30px 36px', background: 'color-mix(in srgb, var(--color-neutral-100) 60%, transparent)' }}>
        {content !== null ? <SafeMarkdown content={content} /> : <div style={{ fontSize: 13.5, color: 'var(--color-neutral-600)' }}>产物正文加载…</div>}
      </div>
    </div>
  );
}

function SlotViewBody({
  task,
  slot,
  streamText,
  slotContent,
  onSelectSlot,
}: {
  task: TaskDetail;
  slot: SlotView;
  streamText: (id: string) => string;
  slotContent: string | null;
  onSelectSlot: (id: string) => void;
}) {
  const running = slot.presentation.tone === 'run';
  const streaming = running && task.activeExecution !== null ? streamText(task.activeExecution.id) : '';
  const showStreaming = running && streaming !== '';
  const blocked = slot.presentation.tone === 'wait';

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 23, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600, letterSpacing: '-.01em' }}>{slot.id}</h4>
        <ToneChip tone={slot.presentation.tone}>{slot.presentation.state}</ToneChip>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 8 }}>类型：{slot.typeName} · 位置：{slot.path.join(' / ')}</div>

      <div style={{ marginTop: 22, border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: '16px 20px', background: 'color-mix(in srgb, var(--color-accent) 5%, transparent)' }}>
        <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-accent-700)', marginBottom: 8 }}>本槽位目标</div>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.85, textWrap: 'pretty' }}>{slot.instruction}</p>
      </div>

      {slot.dependsOn.length > 0 ? (
        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>依赖</span>
          {slot.dependsOn.map((dep) => (
            <button
              key={dep}
              type="button"
              onClick={() => onSelectSlot(dep)}
              className="mono"
              style={{ cursor: 'pointer', font: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid var(--color-divider)', color: 'var(--color-text)' }}
            >
              {dep}
            </button>
          ))}
        </div>
      ) : null}

      {blocked ? (
        <div style={{ marginTop: 20, border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: '18px 20px', background: 'color-mix(in srgb, var(--color-surface) 45%, transparent)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 16, marginBottom: 6 }}>当前尚不能生产</div>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.8, color: 'var(--color-neutral-700)' }}>
            等待以下槽位完成：{slot.blockedBy.join('、')}。依赖全部完成后，该槽位成为可生产状态，由系统按深度优先顺序调度，Agent 不能自行领取。
          </p>
        </div>
      ) : null}

      {slot.error !== null ? (
        <div style={{ marginTop: 20, border: '1px solid var(--color-danger)', borderRadius: 'var(--radius-md)', padding: '18px 20px', background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 16, marginBottom: 6 }}>槽位生产失败 · {slot.id}</div>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.85 }}>{slot.error.message}</p>
          {slot.error.action !== null ? <div style={{ fontSize: 12.5 }}>{slot.error.action}</div> : null}
        </div>
      ) : null}

      {!blocked ? (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h5 style={{ margin: 0, fontSize: 15 }}>{running ? `正在生成 ${slot.id}……` : '槽位内容'}</h5>
            <span style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
              {running ? `${String(streaming.length)} 字符` : slot.charCount !== null ? `${String(slot.charCount)} 字符` : '尚未生成内容'}
            </span>
          </div>
          {showStreaming ? (
            <div style={{ fontSize: 15.5, lineHeight: 2.05, textAlign: 'justify', whiteSpace: 'pre-wrap', textWrap: 'pretty', minHeight: 40 }}>
              {streaming}
              <span style={{ display: 'inline-block', width: 2, height: '1em', background: 'var(--color-accent)', verticalAlign: '-2px', marginLeft: 2, animation: 'fc-blink 1s steps(1) infinite' }} />
            </div>
          ) : slotContent !== null && slotContent !== '' ? (
            <SafeMarkdown content={slotContent} />
          ) : (
            <div style={{ fontSize: 13.5, color: 'var(--color-neutral-600)' }}>尚未生成内容。</div>
          )}
        </div>
      ) : null}

      {slot.producer !== null ? (
        <div style={{ marginTop: 30, borderTop: '1px solid var(--color-divider)', paddingTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 10 }}>生产来源</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '6px 34px', justifyContent: 'start', fontSize: 12.5 }}>
            <div>
              <div style={{ color: 'var(--color-neutral-500)', fontSize: 11 }}>Agent</div>
              <div className="mono" style={{ fontSize: 12.5 }}>
                {slot.producer.agentName}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--color-neutral-500)', fontSize: 11 }}>Skill</div>
              <div className="mono" style={{ fontSize: 12.5 }}>
                {slot.producer.skillId} v{slot.producer.skillVersion}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--color-neutral-500)', fontSize: 11 }}>Execution</div>
              <div className="mono" style={{ fontSize: 12.5 }}>
                {slot.producer.executionId}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--color-neutral-500)', fontSize: 11 }}>耗时</div>
              <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>{formatMs(slot.producer.durationMs)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(0)} 秒`;
}
