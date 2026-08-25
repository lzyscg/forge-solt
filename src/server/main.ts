import { openDatabase } from './infrastructure/database/db.ts';
import { runMigrations } from './infrastructure/database/migrate.ts';
import { buildApp } from './application/composition.ts';
import { loadProviderConfig } from './application/provider-config.ts';
import { buildServer } from './api/server.ts';
import { setInternalErrorSink } from './application/runtime-ports.ts';

const PORT = Number(process.env['PORT'] ?? 3311);
const HOST = process.env['HOST'] ?? '127.0.0.1';
/** Q-23：收尾时等待在跑任务收敛的上界，超时不阻塞 flush/关库 */
const DRAIN_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const db = openDatabase();

  // 迁移在服务起来之前跑完。宁可启动失败，也不要让一个 schema 不确定的
  // 进程开始接管任务生命周期。
  const { applied, total } = runMigrations(db);
  if (applied.length > 0) {
    console.log(`[migrate] 已应用 ${applied.length} 个迁移: ${applied.join(', ')}`);
  }

  // providers.yaml 读不出来就不启动：别名解析不了的话，任何任务一跑就失败，
  // 而那时的报错指向运行期而不是这行配置（D-19 的同一条纪律）。
  const providers = await loadProviderConfig();
  const forge = buildApp({
    db,
    providers,
    templatesDir: process.env['TEMPLATES_DIR'] ?? './templates',
    skillsDir: process.env['SKILLS_DIR'] ?? './skills',
  });

  /**
   * §8.6：**必须在 HTTP 开始监听之前**。
   *
   * 上一次进程被 kill -9 时，库里会留下 `status='running'` 但没有任何东西在推的任务。
   * 恢复要在开门之前做完，否则窗口期内进来的请求会看到一批「正在运行」的任务，
   * 而它们一个字都不会再动——用户能看到的唯一现象是进度条永远停在那里。
   *
   * REQ FR-LIFE-003 明确 P0 **不自动恢复模型调用**：这里只把它们落到 stopped，
   * 等用户按「继续」。自动续跑会把「进程为什么会挂」藏起来——
   * 若崩溃是某个特定槽位触发的，自动恢复就是崩溃—恢复—再崩溃的循环。
   */
  const recovery = forge.lifecycle.recoverOnStartup();
  if (recovery.recovered.length > 0 || recovery.orphans > 0) {
    console.log(
      `[recover] ${String(recovery.recovered.length)} 个任务已置为「已停止」，` +
        `${String(recovery.orphans)} 条孤儿执行已取消`,
    );
  }

  const app = buildServer({ forge, migrationCount: total });

  // Q-21：内部错误（非 ForgeError）走 pino（带 redact/结构），不再裸 console.error。
  setInternalErrorSink((error) => {
    app.log.error({ internal: true, err: error }, '内部错误（已脱敏配置生效）');
  });

  /**
   * §8.6 / Q-23 收尾顺序：
   *  1. `app.close()` 停 HTTP 与 SSE（preClose 里 sse.close()）；
   *  2. 有界等待 `engine.drain()`，让在跑任务的本轮收敛，超时不阻塞；
   *  3. `traces.flushAll()` 把缓冲里未满 1024 字符的正文落库（它是那段正文唯一的持久化副本）；
   *  4. 关库、退出。
   */
  const shutdown = (signal: string) => {
    void (async () => {
      app.log.info({ signal }, '正在关闭');
      await app.close();
      await withTimeout(forge.engine.drain(), DRAIN_TIMEOUT_MS).catch((err) => {
        app.log.warn({ err }, 'drain 超时或失败，继续收尾');
      });
      forge.traces.flushAll();
      db.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`drain 超时（${String(ms)}ms）`)), ms);
    }),
  ]);
}

main().catch((err: unknown) => {
  console.error('启动失败', err);
  process.exit(1);
});
