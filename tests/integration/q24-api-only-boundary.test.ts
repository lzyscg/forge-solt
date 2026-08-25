/**
 * Q-24 定案（方案 §10.6）：部署形态为**前后端分离**，后端**永远只有 `/api/*`**。
 *
 * 命名不跟 m0..m7 的里程碑走，是因为这条不属于任何一个里程碑——
 * 它是一个业务方裁决所带来的、需要长期守住的约束。
 *
 * 这条约束原本只写在文档和注释里。文档拦不住任何人：在 `buildServer` 里
 * 顺手注册一条 `/review/...`，`tsc` / `eslint` / 全部测试都不会变红，
 * 而线上现象是「这条路由写了没生效、刷新页面 404」——因为静态托管
 * 已经把非 `/api` 的路径 fallback 到 `index.html`，请求根本到不了后端。
 *
 * 因此真正的守卫是 `server.ts` 里那个构造期就抛的 `onRoute` 钩子，
 * 本文件负责证明**那个守卫真的会响**，而不只是「现在恰好没人违规」。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

let harness: ApiHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('Q-24 后端只有 /api/*（前后端分离的唯一约束）', () => {
  it('现有全部端点都合规——构造真实服务不抛', () => {
    expect(() => {
      harness = createApiHarness();
    }).not.toThrow();
  });

  /**
   * 反证。没有这一条，上面那条「不抛」是**恒为真**的——
   * 一个从不生效的钩子同样不会抛。
   * 判据不是「测试通过」，是「改坏了会失败」（HANDOFF §3.4）。
   */
  it('注册一条非 /api 路由会当场炸，而不是悄悄生效', () => {
    harness = createApiHarness();

    expect(() => {
      harness?.server.get('/review/pending', () => ({ ok: true }));
    }).toThrow(/只允许注册 \/api\/\* 路由/);
  });

  it('容易看错的两种前缀也拦得住', () => {
    harness = createApiHarness();

    // 以 api 开头但不是 /api/ 段——`/apidocs` 会被静态托管吃掉
    expect(() => {
      harness?.server.get('/apidocs', () => ({ ok: true }));
    }).toThrow(/只允许注册/);

    // 根路由：单端口方案下这里会是 index.html，分离方案下它不该存在
    expect(() => {
      harness?.server.get('/', () => 'index');
    }).toThrow(/只允许注册/);
  });

  /**
   * 从外部再验一次同一件事。上面三条测的是「注册不进来」，
   * 这条测的是用户/运维实际会看到的东西：非 API 路径一律 404，
   * 这是**对的行为**，不是 bug——文档里写了，这里把它钉住。
   */
  it('非 /api 路径对外表现为 404（这是定案行为，不是缺陷）', async () => {
    harness = createApiHarness();

    for (const url of ['/', '/tasks', '/tasks/any-id', '/templates', '/assets/index.js']) {
      const res = await harness.server.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} 应当 404`).toBe(404);
    }

    // 对照：/api/* 确实还活着，否则上面的 404 可能只是服务整个没起来
    const health = await harness.server.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});
