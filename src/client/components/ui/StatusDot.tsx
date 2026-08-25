import type { Tone } from '@shared/presentation.ts';
import { toneStyle } from '../tone.ts';

/** 7px 状态点。运行态（run）加脉冲；颜色由 tone 决定（D-07 前端只取色） */
export function StatusDot({ tone }: { tone: Tone }) {
  const s = toneStyle(tone);
  return <span className={`fc-dot${s.pulse ? ' fc-dot-pulse' : ''}`} style={{ background: s.dot }} />;
}
