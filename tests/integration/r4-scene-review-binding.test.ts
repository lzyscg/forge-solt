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

describe('R4：生产模板的审核绑定端到端', () => {
  it('scene 槽位跑满四条判据，各一条 slot_reviews 记录', async () => {
    const { code, reviews } = await runRealTemplate();
    const scene = reviews.filter((r) => r.slot_id === 'scene_01');

    expect(code).toBe(0);
    // 四条判据全部上线（D-28）：三、四实测 0/3 也照样跑，
    // 少一条就说明有人为了「反正测不出来」把它摘了
    expect(scene.map((r) => r.criterion_id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    // D-23：一条判据一次 execution，四条各自落一行——
    // 判据 ID 重复会让后一条覆盖前一条，这里就只剩三行
    expect(scene).toHaveLength(4);
    for (const row of scene) {
      expect(row.round).toBe(0);
      expect(row.verdict).toBe('no_finding');
    }
  });

  /*
   * R5 结构审核（reviewStructure → structure-review），审核对象是**根容器**。
   *
   * 这条用例存在的意义不只是「又绑了一条」：结构是全章的上游，它错了每一场都
   * 跟着错。而绑定失效不会报错，只会安静地退回旧行为——结构提交完直接开始填槽，
   * 没有任何 slot_reviews 行。所以断言的是「根槽位上确实有四行」，
   * 而不是「任务跑通了」（后者在没有审核时同样成立）。
   */
  it('根容器跑满结构审核的四条判据，各一条 slot_reviews 记录', async () => {
    const { reviews } = await runRealTemplate();
    const structure = reviews.filter((r) => r.slot_id === 'chapter');

    expect(structure.map((r) => r.criterion_id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(structure).toHaveLength(4);
    for (const row of structure) {
      expect(row.round).toBe(0);
      expect(row.verdict).toBe('no_finding');
    }
  });

  /*
   * title 仍然不被审（D-27：不绑定是合法默认）。
   *
   * 「默认全开意味着为没测过的槽位类型付 token 并承担未知误报」——
   * title 正属于这一类：一个 4~40 字的标题，四次模型调用去审它，
   * 代价与收益差着量级。
   */
  it('title 不被审：没有绑定的类型不许自己长出审核记录（D-27）', async () => {
    const { reviews } = await runRealTemplate();
    const reviewed = [...new Set(reviews.map((r) => r.slot_id))].sort();
    expect(reviewed).toEqual(['chapter', 'scene_01']);
  });
});
