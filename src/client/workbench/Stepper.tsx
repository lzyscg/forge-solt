/**
 * 五段 Stepper（§9.2）。数据源 `TaskDetail.stepper[]`（key/label/state/summary/owner）。
 * `owner` 区分「System / Agent」徽章。五段可点击导航（只导航不改状态，§20.2）。
 * 契约 `state` 是 4 值；终段「final」外观由「最后一段 + done + 任务 completed」纯展示判断。
 */

import type { StepperKey, TaskDetail } from '@shared/contracts.ts';

const DANGER = 'var(--color-danger)';
const DANGER_BG = 'var(--color-danger-bg)';

interface StepperProps {
  steps: TaskDetail['stepper'];
  completed: boolean;
  /** 当前中栏正在查看的段（高亮） */
  viewingKey: StepperKey | null;
  onFocus: (key: StepperKey) => void;
}

export function Stepper({ steps, completed, viewingKey, onFocus }: StepperProps) {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 28px',
        borderBottom: '1px solid var(--color-divider)',
        background: 'color-mix(in srgb, var(--color-surface) 40%, transparent)',
      }}
    >
      {steps.map((step, i) => {
        const isFinal = i === steps.length - 1 && step.state === 'done' && completed;
        const viewing = viewingKey === step.key;
        const clickable = step.state !== 'todo';
        const mark = step.state === 'done' ? '✓' : step.state === 'current' ? '▶' : step.state === 'error' ? '!' : '○';
        const markColor = isFinal
          ? 'var(--color-accent-700)'
          : step.state === 'done'
            ? 'var(--color-neutral-700)'
            : step.state === 'current'
              ? 'var(--color-accent)'
              : step.state === 'error'
                ? DANGER
                : 'var(--color-neutral-400)';
        return (
          <div
            key={step.key}
            onClick={() => {
              if (clickable) onFocus(step.key);
            }}
            style={{
              flex: 1,
              padding: '14px 16px 13px',
              borderRight: i < steps.length - 1 ? '1px solid var(--color-divider)' : 'none',
              cursor: clickable ? 'pointer' : 'default',
              opacity: step.state === 'todo' ? 0.6 : 1,
              background: viewing ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : isFinal ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : step.state === 'error' ? DANGER_BG : 'transparent',
              boxShadow: viewing ? 'inset 0 0 0 1px var(--color-accent-300)' : step.state === 'current' ? 'inset 0 -2px 0 var(--color-accent)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, width: 16, textAlign: 'center', color: markColor }}>{mark}</span>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap' }}>{step.label}</span>
              <span
                style={{
                  fontSize: 9.5,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-500)',
                  border: '1px solid var(--color-divider)',
                  borderRadius: 2,
                  padding: '1px 4px',
                }}
              >
                {step.owner === 'system' ? 'System' : 'Agent'}
              </span>
            </div>
            <div
              style={{
                fontSize: 11.5,
                marginTop: 3,
                paddingLeft: 24,
                fontVariantNumeric: 'tabular-nums',
                color: viewing || step.state === 'current' ? 'var(--color-accent-700)' : 'var(--color-neutral-500)',
              }}
            >
              {viewing ? `正在查看 · ${step.summary}` : step.summary}
            </div>
          </div>
        );
      })}
    </div>
  );
}
