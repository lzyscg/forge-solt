/**
 * M2 完成判据：**创建任务后改磁盘上的 SKILL.md / template.yaml，旧任务读回来的仍是旧内容**
 * （REQ AC-002 / D-02）。
 *
 * 这份测试刻意走完整的真实路径：真的把文件拷到临时目录、真的用 `writeFile` 改它、
 * 真的让 catalog 重新扫描。用假的 loader 返回两份对象只能证明测试替身工作正常，
 * 而这条判据要防的恰恰是「加载器某天开始按引用共享对象」「快照存的其实是路径」
 * 这类只有碰到真文件才会暴露的问题。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotService } from '@server/application/snapshot-service.ts';
import type { SnapshotService } from '@server/application/snapshot-service.ts';
import { createTemplateCatalog } from '@server/application/template-catalog.ts';
import { createTestEnv, type TestEnv } from '../fixtures/db.ts';
import { createTemplateWorkspace, type TemplateWorkspace } from '../fixtures/workspace.ts';

let env: TestEnv;
let workspace: TemplateWorkspace;

const INPUT = { chapter_packet: '主角在雨夜与债主对峙。' };

/**
 * 每次都新建 catalog：`TemplateCatalog` 首次读取后会缓存扫描结果（这是它的设计），
 * 改完文件不换实例就等于什么都没改，测试会以「隔离成功」的假象通过。
 */
function freshService(): SnapshotService {
  return createSnapshotService({
    catalog: createTemplateCatalog({
      templatesDir: workspace.templatesDir,
      skillsDir: workspace.skillsDir,
      defaults: { timeoutMs: 180000, maxRetries: 2 },
    }),
    uow: env.uow,
  });
}

beforeEach(async () => {
  env = createTestEnv();
  workspace = await createTemplateWorkspace();
});

afterEach(async () => {
  env?.close();
  await workspace?.cleanup();
});

describe('AC-002 快照隔离', () => {
  it('改 SKILL.md：旧任务读到旧内容，新任务读到新内容', async () => {
    const before = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });
    const frozenBefore = freshService().readSnapshot(before.task.id);

    const original = await workspace.readSkill('scene-writing');
    expect(original).toContain('读取本槽位的 instruction');
    await workspace.writeSkill(
      'scene-writing',
      original
        .replace('读取本槽位的 instruction', '【改动】读取本槽位的 instruction')
        .replace('summary: 通过可见行动', 'summary: 【改动】通过可见行动'),
    );

    const after = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第二章',
      input: INPUT,
    });

    const service = freshService();
    const oldSnapshot = service.readSnapshot(before.task.id);
    const newSnapshot = service.readSnapshot(after.task.id);

    const oldSkill = oldSnapshot.skills['scene-writing'];
    const newSkill = newSnapshot.skills['scene-writing'];

    // 旧任务：正文、summary、section 索引、contentHash 全部保持冻结时的样子
    expect(oldSkill?.contentMarkdown).toBe(original);
    expect(oldSkill?.summary).not.toContain('【改动】');
    expect(oldSkill?.sectionIndex['S1']?.content).not.toContain('【改动】');
    expect(oldSkill?.contentHash).toBe(frozenBefore.skills['scene-writing']?.contentHash);

    // 新任务：确实看到了新内容——否则上面那组断言可能只是因为改文件没生效
    expect(newSkill?.summary).toContain('【改动】');
    expect(newSkill?.sectionIndex['S1']?.content).toContain('【改动】');
    expect(newSkill?.contentHash).not.toBe(oldSkill?.contentHash);

    // Skill 全文哈希进 templateHash（见 template-loader），所以整份快照的 hash 也必须变
    expect(newSnapshot.snapshotHash).not.toBe(oldSnapshot.snapshotHash);
  });

  it('改 template.yaml：旧任务的限制、guidance、绑定都不受影响', async () => {
    const before = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });

    await workspace.patchTemplate('zhihu-chapter', 'maxSlots: 32', 'maxSlots: 8');
    await workspace.patchTemplate('zhihu-chapter', 'timeoutMs: 180000', 'timeoutMs: 5000');
    await workspace.patchTemplate('zhihu-chapter', '首段需衔接前一场景的结尾状态', '【改动】首段随意');

    const after = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第二章',
      input: INPUT,
    });

    const service = freshService();
    const oldSnapshot = service.readSnapshot(before.task.id);
    const newSnapshot = service.readSnapshot(after.task.id);

    expect(oldSnapshot.compiled.limits.maxSlots).toBe(32);
    expect(oldSnapshot.compiled.bindings.fillSlotByType['scene']?.timeoutMs).toBe(180000);
    expect(
      oldSnapshot.compiled.slotTypes.find((t) => t.id === 'scene')?.guidance.join(),
    ).toContain('首段需衔接前一场景的结尾状态');

    expect(newSnapshot.compiled.limits.maxSlots).toBe(8);
    expect(newSnapshot.compiled.bindings.fillSlotByType['scene']?.timeoutMs).toBe(5000);
    expect(newSnapshot.compiled.templateHash).not.toBe(oldSnapshot.compiled.templateHash);
  });

  it('模板改成 archived 后：旧任务照常读得到快照，但不能再据此建新任务（D-08）', async () => {
    const before = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });

    await workspace.patchTemplate('zhihu-chapter', 'status: published', 'status: archived');

    // 旧任务不受牵连：正在跑的任务不该因为有人归档了模板而失去它的冻结输入
    const frozen = freshService().readSnapshot(before.task.id);
    expect(frozen.compiled.status).toBe('published');

    await expect(
      freshService().createTask({ templateId: 'zhihu-chapter', name: '第二章', input: INPUT }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_PUBLISHED' });
  });

  it('删掉 SKILL.md 后旧任务仍可读回全文——快照存的是内容，不是路径', async () => {
    const created = await freshService().createTask({
      templateId: 'zhihu-chapter',
      name: '第一章',
      input: INPUT,
    });
    const original = await workspace.readSkill('title-writing');

    await workspace.writeSkill('title-writing', '');

    const frozen = freshService().readSnapshot(created.task.id);
    expect(frozen.skills['title-writing']?.contentMarkdown).toBe(original);
  });

  it('D-08 runCount：countTasksByTemplate 随任务数增长', async () => {
    const service = freshService();
    await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });
    await service.createTask({ templateId: 'zhihu-chapter', name: '第二章', input: INPUT });
    expect(env.uow.repositories.snapshots.countTasksByTemplate('zhihu-chapter')).toBe(2);
  });
});
