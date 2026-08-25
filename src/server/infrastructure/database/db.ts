/**
 * SQLite 连接、PRAGMA 与事务封装。
 *
 * 权威来源：《Forge Core vNext 可执行技术实现方案 V1.0》§5.1、D-10、D-15。
 *
 * 驱动选型是 better-sqlite3，**理由不是性能而是同步语义**（D-10 / D-15）：
 * 只有同步驱动才能保证 `db.transaction(() => { ... })` 块内不存在 await 点，
 * 从而物理上杜绝「stop 事务插进读-判-写窗口」的交错。
 * 本文件所有事务封装的类型签名都拒绝返回 Promise 的回调，见 `NotPromise`。
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
// migrate.ts 反向 import 本文件的 openDatabase/applyPragmas。ESM 的循环导入在
// 「两个模块顶层都只声明函数、不执行副作用」的前提下是安全的。
import { runMigrations } from './migrate.ts';

/** 全库统一的数据库句柄类型别名，避免各层到处写 `Database.Database`。 */
export type ForgeDb = Database.Database;

/** 默认数据库文件路径（可由 DATABASE_PATH 覆盖，见 .env.example）。 */
export const DEFAULT_DATABASE_PATH = './data/forge-core.sqlite';

/**
 * 编译期拒绝异步回调。
 *
 * D-10：事务回调一旦是 async，函数会在第一个 await 点把控制权交还事件循环，
 * better-sqlite3 的事务不跨微任务，事务会先于回调完成而提交，
 * 「token 校验压进 UPDATE WHERE 子句」的原子性保证随之失效。
 * 因此把「不得返回 Promise」写进类型，而不是只写进 code review checklist。
 */
export type NotPromise<T> = T extends Promise<unknown> ? never : T;

/**
 * SQLite 的内存库不是路径，是**哨兵值**。
 *
 * `:memory:` 与 `file:...?mode=memory` 都由 SQLite 自己解释，
 * 一旦被 `path.resolve` 拼成绝对路径就变成了一个普通文件名——
 * 而 better-sqlite3 会老老实实在磁盘上建出那个文件来。
 */
function isMemorySentinel(raw: string): boolean {
  return raw === ':memory:' || raw.startsWith('file:');
}

/**
 * 解析数据库文件路径。缺省 `./data/forge-core.sqlite`，相对路径相对于进程工作目录解析。
 *
 * **本函数不读 `process.env`**（自统一配置起）。配置的唯一读取点是
 * `@server/config/env.ts`，由入口解析后把 `config.databasePath` 显式传进来。
 * infrastructure 自己去读环境变量会造出第二个默认值来源：
 * 入口用新值、这里用旧值，两条路径连到不同的库，且没有任何报错。
 *
 * **内存哨兵原样返回**。这一条是 M5 发现的真 bug 的修复：原实现无条件
 * `resolve(cwd, ':memory:')`，把哨兵变成了 `<repo>/:memory:` 这个**真实文件**。
 * 更麻烦的是下游那句 `dbPath.includes(':memory:')` 对解析后的绝对路径
 * **依然为真**，于是「跳过建目录」的分支照常命中——代码看起来完全正确，
 * 实际上每一个声称用内存库的测试都在往仓库根目录写同一个文件，
 * 互相看得见对方的数据。发现它靠的是 `git status` 里多出来一个 18MB 的 `:memory:`，
 * 而不是任何一条失败的测试：这类 bug 不会让测试变红，只会让测试**失去隔离**。
 */
export function resolveDatabasePath(explicitPath?: string): string {
  const raw = explicitPath ?? DEFAULT_DATABASE_PATH;
  if (isMemorySentinel(raw)) return raw;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * 打开数据库连接：建目录 → 开连接 → 设 PRAGMA。
 *
 * 本函数**不执行迁移**（迁移由 `runMigrations` 负责，通常在 main.ts 启动时调用，
 * 或 `getDatabase()` 帮你连带执行）。这样 migrate.ts 可以复用连接逻辑而不产生循环依赖。
 */
export function openDatabase(path?: string): ForgeDb {
  const dbPath = resolveDatabasePath(path);
  // 内存库没有目录可建。判据用 `isMemorySentinel` 而不是 `includes(':memory:')`——
  // 后者对 `<repo>/:memory:` 这种被误解析出来的**真实路径**也为真，
  // 于是它既挡不住误解析，又让误解析看起来是被正确处理过的。
  if (!isMemorySentinel(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  applyPragmas(db);
  return db;
}

/**
 * §5.1 的 PRAGMA 组合。
 *
 * - `journal_mode = WAL`  读不阻塞写
 * - `synchronous = FULL`  REQ NFR-002「每个 Slot 完成后立即持久化」：
 *                          一次 fsync（约 1ms）相对于一次 Provider 调用（数十秒）可忽略，
 *                          换来断电不丢已完成槽位。刻意不用 NORMAL。
 * - `foreign_keys = ON`   SQLite 默认关闭外键，必须显式打开，否则 §5.2 的 REFERENCES 是装饰
 * - `busy_timeout = 5000` 单进程仍有 WAL checkpoint 与 CLI 并发访问的可能
 */
export function applyPragmas(db: ForgeDb): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/**
 * 同步事务封装。回调内**绝对不允许出现 await**——签名已在编译期拦下 async 回调。
 *
 * 用法：`transaction(db, () => { ...同步写...; return result; })`
 */
export function transaction<T>(db: ForgeDb, fn: () => NotPromise<T>): T {
  return db.transaction(fn)() as T;
}

// ---------------------------------------------------------------------------
// 进程级单例：给不需要自己管理连接生命周期的调用方使用
// ---------------------------------------------------------------------------

let singleton: ForgeDb | null = null;

/**
 * 取进程级数据库句柄；首次调用时打开连接并**自动执行迁移**（约束 4：启动时自动执行）。
 *
 * main.ts 若要显式控制启动顺序，也可以自己 `openDatabase()` + `runMigrations()`，
 * 两条路径等价。
 */
export function getDatabase(path?: string): ForgeDb {
  if (singleton === null) {
    const db = openDatabase(path);
    runMigrations(db);
    singleton = db;
  }
  return singleton;
}

/** 关闭并清空单例（测试与优雅退出使用）。 */
export function closeDatabase(): void {
  if (singleton !== null) {
    singleton.close();
    singleton = null;
  }
}
