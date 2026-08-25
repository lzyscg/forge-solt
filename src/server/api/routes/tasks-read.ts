/**
 * 任务只读端点（§9.1）。
 *
 * ```
 * GET /api/tasks                        任务列表（含 presentation）
 * GET /api/tasks/:id                    任务详情
 * GET /api/tasks/:id/slots              槽位列表
 * GET /api/tasks/:id/slots/:slotId      单槽位（含完整 content）
 * GET /api/tasks/:id/executions         执行记录
 * GET /api/tasks/:id/traces?after=&limit=  轨迹分页
 * GET /api/tasks/:id/artifact           产物元信息 + 内容
 * GET /api/tasks/:id/artifact/download  下载
 * ```
 *
 * 与 templates.ts 同为薄转发：不 catch、不判状态、不算派生字段。
 * 唯一有实质逻辑的是 `/artifact/download` 的响应头，见那里的注释。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ForgeApp } from '@server/application/composition.ts';
import { optionalInt } from '../query.ts';

interface TaskIdParams {
  id: string;
}

interface SlotParams extends TaskIdParams {
  slotId: string;
}

/** 列表页一屏放不下更多；上界防的是「?limit=100000 把整库拉进内存」 */
const TASK_LIMIT = { fallback: 50, min: 1, max: 200 };
/** 轨迹一页。UX §13 的轨迹面板是虚拟滚动，200 条足够铺满并预留缓冲 */
const TRACE_LIMIT = { fallback: 200, min: 1, max: 1000 };

/**
 * `Content-Disposition` 的文件名。
 *
 * 两种写法都给：`filename=` 是 ASCII 兜底（老客户端只认它），
 * `filename*=UTF-8''` 才能正确表达中文文件名（RFC 5987）。
 * 只写前者会让 `第三章.md` 变成一串乱码或被截断；
 * 只写后者会让不认识 RFC 5987 的客户端退回到 URL 末段当文件名——
 * 那是 `download`，没有扩展名。
 *
 * ASCII 兜底同时把引号和控制字符剔掉：文件名来自 template.yaml，
 * 一个带引号的文件名会把 header 提前截断，后面的参数被吞掉。
 */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerTaskReadRoutes(app: FastifyInstance, forge: ForgeApp): void {
  app.get<{ Querystring: Record<string, unknown> }>('/api/tasks', (request) => {
    const limit = optionalInt(request.query['limit'], 'limit', TASK_LIMIT.fallback, TASK_LIMIT);
    return forge.tasks.listTasks({ limit });
  });

  app.get<{ Params: TaskIdParams }>('/api/tasks/:id', (request) =>
    forge.tasks.getTaskDetail(request.params.id),
  );

  app.get<{ Params: TaskIdParams }>('/api/tasks/:id/slots', (request) =>
    forge.tasks.listSlots(request.params.id),
  );

  app.get<{ Params: SlotParams }>('/api/tasks/:id/slots/:slotId', (request) =>
    forge.tasks.getSlotDetail(request.params.id, request.params.slotId),
  );

  app.get<{ Params: TaskIdParams }>('/api/tasks/:id/executions', (request) =>
    forge.tasks.listExecutions(request.params.id),
  );

  app.get<{ Params: TaskIdParams; Querystring: Record<string, unknown> }>(
    '/api/tasks/:id/traces',
    (request) => {
      // after 的缺省是 0（= 从头），这与「没传」的语义一致；
      // 但传了个非数字必须 400，见 query.ts 的文件头
      const after = optionalInt(request.query['after'], 'after', 0, {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      const limit = optionalInt(request.query['limit'], 'limit', TRACE_LIMIT.fallback, TRACE_LIMIT);
      // 「任务不存在 → 404 而不是空页」由 listTraces 自己守住，见那里的注释
      return forge.tasks.listTraces(request.params.id, { after, limit });
    },
  );

  // 元信息端点带 content：§9.1 写的是「产物元信息 + 内容」，
  // 产物预览面板要靠它渲染正文
  app.get<{ Params: TaskIdParams }>('/api/tasks/:id/artifact', (request) =>
    forge.tasks.getArtifactOrThrow(request.params.id, { includeContent: true }),
  );

  app.get<{ Params: TaskIdParams }>(
    '/api/tasks/:id/artifact/download',
    (request, reply: FastifyReply) => {
      const artifact = forge.tasks.getArtifactOrThrow(request.params.id, { includeContent: true });
      // content 在 includeContent 下必然非 null，但类型上是 nullable：
      // 用 ?? '' 兜底而不是断言，免得将来某次改动让这里在运行时抛 TypeError
      const body = artifact.content ?? '';
      return reply
        .header('Content-Type', `${artifact.mediaType}; charset=utf-8`)
        .header('Content-Disposition', contentDisposition(artifact.fileName))
        // 刻意**不手写 Content-Length**。Fastify 会按 `Buffer.byteLength` 自己算，
        // 而手写一份只会多一处能算错的地方——最经典的错法是 `body.length`，
        // 那是 UTF-16 码元数，中文正文下比真实字节数少近三分之二，
        // 下载会在中途被截断。这里试过手写，反证测试证明它连生效都没生效
        // （Fastify 覆盖了它），于是它既没用又掩盖了一条假绿的断言。
        .send(body);
    },
  );
}
