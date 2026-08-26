/**
 * M4 数据库迁移验证（在副本上跑，绝不修改 data/ 原件）。
 *
 * data/*.sqlite 被 .gitignore，全新检出 / CI 上不存在——
 * 用 `it.skipIf(!existsSync(...))` 逐个用例按各自文件是否存在判断，
 * 缺席时优雅跳过而不是让 `npm run test` 直接炸（ENOENT）。
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyPragmas, type ForgeDb } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';

const m4Cases = [
  { file: 'm4-smoke.sqlite', slots: 7, execs: 7, tasks: 1 },
  { file: 'm4-dense.sqlite', slots: 37, execs: 37, tasks: 5 },
  { file: 'm4-measure.sqlite', slots: 120, execs: 121, tasks: 20 },
];

describe('M4 数据库迁移验证', () => {
  for (const { file, slots: expSlots, execs: expExecs, tasks: expTasks } of m4Cases) {
    const srcPath = path.resolve('data', file);
    it.skipIf(!existsSync(srcPath))(
      `${file} 迁移后行数一致、FK 无违规、新列就位、无临时表残留`,
      () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'm4-verify-'));
        const tmpPath = path.join(dir, 'copy.sqlite');
        copyFileSync(srcPath, tmpPath);

        const db = new Database(tmpPath) as ForgeDb;
        applyPragmas(db);

        const beforeSlots = (db.prepare('SELECT COUNT(*) as n FROM slots').get() as { n: number }).n;
        const beforeExecs = (db.prepare('SELECT COUNT(*) as n FROM executions').get() as { n: number }).n;
        const beforeTasks = (db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number }).n;

        expect(beforeSlots).toBe(expSlots);
        expect(beforeExecs).toBe(expExecs);
        expect(beforeTasks).toBe(expTasks);

        // 迁移前快照已有 001/002，runMigrations 只应用 003
        runMigrations(db);

        const afterSlots = (db.prepare('SELECT COUNT(*) as n FROM slots').get() as { n: number }).n;
        const afterExecs = (db.prepare('SELECT COUNT(*) as n FROM executions').get() as { n: number }).n;
        const afterTasks = (db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number }).n;

        expect(afterSlots).toBe(beforeSlots);
        expect(afterExecs).toBe(beforeExecs);
        expect(afterTasks).toBe(beforeTasks);

        // FK 无违规
        const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
        expect(fkCheck).toEqual([]);

        // 新列存在
        const slotCols = (db.prepare('PRAGMA table_info(slots)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(slotCols).toContain('revision_round');
        expect(slotCols).toContain('review_exhausted');

        // slot_reviews 表存在
        const reviewsTable = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='slot_reviews'",
        ).get();
        expect(reviewsTable).toBeDefined();

        // revision_round 全为 0
        const nonZero = (
          db.prepare('SELECT COUNT(*) as n FROM slots WHERE revision_round != 0').get() as { n: number }
        ).n;
        expect(nonZero).toBe(0);

        // 无临时表残留：重建用的 *_new 别名与 _temp_* 备份表必须全部消失。
        // 用 JS 过滤而不是 SQL LIKE——LIKE 里的下划线是通配符，字面匹配语义更明确。
        const tableNames = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((r) => r.name);
        const leftovers = tableNames.filter((n) => n.includes('_new') || n.startsWith('_temp_'));
        expect(leftovers).toEqual([]);

        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    );
  }
});
