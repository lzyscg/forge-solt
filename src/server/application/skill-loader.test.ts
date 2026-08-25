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
