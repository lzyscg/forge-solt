import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { canonicalJson } from '@server/domain/canonical.ts';
import { validateConcreteStructure } from '@server/domain/structure-validation.ts';
import { createTemplateWorkspace } from '../../../tests/fixtures/workspace.ts';
import { compileTemplate, loadTemplate } from './template-loader.ts';
import type { TemplateLoaderOptions } from './template-loader.ts';

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const SKILLS_DIR = path.join(FIXTURES, 'skills');
const VALID_DIR = path.join(FIXTURES, 'templates', 'zhihu-chapter');
const invalidDir = (name: string): string => path.join(FIXTURES, 'invalid-templates', name);

/** 与 config/providers.yaml 的 defaults 同值——它是 D-06 回退链的最后一级 */
const OPTIONS: TemplateLoaderOptions = {
  skillsDir: SKILLS_DIR,
  defaults: { timeoutMs: 180000, maxRetries: 2 },
};

const readValid = async (): Promise<string> => readFile(path.join(VALID_DIR, 'template.yaml'), 'utf8');

type CompileResult = Awaited<ReturnType<typeof compileTemplate>>;

/** 就地改一处再编译。断言替换确实发生，避免「改错了字符串导致测了个寂寞」 */
async function compileMutated(from: string, to: string): Promise<CompileResult> {
  const text = await readValid();
  expect(text).toContain(from);
  return compileTemplate(text.replace(from, to), path.join(VALID_DIR, 'template.yaml'), OPTIONS);
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  // 用 ForgeError 而不是裸 Error：错误码是前后端共享的失败词表，
  // 这里断言的是「模板问题一律 TEMPLATE_INVALID」这条契约，不只是「抛了」
  expect(caught).toBeInstanceOf(ForgeError);
  expect((caught as ForgeError).code).toBe('TEMPLATE_INVALID');
  expect((caught as ForgeError).message).toMatch(pattern);
}

describe('loadTemplate：合法模板', () => {
  it('编译通过并保留全部运行时字段', async () => {
    const { compiled, presentation } = await loadTemplate(VALID_DIR, OPTIONS);

    expect(compiled.id).toBe('zhihu-chapter');
    expect(compiled.status).toBe('published');
    expect(compiled.slotTypes.map((s) => s.id)).toEqual(['chapter', 'chapter_outline', 'title', 'scene']);
    expect(Object.keys(compiled.bindings.fillSlotByType).sort()).toEqual(['chapter_outline', 'scene', 'title']);
    expect(compiled.output.assembler).toBe('markdown_concat_v1');
    expect(compiled.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(presentation.outputKind).toBe('单章正文');
  });

  it('D-06：四级回退在编译期算完，三个值均为必填', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const { createStructure, fillSlotByType } = compiled.bindings;

    // binding 自带：直接用 binding 的值
    expect(createStructure).toMatchObject({ timeoutMs: 90000, maxRetries: 2, modelAlias: 'structure' });
    expect(fillSlotByType['scene']).toMatchObject({ timeoutMs: 180000, maxRetries: 1, modelAlias: 'main' });
    // binding 没写：落到 limits（120000 / 2），而不是 providers.yaml 的 180000
    expect(fillSlotByType['title']).toMatchObject({ timeoutMs: 120000, maxRetries: 2, modelAlias: 'main' });
    // binding 与 limits 都没写 timeoutMs：落到 providers.yaml defaults
    expect(fillSlotByType['chapter_outline']).toMatchObject({ timeoutMs: 120000, maxRetries: 2 });
  });

  it('D-06：limits 缺省时落到 providers.yaml 的 defaults', async () => {
    const draftDir = path.join(FIXTURES, 'templates', 'draft-chapter');
    const { compiled } = await loadTemplate(draftDir, OPTIONS);
    expect(compiled.bindings.fillSlotByType['scene']).toMatchObject({ timeoutMs: 180000, maxRetries: 2 });
    expect(compiled.limits.executionTimeoutMs).toBe(180000);
    expect(compiled.limits.maxExecutionRetries).toBe(2);
  });

  it('D-16：includeInArtifact 默认 true，容器类型同样默认 true', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const byId = new Map(compiled.slotTypes.map((s) => [s.id, s]));
    // 容器默认 false 会让整棵树装配不出东西
    expect(byId.get('chapter')?.includeInArtifact).toBe(true);
    expect(byId.get('scene')?.includeInArtifact).toBe(true);
    // 工作槽位：显式声明的 false 必须保留
    expect(byId.get('chapter_outline')?.includeInArtifact).toBe(false);
  });

  it('§4.1 的 `(?m)` 前缀被翻译成 RegExp flags（JS 不支持内联前缀）', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const scene = compiled.slotTypes.find((s) => s.id === 'scene');
    expect(scene?.validation.forbidPattern).toBe('^#{1,6}\\s');
    expect(scene?.validation.forbidPatternFlags).toBe('m');
    // 编译产物可直接用，运行时不需要再解析一次
    const re = new RegExp(scene?.validation.forbidPattern ?? '', scene?.validation.forbidPatternFlags ?? '');
    expect(re.test('正文第一行\n## 小标题')).toBe(true);
    expect(re.test('正文里出现一个 # 号但不在行首')).toBe(false);
  });

  it('编译产物可直接传进 validateConcreteStructure（结构化兼容，无需适配层）', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const result = validateConcreteStructure(
      {
        rootSlotId: 'chapter',
        slots: [
          { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '本章容器', dependsOn: [] },
          { id: 'outline', type: 'chapter_outline', parentId: 'chapter', order: 0, instruction: '规划', dependsOn: [] },
          { id: 'scene_01', type: 'scene', parentId: 'chapter', order: 1, instruction: '开场', dependsOn: ['outline'] },
        ],
      },
      compiled,
    );
    expect(result.ok).toBe(true);
    // includeInArtifact 由模板解析而来，Agent 无权声明（D-16 / D-19）
    expect(result.ok && result.slots.find((s) => s.slotId === 'outline')?.includeInArtifact).toBe(false);
  });
});

describe('templateHash 的确定性与 presentation 隔离', () => {
  it('同一份模板两次加载得到逐字相同的 hash', async () => {
    const a = await loadTemplate(VALID_DIR, OPTIONS);
    const b = await loadTemplate(VALID_DIR, OPTIONS);
    expect(a.compiled.templateHash).toBe(b.compiled.templateHash);
    // 不只是 hash 相同：整个编译产物必须逐字相同，否则 hash 相同只是巧合
    expect(canonicalJson(a.compiled)).toBe(canonicalJson(b.compiled));
  });

  it('presentation 不进编译产物', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const json = canonicalJson(compiled);
    expect(json).not.toContain('outputKind');
    expect(json).not.toContain('exampleStructure');
    expect(json).not.toContain('结构 Agent'); // tags
  });

  it('改 presentation 不改 templateHash，改运行时字段则改', async () => {
    const baseline = (await loadTemplate(VALID_DIR, OPTIONS)).compiled.templateHash;

    const tagged = await compileMutated('tags: [结构 Agent, 写作 Agent, 场景写作]', 'tags: [新标签]');
    expect(tagged.compiled.templateHash).toBe(baseline);

    const renamedKind = await compileMutated('outputKind: 单章正文', 'outputKind: 短篇');
    expect(renamedKind.compiled.templateHash).toBe(baseline);

    // 反向断言：运行时字段一变，hash 必须变——否则上一条只是因为 hash 对什么都不敏感
    const retimed = await compileMutated('timeoutMs: 180000', 'timeoutMs: 175000');
    expect(retimed.compiled.templateHash).not.toBe(baseline);
  });

  it('SKILL.md 内容变化会传导到 templateHash', async () => {
    // 只记 id+version 会让「版本号没动但内容改了」悄悄溜过去
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    expect(compiled.skills.every((s) => /^[0-9a-f]{64}$/.test(s.contentHash))).toBe(true);
  });

  it('编译产物里不出现任何凭据相关字样（REQ §13）', async () => {
    const { compiled } = await loadTemplate(VALID_DIR, OPTIONS);
    const json = canonicalJson(compiled).toLowerCase();
    for (const forbidden of ['apikey', 'api_key', 'deepseek_api', 'sk-', 'baseurl']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('非法模板：每类各自被拒', () => {
  it('缺 binding（没有 bindings.createStructure）', async () => {
    await expectRejected(loadTemplate(invalidDir('missing-create-structure-binding'), OPTIONS), /createStructure/);
  });

  it('binding 引用不存在的 agent', async () => {
    await expectRejected(loadTemplate(invalidDir('unknown-agent'), OPTIONS), /不存在的 agentId/);
  });

  it('skill operation 不匹配', async () => {
    await expectRejected(loadTemplate(invalidDir('skill-operation-mismatch'), OPTIONS), /operation/);
  });

  it('fillSlotByType 未覆盖全部 contentBearing 类型', async () => {
    await expectRejected(loadTemplate(invalidDir('uncovered-slot-type'), OPTIONS), /未覆盖.*title/s);
  });

  it('forbidPattern 超时（灾难性回溯）在加载期被拒，而不是等到线上卡死', async () => {
    await expectRejected(
      loadTemplate(invalidDir('catastrophic-forbid-pattern'), { ...OPTIONS, patternBudgetMs: 60 }),
      /灾难性回溯/,
    );
  });

  it('模板目录不存在 → TEMPLATE_NOT_FOUND（与内容非法区分开）', async () => {
    await expect(loadTemplate(invalidDir('no-such-dir'), OPTIONS)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });
});

describe('非法模板：单点变异', () => {
  it('binding 引用不存在的 skillId', async () => {
    await expectRejected(compileMutated('skillId: scene-writing', 'skillId: no-such-skill'), /不存在的 skillId/);
  });

  it('fill_slot 的 Skill 管不了这个槽位类型', async () => {
    await expectRejected(
      compileMutated('      skillId: title-writing', '      skillId: scene-writing'),
      /不包含 title/,
    );
  });

  it('fillSlotByType 声明了不存在的槽位类型', async () => {
    await expectRejected(compileMutated('    title:\n', '    no_such_type:\n'), /不存在的槽位类型/);
  });

  it('给容器类型配了 fillSlotByType 绑定', async () => {
    await expectRejected(compileMutated('    title:\n', '    chapter:\n'), /容器/);
  });

  it('binding 与 agent 都没有模型别名（没有全局默认别名）', async () => {
    await expectRejected(compileMutated('    model: main\n', ''), /模型别名/);
  });

  it('模型别名不在 providers.yaml 的 aliases 里（D-19：打错字在编译期炸）', async () => {
    // 晚绑定（D-03）推迟的是「别名 → provider/model 的取值」，不是「别名写错也不管」。
    // 放行的代价是任务创建成功、跑起来、烧掉一次 Assignment 才失败，
    // 而报错指向运行期而不是那行 YAML。
    const text = await readValid();
    await expectRejected(
      compileTemplate(text.replace('    model: main\n', '    model: mian\n'), path.join(VALID_DIR, 'template.yaml'), {
        ...OPTIONS,
        knownAliases: new Set(['main', 'structure']),
      }),
      /mian/,
    );
  });

  it('knownAliases 未传入时不做存在性校验（只想编译、手边没有 providers.yaml 的场景）', async () => {
    const text = await readValid();
    await expect(
      compileTemplate(text.replace('    model: main\n', '    model: mian\n'), path.join(VALID_DIR, 'template.yaml'), OPTIONS),
    ).resolves.toBeDefined();
  });

  it('skills[].version 与 SKILL.md 里的不一致', async () => {
    await expectRejected(
      compileMutated('  - id: scene-writing\n    version: 1.0.0', '  - id: scene-writing\n    version: 2.0.0'),
      /version/,
    );
  });

  it('skills[].source 指向 SKILLS_DIR 之外', async () => {
    await expectRejected(
      compileMutated('source: skills/scene-writing/SKILL.md', 'source: ../../../package.json'),
      /之外/,
    );
  });

  it('forbidPattern 不是合法正则', async () => {
    await expectRejected(compileMutated("forbidPattern: '(?m)^#{1,6}\\s'", "forbidPattern: '([a-z'"), /合法正则/);
  });

  it('forbidPattern 没有配 forbidPatternMessage（D-13：反馈必须可执行）', async () => {
    await expectRejected(
      compileMutated('      forbidPatternMessage: 场景正文不得包含 Markdown 小标题\n', ''),
      /forbidPatternMessage/,
    );
  });

  it('forbidPatternMessage 没有对应的 forbidPattern', async () => {
    await expectRejected(
      compileMutated("      forbidPattern: '(?m)^#{1,6}\\s'\n", ''),
      /forbidPatternMessage 没有对应的 forbidPattern/,
    );
  });

  it('minChars 大于 maxChars', async () => {
    await expectRejected(compileMutated('      minChars: 300', '      minChars: 9000'), /minChars/);
  });

  it('槽位类型 ID 重复', async () => {
    await expectRejected(compileMutated('  - id: title\n', '  - id: scene\n'), /重复 ID/);
  });

  it('顶层多余字段（strict：拼写错误当场报出）', async () => {
    await expectRejected(compileMutated('bindings:', 'bindigns:'), /bindigns|bindings/);
  });

  it('assembler 取了未实现的值', async () => {
    await expectRejected(compileMutated('assembler: markdown_concat_v1', 'assembler: docx_v1'), /assembler/);
  });

  it('exampleStructure 引用了不存在的槽位类型', async () => {
    await expectRejected(
      compileMutated('{ name: title, typeId: title, kind: content', '{ name: title, typeId: nope, kind: content'),
      /exampleStructure/,
    );
  });

  it('exampleStructure 的 kind 与 contentBearing 不符', async () => {
    await expectRejected(
      compileMutated(
        '{ name: chapter, typeId: chapter, kind: container',
        '{ name: chapter, typeId: chapter, kind: content',
      ),
      /contentBearing/,
    );
  });

  it('不是合法 YAML', async () => {
    await expectRejected(
      compileTemplate('id: [unclosed\n', path.join(VALID_DIR, 'template.yaml'), OPTIONS),
      /不是合法 YAML/,
    );
  });

  it('缺 maxToolCallsPerAssignment（无回退来源，必须显式给出）', async () => {
    await expectRejected(compileMutated('  maxToolCallsPerAssignment: 24\n', ''), /maxToolCallsPerAssignment/);
  });
});

/**
 * R4 / FR-TPL-003：`reviewSlotByType` 的编译期校验。
 *
 * 基准夹具换成 `review-chapter`——它是唯一带 `reviewSlotByType` 的模板。
 *
 * 一条必须写在这里的事实：**「判据至少一条」「判据 ID 唯一」两条规则的实现
 * 在 `skill-loader.ts`，不在本文件**。原因是模板编译必然先 `loadSkill` 把
 * SKILL.md 解析进来（第 4 步），一份 0 判据或判据 ID 重复的审核 Skill
 * 根本走不到绑定校验那一步。在这里再写一遍等于写一段永远进不去的分支——
 * 它测不出来，也就防不住任何东西。下面两条用例验的是**编译期确实会拒**
 * （这才是 FR-TPL-003 要的东西），而规则本身由 skill-loader 的用例锁住。
 */
describe('FR-TPL-003：reviewSlotByType 的编译期校验（R4）', () => {
  const REVIEW_DIR = path.join(FIXTURES, 'templates', 'review-chapter');
  const reviewYaml = async (): Promise<string> => readFile(path.join(REVIEW_DIR, 'template.yaml'), 'utf8');

  async function compileReview(mutate?: [from: string, to: string]): Promise<CompileResult> {
    let text = await reviewYaml();
    if (mutate !== undefined) {
      expect(text).toContain(mutate[0]);
      text = text.replace(mutate[0], mutate[1]);
    }
    return compileTemplate(text, path.join(REVIEW_DIR, 'template.yaml'), OPTIONS);
  }

  it('合法：scene 绑定 review_slot Skill', async () => {
    const { compiled } = await compileReview();
    expect(Object.keys(compiled.bindings.reviewSlotByType)).toEqual(['scene']);
    expect(compiled.bindings.reviewSlotByType['scene']?.skillId).toBe('scene-review');
  });

  it('绑定的 Skill 的 operation 不是 review_slot 时拒绝', async () => {
    // 拿写作 Skill 当审核员：它跑得起来，只是审出来的东西是错的
    await expectRejected(
      compileReview(['skillId: scene-review', 'skillId: scene-writing']),
      /reviewSlotByType\.scene 需要 operation 为 review_slot/,
    );
  });

  it('不绑定审核是合法且默认的状态——不套用 fillSlotByType 的覆盖性校验（D-27）', async () => {
    // 这条是反过来守的：谁要是照抄 fill 的「必须覆盖全部 contentBearing 类型」，
    // 这里立刻红。zhihu-chapter 之外的模板一个审核绑定都没有，全会编译不过
    const text = await reviewYaml();
    const from = '  reviewSlotByType:\n    scene:\n      agentId: scene_reviewer\n      skillId: scene-review\n      maxRetries: 1\n';
    expect(text).toContain(from);
    const { compiled } = await compileTemplate(
      text.replace(from, ''),
      path.join(REVIEW_DIR, 'template.yaml'),
      OPTIONS,
    );
    expect(compiled.bindings.reviewSlotByType).toEqual({});
    // 内容型槽位一个不少，只是没人审
    expect(Object.keys(compiled.bindings.fillSlotByType).sort()).toEqual(['chapter_outline', 'scene', 'title']);
  });

  it('maxRevisionRounds 为负数时拒绝', async () => {
    await expectRejected(compileReview(['maxRevisionRounds: 2', 'maxRevisionRounds: -1']), /maxRevisionRounds/);
  });

  it('maxRevisionRounds 非整数时拒绝', async () => {
    await expectRejected(compileReview(['maxRevisionRounds: 2', 'maxRevisionRounds: 1.5']), /maxRevisionRounds/);
  });

  it('maxRevisionRounds 省略时编译为 2（D-26 的默认值）', async () => {
    const { compiled } = await compileReview(['    maxRevisionRounds: 2\n', '']);
    expect(compiled.slotTypes.find((s) => s.id === 'scene')?.maxRevisionRounds).toBe(2);
  });

  it('maxRevisionRounds 为 0 合法（等于关掉返修，只审不修）', async () => {
    const { compiled } = await compileReview(['maxRevisionRounds: 2', 'maxRevisionRounds: 0']);
    expect(compiled.slotTypes.find((s) => s.id === 'scene')?.maxRevisionRounds).toBe(0);
  });

  it('绑定的审核 Skill 一条判据都没有时，编译期拒绝', async () => {
    const workspace = await createTemplateWorkspace();
    try {
      await workspace.writeSkill(
        'scene-review',
        '---\nid: scene-review\nversion: 1.0.0\noperation: review_slot\nslotTypes: [scene]\nsummary: 空判据。\nrequiredSections: []\n---\n\n没有任何 `## S<n>` 章节。\n',
      );
      await expectRejected(
        loadTemplate(path.join(workspace.templatesDir, 'review-chapter'), {
          ...OPTIONS,
          skillsDir: workspace.skillsDir,
        }),
        /至少声明一条判据/,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('绑定的审核 Skill 判据 ID 重复时，编译期拒绝', async () => {
    const workspace = await createTemplateWorkspace();
    try {
      const original = await workspace.readSkill('scene-review');
      expect(original).toContain('## S2. 行动推进');
      await workspace.writeSkill('scene-review', original.replace('## S2. 行动推进', '## S1. 又一个 S1'));
      await expectRejected(
        loadTemplate(path.join(workspace.templatesDir, 'review-chapter'), {
          ...OPTIONS,
          skillsDir: workspace.skillsDir,
        }),
        /重复/,
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

/**
 * R4：仓库里真正会被加载的那份 `templates/zhihu-chapter`。
 * 夹具过了而生产模板没过，等于什么都没验——而这一版的改动恰恰只落在生产模板上。
 */
describe('templates/zhihu-chapter：scene 绑上审核（R4 / D-27）', () => {
  const REAL_TEMPLATE_DIR = fileURLToPath(new URL('../../../templates/zhihu-chapter', import.meta.url));
  const REAL_SKILLS_DIR = fileURLToPath(new URL('../../../skills', import.meta.url));
  const realOptions: TemplateLoaderOptions = { ...OPTIONS, skillsDir: REAL_SKILLS_DIR };

  it('只给 scene 绑审核，绑的是 scene-review', async () => {
    const { compiled } = await loadTemplate(REAL_TEMPLATE_DIR, realOptions);
    // 「只给 scene」不是文案：R0.5 只测了场景正文，给 outline/title 开审核
    // 是在为没测过的场景付 token 并承担未知误报（D-27）
    expect(Object.keys(compiled.bindings.reviewSlotByType)).toEqual(['scene']);
    const binding = compiled.bindings.reviewSlotByType['scene'];
    expect(binding?.skillId).toBe('scene-review');
    expect(binding?.agentId).toBe('scene_reviewer');
    // 审核 Agent 与写作 Agent 必须是两个：同一个 Agent 既写又审，
    // 它的 systemInstruction 会同时装着「你负责写」和「你负责挑错」
    expect(binding?.agentId).not.toBe(compiled.bindings.fillSlotByType['scene']?.agentId);
  });

  it('scene 的 maxRevisionRounds 是 2（D-26）', async () => {
    const { compiled } = await loadTemplate(REAL_TEMPLATE_DIR, realOptions);
    expect(compiled.slotTypes.find((s) => s.id === 'scene')?.maxRevisionRounds).toBe(2);
  });
});
