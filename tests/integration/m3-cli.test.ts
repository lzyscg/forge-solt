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
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runTask } from '@server/cli/run-task.ts';
import { createTemplateWorkspace, type TemplateWorkspace } from '../fixtures/workspace.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function narrativeOutline(sectionCount = 8): string {
  return Array.from({ length: sectionCount }, (_, index) => {
    const number = index + 1;
    const priority = number === 1
      ? 'P0 P001'
      : number === sectionCount
        ? 'P0 P002'
        : 'bridge';
    const expansion = number % 3 === 1 ? '轻过渡' : number % 3 === 2 ? '标准' : '细写';
    return `${number}. 第${number}节
变化：状态${number - 1} → 状态${number}
重点：${priority}
展开：${expansion}
模式：冲突场景
容量：对白轮次 1；动作反馈闭环 1；认知转折 1；事后余波 1
出场：我
目标：推进第${number}步
冲突：第${number}步遇到阻力
结束状态：完成第${number}步`;
  }).join('\n\n');
}

async function enableNarrativePlanTemplate(workspace: TemplateWorkspace): Promise<void> {
  await workspace.patchTemplate(
    'zhihu-chapter',
    `    validation:
      minChars: 300
      maxChars: 8000
      forbidPattern: '(?m)^#{1,6}\\s'`,
    `    validation:
      forbidPattern: '(?m)^#{1,6}\\s'`,
  );
  await workspace.patchTemplate(
    'zhihu-chapter',
    `output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1`,
    `output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1
  validation:
    outlineCount:
      inputField: chapter_packet
      slotType: scene
    storyHan:
      min: 2000
      target: 4000
      max: 8000
      slotType: scene
    narrativePlan:
      inputField: chapter_packet
      slotType: scene`,
  );
}

describe('cli/run-task.ts', () => {
  it('--provider fake 跑通全程并落库产物，退出码 0', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const packet = path.join(dir, 'packet.txt');
    writeFileSync(packet, '主角在雨夜与债主对峙，本章需完成摊牌。', 'utf8');

    const code = await runTask([
      '--template',
      'zhihu-outline',
      '--input-file',
      packet,
      '--provider',
      'fake',
      '--db',
      path.join(dir, 'run.sqlite'),
    ]);

    expect(code).toBe(0);
  });

  it('plan-enabled fake CLI 按冻结 unit policy 跑通，不回退到整篇均分下限', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-plan-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const workspace = await createTemplateWorkspace();
    cleanups.push(() => workspace.cleanup());
    await enableNarrativePlanTemplate(workspace);
    const input = path.join(dir, 'outline-v2.txt');
    writeFileSync(input, narrativeOutline(), 'utf8');

    const dbPath = path.join(dir, 'run.sqlite');
    const code = await runTask([
      '--template',
      'zhihu-chapter',
      '--input-file',
      input,
      '--provider',
      'fake',
      '--db',
      dbPath,
      '--templates-dir',
      workspace.templatesDir,
      '--skills-dir',
      workspace.skillsDir,
    ]);

    expect(code).toBe(0);
    const db = openDatabase(dbPath);
    cleanups.push(() => {
      db.close();
    });
    const scenes = db.prepare("SELECT content_text FROM slots WHERE type = 'scene'").all() as Array<{
      content_text: string;
    }>;
    const sceneHan = scenes.reduce(
      (total, scene) => total + (scene.content_text.match(/[㐀-鿿]/gu)?.length ?? 0),
      0,
    );
    expect(scenes).toHaveLength(8);
    expect(sceneHan).toBe(4000);
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
