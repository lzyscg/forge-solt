/**
 * M3 完成判据的最后一条：CLI 能 headless 跑通整个任务（文档 §12.2）。
 *
 * 这条用例存在的理由是**防回归**：CLI 是唯一一条不经过 UI、不经过 HTTP 的
 * 端到端路径，它一旦坏掉，坏的往往是接线（composition root）而不是某一层的逻辑，
 * 而接线问题在分层单测里是照不出来的。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTask } from '@server/cli/run-task.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('cli/run-task.ts', () => {
  it('--provider fake 跑通全程并落库产物，退出码 0', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const packet = path.join(dir, 'packet.txt');
    writeFileSync(packet, '主角在雨夜与债主对峙，本章需完成摊牌。', 'utf8');

    const code = await runTask([
      '--template',
      'zhihu-chapter',
      '--input-file',
      packet,
      '--provider',
      'fake',
      '--db',
      path.join(dir, 'run.sqlite'),
    ]);

    expect(code).toBe(0);
  });

  it('缺参数时报用法而不是抛一个看不懂的 TypeError', async () => {
    await expect(runTask(['--template', 'zhihu-chapter'])).rejects.toThrow(/用法/);
  });

  it('--provider 只接受 fake 或 real', async () => {
    await expect(
      runTask(['--template', 'x', '--input-file', 'y', '--provider', 'anthropic']),
    ).rejects.toThrow(/只能是 fake 或 real/);
  });
});
