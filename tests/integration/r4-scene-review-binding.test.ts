/**
 * R4：仓库里那份**生产模板**（`templates/zhihu-chapter`）与那份**生产审核 Skill**
 * （`skills/scene-review/SKILL.md`）接上之后，审核确实在跑。
 *
 * 为什么不用夹具：R4 唯一的改动就落在这两份真文件上。用 `tests/fixtures` 里的
 * `review-chapter` + 两判据夹具去测，测到的是 R2 已经证明过的引擎，
 * 而「生产模板绑没绑上、四条判据是不是四条」一个字都没验到。
 *
 * 走 CLI（`--provider fake`）而不是直接调 application 层：CLI 是唯一一条
 * 不经 UI、不经 HTTP 的端到端路径，它跑通说明接线（composition root）也是通的。
 * 全程无网络——FakeProvider 按脚本回，四条判据一律回 no_finding。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runTask } from '@server/cli/run-task.ts';
import { openDatabase } from '@server/infrastructure/database/db.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface ReviewRow {
  slot_id: string;
  round: number;
  criterion_id: string;
  verdict: string;
}

async function runRealTemplate(): Promise<{ code: number; reviews: ReviewRow[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-r4-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const packet = path.join(dir, 'packet.txt');
  writeFileSync(packet, '主角在雨夜与债主对峙，本章需完成摊牌。', 'utf8');
  const dbPath = path.join(dir, 'run.sqlite');

  const code = await runTask([
    '--template', 'zhihu-chapter',
    '--input-file', packet,
    '--provider', 'fake',
    '--db', dbPath,
    '--templates-dir', path.join(REPO_ROOT, 'templates'),
    '--skills-dir', path.join(REPO_ROOT, 'skills'),
    '--provider-config', path.join(REPO_ROOT, 'config', 'providers.yaml'),
  ]);

  const db = openDatabase(dbPath);
  cleanups.push(() => { db.close(); });
  const reviews = db
    .prepare('SELECT slot_id, round, criterion_id, verdict FROM slot_reviews ORDER BY slot_id, round, criterion_id')
    .all() as ReviewRow[];
  return { code, reviews };
}

describe('R4：生产模板的 scene 审核绑定端到端', () => {
  it('scene 槽位跑满四条判据，各一条 slot_reviews 记录', async () => {
    const { code, reviews } = await runRealTemplate();

    expect(code).toBe(0);
    // 四条判据全部上线（D-28）：三、四实测 0/3 也照样跑，
    // 少一条就说明有人为了「反正测不出来」把它摘了
    expect(reviews.map((r) => r.criterion_id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    // D-23：一条判据一次 execution，四条各自落一行——
    // 判据 ID 重复会让后一条覆盖前一条，这里就只剩三行
    expect(reviews).toHaveLength(4);
    for (const row of reviews) {
      expect(row.slot_id).toBe('scene_01');
      expect(row.round).toBe(0);
      expect(row.verdict).toBe('no_finding');
    }
  });

  it('只有 scene 被审：outline 与 title 没有任何审核记录（D-27）', async () => {
    const { reviews } = await runRealTemplate();
    // 「默认全开」意味着为 R0.5 没测过的槽位类型付 token 并承担未知误报
    expect(reviews.filter((r) => r.slot_id !== 'scene_01')).toEqual([]);
  });
});
