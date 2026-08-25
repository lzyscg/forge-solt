/**
 * Provider 设置 `/settings/providers`。
 *
 * 数据：`GET /api/providers` → {providers, aliases, defaults}。
 * 凭据只显示「环境变量名 + 是否已配置」，**绝不回显密钥值**（§17 / REQ §13）。
 * `concurrentSlots` 渲染为 1 且不可编辑（契约 `z.literal(1)`，D-04）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderHealth, ProviderView } from '@shared/contracts.ts';
import { listProviders, probeProvider } from '../api/providers.ts';
import { ApiError } from '../api/http.ts';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { formatDateTime, formatDurationMs } from '../lib/format.ts';

const HEALTH_META: Record<ProviderHealth['status'], { label: string; color: string; pulse: boolean }> = {
  ok: { label: '连通正常', color: 'var(--color-accent-700)', pulse: true },
  rate_limited: { label: '限流中', color: 'var(--color-accent-600)', pulse: true },
  down: { label: '未连通', color: 'var(--color-neutral-500)', pulse: false },
};

export function ProviderSettings() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: listProviders });

  const probe = useMutation({
    mutationFn: (providerId: string) => probeProvider(providerId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  const data = providersQuery.data;

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
          <h3 style={{ margin: 0, fontSize: 25 }}>模型 Provider</h3>
          <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--color-neutral-600)', maxWidth: 620, textWrap: 'pretty' }}>
            只管模型层：Provider、别名映射与执行默认值。Agent 与 Skill 的编排在模板里定义，不在此页。
          </div>
        </div>
        <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={probe.isPending}
            onClick={() => {
              for (const p of data?.providers ?? []) probe.mutate(p.id);
            }}
          >
            {probe.isPending ? '正在检测…' : '全部测试连通'}
          </button>
        </div>
      </header>

      <div className="fc-scroll" style={{ flex: 1, minHeight: 0, padding: '26px 32px 44px' }}>
        {providersQuery.isPending ? <EmptyState title="加载中…" /> : null}
        {providersQuery.isError ? (
          <EmptyState title="Provider 加载失败" sub={providersQuery.error instanceof ApiError ? providersQuery.error.message : '请稍后重试'} />
        ) : null}

        {data !== undefined ? (
          <div style={{ maxWidth: 940, display: 'flex', flexDirection: 'column', gap: 34 }}>
            {/* 已接入 Provider */}
            <section>
              <SectionTitle label={`已接入 Provider · ${String(data.providers.length)} 个`} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
                {data.providers.map((p) => (
                  <ProviderCard key={p.id} provider={p} onProbe={() => probe.mutate(p.id)} probing={probe.isPending} />
                ))}
              </div>
            </section>

            {/* 模型映射 */}
            <section>
              <SectionTitle label="模型映射" />
              <div style={{ marginTop: 12, border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 16,
                    padding: '10px 18px',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'color-mix(in srgb, var(--color-surface) 50%, transparent)',
                    fontSize: 11,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    color: 'var(--color-neutral-600)',
                  }}
                >
                  <span style={{ width: 168 }}>别名</span>
                  <span style={{ width: 136 }}>Provider</span>
                  <span style={{ flex: 1 }}>实际模型</span>
                  <span style={{ width: 120, textAlign: 'right' }}>在用绑定</span>
                </div>
                {data.aliases.map((a) => (
                  <div
                    key={a.alias}
                    style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 18px', borderBottom: '1px solid var(--color-divider)' }}
                  >
                    <span style={{ width: 168, fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
                      {a.alias}
                    </span>
                    <span style={{ width: 136, fontSize: 12.5, color: 'var(--color-neutral-700)' }}>{a.providerName}</span>
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--color-neutral-700)', fontVariantNumeric: 'tabular-nums' }}>{a.model}</span>
                    <span style={{ width: 120, textAlign: 'right', fontSize: 12.5, color: 'var(--color-neutral-600)', fontVariantNumeric: 'tabular-nums' }}>
                      {`${String(a.usageCount)} 个绑定`}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* 执行默认值 */}
            <section>
              <SectionTitle label="执行默认值" />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginTop: 12 }}>
                <DefaultCard label="单槽位超时" value={formatDurationMs(data.defaults.timeoutMs)} note="Assignment 未显式指定时取此值" />
                <DefaultCard label="重试次数" value={`${String(data.defaults.maxRetries)} 次`} note="校验失败 / Provider 错误时消耗" />
                <DefaultCard label="并发槽位" value={String(data.defaults.concurrentSlots)} note="P0 固定为 1，不可编辑" />
                <DefaultCard
                  label="限流退避"
                  value={`指数 · 上限 ${formatDurationMs(data.defaults.rateLimitBackoff.maxMs)}`}
                  note={`最多 ${String(data.defaults.rateLimitBackoff.maxAttempts)} 次，不计入重试配额`}
                />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>{label}</div>
  );
}

function DefaultCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 21, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', lineHeight: 1.6, marginTop: 2 }}>{note}</div>
    </div>
  );
}

function ProviderCard({ provider, onProbe, probing }: { provider: ProviderView; onProbe: () => void; probing: boolean }) {
  const meta = HEALTH_META[provider.health.status];
  return (
    <div style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: '17px 19px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 17 }}>{provider.name}</span>
            <span style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', fontVariantNumeric: 'tabular-nums' }}>{provider.baseUrl}</span>
            {provider.apiKeyPresent === false ? (
              <span className="tag tag-neutral" style={{ fontSize: 10.5 }}>
                凭证缺失 · {provider.apiKeyEnv}
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5 }}>
            <span
              className={`fc-dot${meta.pulse ? ' fc-dot-pulse' : ''}`}
              style={{ background: meta.color }}
            />
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: meta.color }}>{meta.label}</span>
            {provider.health.status === 'rate_limited' ? (
              <span style={{ color: 'var(--color-neutral-600)' }}>{`${String(provider.health.rateLimitCount)} 次 429`}</span>
            ) : null}
            {provider.health.latencyMs !== null ? (
              <>
                <span style={{ color: 'var(--color-neutral-400)' }}>·</span>
                <span style={{ color: 'var(--color-neutral-600)', fontVariantNumeric: 'tabular-nums' }}>{`${String(provider.health.latencyMs)} ms`}</span>
              </>
            ) : null}
            {provider.health.checkedAt !== null ? (
              <>
                <span style={{ color: 'var(--color-neutral-400)' }}>·</span>
                <span style={{ color: 'var(--color-neutral-600)' }}>{formatDateTime(provider.health.checkedAt)}</span>
              </>
            ) : null}
          </div>
          {provider.health.note !== null ? (
            <div
              style={{
                marginTop: 8,
                padding: '9px 12px',
                borderLeft: '2px solid var(--color-accent)',
                fontSize: 12.5,
                color: 'var(--color-neutral-700)',
                lineHeight: 1.65,
              }}
            >
              {provider.health.note}
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 12.5, padding: '5px 11px' }} disabled={probing} onClick={onProbe}>
          测试连通
        </button>
      </div>
      <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--color-divider)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {provider.models.map((m) => (
          <span key={m} className="tag tag-outline" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}
