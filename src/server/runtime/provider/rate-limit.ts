/**
 * 限流的附加信息（D-04 / §8.5）。
 *
 * `Retry-After` 需要从 adapter 传到 `AssignmentRunner` 的退避循环，但
 * `ForgeError` 的公开字段（code / message / location / action）没有放它的地方，
 * 而 `@shared/errors.ts` 明确不希望出现 ForgeError 的子类树
 * （「错误的差异全在 code 上，子类树只会诱使 catch 写成 instanceof 链」）。
 *
 * 因此走 `cause`：它是 ForgeError 唯一的私有通道，`toPublic()` 会丢掉它，
 * 于是 Retry-After 天然不会出网。读取统一走本文件的函数，
 * 不要在别处对 `error.cause` 做鸭子类型判断。
 */

import { ForgeError } from '@shared/errors.ts';

export interface RateLimitCause {
  readonly kind: 'rate_limit';
  /** 来自 `Retry-After` 头，毫秒；Provider 没给就是 null，由退避策略自己定 */
  readonly retryAfterMs: number | null;
}

export function rateLimited(message: string, retryAfterMs: number | null, providerId: string): ForgeError {
  const cause: RateLimitCause = { kind: 'rate_limit', retryAfterMs };
  return new ForgeError('PROVIDER_RATE_LIMITED', message, `provider:${providerId}`, null, cause);
}

/** 取出 Provider 建议的等待时长。非限流错误或没给建议时返回 null */
export function rateLimitRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof ForgeError) || error.code !== 'PROVIDER_RATE_LIMITED') return null;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null) return null;
  const candidate = cause as Partial<RateLimitCause>;
  if (candidate.kind !== 'rate_limit') return null;
  return typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : null;
}

/**
 * 解析 `Retry-After` 头。支持秒数与 HTTP-date 两种形态。
 * 解析不出来返回 null——**不猜一个默认值**，那属于退避策略，
 * 在这里编一个数字会让「Provider 明确要求等 60 秒」和「Provider 什么都没说」
 * 在下游变得无法区分。
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
