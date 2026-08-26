import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTemplateCatalog, createTemplateCatalogFromEnv } from './template-catalog.ts';

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

const catalog = (): ReturnType<typeof createTemplateCatalog> =>
  createTemplateCatalog({
    templatesDir: path.join(FIXTURES, 'templates'),
    skillsDir: path.join(FIXTURES, 'skills'),
    defaults: { timeoutMs: 180000, maxRetries: 2 },
  });

describe('TemplateCatalog', () => {
  it('枚举全部模板，顺序确定', async () => {
    const list = await catalog().list();
    // 文件系统的目录序在 APFS 与 ext4 上不同；这里断言的是排序后的确定序
    expect(list.map((t) => t.compiled.id)).toEqual(['archived-chapter', 'draft-chapter', 'review-chapter', 'zhihu-chapter']);
  });

  it('坏模板不让列表空白，但必须显式可见', async () => {
    const instance = catalog();
    const list = await instance.list();
    const failures = await instance.failures();

    expect(list.map((t) => t.compiled.id)).not.toContain('broken-chapter');
    // 两种坏法：broken-chapter 坏在编译期（status 取值非法），
    // no-yaml-chapter 坏在读文件（目录里根本没有 template.yaml）。
    // 后者是 M5 审查之后补的样本——只有它会走到「拼绝对路径」那条分支
    const byDir = new Map(failures.map((f) => [f.dirName, f]));
    expect([...byDir.keys()].sort()).toEqual(['broken-chapter', 'no-yaml-chapter']);
    expect(byDir.get('broken-chapter')?.error.code).toBe('TEMPLATE_INVALID');
    expect(byDir.get('no-yaml-chapter')?.error.code).toBe('TEMPLATE_NOT_FOUND');
    // 报错里给的是目录名而不是绝对路径（§9.3：路径不出网，只进 cause）
    expect(byDir.get('no-yaml-chapter')?.error.message).toContain('no-yaml-chapter');
    expect(byDir.get('no-yaml-chapter')?.error.message).not.toContain('/');
    // 失败信息要能定位到文件，否则用户只知道「有个模板坏了」
    expect(failures[0]?.sourcePath).toMatch(/broken-chapter[/\\]template\.yaml$/);
  });

  it('按 status 过滤（D-08）', async () => {
    const instance = catalog();
    expect((await instance.list({ status: 'published' })).map((t) => t.compiled.id)).toEqual(['review-chapter', 'zhihu-chapter']);
    expect((await instance.list({ status: ['draft', 'archived'] })).map((t) => t.compiled.id)).toEqual([
      'archived-chapter',
      'draft-chapter',
    ]);
  });

  it('get 对 draft / archived 同样可查——它们的详情页要能打开', async () => {
    const instance = catalog();
    await expect(instance.get('draft-chapter')).resolves.toMatchObject({ compiled: { status: 'draft' } });
    await expect(instance.get('archived-chapter')).resolves.toMatchObject({ compiled: { status: 'archived' } });
  });

  it('get 不存在的模板 → TEMPLATE_NOT_FOUND', async () => {
    await expect(catalog().get('no-such')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('requireUsable 只放行 published（D-08）', async () => {
    const instance = catalog();
    await expect(instance.requireUsable('zhihu-chapter')).resolves.toBeDefined();
    // 关键是**不能**报 TEMPLATE_NOT_FOUND：对着一个自己刚建的模板说「不存在」最令人困惑
    await expect(instance.requireUsable('draft-chapter')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_PUBLISHED',
    });
    await expect(instance.requireUsable('archived-chapter')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_PUBLISHED',
    });
  });

  it('reload 后结果一致（模板未变则 hash 不变）', async () => {
    const instance = catalog();
    const first = await instance.list();
    const second = (await instance.reload()).templates;
    expect(second.map((t) => t.compiled.templateHash)).toEqual(first.map((t) => t.compiled.templateHash));
  });

  it('目录不可读 → TEMPLATE_NOT_FOUND，指向配置项', async () => {
    const instance = createTemplateCatalog({
      templatesDir: path.join(FIXTURES, 'no-such-dir'),
      skillsDir: path.join(FIXTURES, 'skills'),
      defaults: { timeoutMs: 180000, maxRetries: 2 },
    });
    await expect(instance.list()).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      location: 'config:TEMPLATES_DIR',
    });
  });

  it('目录名与 template.yaml 的 id 不一致 → 失败项', async () => {
    // 不强制的话，同一个 ID 可以藏在两个目录里，「按 ID 找模板」会随扫描顺序返回不同的那一个
    const instance = createTemplateCatalog({
      templatesDir: path.join(FIXTURES, 'invalid-templates'),
      skillsDir: path.join(FIXTURES, 'skills'),
      defaults: { timeoutMs: 180000, maxRetries: 2 },
      patternBudgetMs: 60,
    });
    const failures = await instance.failures();
    expect(failures.map((f) => f.dirName).sort()).toEqual([
      'catastrophic-forbid-pattern',
      'dirname-mismatch',
      'missing-create-structure-binding',
      'skill-operation-mismatch',
      'uncovered-slot-type',
      'unknown-agent',
    ]);
    // dirname-mismatch 的 template.yaml 本身合法，被拒的是「目录名 ≠ id」
    expect(failures.find((f) => f.dirName === 'dirname-mismatch')?.error.message).toMatch(/不一致/);
    expect(await instance.list()).toHaveLength(0);
  });

  it('createTemplateCatalogFromEnv 从 .env 与 providers.yaml 装配', async () => {
    const instance = await createTemplateCatalogFromEnv({
      TEMPLATES_DIR: path.join(FIXTURES, 'templates'),
      SKILLS_DIR: path.join(FIXTURES, 'skills'),
    });
    // defaults 来自真实的 config/providers.yaml：这条用例同时守住了
    // 「providers.yaml 的 defaults 改了会影响模板编译」这条链路
    const template = await instance.get('draft-chapter');
    expect(template.compiled.bindings.fillSlotByType['scene']?.timeoutMs).toBe(180000);
  });
});
