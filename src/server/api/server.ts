import Fastify, { type FastifyInstance } from 'fastify';
import type { ForgeApp } from '@server/application/composition.ts';
import { registerErrorHandler } from './error-handler.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerTaskReadRoutes } from './routes/tasks-read.ts';
import { registerTaskWriteRoutes } from './routes/tasks-write.ts';
import { registerProviderRoutes } from './routes/providers.ts';
import { registerStreamRoute } from './routes/stream.ts';

export interface BuildServerOptions {
  /**
   * 组合根装配出的整张服务图（`buildApp`）。
   *
   * M5-A 时这里收的是裸 `db`，M5-B 改成 `ForgeApp`：路由需要的是 service，
   * 而不是数据库句柄。收 db 就意味着 api 层要自己 `buildApp` 一次，
   * 于是 CLI、测试、HTTP 服务会各拼一张图——`composition.ts` 存在的
   * 全部理由就是不让这件事发生。
   */
  forge: ForgeApp;
  /** 启动时已应用的迁移总数，用于 /api/health 自证数据库确实就绪 */
  migrationCount: number;
  logLevel?: string;
  /**
   * 关闭时强制断开仍然连着的 socket。
   *
   * 默认 false（Node 的默认行为：等空闲连接自己超时）。测试要开——
   * 一条走完的 SSE 请求之后，客户端的 keep-alive socket 还会挂约 4 秒，
   * 而 `server.close()` 会一直等它，于是每个用例的 afterEach 白等 4 秒。
   *
   * 生产没开，是因为强制断开会打断真正在途的请求。SSE 连接本身不靠它收尾——
   * 那是 `preClose` 里 `sse.close()` 的职责（见下）。
   */
  forceCloseConnections?: boolean;
}

/**
 * 构造 Fastify 实例。
 *
 * 刻意做成纯构造函数（不 listen）：集成测试可以直接 `app.inject()` 打真实路由，
 * 不需要占端口，也不需要跑真实的 HTTP 栈。
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    ...(opts.forceCloseConnections === true ? { forceCloseConnections: true } : {}),
    logger: {
      // 不在这里读 LOG_LEVEL：配置的唯一读取点是 @server/config/env.ts，
      // 由入口解析后显式传进来。api 层自己兜底会造出第二个默认值来源。
      level: opts.logLevel ?? 'info',
      // 安全约束（REQ §13）：日志不得回显凭据
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.api_key'],
        censor: '[REDACTED]',
      },
    },
  });

  /**
   * §10.6（Q-24 定案）：**后端永远只有 `/api/*`**。
   *
   * 前后端分离方案的全部约束就是这一句。但一句话拦不住任何人——
   * 在这里顺手注册一条 `/review/...`，`tsc`、`eslint`、691 条测试
   * 不会有任何一个变红，而线上的现象是「刷新页面 404」：
   * 静态托管把非 `/api` 的路径全部 fallback 到 `index.html` 了，
   * 那条后端路由根本收不到请求，看起来就是「写了没生效」。
   *
   * 所以把它变成**构造期就会炸**的断言，与分层交给 ESLint、
   * 事务回调交给 `NotPromise<T>`、`providers.yaml` 交给 `.strict()` 是同一条纪律：
   * 靠自觉的约束等于没有约束。
   *
   * 必须注册在所有路由之前——`onRoute` 只对**其后**注册的路由生效。
   */
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/') && route.url !== '/api') {
      throw new Error(
        `后端只允许注册 /api/* 路由，收到「${route.url}」。` +
          `前后端分离下非 /api 路径由静态托管处理（方案 §10.6）；` +
          `若确实要改变这个决定，先改文档再改代码。`,
      );
    }
  });

  app.get('/api/health', () => ({
    status: 'ok',
    version: '0.1.0',
    migrations: opts.migrationCount,
  }));

  registerErrorHandler(app);
  registerTemplateRoutes(app, opts.forge);
  registerTaskReadRoutes(app, opts.forge);
  registerTaskWriteRoutes(app, opts.forge);
  registerProviderRoutes(app, opts.forge);
  registerStreamRoute(app, opts.forge, opts.forge.sse);

  // 用 preClose 而不是 onClose：前者在**关闭 HTTP server 之前**跑。
  // SSE 的响应永远不会自己结束，等到 onClose 才去 end 它们，
  // `server.close()` 已经在等这些连接了——优雅关闭会挂到超时。
  // 同一个 hook 里也把心跳定时器停掉。
  app.addHook('preClose', () => {
    opts.forge.sse.close();
  });

  return app;
}
