/**
 * 前端薄客户端（HANDOFF §6 建议的起手式）。
 *
 * 职责只有一件：把 fetch 的响应在**数据边界**用契约 schema `.parse()` 一次。
 * 后端已保证形状，这里再 parse 的价值是——契约漂移会在边界立刻炸，
 * 而不是在某个组件里表现为一处 undefined 渲染。
 *
 * 错误统一归一成 `PublicError`（{code,message,location,action}），
 * 404 也是这个形状（HANDOFF §5），前端不必为「路由不存在」单写一套解析。
 */

import type { z } from 'zod';
import { PublicErrorSchema, type PublicError } from '@shared/errors.ts';

/** 出网错误的类型化载体。`action` 为 null 表示没有可执行的下一步（§18.8） */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly error: PublicError,
    readonly status: number,
  ) {
    super(error.message);
  }
}

export interface RequestOptions {
  path: string;
  method?: 'GET' | 'POST';
  /** POST 的请求体；会被 JSON 序列化 */
  body?: unknown;
}

/**
 * 发起请求并用 `schema` 校验响应。
 *
 * 泛型约束到 `z.ZodType`，返回 `z.infer`——调用方拿到的类型直接来自契约，
 * 不手写 interface（HANDOFF §5「前端直接 z.infer 推导类型」）。
 */
export async function request<TSchema extends z.ZodType>(
  schema: TSchema,
  options: RequestOptions,
): Promise<z.infer<TSchema>> {
  const init: RequestInit = { method: options.method ?? 'GET' };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json' };
  }

  const res = await fetch(options.path, init);
  if (!res.ok) {
    throw new ApiError(await parsePublicError(res), res.status);
  }
  const body: unknown = await res.json();
  return schema.parse(body);
}

/**
 * 非 2xx 响应一律解释成 `PublicError`。
 * 解析失败（理论上不该发生）退回一个成文的兜底，而不是把裸文本抛给用户——
 * 与后端 `reasonOf` 只信任成文中文是同一条纪律（HANDOFF §3.5）。
 */
async function parsePublicError(res: Response): Promise<PublicError> {
  try {
    return PublicErrorSchema.parse(await res.json());
  } catch {
    return {
      code: 'STORAGE_ERROR',
      message: `请求失败（HTTP ${String(res.status)}）`,
      location: null,
      action: null,
    };
  }
}

/** 编码查询参数，跳过 undefined / null / 空串 */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
