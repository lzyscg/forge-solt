/**
 * `cli/dump-trace.ts`（文档 §12.2 M4 产出）。
 *
 * 被测的不是「能不能打印」——那个看一眼就知道。被测的是三件会**悄悄骗人**的事：
 * 筛选与 limit 的先后次序、脱敏承诺、以及找不到任务时的退出码。
 *
 * 夹具走真实 CLI 跑一遍 `--provider fake`，而不是手插几条 trace：
 * 手插的数据形状由测试自己决定，于是它永远符合测试的预期。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTask } from '@server/cli/run-task.ts';
import { dumpTrace } from '@server/cli/dump-trace.ts';
import { TRACE_FILTER_GROUPS } from '@shared/trace.ts';

let dbPath: string;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-dump-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const packet = path.join(dir, 'packet.txt');
  writeFileSync(packet, '主角在雨夜与债主对峙，本章需完成摊牌。', 'utf8');
  dbPath = path.join(dir, 'run.sqlite');
  const code = await runTask([
    '--template', 'zhihu-chapter',
    '--input-file', packet,
    '--provider', 'fake',
    '--db', dbPath,
  ]);
  expect(code).toBe(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 捕获 stdout，返回打印出来的整段文本 */
function capture(argv: readonly string[]): { code: number; out: string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const code = dumpTrace(argv);
  return { code, out };
}

describe('cli/dump-trace.ts', () => {
  it('--latest 打印最近一个任务的时间线', () => {
    const { code, out } = capture(['--db', dbPath, '--latest']);
    expect(code).toBe(0);
    expect(out).toContain('status=completed');
    expect(out).toContain('assignment_submitted');
    expect(out).toContain('artifact_created');
  });

  /**
   * 这一条是本文件真正的理由。仓储的 `limit` 作用在筛选**之前**，
   * 所以「先取 limit 条再按 group 筛」会产出一份看起来完全正常、
   * 实际漏掉了后半个任务的时间线——排查时照着它得出的结论全是错的。
   */
  it('筛选发生在 limit 之前：--group X --limit N 给的是 N 条 X，不是「前 N 条里的 X」', () => {
    const { out } = capture(['--db', dbPath, '--latest', '--group', 'system', '--limit', '5']);

    // 事件行形如 `  12 2026-…Z 60a32e03 [system] assignment_created`
    const kinds = [...out.matchAll(/^\s*\d+ \S+ .{0,8} \[\w+\] (\w+)$/gm)].map((m) => m[1]);
    const systemKinds = new Set<string>(TRACE_FILTER_GROUPS.system);

    // 先取 5 条再筛的实现会少于 5 条——那份输出看起来完全正常，只是短一截
    expect(kinds).toHaveLength(5);
    for (const kind of kinds) expect(systemKinds, `${kind} 不属于 system 分组`).toContain(kind);
  });

  it('--limit 截断时明说还剩多少条，不假装打完了', () => {
    const { out } = capture(['--db', dbPath, '--latest', '--limit', '3']);
    expect(out).toMatch(/还有 \d+ 条被 --limit 截断/);
  });

  /**
   * REQ §13。这里断言的是**结果**而不是 dump-trace 的实现：
   * 密钥进不了输出，是因为写入侧的黑名单让它进不了库。
   * 若哪天有人在读取侧加一层过滤把脏数据挡住，这条依然绿——所以它同时
   * 依赖 `shared/trace.ts` 那组写入期用例，两者缺一不可。
   */
  it('输出里没有 Authorization / apiKey / 隐藏推理', () => {
    const { out } = capture(['--db', dbPath, '--latest', '--payload']);
    for (const needle of ['Authorization', 'apiKey', 'api_key', 'reasoning_content', 'sk-']) {
      expect(out, `输出里出现了 ${needle}`).not.toContain(needle);
    }
  });

  it('任务不存在 → 退出码 1，且说清楚是哪个 id', () => {
    const { code, out } = capture(['--db', dbPath, '--task', 'no-such-task']);
    expect(code).toBe(1);
    expect(out).toContain('no-such-task');
  });

  it('缺参数与非法 --group 都报用法，不抛看不懂的错', () => {
    expect(() => dumpTrace(['--db', dbPath])).toThrow(/用法/);
    expect(() => dumpTrace(['--db', dbPath, '--latest', '--group', 'nope'])).toThrow(/--group 只能是/);
    expect(() => dumpTrace(['--db', dbPath, '--latest', '--limit', 'x'])).toThrow(/正整数/);
  });
});
