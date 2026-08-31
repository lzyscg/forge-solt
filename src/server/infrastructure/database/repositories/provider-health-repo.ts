/**
 * ProviderHealthRepo —— `provider_health` 表（D-68）。
 *
 * ## 为什么这张表必须落库，而不是留在内存
 *
 * 这张表在 `001_initial.sql` 里就建了，但迁移 005 之前**没有任何代码读写它**——
 * 健康状态一直活在 `ProviderRegistry` 的内存 Map 里。对「连通性」来说这没问题，
 * 那本来就是缓存。但对「额度耗尽」不行：
 *
 * 耗尽是一个**用真金白银换来的结论**。进程一重启就忘掉，等于每次重启都要
 * 再撞一次同样的墙、再浪费一次调用（在按次计费的档上，那还不止一次——
 * 优云一次 deepseek 调用扣 3 次）。
 *
 * ## 耗尽为什么带冷却，而不是永久拉黑
 *
 * 订阅额度按月重置，而我们**无从得知重置时刻**（三家都没给这个接口）。
 * 永久拉黑意味着额度恢复了也爬不回高优先级档，得靠人去清状态——
 * 而人不会记得。冷却过期后下一个新任务重试一次，代价是每 `cooldownMs`
 * 浪费一次调用，可忽略。
 */

import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';

export type ProviderHealthStatus = 'ok' | 'rate_limited' | 'exhausted' | 'down';

export interface ProviderHealthRow {
  providerId: string;
  status: ProviderHealthStatus;
  latencyMs: number | null;
  note: string | null;
  rateLimitCount: number;
  exhaustedAt: string | null;
  /** 判定依据的上游原文。D-68 L2 特征表的唯一数据来源 */
  exhaustedReason: string | null;
  checkedAt: string;
}

interface Row {
  provider_id: string;
  status: string;
  latency_ms: number | null;
  note: string | null;
  rate_limit_count: number;
  exhausted_at: string | null;
  exhausted_reason: string | null;
  checked_at: string;
}

function toRow(r: Row): ProviderHealthRow {
  return {
    providerId: r.provider_id,
    status: r.status as ProviderHealthStatus,
    latencyMs: r.latency_ms,
    note: r.note,
    rateLimitCount: r.rate_limit_count,
    exhaustedAt: r.exhausted_at,
    exhaustedReason: r.exhausted_reason,
    checkedAt: r.checked_at,
  };
}

/** 耗尽状态的默认冷却窗口。**这个值是拍的**，没有数据支持，改它不需要理由 */
export const DEFAULT_EXHAUSTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface ProviderHealthRepo {
  get(providerId: string): ProviderHealthRow | null;
  list(): ProviderHealthRow[];
  markExhausted(providerId: string, reason: string): void;
  clearExhausted(providerId: string): void;
  isExhausted(providerId: string, cooldownMs?: number): boolean;
}

export function createProviderHealthRepo(db: ForgeDb, clock: Clock): ProviderHealthRepo {
  const get = (providerId: string): ProviderHealthRow | null => {
    const row = db
      .prepare('SELECT * FROM provider_health WHERE provider_id = ?')
      .get(providerId) as Row | undefined;
    return row === undefined ? null : toRow(row);
  };

  const list = (): ProviderHealthRow[] => {
    const rows = db
      .prepare('SELECT * FROM provider_health ORDER BY provider_id')
      .all() as Row[];
    return rows.map(toRow);
  };

  /**
   * 判定某 Provider 额度耗尽。
   *
   * `reason` 必须带上游返回的原文（状态码 + body 片段）。这不是日志洁癖：
   * 我们至今**不知道**火山/优云耗尽时回什么（D-68 L2 那张特征表因此是空的），
   * 而这一列是补上它的唯一线索来源。写成「额度不足」这种自拟的话，
   * 等于把这次用真钱换来的样本丢了。
   */
  const markExhausted = (providerId: string, reason: string): void => {
    const now = clock();
    db
      .prepare(
        `INSERT INTO provider_health
           (provider_id, status, latency_ms, note, rate_limit_count,
            exhausted_at, exhausted_reason, checked_at)
         VALUES (?, 'exhausted', NULL, NULL, 0, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           status = 'exhausted',
           exhausted_at = excluded.exhausted_at,
           exhausted_reason = excluded.exhausted_reason,
           checked_at = excluded.checked_at`,
      )
      .run(providerId, now, reason, now);
  };

  /** 手动或探测成功后清除耗尽标记 */
  const clearExhausted = (providerId: string): void => {
    db
      .prepare(
        `UPDATE provider_health
            SET status = 'ok', exhausted_at = NULL, exhausted_reason = NULL, checked_at = ?
          WHERE provider_id = ?`,
      )
      .run(clock(), providerId);
  };

  /**
   * 这个 Provider 现在是否应当被降级链跳过。
   *
   * 只看 `exhausted` 一种状态。**`rate_limited` 与 `down` 刻意不算数**：
   * - `rate_limited` 等一会儿还能用，退避机制已经在处理它；
   * - `down` 来自连通性探测，那是个可能过期很久的缓存，
   *   拿它决定钱花在哪里太轻率了。
   * 降级是花钱的决定，只认真正撞过墙的那一种信号。
   */
  const isExhausted = (
    providerId: string,
    cooldownMs = DEFAULT_EXHAUSTION_COOLDOWN_MS,
  ): boolean => {
    const row = get(providerId);
    if (row === null || row.status !== 'exhausted' || row.exhaustedAt === null) return false;
    const at = Date.parse(row.exhaustedAt);
    if (Number.isNaN(at)) return false; // 时间戳坏了就当没耗尽——宁可多试一次，不要莫名其妙掉档
    return Date.parse(clock()) - at < cooldownMs;
  };

  return { get, list, markExhausted, clearExhausted, isExhausted };
}
