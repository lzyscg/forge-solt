/**
 * 模板详情 `/templates/$templateId`。
 *
 * 左栏：槽位结构树（`exampleStructure` 提供层级，`slotTypes` 提供每行详情）+
 * 「模板级冻结输入」表（`inputFields`）。
 * 右栏：选中槽位后按 `binding === null` 分两支（容器 / 内容）——这就是
 * container/content 判据（D-01）。**不做 Agent 路由图**（§16.2）。
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from '@tanstack/react-router';
import type { SlotTypeDetail, TemplateStatus } from '@shared/contracts.ts';
import { getTemplate, getTemplateTasks } from '../api/templates.ts';
import { ApiError } from '../api/http.ts';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { formatDurationMs, formatRelative } from '../lib/format.ts';

const TABS = ['槽位结构', '版本历史', '引用任务'] as const;
type Tab = (typeof TABS)[number];

const STATUS_TAG: Record<TemplateStatus, { label: string; cls: string }> = {
  published: { label: '已发布', cls: 'tag tag-accent' },
  draft: { label: '草稿', cls: 'tag tag-neutral' },
  archived: { label: '已归档', cls: 'tag tag-neutral' },
};

interface TreeNode {
  name: string;
  typeId: string;
  kind: 'container' | 'content';
  depth: number;
}

export function TemplateDetail() {
  const { templateId } = useParams({ from: '/templates/$templateId' });
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['template', templateId], queryFn: () => getTemplate(templateId) });
  const [tab, setTab] = useState<Tab>('槽位结构');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const detail = query.data;
  const tree = useMemo<TreeNode[]>(() => {
    if (detail === undefined) return [];
    if (detail.exampleStructure !== null && detail.exampleStructure.length > 0) {
      return detail.exampleStructure.map((n) => ({ name: n.name, typeId: n.typeId, kind: n.kind, depth: n.depth }));
    }
    // 无示例结构时退化为平铺槽位类型
    return detail.slotTypes.map((s) => ({
      name: s.id,
      typeId: s.id,
      kind: s.contentBearing ? 'content' : 'container',
      depth: 0,
    }));
  }, [detail]);

  const selectedTypeId = selectedId ?? tree[0]?.typeId ?? null;
  const selected = useMemo(
    () => detail?.slotTypes.find((s) => s.id === selectedTypeId) ?? null,
    [detail, selectedTypeId],
  );

  if (query.isPending) return <EmptyState title="加载中…" />;
  if (query.isError || detail === undefined) {
    return (
      <EmptyState
        title="模板详情加载失败"
        sub={query.error instanceof ApiError ? query.error.message : '请稍后重试'}
      />
    );
  }

  const contentCount = detail.slotTypes.filter((s) => s.contentBearing).length;
  const status = STATUS_TAG[detail.status];

  return (
    <>
      <header
        style={{
          flex: 'none',
          padding: '20px 32px 17px',
          borderBottom: '1px solid var(--color-divider)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 24,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-500)',
              marginBottom: 6,
            }}
          >
            <Link to="/templates" style={{ color: 'inherit', textDecoration: 'none' }}>
              结构模板
            </Link>{' '}
            / {detail.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 25 }}>{detail.name}</h3>
            <span className={status.cls} style={{ fontSize: 11 }}>
              {status.label}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
              {`${String(detail.slotTypeCount)} 个槽位 · ${String(contentCount)} 个内容槽位 · ${String(detail.runCount)} 个任务在用`}
            </span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void navigate({ to: '/tasks/new', search: { templateId } })}
          >
            用此模板新建任务
          </button>
        </div>
      </header>

      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'stretch',
          padding: '0 32px',
          borderBottom: '1px solid var(--color-divider)',
          background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)',
        }}
      >
        {TABS.map((t) => (
          <div
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '12px 18px',
              fontFamily: 'var(--font-heading)',
              fontWeight: 600,
              fontSize: 14.5,
              cursor: 'pointer',
              color: tab === t ? 'var(--color-accent-700)' : 'var(--color-neutral-600)',
              boxShadow: tab === t ? 'inset 0 -2px 0 var(--color-accent)' : 'none',
            }}
          >
            {t}
          </div>
        ))}
      </div>

      {tab === '槽位结构' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div className="fc-scroll" style={{ flex: 1, minWidth: 0, borderRight: '1px solid var(--color-divider)' }}>
            <div style={{ padding: '20px 26px 12px' }}>
              <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>
                槽位结构
              </div>
              <div style={{ marginTop: 5, fontSize: 12.5, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
                树内顺序即组装顺序。容器槽位本身不生产内容，只收拢下级产物。
              </div>
            </div>
            <div>
              {tree.map((node) => (
                <TreeNodeRow
                  key={node.name}
                  node={node}
                  active={node.typeId === selectedTypeId}
                  slotType={detail.slotTypes.find((s) => s.id === node.typeId) ?? null}
                  onSelect={() => setSelectedId(node.typeId)}
                />
              ))}
            </div>

            <div style={{ padding: '24px 26px 40px' }}>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-500)',
                  marginBottom: 11,
                }}
              >
                模板级冻结输入
              </div>
              <div style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)' }}>
                {detail.inputFields.map((f, i) => (
                  <div
                    key={f.id}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 14,
                      padding: '12px 16px',
                      borderBottom: i < detail.inputFields.length - 1 ? '1px solid var(--color-divider)' : 'none',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 600,
                        fontSize: 13.5,
                        minWidth: 132,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {f.id}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--color-neutral-700)', flex: 1 }}>
                      {f.label}
                      {f.hint !== null ? <span style={{ color: 'var(--color-neutral-500)' }}> · {f.hint}</span> : null}
                    </span>
                    <ReqBadge required={f.required} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            className="fc-scroll"
            style={{ width: 430, flex: 'none', background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)' }}
          >
            {selected !== null ? <SlotDetailPanel slot={selected} tree={tree} /> : null}
          </div>
        </div>
      ) : tab === '引用任务' ? (
        <ReferencingTasks templateId={templateId} />
      ) : (
        <EmptyState title="暂无版本历史" sub="该数据源在 P0 尚未提供接口。" />
      )}
    </>
  );
}

function ReqBadge({ required }: { required: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        color: required ? 'var(--color-accent-700)' : 'var(--color-neutral-500)',
        border: `1px solid ${required ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'var(--color-divider)'}`,
        padding: '0 5px',
        borderRadius: 2,
      }}
    >
      {required ? '必填' : '可选'}
    </span>
  );
}

function TreeNodeRow({
  node,
  active,
  slotType,
  onSelect,
}: {
  node: TreeNode;
  active: boolean;
  slotType: SlotTypeDetail | null;
  onSelect: () => void;
}) {
  const isContainer = node.kind === 'container';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 11,
        cursor: 'pointer',
        padding: `13px 26px 13px ${String(26 + node.depth * 22)}px`,
        borderBottom: '1px solid var(--color-divider)',
        background: active ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 0 var(--color-accent)' : 'none',
      }}
    >
      <span
        style={{
          width: 15,
          height: 15,
          flex: 'none',
          marginTop: 2,
          border: `1px solid ${isContainer ? 'var(--color-neutral-500)' : 'color-mix(in srgb, var(--color-accent) 55%, transparent)'}`,
          borderRadius: isContainer ? 2 : '50%',
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15.5 }}>{node.name}</span>
          <span style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>{isContainer ? '容器槽位' : '内容槽位'}</span>
        </div>
        {isContainer ? (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {slotType?.description ?? '收拢下级槽位'}
          </div>
        ) : (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--color-neutral-700)' }}>
            <span>{slotType?.binding?.agentName ?? ''}</span>
            <span style={{ color: 'var(--color-neutral-400)' }}>→</span>
            <span>{slotType?.binding?.skillId ?? ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SlotDetailPanel({ slot, tree }: { slot: SlotTypeDetail; tree: TreeNode[] }) {
  const isContainer = slot.binding === null;
  const children = useMemo(() => {
    if (!isContainer) return [];
    const selfIndex = tree.findIndex((n) => n.typeId === slot.id);
    if (selfIndex < 0) return [];
    const selfDepth = tree[selfIndex]?.depth ?? 0;
    const result: TreeNode[] = [];
    for (const node of tree.slice(selfIndex + 1)) {
      if (node.depth <= selfDepth) break;
      if (node.depth === selfDepth + 1) result.push(node);
    }
    return result;
  }, [isContainer, slot.id, tree]);

  return (
    <div style={{ padding: '22px 26px 40px' }}>
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>
        {isContainer ? '容器槽位' : '内容槽位 · Assignment'}
      </div>
      <h4 style={{ margin: '6px 0 4px', fontSize: 21 }}>{slot.name}</h4>
      <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)', textWrap: 'pretty', lineHeight: 1.7 }}>
        {slot.description}
      </div>

      {isContainer ? (
        <div style={{ marginTop: 22 }}>
          <div
            style={{
              padding: '15px 16px',
              border: '1px solid var(--color-divider)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12.5,
              color: 'var(--color-neutral-700)',
              lineHeight: 1.75,
              textWrap: 'pretty',
            }}
          >
            容器槽位没有 Assignment。它不调用 Agent，只在下级槽位全部通过后按顺序拼接产物。
          </div>
          <div
            style={{
              marginTop: 20,
              fontSize: 11,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-500)',
              marginBottom: 9,
            }}
          >
            下级槽位 · 组装顺序
          </div>
          {children.map((c, i) => (
            <div
              key={c.name}
              style={{ display: 'flex', alignItems: 'baseline', gap: 11, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}
            >
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, color: 'var(--color-accent)', fontVariantNumeric: 'tabular-nums' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 14 }}>{c.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--color-neutral-600)' }}>
                {c.kind === 'container' ? '容器' : '内容'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <ContentPanel slot={slot} />
      )}
    </div>
  );
}

function ReferencingTasks({ templateId }: { templateId: string }) {
  const tasksQuery = useQuery({
    queryKey: ['template', templateId, 'tasks'],
    queryFn: () => getTemplateTasks(templateId),
  });
  if (tasksQuery.isPending) return <EmptyState title="加载中…" />;
  if (tasksQuery.isError)
    return <EmptyState title="引用任务加载失败" sub={tasksQuery.error instanceof ApiError ? tasksQuery.error.message : '请稍后重试'} />;
  const tasks = tasksQuery.data ?? [];
  if (tasks.length === 0) return <EmptyState title="暂无引用任务" sub="用此模板新建一个任务后会出现在这里。" />;
  return (
    <div className="fc-scroll" style={{ flex: 1, minHeight: 0, padding: '20px 26px 40px' }}>
      {tasks.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--color-divider)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15 }}>{t.name}</span>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{t.presentation.state}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
            {formatRelative(t.updatedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ContentPanel({ slot }: { slot: SlotTypeDetail }) {
  const binding = slot.binding;
  if (binding === null) return null;
  return (
    <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <section>
        <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 10 }}>
          Assignment
        </div>
        <div style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: '15px 16px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginBottom: 3 }}>Agent</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15 }}>{binding.agentName}</div>
            <div style={{ marginTop: 3, fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>{binding.agentRole}</div>
          </div>
          <div style={{ height: 1, background: 'var(--color-divider)' }} />
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginBottom: 3 }}>Skill</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15 }}>
              {binding.skillId} · v{binding.skillVersion}
            </div>
            <div style={{ marginTop: 3, fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>{binding.skillSummary}</div>
          </div>
          <div style={{ height: 1, background: 'var(--color-divider)' }} />
          <div style={{ display: 'flex', gap: 28 }}>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginBottom: 2 }}>模型</div>
              <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                {binding.modelAlias}
                {binding.resolvedModel !== null ? ` → ${binding.resolvedModel}` : ''}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginBottom: 2 }}>超时</div>
              <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{formatDurationMs(binding.timeoutMs)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginBottom: 2 }}>重试</div>
              <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{`${String(binding.maxRetries)} 次`}</div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 10 }}>
          输入依赖
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
          槽位间依赖由结构 Agent 在生产时设计；模板层不预先声明。
        </div>
      </section>

      {slot.validation.rules.length > 0 ? (
        <section>
          <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 10 }}>
            产物校验
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {slot.validation.rules.map((rule) => (
              <div key={rule} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 2 }}>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span style={{ fontSize: 12.5, color: 'var(--color-neutral-800)', textWrap: 'pretty', lineHeight: 1.6 }}>{rule}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {slot.guidance.length > 0 ? (
        <section>
          <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)', marginBottom: 10 }}>
            写作要求
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.7 }}>
            {slot.guidance.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
