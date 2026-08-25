/**
 * 语气（Tone）→ 视觉样式的**单一映射表**。
 *
 * 键是契约的 7 个 `Tone`（@shared/presentation.ts），值取自设计稿的精确色值
 * （组件状态变体.dc.html / 任务工作台.dc.html），一律用 var(--…)，不硬编码。
 *
 * 之所以集中在这一处：原型里 run/ok/wait/fail/idle/stop/done/danger/warn 等
 * 简写词表各不相同，若让各页面自己取色就会漂移。前端只做「按 tone 取色」（D-07），
 * 取色逻辑全部落在这里。
 */

import type { Tone } from '@shared/presentation.ts';

export interface ToneStyle {
  /** 状态点颜色 */
  dot: string;
  /** 状态文字颜色 */
  text: string;
  /** 运行态是否脉冲（仅 run） */
  pulse: boolean;
  /** 容器槽位用方形标记而非圆点（仅 container） */
  square: boolean;
  /** 已完成是否实心填充圆点（仅 ok） */
  filled: boolean;
  /** 状态徽章（ToneChip）的描边与文字色 */
  chipBorder: string;
  chipColor: string;
}

export const TONE_STYLES: Record<Tone, ToneStyle> = {
  idle: {
    dot: 'var(--color-neutral-400)',
    text: 'var(--color-neutral-600)',
    pulse: false,
    square: false,
    filled: false,
    chipBorder: 'var(--color-neutral-400)',
    chipColor: 'var(--color-neutral-600)',
  },
  run: {
    dot: 'var(--color-accent)',
    text: 'var(--color-accent-700)',
    pulse: true,
    square: false,
    filled: false,
    chipBorder: 'var(--color-accent)',
    chipColor: 'var(--color-accent-700)',
  },
  wait: {
    dot: 'var(--color-accent-600)',
    text: 'var(--color-accent-700)',
    pulse: false,
    square: false,
    filled: false,
    chipBorder: 'var(--color-neutral-400)',
    chipColor: 'var(--color-accent-700)',
  },
  warn: {
    dot: 'var(--color-accent-600)',
    text: 'var(--color-accent-700)',
    pulse: false,
    square: false,
    filled: false,
    chipBorder: 'var(--color-accent-600)',
    chipColor: 'var(--color-accent-800)',
  },
  ok: {
    dot: 'var(--color-accent-700)',
    text: 'var(--color-neutral-700)',
    pulse: false,
    square: false,
    filled: true,
    chipBorder: 'var(--color-accent-700)',
    chipColor: 'var(--color-accent-800)',
  },
  fail: {
    dot: 'var(--color-danger)',
    text: 'var(--color-danger)',
    pulse: false,
    square: false,
    filled: false,
    chipBorder: 'var(--color-danger)',
    chipColor: 'var(--color-danger)',
  },
  container: {
    dot: 'var(--color-neutral-500)',
    text: 'var(--color-neutral-700)',
    pulse: false,
    square: true,
    filled: false,
    chipBorder: 'var(--color-neutral-400)',
    chipColor: 'var(--color-neutral-700)',
  },
};

export function toneStyle(tone: Tone): ToneStyle {
  return TONE_STYLES[tone];
}
