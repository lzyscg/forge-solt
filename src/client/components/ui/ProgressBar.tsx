/** 3px 进度条（任务列表「槽位」列）。宽度 = done/total，填充色随语气 */
export function ProgressBar({ done, total, color }: { done: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="fc-progress">
      <div
        className="fc-progress-fill"
        style={{ width: `${String(pct)}%`, background: color ?? 'var(--color-accent)' }}
      />
    </div>
  );
}
