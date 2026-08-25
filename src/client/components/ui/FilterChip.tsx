/** 筛选条上的可点选 chip（模板/状态/模板详情 Tab 之外的通用筛选） */
export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="fc-filter" data-active={active} onClick={onClick}>
      {label}
    </button>
  );
}
