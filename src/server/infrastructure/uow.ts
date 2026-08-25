/**
 * Unit of Work。
 *
 * 权威来源：《Forge Core vNext 可执行技术实现方案 V1.0》§5.4、§5.5、D-10。
 *
 * 存在的理由（TECH-V0.1 §8）：Application 层不得手工跨多个独立 Repository 拼接事务。
 * §5.5 列出的 8 个用例（创建 Task / 创建 Assignment / 提交 Structure / 提交 Slot Content /
 * Stop / 完成 Artifact / 重置失败 Slot / 启动恢复）每一个都要跨 3~5 张表原子写入，
 * 由本模块提供唯一的事务入口。
 *
 * ## 为什么事务体内绝对不能出现 await
 *
 * 这是选用同步驱动 better-sqlite3 的**全部理由**（D-15：「同步 API 是 D-10 的前提，
 * 非性能考虑」）。D-10 把 Execution Token 的校验条件下推进 UPDATE 的 WHERE 子句，
 * 用受影响行数判断成败；这套机制成立的前提是「读-判-写」之间没有任何调度点。
 * 回调一旦是 async，函数会在第一个 await 处交还事件循环，
 * better-sqlite3 的事务不跨微任务，事务会先于回调体完成而提交——
 * 此时 stop 请求的事务完全可以插进来，D-10 的原子性保证全部失效。
 *
 * 因此这条约定不是 code review 的软要求，而是写进类型的硬约束：
 * `NotPromise<T>` 使 `run(async (uow) => ...)` 在编译期即被拒绝。
 *
 * ## Trace 的两段式
 *
 * §5.5 规定 trace 写入在事务内（否则事务回滚后 UI 会显示一个没发生的事件），
 * 但 SSE 推送必须在事务**提交之后**。所以调用方的形态永远是：
 * 事务内 `uow.traces.insert(...)` → `run()` 返回 → 事务外 `sseHub.publish(...)`。
 * 不要在回调里推 SSE。
 *
 * ## 关于 Repository
 *
 * `createUnitOfWork` 对仓储集合保持泛型，M2 在其上收敛出具体的 `UnitOfWork`
 * （见文件末尾的 `createUow`）。保留泛型而不是把 `Repositories` 焊死在签名里，
 * 是为了让测试能塞一组假仓储验证事务语义本身，而不必先造六个真表。
 *
 * 所有仓储共享同一个 `db` 句柄——这是事务能覆盖多个仓储调用的前提，
 * 每个仓储各开一个连接会让 `run()` 退化成若干个独立事务。
 */

import type { ForgeDb, NotPromise } from './database/db.ts';
import type { Clock, Repositories } from './database/repositories/index.ts';
import { buildRepositories } from './database/repositories/index.ts';

/**
 * 事务执行器。
 *
 * `fn` 必须是**同步**函数：返回类型被 `NotPromise` 约束，
 * 传入 `async` 回调时 TypeScript 会把返回类型解析为 `never` 并报错。
 */
export type UowRunner<TRepositories> = <T>(fn: (uow: TRepositories) => NotPromise<T>) => T;

export interface UnitOfWorkHandle<TRepositories> {
  /** 仓储集合，全部持有同一个 db 句柄。 */
  readonly repositories: TRepositories;
  /** 在单个 SQLite 事务内执行同步回调；抛异常则整体回滚。 */
  readonly run: UowRunner<TRepositories>;
}

/**
 * 用给定的仓储工厂构造一个 Unit of Work。
 *
 * @param db      进程内唯一的数据库句柄
 * @param build   仓储工厂；必须把同一个 `db` 交给所有仓储
 */
export function createUnitOfWork<TRepositories extends object>(
  db: ForgeDb,
  build: (db: ForgeDb) => TRepositories,
): UnitOfWorkHandle<TRepositories> {
  const repositories = build(db);
  return { repositories, run: createUowRunner(db, repositories) };
}

/**
 * §5.4 的 `createUowRunner`：把仓储集合绑定到一个事务执行器上。
 */
export function createUowRunner<TRepositories extends object>(
  db: ForgeDb,
  repositories: TRepositories,
): UowRunner<TRepositories> {
  return function run<T>(fn: (uow: TRepositories) => NotPromise<T>): T {
    // better-sqlite3 的 transaction 是同步的：fn 内不得有 await（见文件头说明）。
    return db.transaction(fn)(repositories) as T;
  };
}

/**
 * 不需要仓储集合时的裸事务入口（例如启动期的 schema 维护、一次性脚本）。
 * 同样禁止异步回调。
 */
export function runInTransaction<T>(db: ForgeDb, fn: (db: ForgeDb) => NotPromise<T>): T {
  return db.transaction(fn)(db) as T;
}

// ---------------------------------------------------------------------------
// §5.4 的具体 UnitOfWork
// ---------------------------------------------------------------------------

/**
 * §5.4 逐字列出的六个仓储。
 *
 * 这是 Application 层唯一该认识的持久化面：它不该知道有几张表、
 * 更不该知道 D-10 的条件 UPDATE 长什么样——那条 SQL 的正确性由 SlotRepo 独自负责，
 * 一旦泄漏到编排层，就会有第二个地方尝试「自己判断一下 execution 还新鲜吗」。
 */
export type UnitOfWork = Repositories;

/** 便捷入口：`const { run } = createUow(db); run(uow => { ... })`。 */
export function createUow(db: ForgeDb, clock?: Clock): UnitOfWorkHandle<UnitOfWork> {
  return createUnitOfWork(db, (handle) => buildRepositories(handle, clock));
}
