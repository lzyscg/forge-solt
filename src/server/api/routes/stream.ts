/**
 * `GET /api/tasks/:id/stream`（文档 §9.4）。
 *
 * 这是全系统唯一一条**不由 Fastify 结束响应**的路由：SSE 连接要一直开着。
 * 因此要 `reply.hijack()`，之后 Fastify 不再碰这个 reply，
 * 生命周期完全由本文件与 SseHub 负责。
 *
 * ## 补发游标的优先级：`Last-Event-ID` 高于 `?after=`
 *
 * 这条顺序不能反。浏览器 `EventSource` 重连时会**原样重发同一个 URL**
 * （连同当初那个 `?after=`），同时带上 `Last-Event-ID` 头。
 * 若让 query 赢，每一次重连都会从最初那个游标重放一遍——
 * 断线越多，重复越多，而前端看到的是同一批轨迹一次次涌进来。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ForgeApp } from '@server/application/composition.ts';
import type { SseHub } from '@server/infrastructure/sse-hub.ts';
import { optionalInt } from '../query.ts';

interface TaskIdParams {
  id: string;
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform 是关键：某些代理会「顺手」压缩响应，而压缩会引入缓冲，
  // 于是事件要攒够一个块才吐出去——流式光标当场变成一卡一卡的
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx 专用。它默认给 proxy 响应开缓冲，同样会把流吃掉
  'X-Accel-Buffering': 'no',
};

export function registerStreamRoute(app: FastifyInstance, forge: ForgeApp, hub: SseHub): void {
  app.get<{ Params: TaskIdParams; Querystring: Record<string, unknown> }>(
    '/api/tasks/:id/stream',
    (request: FastifyRequest<{ Params: TaskIdParams; Querystring: Record<string, unknown> }>, reply: FastifyReply) => {
      const taskId = request.params.id;

      // **在 hijack 之前**把能失败的事情做完。hijack 之后再抛错，
      // setErrorHandler 已经没有 reply 可写了——客户端会收到一个空连接，
      // 既不是 404 也不是流。下面两步就是全部会失败的事。

      // **没传就是没传，不要造一个 0 出来。** `after: 0` 对 Hub 的含义是
      // 「从头补发」，而缺省的含义是「不补发」。造 0 的话，每一次首连都会
      // 全量重放整条轨迹（实测一章 295 条），而前端同时还会
      // `GET /traces` 拉一次历史——时间线里每条事件出现两次。
      const rawAfter = request.query['after'];
      const after =
        rawAfter === undefined
          ? undefined
          : optionalInt(rawAfter, 'after', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });

      // 任务不存在时给正常的 404 JSON，而不是开一条永远没有事件的流
      forge.tasks.getTaskSummary(taskId);

      const lastEventId = request.headers['last-event-id'];
      const cursor =
        typeof lastEventId === 'string' && /^\d+$/.test(lastEventId) ? Number(lastEventId) : after;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);
      // 立刻吐一个注释行：有些客户端（和代理）要收到第一个字节才认为连接建立，
      // 而下一条真事件可能是几十秒后的事
      raw.write(': connected\n\n');

      const unsubscribe = hub.subscribe(
        taskId,
        {
          write(chunk) {
            raw.write(chunk);
          },
          end() {
            raw.end();
          },
        },
        // 同理：cursor 为 undefined 时整个字段都不传
        cursor === undefined ? {} : { after: cursor },
      );

      // 两个事件都要挂：`close` 覆盖正常关闭与网络中断，
      // `error` 覆盖对端 RST 这类不走 close 的情况。退订是幂等的。
      const detach = (): void => {
        unsubscribe();
      };
      request.raw.on('close', detach);
      request.raw.on('error', detach);
    },
  );
}
