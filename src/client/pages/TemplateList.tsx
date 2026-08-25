/**
 * 模板列表 `/templates`。
 *
 * 数据：`GET /api/templates` → `TemplateListResponse {templates, failures}`。
 * `failures` 必须显式可见（§4.1「一个坏模板不许让整个列表页空白」的对应面：
 * 列表不空白，坏模板也要让用户知道为什么不在里面）。
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { TemplateSummary, TemplateLoadFailureView } from '@shared/contracts.ts';
import { listTemplates } from '../api/templates.ts';
import { ApiError } from '../api/http.ts';
import { FilterChip } from '../components/ui/FilterChip.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { formatRelative } from '../lib/format.ts';

const STATUS_LABEL: Record<TemplateSummary['status'], string> = {
  published: '已发布',
  draft: '草稿',
  archived: '已归档',
};
const STATUS_COLOR: Record<TemplateSummary['status'], string> = {
  published: 'var(--color-accent-700)',
  draft: 'var(--color-neutral-700)',
  archived: 'var(--color-neutral-500)',
};

export function TemplateList() {
  const navigate = useNavigate();
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: listTemplates });
  const [filter, setFilter] = useState('全部');

  // 产出类型筛选直接取数据里出现过的 outputKind（原型那组写死的粗类在契约里不存在）
  const kinds = useMemo(() => {
    const list = templatesQuery.data?.templates ?? [];
    return ['全部', ...Array.from(new Set(list.map((t) => t.outputKind)))];
  }, [templatesQuery.data]);

  const visible = useMemo(() => {
    const list = templatesQuery.data?.templates ?? [];
    return filter === '全部' ? list : list.filter((t) => t.outputKind === filter);
  }, [templatesQuery.data, filter]);

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
          <h3 style={{ margin: 0, fontSize: 26 }}>结构模板</h3>
          <div
            style={{
              marginTop: 7,
              fontSize: 12.5,
              color: 'var(--color-neutral-600)',
              maxWidth: 560,
              textWrap: 'pretty',
            }}
          >
            模板定义槽位树与每个槽位的 Assignment。任务运行时读的是模板的某个已发布版本，模板改动不影响在跑的任务。
          </div>
        </div>
      </header>

      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '13px 32px',
          borderBottom: '1px solid var(--color-divider)',
          background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)',
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--color-neutral-500)',
            marginRight: 6,
          }}
        >
          产出类型
        </span>
        {kinds.map((kind) => (
          <FilterChip key={kind} label={kind} active={filter === kind} onClick={() => setFilter(kind)} />
        ))}
        <span
          style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--color-neutral-600)', fontVariantNumeric: 'tabular-nums' }}
        >
          {`${String(visible.length)} 个模板`}
        </span>
      </div>

      <div className="fc-scroll" style={{ flex: 1, minHeight: 0, padding: '26px 32px 40px' }}>
        {templatesQuery.isPending ? <EmptyState title="加载中…" /> : null}
        {templatesQuery.isError ? (
          <EmptyState title="模板列表加载失败" sub={errorMessage(templatesQuery.error)} />
        ) : null}

        {templatesQuery.data !== undefined ? (
          <>
            {templatesQuery.data.failures.length > 0 ? (
              <FailureNotice failures={templatesQuery.data.failures} />
            ) : null}

            {visible.length === 0 ? (
              <EmptyState title="没有符合条件的模板" sub="换一个产出类型，或检查模板目录。" />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: 18,
                }}
              >
                {visible.map((t) => (
                  <TemplateCard key={t.id} template={t} onOpen={() => void navigate({ to: `/templates/${t.id}` })} />
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '请稍后重试';
}

function FailureNotice({ failures }: { failures: TemplateLoadFailureView[] }) {
  return (
    <div style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {failures.map((f) => (
        <div
          key={f.dirName}
          style={{
            border: '1px solid var(--color-divider)',
            borderLeft: '2px solid var(--color-accent-600)',
            borderRadius: 'var(--radius-md)',
            padding: '13px 16px',
            background: 'color-mix(in srgb, var(--color-surface) 45%, transparent)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15 }}>
              {f.dirName}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--color-neutral-500)' }}>模板加载失败，未列入可用模板</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.7 }}>
            {f.error.message}
          </div>
          {f.error.action !== null ? (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-accent-700)' }}>{f.error.action}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TemplateCard({ template, onOpen }: { template: TemplateSummary; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="card"
      style={{
        padding: '20px 21px 18px',
        cursor: 'pointer',
        transition: 'border-color .15s',
        gap: 14,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-accent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-divider)';
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span
            style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}
          >
            {template.outputKind}
          </span>
          <span
            style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}
          >
            {template.version}
          </span>
        </div>
        <h4 style={{ margin: '7px 0 0', fontSize: 19 }}>{template.name}</h4>
        <div
          style={{ marginTop: 6, fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.7, textWrap: 'pretty' }}
        >
          {template.description}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 26, paddingTop: 13, borderTop: '1px solid var(--color-divider)' }}>
        <Stat value={template.slotTypeCount} label="槽位" />
        <Stat value={template.agentCount} label="Agent" />
        <Stat value={template.skillCount} label="Skill" />
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>
            {template.runCount}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-500)', marginTop: 1 }}>已跑任务</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {template.tags.map((tag) => (
          <span key={tag} className="tag tag-outline" style={{ fontSize: 11 }}>
            {tag}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--color-neutral-500)' }}>
        <span style={{ color: STATUS_COLOR[template.status] }}>{STATUS_LABEL[template.status]}</span>
        <span>·</span>
        <span>{formatRelative(template.updatedAt)}</span>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--color-neutral-500)', marginTop: 1 }}>{label}</div>
    </div>
  );
}
