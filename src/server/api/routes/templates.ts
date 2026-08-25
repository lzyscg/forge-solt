/**
 * 模板只读端点（§9.1 前三行）。
 *
 * ```
 * GET  /api/templates             模板列表（含 runCount 与加载失败项）
 * GET  /api/templates/:id         模板详情
 * GET  /api/templates/:id/tasks   引用该模板的任务
 * POST /api/templates/:id/reload  开发期热重载
 * ```
 *
 * 本文件是「薄转发」的字面意思：取参数 → 调 service → 返回。
 * 没有 try/catch——`ForgeError` 一路冒泡到 `registerErrorHandler`，
 * 状态码与 action 文案由那一处统一决定（§9.3）。在这里就地 catch 再包一层，
 * 等于让每条路由各自决定 `TEMPLATE_NOT_FOUND` 该回几，那正是 §9.3 要消灭的东西。
 */

import type { FastifyInstance } from 'fastify';
import type { ForgeApp } from '@server/application/composition.ts';

interface TemplateIdParams {
  id: string;
}

export function registerTemplateRoutes(app: FastifyInstance, forge: ForgeApp): void {
  app.get('/api/templates', () => forge.templates.list());

  app.get<{ Params: TemplateIdParams }>('/api/templates/:id', (request) =>
    forge.templates.get(request.params.id),
  );

  app.get<{ Params: TemplateIdParams }>('/api/templates/:id/tasks', (request) =>
    forge.templates.listTasks(request.params.id),
  );

  /**
   * 开发期热重载（REQ §21）。
   *
   * **整个目录重扫，不是只重扫 `:id` 那一个。** TemplateCatalog 只有全量
   * `reload()`（见那里的注释：增量缓存要处理的边界情况与收益完全不成比例），
   * 所以路径参数在这里的作用是「重载完之后把这一个的详情返回给你」，
   * 而不是「只重载这一个」。返回详情是刻意的：改完 YAML 点重载，
   * 用户想看的就是「我改的东西生效了没有」，让他再点一次详情属于多余的一步。
   *
   * 重载**不影响任何已存在的任务**——它们读的是自己的冻结快照（AC-002），
   * 磁盘上的模板改成什么样都与它们无关。
   */
  app.post<{ Params: TemplateIdParams }>('/api/templates/:id/reload', async (request) => {
    await forge.catalog.reload();
    // 重载后这个 ID 可能已经不存在了（文件被删/改名/改坏），
    // 那时 `get` 会抛 TEMPLATE_NOT_FOUND——这正是要告诉用户的事
    return forge.templates.get(request.params.id);
  });
}
