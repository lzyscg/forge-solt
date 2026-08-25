/**
 * HTTP 层的集成测试夹具。
 *
 * 在 `createEngineHarness` 之上再套一层真实的 Fastify（`buildServer`），
 * 用 `app.inject()` 打路由——不占端口，但走的是完整的路由匹配、
 * 序列化与 `setErrorHandler`。
 *
 * 替身仍然只有两个（内存库 + FakeProvider），与 engine 夹具一致。
 * 尤其是**不 mock service**：M5 的完成判据是「§9.1 全部端点有 inject 测试」，
 * 而对着一个假 TaskService 打路由，验的是转发有没有拼错字段名，
 * 不是端点能不能真的把库里的数据取出来。
 */

import type { FastifyInstance } from 'fastify';
import { buildServer } from '@server/api/server.ts';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './engine.ts';

export interface ApiHarness extends EngineHarness {
  /** 整张服务图。测试用它直接造数据（建任务、跑引擎），再用 HTTP 读回来 */
  forge: EngineHarness;
  server: FastifyInstance;
  close(): Promise<void>;
}

export function createApiHarness(options: EngineHarnessOptions = {}): ApiHarness {
  const forge = createEngineHarness(options);
  const server = buildServer({
    forge,
    migrationCount: forge.migrationCount,
    // silent：错误映射测试会故意打出 500，pino 的默认输出会把测试日志淹掉。
    // 需要断言日志内容的用例自己建实例（见 m5-error-mapping.test.ts）
    logLevel: 'silent',
    // 见 BuildServerOptions 里的说明：不开的话，每个用过真 HTTP 的用例
    // 都要在 afterEach 里白等一次 keep-alive 超时（约 4 秒）
    forceCloseConnections: true,
  });

  return {
    ...forge,
    forge,
    server,
    async close() {
      await server.close();
      forge.close();
    },
  };
}
