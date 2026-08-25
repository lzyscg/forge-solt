/**
 * 内存库哨兵不得被当成路径解析。
 *
 * 这条回归用例存在的理由，比它测的东西本身更值得记：
 * **原来的 bug 不会让任何测试变红。** `resolveDatabasePath(':memory:')` 把哨兵
 * 解析成了 `<repo>/:memory:` 这个真实文件，于是每一个声称「用内存库」的测试
 * 其实都在往仓库根目录写同一个文件，彼此看得见对方的数据。
 * 测试照样全绿——它们只是**失去了隔离**，而隔离的丧失要等到两条用例
 * 真的撞在一起时才会以「莫名其妙的偶发失败」的形式浮现。
 *
 * 它是靠 `git status` 里多出来一个 18MB 的 `:memory:` 被发现的。
 * 所以这里断言的是**文件系统的可观察结果**，不是函数的返回值：
 * 只断言返回值的话，将来有人在下游重新引入一次 resolve，这条依然绿。
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, resolveDatabasePath } from '@server/infrastructure/database/db.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('resolveDatabasePath', () => {
  it(':memory: 原样返回，不拼成绝对路径', () => {
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
  });

  it('file: URI 形式的内存库同样原样返回', () => {
    const uri = 'file:test-shared?mode=memory&cache=shared';
    expect(resolveDatabasePath(uri)).toBe(uri);
  });

  it('普通相对路径仍然照常解析成绝对路径', () => {
    const resolved = resolveDatabasePath('./data/forge-core.sqlite');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join('data', 'forge-core.sqlite'))).toBe(true);
  });
});

describe('openDatabase(":memory:")', () => {
  it('开库并建表也不在工作目录留下任何文件', () => {
    // 换到一个空的临时目录再开库：在仓库根目录跑的话，
    // 「没有新增文件」会被一堆既有文件淹没，断言不出东西
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-mem-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cwd = process.cwd();
    process.chdir(dir);
    cleanups.push(() => process.chdir(cwd));

    const before = readdirSync(dir);
    const db = openDatabase(':memory:');
    cleanups.push(() => db.close());

    // 建了表、写得进数据——确认它真的是个能用的库，不是空壳
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.prepare('INSERT INTO probe VALUES (1)').run();
    expect((db.prepare('SELECT COUNT(*) c FROM probe').get() as { c: number }).c).toBe(1);

    // 而磁盘上什么都没多出来
    expect(readdirSync(dir)).toEqual(before);
    expect(existsSync(path.join(dir, ':memory:'))).toBe(false);
  });

  it('两个内存库互不可见（隔离没丢）', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    cleanups.push(() => a.close());
    cleanups.push(() => b.close());

    a.exec('CREATE TABLE only_in_a (x INTEGER)');
    // 共享同一个磁盘文件的话，b 会看得见 a 建的表——那正是 bug 当时的行为
    expect(() => b.prepare('SELECT * FROM only_in_a').get()).toThrow(/no such table/);
  });
});
