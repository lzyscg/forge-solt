import type { ReactNode } from 'react';
import type { Tone } from '@shared/presentation.ts';
import { toneStyle } from '../tone.ts';

/** 状态徽章：描边 + 文字按 tone 取色（组件状态变体 §D） */
export function ToneChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const s = toneStyle(tone);
  return (
    <span className="fc-chip" style={{ borderColor: s.chipBorder, color: s.chipColor }}>
      {children}
    </span>
  );
}
