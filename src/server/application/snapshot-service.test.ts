import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@server/domain/canonical.ts';
import { createTestEnv, dumpAll, type TestEnv } from '../../../tests/fixtures/db.ts';
import { parseSkill } from './skill-loader.ts';
import { createSnapshotService, normalizeTaskInput, prepareSnapshot } from './snapshot-service.ts';
import type { SnapshotService } from './snapshot-service.ts';
import { createTemplateCatalog } from './template-catalog.ts';
import type { TemplateCatalog } from './template-catalog.ts';

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

const catalog = (): TemplateCatalog =>
  createTemplateCatalog({
    templatesDir: path.join(FIXTURES, 'templates'),
    skillsDir: path.join(FIXTURES, 'skills'),
    defaults: { timeoutMs: 180000, maxRetries: 2 },
  });

let env: TestEnv;
afterEach(() => env?.close());

/** ID 生成器注入成计数器：断言里可以直接写出 ID，不必到处 expect.any(String) */
function serviceWith(instance: TemplateCatalog = catalog()): { env: TestEnv; service: SnapshotService } {
  env = createTestEnv();
  let n = 0;
  return {
    env,
    service: createSnapshotService({ catalog: instance, uow: env.uow, newId: () => `id-${++n}` }),
  };
}

/** 递归收集对象里出现过的全部键名。用于按**结构**而非按子串判断某个字段有没有被剥离 */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

describe('prepareSnapshot（D-02 / D-12）', () => {
  it('presentation 的任何字段都不出现在 compiled_json 里', async () => {
    const loaded = await catalog().get('zhihu-chapter');
    const prepared = prepareSnapshot(loaded, { taskId: 't', snapshotId: 's' });

    // 夹具的 presentation 确实有内容——否则这条断言等于什么都没验
    expect(loaded.presentation.tags).toContain('场景写作');
    expect(loaded.presentation.exampleStructure).not.toBeNull();

    // 判据只能是**键名**，不能是值。
    // 值级别的子串扫描在这里是不可靠的判据：`tags` 里有「写作 Agent」，
    // 而 `agents[].name` 里正当地存在「章节写作 Agent」——一个合法的编译产物
    // 会被判成泄漏。同理 `outputKind` 的「单章正文」也出现在 description 里。
    // presentation 是否被剥离是一个**结构**问题，就该按结构验。
    const keys = collectKeys(JSON.parse(prepared.compiledJson));
    for (const key of ['presentation', 'outputKind', 'tags', 'exampleStructure']) {
      expect(keys, `编译产物里不该出现 ${key}`).not.toContain(key);
    }
  });

  it('snapshotHash 与落库文本逐字对应，重算即可验证', async () => {
    const loaded = await catalog().get('zhihu-chapter');
    const prepared = prepareSnapshot(loaded, { taskId: 't', snapshotId: 's' });

    expect(prepared.snapshotHash).toBe(sha256Hex(prepared.compiledJson));
    // canonicalJson 而不是 JSON.stringify：键序由码点序决定，与对象字面量的书写顺序无关
    expect(prepared.compiledJson).toBe(canonicalJson(loaded.compiled));
  });

  it('同一份模板冻结两次，字节完全相同（AC-013）', async () => {
    const a = prepareSnapshot(await catalog().get('zhihu-chapter'), { taskId: 't', snapshotId: 's' });
    const b = prepareSnapshot(await catalog().get('zhihu-chapter'), { taskId: 't', snapshotId: 's' });
    expect(a).toEqual(b);
  });

  it('Skill 行按 skillId 码点序排列，且 content_markdown 与 section 索引同源', async () => {
    const loaded = await catalog().get('zhihu-chapter');
    const prepared = prepareSnapshot(loaded, { taskId: 't', snapshotId: 's' });

    expect(prepared.skills.map((s) => s.skillId)).toEqual([
      'chapter-structure-design',
      'outline-writing',
      'scene-writing',
      'title-writing',
    ]);

    for (const row of prepared.skills) {
      // 冻结的是原文：拿它重新解析必须得到同一份 Skill，contentHash 也必须对得上。
      // 这条同时证明 section 索引与 content_markdown 不会各说各话。
      const reparsed = parseSkill(row.contentMarkdown, 'memory://snapshot');
      expect(reparsed.contentHash).toBe(row.contentHash);
      expect(reparsed.version).toBe(row.skillVersion);
      expect(JSON.parse(row.sectionIndexJson)).toMatchObject({
        summary: reparsed.summary,
        sections: reparsed.sections,
      });
    }
  });

  it('section 索引保持文件中的出现顺序，不被码点序打乱', () => {
    const skill = parseSkill(
      ['---', 'id: many', 'version: 1.0.0', 'operation: create_structure', 'summary: 多章节',
        'requiredSections: [S2]', '---', '', '## S2. 第二', 'b', '', '## S10. 第十', 'c', '',
        '## S1. 第一', 'a', ''].join('\n'),
      'memory://many',
    );
    const prepared = prepareSnapshot(
      { compiled: { id: 'x', version: '1', skills: [] } as never, skills: { many: skill } },
      { taskId: 't', snapshotId: 's' },
    );
    const index = JSON.parse(prepared.skills[0]?.sectionIndexJson ?? '{}') as {
      sections: { id: string }[];
    };
    // 码点序会给出 S1 / S10 / S2——注入顺序被打乱，模型读到的章节次序就不是作者写的次序
    expect(index.sections.map((s) => s.id)).toEqual(['S2', 'S10', 'S1']);
  });
});

describe('normalizeTaskInput', () => {
  const fields = [
    { id: 'packet', label: '执行包', type: 'textarea' as const, required: true, hint: null },
    { id: 'note', label: '备注', type: 'text' as const, required: false, hint: null },
  ];

  it('required 缺失被拒', () => {
    expect(() => normalizeTaskInput(fields, { note: 'x' }, 'tpl')).toThrow(/必填字段「执行包」/);
  });

  it('required 是空白等同于缺失', () => {
    expect(() => normalizeTaskInput(fields, { packet: '   ' }, 'tpl')).toThrow(/不能为空/);
  });

  it('未知键被拒，且报错点名那个键——静默丢弃会变成「Agent 看不见我填的内容」', () => {
    expect(() => normalizeTaskInput(fields, { packet: 'a', pakcet: 'b' }, 'tpl')).toThrow(/pakcet/);
  });

  it('非字符串值被拒（输入来自 HTTP，是不可信边界）', () => {
    expect(() => normalizeTaskInput(fields, { packet: 42 }, 'tpl')).toThrow(/必须是字符串/);
  });

  it('可选字段缺失就不落键；键序按 inputFields 重建，与请求体的键序无关', () => {
    expect(normalizeTaskInput(fields, { packet: 'a' }, 'tpl')).toEqual({ packet: 'a' });
    expect(Object.keys(normalizeTaskInput(fields, { note: 'n', packet: 'a' }, 'tpl'))).toEqual([
      'packet',
      'note',
    ]);
  });

  it('错误码是 TASK_INPUT_INVALID', () => {
    expect(() => normalizeTaskInput(fields, {}, 'tpl')).toThrow(
      expect.objectContaining({ code: 'TASK_INPUT_INVALID' }),
    );
  });
});

describe('createTask（§5.5 第一行）', () => {
  it('三条 INSERT 在一个事务内落库，任务落在 ready / structure', async () => {
    const { env: e, service } = serviceWith();
    const created = await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });

    expect(created.task.status).toBe('ready');
    expect(created.task.phase).toBe('structure');
    expect(created.task.snapshotId).toBe(created.snapshot.id);
    expect(created.skills).toHaveLength(4);

    const rows = dumpAll(e.db);
    expect(rows['tasks']).toHaveLength(1);
    expect(rows['task_snapshots']).toHaveLength(1);
    expect(rows['task_skill_snapshots']).toHaveLength(4);
  });

  it('库里的 snapshot_hash 能被重算验证（NFR-004 的诊断信号）', async () => {
    const { env: e, service } = serviceWith();
    const created = await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });
    const row = e.uow.repositories.snapshots.getByTaskOrThrow(created.task.id);
    expect(sha256Hex(row.compiledJson)).toBe(row.snapshotHash);
  });

  it('只允许 published 模板（D-08）', async () => {
    const { service } = serviceWith();
    for (const templateId of ['draft-chapter', 'archived-chapter']) {
      await expect(service.createTask({ templateId, name: 'x', input: INPUT })).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_PUBLISHED',
      });
    }
  });

  it('模板不存在 → TEMPLATE_NOT_FOUND', async () => {
    const { service } = serviceWith();
    await expect(
      service.createTask({ templateId: 'no-such', name: 'x', input: INPUT }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('任务名为空被拒', async () => {
    const { service } = serviceWith();
    await expect(
      service.createTask({ templateId: 'zhihu-chapter', name: '  ', input: INPUT }),
    ).rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });
  });

  it('输入非法时一行都不写（校验发生在事务之前）', async () => {
    const { env: e, service } = serviceWith();
    const before = dumpAll(e.db);
    await expect(
      service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: {} }),
    ).rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });
    expect(dumpAll(e.db)).toEqual(before);
  });

  it('事务中途失败 → 全库与事务前逐字节相同（D-10 原子性）', async () => {
    const { env: e, service } = serviceWith();
    await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });
    const before = dumpAll(e.db);

    // 用重复 ID 制造第二个任务写到一半才失败：快照与 4 条 Skill 已经 INSERT 成功，
    // tasks 的主键冲突发生在最后一步。若三条 INSERT 不在同一事务里，
    // 这里会留下一份没有任务的孤儿快照。
    let n = 0;
    const clashing = createSnapshotService({
      catalog: catalog(),
      uow: e.uow,
      newId: () => (n++ === 0 ? (dumpAll(e.db)['tasks']?.[0] as { id: string }).id : 'snap-x'),
    });
    await expect(
      clashing.createTask({ templateId: 'zhihu-chapter', name: '第二章', input: INPUT }),
    ).rejects.toThrow();

    expect(dumpAll(e.db)).toEqual(before);
  });

  it('REQ §13：快照文本里搜不到任何凭据相关字样', async () => {
    const { env: e, service } = serviceWith();
    await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });

    const dump = dumpAll(e.db);
    const text = JSON.stringify(dump);
    for (const forbidden of ['api_key', 'apikey', 'apiKeyEnv', 'authorization', 'secret', 'token', 'sk-']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // 反向断言：证明上面那圈扫描不是因为「压根没扫到东西」才通过的。
    // 注意不能在 `text` 上找 `"modelAlias":"main"`——compiled_json 在整库 dump 里
    // 是**被转义了一层的字符串**，那个子串根本不会以这个形状出现。
    // 要断言就断言解析后的对象，别断言序列化的偶然形状。
    const row = dump['task_snapshots']?.[0] as { compiled_json: string } | undefined;
    const compiled = JSON.parse(row?.compiled_json ?? '{}') as {
      bindings?: { createStructure?: { modelAlias?: string } };
    };
    // 快照里与 Provider 有关的只有别名字符串——别名 → provider/model 是 D-03 的晚绑定
    expect(compiled.bindings?.createStructure?.modelAlias).toBe('structure');
  });
});

describe('readSnapshot（M3 ContextBuilder 的读入口）', () => {
  it('读回的编译产物与冻结时逐字相同，Skill 索引可 O(1) 取用', async () => {
    const { service } = serviceWith();
    const created = await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });
    const frozen = service.readSnapshot(created.task.id);

    expect(canonicalJson(frozen.compiled)).toBe(created.snapshot.compiledJson);
    expect(frozen.input).toEqual(INPUT);
    expect(frozen.templateVersion).toBe('1.0.0');
    expect(Object.keys(frozen.skills).sort()).toEqual([
      'chapter-structure-design',
      'outline-writing',
      'scene-writing',
      'title-writing',
    ]);

    const scene = frozen.skills['scene-writing'];
    expect(scene?.requiredSections).toEqual(['S1', 'S2', 'S6']);
    expect(scene?.sectionIndex['S2']?.title).toBe('读取前置状态');
    expect(scene?.summary).toMatch(/可见行动/);
  });

  it('compiled_json 被外部改动 → STORAGE_ERROR，而不是拿着它继续生产', async () => {
    const { env: e, service } = serviceWith();
    const created = await service.createTask({ templateId: 'zhihu-chapter', name: '第一章', input: INPUT });

    e.db.prepare('UPDATE task_snapshots SET compiled_json = ? WHERE task_id = ?').run(
      '{"tampered":true}',
      created.task.id,
    );
    expect(() => service.readSnapshot(created.task.id)).toThrow(
      expect.objectContaining({ code: 'STORAGE_ERROR' }),
    );
  });

  it('任务不存在 → TASK_NOT_FOUND', () => {
    const { service } = serviceWith();
    expect(() => service.readSnapshot('no-such')).toThrow(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
  });
});
