/**
 * 左栏结构槽树。`depth` 直接 `× 14px` 缩进（服务端派生，前端不递归，D-07）。
 * 标记：容器=方形；内容按状态（✓/▶/!/○/●）。点击选中并停止自动跟随（§10.3①）。
 */

import type { SlotView } from '@shared/contracts.ts';
import { toneStyle } from '../components/tone.ts';

interface SlotTreeProps {
  slots: SlotView[];
  selectedId: string | null;
  hasStructure: boolean;
  emptyNote: string;
  footnote: string;
  onSelect: (slotId: string) => void;
}

export function SlotTree({ slots, selectedId, hasStructure, emptyNote, footnote, onSelect }: SlotTreeProps) {
  const contentSlots = slots.filter((s) => s.contentBearing);
  const doneCount = contentSlots.filter((s) => s.status === 'completed').length;

  return (
    <aside
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--color-divider)',
        background: 'color-mix(in srgb, var(--color-surface) 30%, transparent)',
      }}
    >
      <div style={{ flex: 'none', padding: '18px 20px 14px', borderBottom: '1px solid var(--color-divider)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h5 style={{ margin: 0, fontSize: 15 }}>内容结构</h5>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)', fontVariantNumeric: 'tabular-nums' }}>
            {hasStructure ? `${String(doneCount)} / ${String(contentSlots.length)} 已完成` : '—'}
          </span>
        </div>
        <div className="fc-progress" style={{ marginTop: 10 }}>
          <div
            className="fc-progress-fill"
            style={{ width: hasStructure && contentSlots.length > 0 ? `${String(Math.round((doneCount / contentSlots.length) * 100))}%` : '0%' }}
          />
        </div>
      </div>

      <div className="fc-scroll" style={{ flex: 1, minHeight: 0, padding: '10px 12px 24px' }}>
        {!hasStructure ? (
          <div style={{ padding: '22px 10px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, marginBottom: 8 }}>结构尚未创建</div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>{emptyNote}</p>
          </div>
        ) : (
          slots.map((slot) => (
            <SlotNode key={slot.id} slot={slot} selected={slot.id === selectedId} onSelect={() => onSelect(slot.id)} />
          ))
        )}
      </div>

      <div style={{ flex: 'none', padding: '12px 20px', borderTop: '1px solid var(--color-divider)', fontSize: 11, color: 'var(--color-neutral-500)', lineHeight: 1.6 }}>
        {footnote}
      </div>
    </aside>
  );
}

/**
 * 标记的「形状」与颜色都来自服务端派生的 presentation.tone（D-07），
 * 不在前端用 status/blockedBy 重新推导业务状态。
 */
function slotMark(slot: SlotView): { mark: string; color: string; pulse: boolean } {
  if (!slot.contentBearing) return { mark: '▣', color: toneStyle('container').dot, pulse: false };
  const t = toneStyle(slot.presentation.tone);
  switch (slot.presentation.tone) {
    case 'ok':
      return { mark: '✓', color: t.dot, pulse: false };
    case 'run':
      return { mark: '▶', color: t.dot, pulse: t.pulse };
    case 'warn':
      return { mark: '▶', color: t.dot, pulse: false };
    case 'fail':
      return { mark: '!', color: t.dot, pulse: false };
    case 'wait':
      return { mark: '○', color: t.dot, pulse: false };
    default:
      return { mark: '●', color: t.dot, pulse: false };
  }
}

function SlotNode({ slot, selected, onSelect }: { slot: SlotView; selected: boolean; onSelect: () => void }) {
  const m = slotMark(slot);
  const meta = !slot.contentBearing ? '容器槽位 · 不承载正文' : `${slot.typeName} · ${slot.presentation.detail}`;
  const nameColor = !slot.contentBearing
    ? 'var(--color-neutral-600)'
    : slot.presentation.tone === 'fail'
      ? 'var(--color-danger)'
      : 'var(--color-text)';

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
        gap: 8,
        alignItems: 'flex-start',
        padding: `9px 10px 9px ${String(10 + slot.depth * 14)}px`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        marginBottom: 2,
        background: selected ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
        boxShadow: selected ? 'inset 0 0 0 1px var(--color-accent-300)' : 'none',
      }}
    >
      <span
        style={{
          width: 18,
          flex: 'none',
          textAlign: 'center',
          fontSize: 12,
          lineHeight: 1.5,
          color: m.color,
          animation: m.pulse ? 'fc-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      >
        {m.mark}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            letterSpacing: '-.01em',
            color: nameColor,
          }}
        >
          {slot.id}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{meta}</div>
      </div>
    </div>
  );
}
