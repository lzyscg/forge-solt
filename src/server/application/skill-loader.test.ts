import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import { loadSkill, parseSkill } from './skill-loader.ts';

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const skillPath = (name: string): string => path.join(FIXTURES, 'skills', name, 'SKILL.md');

/** 各用例只改一处，其余保持合法——否则断言到的可能是另一条规则 */
const VALID = `---
id: scene-writing
version: 1.0.0
operation: fill_slot
slotTypes: [scene]
summary: 通过可见行动推进场景。
requiredSections: [S1, S6]
---

# 场景写作 Skill

前言部分。

## S1. 理解槽位目标

读 instruction。

## S6. 提交前自检

检查字数。
`;

/**
 * R4：审核 Skill 的基准合法样本。判据 = `## S<n>` 章节（D-23，调度器按 sections 顺序枚举）。
 * 与 VALID 分开一份，是因为 review_slot 的规则与 fill_slot 不同，
 * 复用同一份再逐条 replace 会让「这条用例到底在测哪条规则」变得看不出来。
 */
const REVIEW_VALID = `---
id: scene-review
version: 1.0.0
operation: review_slot
slotTypes: [scene]
summary: 按判据检查场景正文。
requiredSections: []
---

# 场景审核 Skill

前言部分。

## S1. 首段承接

检查首段。

## S2. 可见行动

检查行动。
`;

describe('parseSkill：合法文件', () => {
  it('解析 frontmatter、前言与 section 索引', () => {
    const skill = parseSkill(VALID, skillPath('scene-writing'));

    expect(skill.id).toBe('scene-writing');
    expect(skill.operation).toBe('fill_slot');
    expect(skill.slotTypes).toEqual(['scene']);
    expect(skill.summary).toBe('通过可见行动推进场景。');
    expect(skill.requiredSections).toEqual(['S1', 'S6']);
    // 前言 = frontmatter 之后、首个 `## S1` 之前的内容（§4.3），含一级标题
    expect(skill.preamble).toBe('# 场景写作 Skill\n\n前言部分。');
    expect(skill.sections.map((s) => s.id)).toEqual(['S1', 'S6']);
    expect(skill.sectionIndex['S1']?.title).toBe('理解槽位目标');
    expect(skill.sectionIndex['S6']?.content).toBe('检查字数。');
  });

  it('section 顺序按文件出现序，不按 ID 排序', () => {
    const raw = VALID.replace('requiredSections: [S1, S6]', 'requiredSections: []')
      .replace('## S1. 理解槽位目标', '## S9. 后写的章节')
      .replace('## S6. 提交前自检', '## S2. 先写的章节');
    // 注入顺序影响模型理解，因此必须是文件序而不是 S2 < S9 的字典序
    expect(parseSkill(raw, 'x/SKILL.md').sections.map((s) => s.id)).toEqual(['S9', 'S2']);
  });

  it('contentHash 对同一内容稳定、对任意修改敏感', () => {
    const a = parseSkill(VALID, 'x/SKILL.md').contentHash;
    const b = parseSkill(VALID, 'y/SKILL.md').contentHash;
    // 路径不参与哈希：同一份 Skill 在不同机器上的绝对路径不同，
    // 让路径进 hash 会让快照隔离的判据随部署环境漂移
    expect(a).toBe(b);
    // 只多一个换行也必须换 hash —— 快照隔离要的正是「改了就是改了」
    expect(parseSkill(`${VALID}\n`, 'x/SKILL.md').contentHash).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CRLF 与 LF 得到同一个 contentHash', () => {
    // 否则在 Windows 上 checkout 一次仓库，所有历史快照就全部失配
    const crlf = VALID.replace(/\n/g, '\r\n');
    expect(parseSkill(crlf, 'x/SKILL.md').contentHash).toBe(parseSkill(VALID, 'x/SKILL.md').contentHash);
  });

  it('非 S 开头的二级标题终止当前 section', () => {
    const raw = VALID.replace('## S6. 提交前自检\n\n检查字数。', '## 附录\n\n不属于任何 section。');
    const skill = parseSkill(raw.replace('requiredSections: [S1, S6]', 'requiredSections: [S1]'), 'x/SKILL.md');
    expect(skill.sections.map((s) => s.id)).toEqual(['S1']);
    expect(skill.sectionIndex['S1']?.content).toBe('读 instruction。');
  });
});

describe('parseSkill：非法文件各自被拒', () => {
  const rejects = (raw: string, expected: RegExp): void => {
    try {
      parseSkill(raw, skillPath('scene-writing'));
      throw new Error('本应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe('TEMPLATE_INVALID');
      expect((error as ForgeError).message).toMatch(expected);
    }
  };

  it('没有 frontmatter', () => {
    rejects('# 只有正文\n', /frontmatter/);
  });

  it('frontmatter 未闭合', () => {
    rejects('---\nid: scene-writing\n', /没有闭合/);
  });

  it('frontmatter 不是合法 YAML', () => {
    rejects('---\nid: [unclosed\n---\n', /不是合法 YAML/);
  });

  it('缺 summary（§4.3 新增约束 1）', () => {
    rejects(VALID.replace('summary: 通过可见行动推进场景。\n', ''), /summary/);
  });

  it('多余字段（strict）', () => {
    rejects(VALID.replace('slotTypes: [scene]', 'slotType: [scene]'), /slotType/);
  });

  it('Section ID 不匹配 ^S\\d+$（§4.3 新增约束 2）', () => {
    rejects(VALID.replace('requiredSections: [S1, S6]', 'requiredSections: [概述]'), /Section ID/);
  });

  it('requiredSections 指向不存在的章节', () => {
    rejects(VALID.replace('requiredSections: [S1, S6]', 'requiredSections: [S1, S7]'), /S7/);
  });

  it('section ID 重复', () => {
    rejects(VALID.replace('## S6. 提交前自检', '## S1. 又一个 S1'), /重复/);
  });

  it('fill_slot 未声明 slotTypes', () => {
    rejects(VALID.replace('slotTypes: [scene]\n', ''), /fill_slot/);
  });

  it('create_structure 却声明了 slotTypes', () => {
    rejects(VALID.replace('operation: fill_slot', 'operation: create_structure'), /create_structure/);
  });

  it('version 不是三段式', () => {
    rejects(VALID.replace('version: 1.0.0', 'version: v1'), /三段式/);
  });

  // --- R4 / FR-TPL-003：审核 Skill 的三条规则 ---

  it('review_slot 未声明 slotTypes', () => {
    // 不声明就没法在模板编译期校验「reviewSlotByType.scene 绑的这份 Skill 管不管 scene」，
    // 错配会一路漏到运行时——那时已经在按一份不适用的判据审内容了
    rejects(REVIEW_VALID.replace('slotTypes: [scene]\n', ''), /review_slot/);
  });

  it('review_slot 一条判据都没有', () => {
    // 运行期表现是「槽位进 reviewing → 枚举出 0 条判据 → 立刻结算成未检出问题」：
    // 一个配了却什么都没审的静默空转，比没配审核更危险
    const noCriteria = REVIEW_VALID.replace(
      '## S1. 首段承接\n\n检查首段。\n\n## S2. 可见行动\n\n检查行动。\n',
      '',
    );
    rejects(noCriteria, /至少声明一条判据/);
  });

  it('审核 Skill 的判据 ID 重复', () => {
    // 判据 ID 是 slot_reviews 主键的组成部分：重复会让后一条审核结果
    // 覆盖掉前一条，四条判据只落三行，而没有任何地方会报错
    rejects(REVIEW_VALID.replace('## S2. 可见行动', '## S1. 又一个 S1'), /重复/);
  });
});

describe('parseSkill：审核 Skill（R4）', () => {
  it('判据即 sections，按文件出现序', () => {
    const skill = parseSkill(REVIEW_VALID, skillPath('scene-review'));
    expect(skill.operation).toBe('review_slot');
    expect(skill.slotTypes).toEqual(['scene']);
    expect(skill.sections.map((s) => s.id)).toEqual(['S1', 'S2']);
  });
});

describe('skills/scene-review/SKILL.md：上线的那份审核 Skill（R4）', () => {
  // 测的是仓库里真正会被加载的那份文件，不是夹具——
  // 夹具过了而真文件没过，等于什么都没验（§6.4 同一条理由）
  const REAL = fileURLToPath(new URL('../../../skills/scene-review/SKILL.md', import.meta.url));

  it('四条判据全部上线（D-28），ID 为 S1..S4', async () => {
    const skill = await loadSkill(REAL);
    expect(skill.operation).toBe('review_slot');
    expect(skill.slotTypes).toEqual(['scene']);
    expect(skill.sections.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  it('前两条判据的标题与 zhihu-chapter 的 scene guidance 逐字一致（§6.3）', async () => {
    const skill = await loadSkill(REAL);
    const templateYaml = await readFile(
      fileURLToPath(new URL('../../../templates/zhihu-chapter/template.yaml', import.meta.url)),
      'utf8',
    );
    // 判据一/二正是实测 3/3 的那两条。它们与模板 guidance 同源，
    // 一旦有人只改一边，写作要求与审核判据就会开始漂移而无人察觉
    for (const title of [skill.sections[0]?.title, skill.sections[1]?.title]) {
      expect(title).toBeTruthy();
      expect(templateYaml).toContain(`      - ${title ?? ''}\n`);
    }
  });

  it('判据文本逐字取自 scene-writing（§6.3：不另写一套标准）', async () => {
    const review = await loadSkill(REAL);
    const writing = await loadSkill(
      fileURLToPath(new URL('../../../skills/scene-writing/SKILL.md', import.meta.url)),
    );
    const writingText = [writing.preamble, ...writing.sections.map((s) => s.content)].join('\n');
    // 引文块（`> ` 开头）必须能在写作 Skill 里逐字找到。审核判据自己另写一套措辞，
    // 测到的就变成「两份标准的分歧」，而不是「模型能不能判」
    const quoted = review.sections
      .flatMap((s) => s.content.split('\n'))
      .filter((line) => line.startsWith('> ') && line.trim() !== '>')
      .map((line) => line.slice(2).trim());
    expect(quoted.length).toBeGreaterThan(10);
    for (const line of quoted) {
      if (line.startsWith('自检项：')) {
        expect(writingText).toContain(line.slice('自检项：'.length));
      } else {
        expect(writingText).toContain(line);
      }
    }
  });

  it('注入模型的部分不含实测可靠度记录（会告诉模型 S3/S4 没用）', async () => {
    const skill = await loadSkill(REAL);
    // preamble 与 sections 是 buildReviewSlotTexts 唯一会注入 system prompt 的两处。
    // 「0/3」这类工程事实必须留在 RELIABILITY.md 里，进了 prompt 就是在教模型放行
    const injected = [skill.summary, skill.preamble, ...skill.sections.map((s) => s.content)].join('\n');
    expect(injected).not.toContain('0/3');
    expect(injected).not.toContain('未验证有效');
  });

  it('措辞不出现「审核通过」「质量合格」「已校验」（D-30 / FR-REVIEW-004）', async () => {
    const raw = await readFile(REAL, 'utf8');
    for (const banned of ['审核通过', '质量合格', '已校验']) {
      expect(raw).not.toContain(banned);
    }
  });
});

describe('loadSkill', () => {
  it('读取真实夹具', async () => {
    const skill = await loadSkill(skillPath('chapter-structure-design'));
    expect(skill.operation).toBe('create_structure');
    expect(skill.slotTypes).toEqual([]);
    expect(Object.keys(skill.sectionIndex)).toEqual(['S1', 'S2', 'S3']);
  });

  it('文件不存在归为 TEMPLATE_INVALID（是模板的 source 指错了）', async () => {
    await expect(loadSkill(skillPath('no-such-skill'))).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
    });
  });
});
