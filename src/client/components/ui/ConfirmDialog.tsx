import type { ReactNode } from 'react';

/**
 * 确认弹窗（组件状态变体 §F）。
 * 破坏性操作只在文字与描边上转红，不做填充（设计约束）。
 * §20.4：停止/放弃这类操作必须二次确认。
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  /** 将被影响的具体项（如「将被清空：scene_01 · scene_02」），可选 */
  list?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger=true 时确认按钮转红描边/文字 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  const dangerStyle = props.danger === true
    ? { borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }
    : undefined;

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{props.title}</div>
        <div className="dialog-body">{props.body}</div>
        {props.list !== undefined ? (
          <div
            style={{
              padding: '10px 13px',
              border: '1px solid var(--color-divider)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              color: 'var(--color-neutral-700)',
              lineHeight: 1.7,
            }}
          >
            {props.list}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
            {props.cancelLabel ?? '取消'}
          </button>
          <button type="button" className="btn btn-secondary" style={dangerStyle} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
