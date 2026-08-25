/** 空态：居中标题 + 说明（各列表页通用） */
export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="fc-empty">
      <div className="fc-empty-title">{title}</div>
      {sub !== undefined ? <div className="fc-empty-sub">{sub}</div> : null}
    </div>
  );
}
