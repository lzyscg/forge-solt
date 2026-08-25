/**
 * Provider 端点（D-03 / §9.1 后三行）。
 *
 * ```
 * GET  /api/providers            Provider + 健康 + 别名映射 + 执行默认值
 * POST /api/providers/:id/probe  主动探测
 * GET  /api/providers/defaults   执行默认值
 * ```
 *
 * 路由顺序注意：`/api/providers/defaults` 必须**不与** `/api/providers/:id` 冲突。
 * 这里没有 `GET /api/providers/:id`，所以不存在歧义；将来若要加，
 * Fastify 的 find-my-way 会让静态段优先于参数段，但那是实现细节，
 * 别指望它——真要加就把 defaults 挪到 `/api/providers/-/defaults` 之类的位置。
 */

import type { FastifyInstance } from 'fastify';
import type { ForgeApp } from '@server/application/composition.ts';

interface ProviderIdParams {
  id: string;
}

export function registerProviderRoutes(app: FastifyInstance, forge: ForgeApp): void {
  app.get('/api/providers', () => forge.providers.list());

  app.get('/api/providers/defaults', () => forge.providers.defaults());

  /**
   * 主动探测。**超时由本路由负责**。
   *
   * 这里原先写着「adapter 自己带超时，不用管」——那是错的，而且错得很安静。
   * 按 §8.2，超时是 `AssignmentRunner` 在**外面**用 `setTimeout` + `AbortController`
   * 套上去的；adapter 自己没有任何计时器，`OpenAiCompatibleAdapter.probe`
   * 就是一个裸 fetch。而 `ProviderRegistry.probe` 在 signal 缺省时传的是
   * `new AbortController().signal`——一个永远不会 abort 的信号。
   *
   * 后果：`baseUrl` 指向一台「接受连接但不回响应」的主机时（配错端口、
   * 代理黑洞、对端半死），点一次「测试连接」要挂到 undici 的
   * headersTimeout（默认 300 秒）才返回，而客户端关掉页面也取消不了它。
   *
   * 超时值取 `defaults.timeoutMs`：探测与真实调用用同一个数，
   * 才不会出现「探测说超时了，实际调用其实还能跑」这种自相矛盾的结论。
   */
  app.post<{ Params: ProviderIdParams }>('/api/providers/:id/probe', async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, forge.providers.defaults().timeoutMs);
    // 用户关掉页面就没必要接着探了——那次 fetch 会一直占着连接
    request.raw.on('close', () => {
      controller.abort();
    });
    try {
      return await forge.providers.probe(request.params.id, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}
