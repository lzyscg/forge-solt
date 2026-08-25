/**
 * 展示层时间格式化。
 *
 * 注意边界：这里只做「把服务端给的时间戳渲染成人看得懂的样子」，
 * 不重算、不重排——服务端的时间戳值本身是权威（§10.3④「原样显示不做本地时间推算」）。
 */

/** `2026-08-22T03:42:05.000Z` → `11:42:05`（本地时，轨迹时间戳用） */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ISO → `2026-08-22 11:42` */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO → 相对时间（「3 天前」），用于模板/任务列表的「更新」列 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${String(Math.floor(diffMs / minute))} 分钟前`;
  if (diffMs < day) return `${String(Math.floor(diffMs / hour))} 小时前`;
  if (diffMs < 30 * day) return `${String(Math.floor(diffMs / day))} 天前`;
  return formatDateTime(iso);
}

/** 毫秒 → 「90 秒」/「2 分」这类可读时长（模板详情超时、执行耗时用） */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${String(ms)} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`;
}
