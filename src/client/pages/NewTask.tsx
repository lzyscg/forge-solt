/**
 * 新建任务 `/tasks/new`。
 *
 * **创建与启动分离**（§15.2）：「仅创建」→ `POST /api/tasks`；「创建并启动」→
 * `POST /api/tasks?start=true`。start 走 query，不进 body（§9.1）。
 * 右栏实时预览选中模板的槽位树（`exampleStructure`）。
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch, Link } from '@tanstack/react-router';
import { listTemplates, getTemplate } from '../api/templates.ts';
import { createTask } from '../api/tasks.ts';
import { ApiError } from '../api/http.ts';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { IconCheck } from '../components/icons.tsx';

export function NewTask() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/tasks/new' });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: listTemplates });

  const templates = templatesQuery.data?.templates ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? search.templateId ?? templates[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['template', effectiveId],
    queryFn: () => getTemplate(effectiveId as string),
    enabled: effectiveId !== null,
  });

  const [taskName, setTaskName] = useState('');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ mode: 'only' | 'start'; taskId: string } | null>(null);

  const detail = detailQuery.data;

  const missingRequired = useMemo(() => {
    if (detail === undefined) return [];
    return detail.inputFields.filter((f) => f.required && (inputValues[f.id] ?? '').trim() === '').map((f) => f.label);
  }, [detail, inputValues]);

  async function submit(start: boolean): Promise<void> {
    if (effectiveId === null) return;
    setError(null);
    if (taskName.trim() === '') {
      setError('请填写任务名称。');
      return;
    }
    if (missingRequired.length > 0) {
      setError(`请补齐必填字段：${missingRequired.join('、')}`);
      return;
    }
    setSubmitting(true);
    try {
      const result = await createTask(
        { templateId: effectiveId, name: taskName.trim(), input: { ...inputValues } },
        start,
      );
      setCreated({ mode: start ? 'start' : 'only', taskId: result.taskId });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

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
        <div>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-500)',
              marginBottom: 6,
            }}
          >
            <Link to="/tasks" style={{ color: 'inherit', textDecoration: 'none' }}>
              生产任务
            </Link>{' '}
            / 新建
          </div>
          <h3 style={{ margin: 0, fontSize: 25 }}>从模板创建生产任务</h3>
        </div>
        <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn btn-ghost" onClick={() => void navigate({ to: '/tasks' })}>
            取消
          </button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 96 }} disabled={submitting} onClick={() => void submit(false)}>
            仅创建
          </button>
          <button type="button" className="btn btn-primary" style={{ minWidth: 96 }} disabled={submitting} onClick={() => void submit(true)}>
            创建并启动
          </button>
        </div>
      </header>

      {created !== null ? (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '13px 32px',
            borderBottom: '1px solid var(--color-divider)',
            background: 'color-mix(in srgb, var(--color-accent) 7%, transparent)',
          }}
        >
          <span style={{ color: 'var(--color-accent-700)' }}>
            <IconCheck />
          </span>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15, color: 'var(--color-accent-700)' }}>
            {created.mode === 'start' ? '任务已创建并启动' : '任务已创建，处于 Ready 态'}
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--color-neutral-700)' }}>
            {created.mode === 'start' ? '生产已开始，可在工作台观察实时轨迹。' : '可在工作台检查后再手动启动。'}
          </span>
          <button type="button" className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12.5 }} onClick={() => void navigate({ to: `/tasks/${created.taskId}` })}>
            前往工作台 →
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div
          style={{
            flex: 'none',
            padding: '11px 32px',
            borderBottom: '1px solid var(--color-divider)',
            background: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 左栏：选模板 + 填冻结输入 */}
        <div className="fc-scroll" style={{ flex: 1, minWidth: 0, padding: '26px 32px 40px', borderRight: '1px solid var(--color-divider)' }}>
          <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 30 }}>
            {templatesQuery.isError ? (
              <div
                style={{
                  padding: '12px 16px',
                  border: '1px solid var(--color-danger)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-danger-bg)',
                  color: 'var(--color-danger)',
                  fontSize: 12.5,
                }}
              >
                模板列表加载失败：{templatesQuery.error instanceof ApiError ? templatesQuery.error.message : '请稍后重试'}
              </div>
            ) : null}
            <section>
              <SectionHeader no="01" title="选择模板" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                {templates.map((t) => {
                  const active = t.id === effectiveId;
                  return (
                    <div
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedId(t.id);
                        setCreated(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setSelectedId(t.id);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '14px 16px',
                        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: active ? 'color-mix(in srgb, var(--color-accent) 6%, transparent)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'border-color .15s',
                      }}
                    >
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          flex: 'none',
                          borderRadius: '50%',
                          border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                          background: active ? 'var(--color-accent)' : 'transparent',
                          boxShadow: active ? 'inset 0 0 0 2px var(--color-bg)' : 'none',
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 16 }}>{t.name}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{t.description}</div>
                      </div>
                      <span className="tag tag-outline" style={{ flex: 'none', fontSize: 11 }}>
                        {`${String(t.slotTypeCount)} 槽位`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <hr className="hr" style={{ margin: 0 }} />

            <section>
              <SectionHeader no="02" title="填写冻结输入" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 14 }}>
                <div className="field">
                  <label htmlFor="task-name" style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                    任务名称
                  </label>
                  <input
                    id="task-name"
                    className="input"
                    value={taskName}
                    onChange={(e) => setTaskName(e.target.value)}
                    placeholder="如《深夜来电》第三章"
                  />
                </div>

                {detail?.inputFields.map((f) => (
                  <div className="field" key={f.id}>
                    <label style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                      <span>{f.label}</span>
                      <ReqBadge required={f.required} />
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
                        {f.id}
                      </span>
                    </label>
                    {f.type === 'textarea' ? (
                      <textarea
                        className="input"
                        rows={5}
                        value={inputValues[f.id] ?? ''}
                        onChange={(e) => setInputValues((v) => ({ ...v, [f.id]: e.target.value }))}
                        style={{ resize: 'vertical', fontSize: 13.5, lineHeight: 1.6 }}
                      />
                    ) : (
                      <input
                        className="input"
                        value={inputValues[f.id] ?? ''}
                        onChange={(e) => setInputValues((v) => ({ ...v, [f.id]: e.target.value }))}
                      />
                    )}
                    {f.hint !== null ? <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', marginTop: 4 }}>{f.hint}</div> : null}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        {/* 右栏：选中模板的槽位树预览 */}
        <div
          className="fc-scroll"
          style={{ width: 400, flex: 'none', padding: '26px 28px 40px', background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)' }}
        >
          {detailQuery.isError ? (
            <EmptyState
              title="模板详情加载失败"
              sub={detailQuery.error instanceof ApiError ? detailQuery.error.message : '请稍后重试'}
            />
          ) : detail !== undefined ? (
            <StructurePreview exampleStructure={detail.exampleStructure} />
          ) : (
            <EmptyState title="选择模板后预览结构" />
          )}
        </div>
      </div>
    </>
  );
}

function SectionHeader({ no, title }: { no: string; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-accent)', fontVariantNumeric: 'tabular-nums' }}>{no}</span>
      <h4 style={{ margin: 0, fontSize: 18 }}>{title}</h4>
    </div>
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

function StructurePreview({
  exampleStructure,
}: {
  exampleStructure: { name: string; typeId: string; kind: 'container' | 'content'; depth: number }[] | null;
}) {
  const nodes = exampleStructure ?? [];
  const containerCount = nodes.filter((n) => n.kind === 'container').length;
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>
        槽位结构预览
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-neutral-600)' }}>
        {`${String(nodes.length)} 个槽位 · ${String(containerCount)} 个容器槽位 · 组装顺序按树内序`}
      </div>
      <div style={{ marginTop: 16 }}>
        {nodes.map((n) => (
          <div
            key={n.name}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 9,
              padding: `9px 0 9px ${String(n.depth * 20)}px`,
              borderBottom: '1px solid var(--color-divider)',
            }}
          >
            <span
              style={{
                width: 13,
                height: 13,
                flex: 'none',
                marginTop: 2,
                border: `1px solid ${n.kind === 'container' ? 'var(--color-neutral-500)' : 'color-mix(in srgb, var(--color-accent) 55%, transparent)'}`,
                borderRadius: n.kind === 'container' ? 2 : '50%',
              }}
            />
            <div style={{ minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 14.5, color: n.kind === 'container' ? 'var(--color-neutral-800)' : 'var(--color-text)' }}>
                {n.name}
              </span>
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>
                {n.kind === 'container' ? '容器' : '内容'}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 18,
          padding: '15px 16px',
          border: '1px solid var(--color-divider)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 14 }}>创建后会发生什么</div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.75 }}>
          先由结构 Agent 设计具体结构，通过确定性校验后保存槽位树，再按依赖顺序逐槽填充，全部通过后组装为产物。
        </div>
      </div>
    </div>
  );
}
