/**
 * 迁移执行器。
 *
 * 语义：
 * - **幂等**：已应用过的迁移不会重复执行，重复运行必须成功返回。
 * - **有序**：按文件名字典序执行（`001_` / `002_` 前缀因此是有意义的）。
 * - **单文件单事务**：每个 .sql 文件在一个事务内执行，失败整体回滚，
 *   不存在「半个 schema」的中间状态。
 * - **漂移检测**：记录每个文件的 sha256；已应用文件内容被改动时直接报错，
 *   而不是静默跳过——静默跳过会让本地库与 DDL 悄悄失配。
 *
 * 直接运行：`npm run migrate`（= `tsx src/server/infrastructure/database/migrate.ts`）。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeDb } from './db.ts';
import { openDatabase, resolveDatabasePath } from './db.ts';
import { loadServerConfig } from '@server/config/env.ts';

/** 迁移目录默认位于仓库根的 `migrations/`（相对进程工作目录）。 */
export const DEFAULT_MIGRATIONS_DIR = './migrations';

export interface MigrationResult {
  /** 本次真正执行的迁移文件名（按执行顺序）。 */
  applied: string[];
  /** 执行后 schema_migrations 中的总条数。 */
  total: number;
}

interface AppliedRow {
  name: string;
  checksum: string;
}

interface CountRow {
  n: number;
}

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 在给定连接上执行所有未应用的迁移。
 *
 * 回调内全同步——与 D-10 同源的约束：迁移事务内出现 await 同样会让事务提前提交。
 */
export function runMigrations(db: ForgeDb, migrationsDir?: string): MigrationResult {
  const dir = resolve(process.cwd(), migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  db.exec(CREATE_LEDGER_SQL);

  const appliedRows = db.prepare('SELECT name, checksum FROM schema_migrations').all() as AppliedRow[];
  const applied = new Map<string, string>(appliedRows.map((row) => [row.name, row.checksum]));

  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
  );

  const executed: string[] = [];

  for (const name of listMigrationFiles(dir)) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const checksum = sha256Hex(sql);
    const previous = applied.get(name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `迁移 ${name} 的内容在应用之后被修改（记录 ${previous.slice(0, 12)}，当前 ${checksum.slice(0, 12)}）。` +
            '已应用的迁移不可编辑，请新增一个迁移文件。',
        );
      }
      continue; // 幂等：已应用且未漂移，跳过
    }

    // 单个迁移文件 = 单个事务，失败整体回滚。
    db.transaction(() => {
      db.exec(sql);
      insert.run(name, checksum, new Date().toISOString());
    })();

    executed.push(name);
  }

  const countRow = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as CountRow | undefined;

  return { applied: executed, total: countRow?.n ?? 0 };
}

/** CLI 入口：打开（必要时创建）数据库并执行迁移。 */
function main(): void {
  // 走统一配置，而不是自己读 DATABASE_PATH——否则 `npm run migrate`
  // 迁移的可能不是服务实际连的那个库，而两边都不会报错。
  const dbPath = resolveDatabasePath(loadServerConfig().databasePath);
  const db = openDatabase(dbPath);
  try {
    const result = runMigrations(db);
    const summary =
      result.applied.length === 0
        ? '无待执行迁移（已是最新）'
        : `已执行 ${result.applied.length} 个迁移：${result.applied.join(', ')}`;
    process.stdout.write(`[migrate] ${dbPath}\n[migrate] ${summary}\n[migrate] 累计迁移数：${result.total}\n`);
  } finally {
    db.close();
  }
}

// 仅在被直接运行时执行（被 import 时不产生副作用）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
