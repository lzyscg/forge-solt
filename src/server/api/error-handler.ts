/**
 * `ForgeError` → HTTP 的唯一转换点（文档 §9.3）。
 *
 * 三条硬要求，逐条对应一种「看起来正常、实际有害」的失败：
 *
 * 1. **状态码全表来自 `shared/errors.ts`**，不在这里写任何 if。
 *    §9.3 明确点过早期草稿的错：「部分表 + 其余默认 500」会让
 *    `SLOT_NOT_READY`（附录 A 规定 409）悄悄变成 500。
 *    `Record<ErrorCode, number>` 的完备性检查让漏配变成编译错误。
 *
 * 2. **内部错误码不得出网（D-18）**。`INTERNAL_ONLY_ERROR_CODES` 里的码
 *    一旦冒泡到这里，说明某个本该被转成「工具错误结果」的异常逃逸出了工具层——
 *    是实现 bug，不是用户能理解的东西。处理方式必须同时满足两面：
 *    **对外安全**（500 + 通用文案，不泄露内部协议）、
 *    **对内刺眼**（error 级别 + 明确字样，好让它在日志里能被 grep 出来）。
 *    默默按原码返回是泄露，默默改写是掩盖，两个都不行。
 *
 * 3. **非 `ForgeError` 一律 `STORAGE_ERROR` + 通用文案**，原始错误连同 stack
 *    只进 pino。把 `error.message` 直接回给用户是最常见的信息泄露路径——
 *    sqlite 的报错里带表名和 SQL，Node 的报错里带绝对路径。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_ERROR_ACTION,
  ERROR_HTTP_STATUS,
  ForgeError,
  INTERNAL_ONLY_ERROR_CODES,
  type ErrorCode,
  type PublicError,
} from '@shared/errors.ts';

/** grep 用的固定字样。写成常量是为了让测试与日志检索用的是同一个串 */
export const INTERNAL_ESCAPE_LOG_MESSAGE = 'internal-only error escaped to HTTP';

const INTERNAL_ONLY = new Set<ErrorCode>(INTERNAL_ONLY_ERROR_CODES);

/** 兜底响应。任何拿不准的错误都走它 */
function genericError(): PublicError {
  return {
    code: 'STORAGE_ERROR',
    message: '服务内部错误',
    location: null,
    action: DEFAULT_ERROR_ACTION.STORAGE_ERROR,
  };
}

/**
 * 把一个已知的 `ForgeError` 转成对外形状。
 *
 * `action` 在这里兜底而不是在 `ForgeError.toPublic()` 里——见 `errors.ts` 的注释：
 * domain 抛错时不该被静默补上一句不适用的操作提示，而 DTO 一旦出网就没有第二次机会。
 */
export function toPublicWithAction(error: ForgeError): PublicError {
  const base = error.toPublic();
  return { ...base, action: base.action ?? DEFAULT_ERROR_ACTION[error.code] };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ForgeError) {
      if (INTERNAL_ONLY.has(error.code)) {
        // 对内刺眼：带上原始 code，好让人知道是哪一条逃逸了
        request.log.error(
          { err: error, code: error.code, url: request.url },
          INTERNAL_ESCAPE_LOG_MESSAGE,
        );
        // 对外安全：连 code 都不给，它属于 Agent 与 Runtime 之间的内部协议
        void reply.status(500).send(genericError());
        return;
      }
      void reply.status(ERROR_HTTP_STATUS[error.code]).send(toPublicWithAction(error));
      return;
    }

    // 非 ForgeError：可能是 sqlite 的约束错、Zod 的解析错、或者纯粹的编程错误。
    // 它们的 message 里常带表名、SQL、绝对路径——一律不出网。
    request.log.error({ err: error, url: request.url }, 'unhandled error');
    void reply.status(500).send(genericError());
  });

  // 404 也走统一形状。Fastify 默认回的是 `{statusCode,error,message}`，
  // 与 PublicError 不同形——前端要为「路由不存在」单写一套解析分支才能读懂它。
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send({
      code: 'TASK_NOT_FOUND',
      message: `没有这个接口：${request.method} ${request.url}`,
      location: null,
      action: null,
    } satisfies PublicError);
  });
}
