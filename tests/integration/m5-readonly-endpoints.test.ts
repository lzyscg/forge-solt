/**
 * M5-B：模板与任务只读端点（文档 §9.1 前半 + §12.2 M5 完成判据）。
 *
 * 全部经 `app.inject()` 打真实路由，不 mock 任何 service——见 fixtures/api.ts 的说明。
 *
 * 两条贯穿本文件的断言纪律：
 *
 * 1. **形状用 Zod schema 校验，不用 `toMatchObject`。**
 *    `toMatchObject` 只查「我写出来的那几个键对不对」，多一个键、少一个键、
 *    某个键从 string 变成 null，它都不管。而 DTO 是前后端唯一的约定，
 *    「少了一个键」在前端表现为一处 undefined 渲染，追起来极贵。
 *
 * 2. **「没有」要分门别类。**
 *    任务 ID 打错 vs 任务还没跑完，模板不存在 vs 模板下没有任务——
 *    合成同一个 404 会让用户的下一步动作变成猜。
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactViewSchema,
  ExecutionViewSchema,
  SlotDetailSchema,
  SlotViewSchema,
  TaskDetailSchema,
  TaskSummarySchema,
  TemplateDetailSchema,
  TemplateListResponseSchema,
  TraceListResponseSchema,
} from '@shared/contracts.ts';
import { PublicErrorSchema } from '@shared/errors.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import {
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  waitFor,
} from '../fixtures/engine.ts';
import { createApiHarness, type ApiHarness } from '../fixtures/api.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };
const TEMPLATES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'templates');

let harness: ApiHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** 一份能把 fixture 模板从头跑到尾的脚本 */
function happyPathProvider(): FakeProvider {
  return new FakeProvider({
    turns: [
      { submitStructure: VALID_STRUCTURE },
      { submitContent: { slotId: 'outline', content: outlineText() } },
      { submitContent: { slotId: 'title', content: TITLE_TEXT } },
      { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    ],
  });
}

function open(options: { provider?: FakeProvider } = {}): ApiHarness {
  harness = createApiHarness(options);
  return harness;
}

async function createTask(h: ApiHarness, name: string, templateId = 'zhihu-chapter'): Promise<string> {
  const created = await h.forge.snapshots.createTask({ templateId, name, input: INPUT });
  return created.task.id;
}

/** 建任务并跑到 completed */
async function completedTask(h: ApiHarness, name = '第一章'): Promise<string> {
  const taskId = await createTask(h, name);
  await h.forge.lifecycle.start(taskId);
  return taskId;
}

/** 让下一次写入落在不同的毫秒上。`updated_at` 的分辨率就是毫秒 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 3));
}

async function get(h: ApiHarness, url: string): Promise<{ status: number; body: string; json: unknown }> {
  const response = await h.server.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.body, json: response.json() };
}

// ===========================================================================
// 模板端点
// ===========================================================================

describe('GET /api/templates', () => {
  it('列表带 runCount，draft / archived 可见（D-08），坏模板进 failures 不静默消失', async () => {
    const h = open();
    await completedTask(h);
    await createTask(h, '第二章');

    const response = await get(h, '/api/templates');
    expect(response.status).toBe(200);
    const body = TemplateListResponseSchema.parse(response.json);

    // 目录序即码点序（TemplateCatalog 的排序保证），坏的那个不在 templates 里
    expect(body.templates.map((t) => t.id)).toEqual([
      'archived-chapter',
      'draft-chapter',
      'zhihu-chapter',
    ]);
    // D-08：不可用 ≠ 不可见。列表页要能显示它们并打状态 chip
    expect(body.templates.map((t) => t.status)).toEqual(['archived', 'draft', 'published']);

    // 坏模板必须显式可见，而不是「我明明建了模板，列表里没有」。
    // 两种坏法都要在：broken-chapter 坏在**编译期**（status 取值非法），
    // no-yaml-chapter 坏在**读文件**（目录里根本没有 template.yaml）。
    // 后者是下一条用例的必需样本，见那里的说明。
    const failures = new Map(body.failures.map((f) => [f.dirName, f]));
    expect([...failures.keys()].sort()).toEqual(['broken-chapter', 'no-yaml-chapter']);
    expect(failures.get('broken-chapter')?.error.code).toBe('TEMPLATE_INVALID');
    expect(failures.get('no-yaml-chapter')?.error.code).toBe('TEMPLATE_NOT_FOUND');

    // runCount 数的是快照引用，只有真建过任务的模板才有
    const byId = new Map(body.templates.map((t) => [t.id, t]));
    expect(byId.get('zhihu-chapter')?.runCount).toBe(2);
    expect(byId.get('draft-chapter')?.runCount).toBe(0);
  });

  it('failures 不带 sourcePath —— 绝对路径不出网（§9.3 同一条纪律）', async () => {
    const h = open();
    const response = await get(h, '/api/templates');

    // 断言的是**响应全文**里不含那个目录，而不是「failures[0].sourcePath === undefined」：
    // 后者只挡住字段名叫 sourcePath 的那一处，挡不住路径从 error.message 里漏出去。
    //
    // 这条曾经是**恒为真**的假绿：当时唯一的坏样本 broken-chapter 失败在编译期，
    // 报错里本来就没有路径。真正会拼进绝对路径的是「读文件失败」那条分支，
    // 所以 fixture 里专门加了 no-yaml-chapter（一个不含 template.yaml 的目录）
    // 来覆盖它。M5 审查抓到的就是这一条。
    expect(response.body).not.toContain(TEMPLATES_DIR);
    expect(response.body).not.toContain('sourcePath');
    // 注意 action 文案里的「检查 template.yaml 后重新加载」是**文件名**不是路径，
    // 那是给人看的操作提示，留着
    expect(response.body).toContain('检查 template.yaml 后重新加载');
  });

  it('统计字段数的是编译产物，不是拍脑袋的常数', async () => {
    const h = open();
    const body = TemplateListResponseSchema.parse((await get(h, '/api/templates')).json);
    const zhihu = body.templates.find((t) => t.id === 'zhihu-chapter');

    // 对着 fixture 的 template.yaml：4 个槽位类型、2 个 Agent、4 个 Skill
    expect(zhihu?.slotTypeCount).toBe(4);
    expect(zhihu?.agentCount).toBe(2);
    expect(zhihu?.skillCount).toBe(4);
    // presentation 里的字段（D-02：不进 templateHash，但要出 API）
    expect(zhihu?.outputKind).toBe('单章正文');
    expect(zhihu?.tags).toContain('场景写作');
  });
});

describe('GET /api/templates/:id', () => {
  it('详情形状完整，容器类型的 binding 为 null（D-01：UI 不得为它伪造 Producer）', async () => {
    const h = open();
    const response = await get(h, '/api/templates/zhihu-chapter');
    expect(response.status).toBe(200);
    const detail = TemplateDetailSchema.parse(response.json);

    const byId = new Map(detail.slotTypes.map((s) => [s.id, s]));
    expect(byId.get('chapter')?.contentBearing).toBe(false);
    expect(byId.get('chapter')?.binding).toBeNull();
    expect(byId.get('scene')?.binding).not.toBeNull();
    // D-16：子树语义的工作槽位
    expect(byId.get('chapter_outline')?.includeInArtifact).toBe(false);
    expect(byId.get('scene')?.includeInArtifact).toBe(true);
  });

  it('D-06 的回退链在编译期就求解完了，详情页显示的是最终生效值', async () => {
    const h = open();
    const detail = TemplateDetailSchema.parse((await get(h, '/api/templates/zhihu-chapter')).json);
    const byId = new Map(detail.slotTypes.map((s) => [s.id, s]));

    // scene 自带 timeoutMs: 180000
    expect(byId.get('scene')?.binding?.timeoutMs).toBe(180_000);
    expect(byId.get('scene')?.binding?.maxRetries).toBe(1);
    // title 什么都没写 → 回退到 limits.executionTimeoutMs / maxExecutionRetries
    expect(byId.get('title')?.binding?.timeoutMs).toBe(120_000);
    expect(byId.get('title')?.binding?.maxRetries).toBe(2);
    // 结构绑定同理，且带上 D-01 的两条硬护栏
    expect(detail.structureBinding.timeoutMs).toBe(90_000);
    expect(detail.structureBinding.maxSlots).toBe(32);
    expect(detail.structureBinding.maxStructureDepth).toBe(4);
  });

  it('D-03：resolvedModel 是「此刻」的解析结果，与冻结的别名并列', async () => {
    const h = open();
    const detail = TemplateDetailSchema.parse((await get(h, '/api/templates/zhihu-chapter')).json);
    const scene = detail.slotTypes.find((s) => s.id === 'scene');

    expect(scene?.binding?.modelAlias).toBe('main');
    expect(scene?.binding?.resolvedModel).toBe('fake-model');
    expect(detail.structureBinding.modelAlias).toBe('structure');
    expect(detail.structureBinding.resolvedModel).toBe('fake-model');
  });

  it('D-05：校验规则翻成人话，且不把正则源码丢给用户', async () => {
    const h = open();
    const detail = TemplateDetailSchema.parse((await get(h, '/api/templates/zhihu-chapter')).json);
    const scene = detail.slotTypes.find((s) => s.id === 'scene');

    expect(scene?.validation.minChars).toBe(300);
    expect(scene?.validation.rules).toContain('不少于 300 字');
    expect(scene?.validation.rules).toContain('不超过 8000 字');
    // 有 forbidPatternMessage 就用作者写的那句
    expect(scene?.validation.rules).toContain('场景正文不得包含 Markdown 小标题');
    // 正则是给机器看的。放进 UI 会让人以为那是要遵守的写作要求
    expect(JSON.stringify(scene?.validation)).not.toContain('#{1,6}');

    // D-05 的另一半：guidance 是不强制的写作要求，与 validation 分开
    expect(scene?.guidance.length).toBeGreaterThan(0);
    expect(scene?.validation.rules).not.toContain(scene?.guidance[0] ?? '');
  });

  it('D-02：exampleStructure 只出现在详情里，且「没有示例」是 null 不是空数组', async () => {
    const h = open();
    const withExample = TemplateDetailSchema.parse((await get(h, '/api/templates/zhihu-chapter')).json);
    expect(withExample.exampleStructure).toHaveLength(4);
    expect(withExample.exampleStructure?.[0]).toMatchObject({ typeId: 'chapter', kind: 'container' });

    // archived-chapter 的 presentation 里没写 exampleStructure。
    // 给空数组会让 UI 渲染出一个空的示例区块，null 才是「模板没提供」
    const without = TemplateDetailSchema.parse((await get(h, '/api/templates/archived-chapter')).json);
    expect(without.exampleStructure).toBeNull();
  });

  it('draft / archived 的详情页必须打得开（D-08：不可用 ≠ 查不到）', async () => {
    const h = open();
    expect((await get(h, '/api/templates/draft-chapter')).status).toBe(200);
    expect((await get(h, '/api/templates/archived-chapter')).status).toBe(200);
  });

  it('模板不存在 → 404 TEMPLATE_NOT_FOUND，且带可执行的 action', async () => {
    const h = open();
    const response = await get(h, '/api/templates/no-such-template');
    expect(response.status).toBe(404);
    const error = PublicErrorSchema.parse(response.json);
    expect(error.code).toBe('TEMPLATE_NOT_FOUND');
    expect(error.action).toBe('返回模板列表重新选择');
  });
});

describe('GET /api/templates/:id/tasks', () => {
  it('只返回引用该模板的任务，按 updatedAt 倒序', async () => {
    const h = open();
    // 夹具里只有 zhihu-chapter 是 published，而 D-08 禁止用 draft / archived 建新任务，
    // 所以「别的模板的任务不许混进来」只能反过来验：库里明明有三个任务，
    // archived-chapter 名下必须一个都查不到。查询要是漏了 template_id 条件，
    // 下面那条会拿到三个。
    // 逐个隔开几毫秒再建：updated_at 只到毫秒，连着建会并列，
    // 那时验的就成了「破平规则」而不是「按时间倒序」
    await createTask(h, '知乎一');
    await tick();
    await createTask(h, '知乎二');
    await tick();
    await createTask(h, '知乎三');

    const response = await get(h, '/api/templates/zhihu-chapter/tasks');
    expect(response.status).toBe(200);
    const tasks = response.json as unknown[];
    for (const task of tasks) TaskSummarySchema.parse(task);
    expect((tasks as { name: string }[]).map((t) => t.name)).toEqual(['知乎三', '知乎二', '知乎一']);

    const archived = await get(h, '/api/templates/archived-chapter/tasks');
    // 200 + 空数组，不是 404：模板确实存在，只是名下没有任务
    expect(archived.status).toBe(200);
    expect(archived.json).toEqual([]);
  });

  it('模板不存在 → 404，而不是「这个模板没有任务」的空数组', async () => {
    const h = open();
    const response = await get(h, '/api/templates/no-such-template/tasks');
    expect(response.status).toBe(404);
    expect(PublicErrorSchema.parse(response.json).code).toBe('TEMPLATE_NOT_FOUND');
  });
});

// ===========================================================================
// 任务只读端点
// ===========================================================================

describe('GET /api/tasks 与 /api/tasks/:id', () => {
  it('列表与详情的形状都通过 schema，详情带 stepper / slots / snapshotHash', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const list = (await get(h, '/api/tasks')).json as unknown[];
    expect(list).toHaveLength(1);
    TaskSummarySchema.parse(list[0]);

    const response = await get(h, `/api/tasks/${taskId}`);
    expect(response.status).toBe(200);
    const detail = TaskDetailSchema.parse(response.json);

    expect(detail.stepper.map((s) => s.key)).toEqual([
      'input',
      'structure',
      'slots',
      'assembly',
      'done',
    ]);
    // 冻结输入原样返回（AC-002）
    expect(detail.input).toEqual(INPUT);
    expect(detail.snapshotHash).toBeTruthy();
    // 文档序：容器在前，其下按 order
    expect(detail.slots.map((s) => s.id)).toEqual([
      'chapter',
      'outline',
      'title',
      'scene_01',
      'scene_02',
    ]);
    // 内容槽计数不含容器
    expect(detail.totalSlots).toBe(4);
    expect(detail.doneSlots).toBe(4);
  });

  it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
    const h = open();
    const response = await get(h, '/api/tasks/task-does-not-exist');
    expect(response.status).toBe(404);
    expect(PublicErrorSchema.parse(response.json).code).toBe('TASK_NOT_FOUND');
  });

  it('?limit 非法 → 400 TASK_INPUT_INVALID，不静默退回默认值', async () => {
    const h = open();
    for (const query of ['?limit=abc', '?limit=0', '?limit=201', '?limit=1e3', '?limit=-5']) {
      const response = await get(h, `/api/tasks${query}`);
      expect(response.status, `${query} 应当 400`).toBe(400);
      expect(PublicErrorSchema.parse(response.json).code).toBe('TASK_INPUT_INVALID');
    }
    // 没传是「你看着办」，合法值照常生效
    expect((await get(h, '/api/tasks')).status).toBe(200);
    expect((await get(h, '/api/tasks?limit=1')).status).toBe(200);
  });
});

describe('GET /api/tasks/:id/slots[/:slotId]', () => {
  it('正文只在单槽位详情里返回，列表里连这个键都没有', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const list = (await get(h, `/api/tasks/${taskId}/slots`)).json as unknown[];
    for (const slot of list) SlotViewSchema.parse(slot);
    // 50 个槽位的任务里，列表带正文会把响应撑到不可接受
    for (const slot of list) expect(slot).not.toHaveProperty('content');

    const response = await get(h, `/api/tasks/${taskId}/slots/scene_01`);
    expect(response.status).toBe(200);
    const detail = SlotDetailSchema.parse(response.json);
    expect(detail.content).toContain('第一场');
    expect(detail.producer?.executionId).toBeTruthy();
  });

  it('槽位不存在 → 404 SLOT_NOT_FOUND；任务不存在 → 404 TASK_NOT_FOUND', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    // 两种「查不到」的 code 必须不同：一个是「换个槽位看」，
    // 另一个是「这个任务根本不存在，别再刷了」
    expect(PublicErrorSchema.parse((await get(h, `/api/tasks/${taskId}/slots/nope`)).json).code).toBe(
      'SLOT_NOT_FOUND',
    );
    expect(PublicErrorSchema.parse((await get(h, '/api/tasks/nope/slots/scene_01')).json).code).toBe(
      'TASK_NOT_FOUND',
    );
  });
});

describe('GET /api/tasks/:id/executions', () => {
  it('D-03 / D-12：别名与实际模型并列，两个 hash 分开', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const response = await get(h, `/api/tasks/${taskId}/executions`);
    expect(response.status).toBe(200);
    const executions = (response.json as unknown[]).map((e) => ExecutionViewSchema.parse(e));
    expect(executions).toHaveLength(5);

    for (const execution of executions) {
      expect(execution.provider).toBe('fake');
      expect(execution.model).toBe('fake-model');
      expect(['structure', 'main']).toContain(execution.modelAlias);
      // D-12：两个 hash 各回答一个问题，合成一个就都答不了
      expect(execution.contextHash).toBeTruthy();
      expect(execution.promptHash).toBeTruthy();
      expect(execution.contextHash).not.toBe(execution.promptHash);
      expect(execution.agentName).not.toBe(execution.agentId);
    }
  });
});

describe('GET /api/tasks/:id/traces', () => {
  it('分页游标能翻到底，且 nextAfter 用完就是 null', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const all = TraceListResponseSchema.parse(
      (await get(h, `/api/tasks/${taskId}/traces?limit=1000`)).json,
    );
    expect(all.events.length).toBeGreaterThan(5);
    // 取满一页才可能有下一页；没取满就该给 null 让前端停止翻页
    expect(all.nextAfter).toBeNull();

    const firstPage = TraceListResponseSchema.parse(
      (await get(h, `/api/tasks/${taskId}/traces?limit=3`)).json,
    );
    expect(firstPage.events).toHaveLength(3);
    expect(firstPage.nextAfter).toBe(firstPage.events[2]?.sequence);

    const secondPage = TraceListResponseSchema.parse(
      (await get(h, `/api/tasks/${taskId}/traces?after=${firstPage.nextAfter}&limit=3`)).json,
    );
    // 游标是排他的：第二页不该重复第一页的最后一条
    expect(secondPage.events[0]?.sequence).toBeGreaterThan(firstPage.nextAfter ?? 0);

    // 逐页翻完等于一次全取
    const paged = [...firstPage.events, ...secondPage.events];
    expect(paged.map((e) => e.sequence)).toEqual(all.events.slice(0, 6).map((e) => e.sequence));
  });

  it('任务不存在 → 404，而不是一页空轨迹', async () => {
    const h = open();
    // 空页会让「ID 打错了」看起来像「这个任务还没产生轨迹」，
    // 于是前端会一直轮询一个永远不存在的任务
    const response = await get(h, '/api/tasks/nope/traces');
    expect(response.status).toBe(404);
    expect(PublicErrorSchema.parse(response.json).code).toBe('TASK_NOT_FOUND');
  });

  it('?after 非法 → 400。静默归零意味着一次全量重放', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const response = await get(h, `/api/tasks/${taskId}/traces?after=abc`);
    expect(response.status).toBe(400);
    const error = PublicErrorSchema.parse(response.json);
    expect(error.code).toBe('TASK_INPUT_INVALID');
    expect(error.location).toBe('query:after');
  });
});

describe('GET /api/tasks/:id/artifact', () => {
  it('元信息带正文，checksum 与 byteSize 都是真的', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const response = await get(h, `/api/tasks/${taskId}/artifact`);
    expect(response.status).toBe(200);
    const artifact = ArtifactViewSchema.parse(response.json);

    expect(artifact.fileName).toBe('chapter.md');
    expect(artifact.content).toContain(TITLE_TEXT);
    expect(artifact.checksum).toBeTruthy();
    expect(artifact.byteSize).toBe(Buffer.byteLength(artifact.content ?? '', 'utf8'));
  });

  it('「任务不存在」与「还没组装」是两个不同的 404', async () => {
    const h = open();
    const pending = await createTask(h, '还没跑的一章');

    const notReady = await get(h, `/api/tasks/${pending}/artifact`);
    expect(notReady.status).toBe(404);
    const notReadyError = PublicErrorSchema.parse(notReady.json);
    expect(notReadyError.code).toBe('ARTIFACT_NOT_FOUND');
    expect(notReadyError.action).toBe('等待任务完成后再下载');

    const notFound = await get(h, '/api/tasks/nope/artifact');
    expect(notFound.status).toBe(404);
    // 同一个状态码，但下一步动作完全不同：一个是等，一个是别等了
    expect(PublicErrorSchema.parse(notFound.json).code).toBe('TASK_NOT_FOUND');
  });
});

describe('GET /api/tasks/:id/artifact/download', () => {
  it('响应头能让浏览器存成正确的文件名，Content-Length 是 UTF-8 字节数', async () => {
    const h = open({ provider: happyPathProvider() });
    const taskId = await completedTask(h);

    const response = await h.server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/artifact/download`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');

    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="chapter.md"');
    expect(disposition).toContain("filename*=UTF-8''chapter.md");

    // Content-Length 是 Fastify 按 Buffer.byteLength 算的，路由不手写
    // （见 tasks-read.ts 那里的注释）。这条断言守的是「将来别有人手写一个错的」：
    // 正文是中文，UTF-16 码元数比 UTF-8 字节数少近三分之二，
    // 用 body.length 填进去，下载会在中途被截断。
    const bytes = Buffer.byteLength(response.body, 'utf8');
    expect(Number(response.headers['content-length'])).toBe(bytes);
    expect(bytes, '正文必须含中文，否则上一行两种算法同值，等于没测').toBeGreaterThan(
      response.body.length,
    );
    expect(response.body).toContain(TITLE_TEXT);
  });

  it('未组装的任务下载 → 404 ARTIFACT_NOT_FOUND，不返回一个空文件', async () => {
    const h = open();
    const pending = await createTask(h, '还没跑的一章');
    const response = await get(h, `/api/tasks/${pending}/artifact/download`);
    expect(response.status).toBe(404);
    expect(PublicErrorSchema.parse(response.json).code).toBe('ARTIFACT_NOT_FOUND');
  });
});

// ===========================================================================
// M5 完成判据：presentation 三字段在 6 种任务态下均符合附录 B
// ===========================================================================

describe('附录 B.1：GET /api/tasks 的 presentation 三字段', () => {
  /** 取列表里那唯一一个任务的 presentation。走列表而不是详情——判据点的就是列表 */
  async function presentationOf(h: ApiHarness): Promise<{ tone: string; state: string; detail: string }> {
    const list = (await get(h, '/api/tasks')).json as { presentation: { tone: string; state: string; detail: string } }[];
    const first = list[0];
    if (first === undefined) throw new Error('任务列表是空的');
    return first.presentation;
  }

  it('① ready → idle / 待启动', async () => {
    const h = open();
    await createTask(h, '待启动的一章');
    expect(await presentationOf(h)).toEqual({
      tone: 'idle',
      state: '待启动',
      detail: '冻结输入已就绪，尚未开始生产',
    });
  });

  it('④ running + phase=structure → run / 创建结构', async () => {
    // 让结构那一轮挂住，任务就停在 running/structure 上给我们看
    const h = open({ provider: new FakeProvider({ turns: [{ hangMs: 60_000 }] }) });
    const taskId = await createTask(h, '正在设计结构');
    const running = h.forge.lifecycle.start(taskId);
    await waitFor(() => h.forge.uow.repositories.tasks.getOrThrow(taskId).activeExecutionId !== null);

    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('run');
    expect(presentation.state).toBe('创建结构');

    h.forge.lifecycle.stop(taskId);
    await running;
  });

  it('⑥ running + phase=slots + 有 running slot → run / 正在填充 Slot，detail 点名槽位与类型名', async () => {
    const h = open({
      provider: new FakeProvider({
        turns: [{ submitStructure: VALID_STRUCTURE }, { hangMs: 60_000 }],
      }),
    });
    const taskId = await createTask(h, '正在填充');
    const running = h.forge.lifecycle.start(taskId);
    await waitFor(
      () => h.forge.uow.repositories.slots.get(taskId, 'outline')?.status === 'running',
    );

    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('run');
    expect(presentation.state).toBe('正在填充 Slot');
    // 附录 B.1 第 6 行：`{slotId} {typeName}生成中`。typeName 是槽位**类型名**
    // 而不是类型 ID——「chapter_outline 生成中」不是给人看的
    expect(presentation.detail).toContain('outline');
    expect(presentation.detail).toContain('章节骨架');

    h.forge.lifecycle.stop(taskId);
    await running;
  });

  it('⑨ stopped → idle / 已停止，detail 点名从哪里续跑', async () => {
    const h = open({
      provider: new FakeProvider({
        turns: [
          { submitStructure: VALID_STRUCTURE },
          { submitContent: { slotId: 'outline', content: outlineText() } },
          { hangMs: 60_000 },
        ],
      }),
    });
    const taskId = await createTask(h, '被停下的一章');
    const running = h.forge.lifecycle.start(taskId);
    await waitFor(
      () => h.forge.uow.repositories.slots.get(taskId, 'outline')?.status === 'completed',
    );
    h.forge.lifecycle.stop(taskId);
    await running;

    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('idle');
    expect(presentation.state).toBe('已停止');
    // 「可从 xxx 续跑」——中断点是文档序里第一个未完成的内容槽位
    expect(presentation.detail).toContain('title');
  });

  it('⑩ failed + phase=structure → fail / 结构校验失败，detail 是成文中文不是错误码（D-19）', async () => {
    const h = open({
      provider: new FakeProvider({
        turns: [
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
          { invalidStructure: 'DEPENDENCY_ON_CONTAINER' },
        ],
      }),
    });
    const taskId = await createTask(h, '结构会失败的一章');
    await h.forge.lifecycle.start(taskId);

    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('fail');
    expect(presentation.state).toBe('结构校验失败');
    expect(presentation.detail).toBeTruthy();
    // D-19：派生层只取用不重建，lifecycle 写进去的必须已经是一句人话
    expect(presentation.detail).not.toContain('STRUCTURE_RETRY_EXHAUSTED');
  });

  it('⑬ completed → ok / 已完成', async () => {
    const h = open({ provider: happyPathProvider() });
    await completedTask(h);

    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('ok');
    expect(presentation.state).toBe('已完成');
    expect(presentation.detail).toContain('4');
  });

  it('⑭ 兜底行：脏数据不把整页打成 500（D-19）', async () => {
    const h = open();
    const taskId = await createTask(h, '状态组合非法的一章');
    // running + phase=done 是表里 20 种组合中没被覆盖的那一类。
    // 它进不了正常流程，但一次崩溃或一次手改数据库就能造出来，
    // 而那时整个任务列表页不该因为一行数据打不开
    h.forge.uow.run((uow) => uow.tasks.update(taskId, { status: 'running', phase: 'done' }));

    const response = await get(h, '/api/tasks');
    expect(response.status).toBe(200);
    const presentation = await presentationOf(h);
    expect(presentation.tone).toBe('idle');
    expect(presentation.state).toBe('状态未知');
    // 组合原样写进 detail 才排查得动
    expect(presentation.detail).toContain('running');
    expect(presentation.detail).toContain('done');
  });
});
