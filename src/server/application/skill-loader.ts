/**
 * SKILL.md 加载器（文档 §4.3）。
 *
 * Skill 文件是**跨进程边界的不可信输入**（人手改、可能来自别处拷贝），
 * 因此 frontmatter 一律走 Zod 解析而不是手写 interface + `as`（§3 判据表）。
 * 而解析之后的 `LoadedSkill` 是进程内自造自用的形状，用普通 TS 类型即可。
 *
 * 这一层只做「读 + 解析 + 索引 + 哈希」，不做任何注入决策：
 * 哪些 section 进 Context 是 ContextBuilder 的事（§7.4），
 * 这里只负责让它能按 `sectionId` O(1) 取到内容。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { OperationSchema } from '@shared/contracts.ts';
import type { Operation } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import { sha256Hex } from '@server/domain/canonical.ts';

/**
 * Section ID 的形态约束（§4.3 新增约束 2）。
 *
 * 之所以卡这么死：`read_skill_section` 的 `sectionId` 参数由**模型**填，
 * 宽松的 ID 规则（允许标题全文、允许中文）会让模型倾向于传「## S1. 理解槽位目标」
 * 这样的整行，进而稳定地拿到 `SKILL_SECTION_NOT_FOUND`。
 * 固定成 `S1` 这种两三个字符的形式，模型的命中率显著更高。
 */
const SECTION_ID_PATTERN = /^S\d+$/;

/** `## S1. 标题` / `## S12 标题` 都算 section 起点；ID 后的句点可有可无（§4.3 解析规则） */
const SECTION_HEADING_PATTERN = /^##\s+(S\d+)\.?(?:\s+(.*))?$/;

/** 任意一级标题都终止当前 section。`#` 一级标题在 section 之后出现属于文件写法异常，但不该被吞进上一段 */
const ANY_HEADING_PATTERN = /^#{1,2}\s/;

/**
 * frontmatter 契约。
 *
 * 用 `.strict()`：多写一个 `slotType:`（少个 s）这类拼写错误，
 * 宽松模式下会被静默忽略，然后表现为「这个 Skill 莫名其妙不匹配任何槽位类型」——
 * 一个要靠通读 YAML 才能发现的 bug。strict 让它在加载期就报出来。
 */
const SkillFrontmatterSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Skill id 只能是小写字母、数字与连字符，且以字母开头'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Skill version 必须是 x.y.z 三段式'),
    operation: OperationSchema,
    /** 该 Skill 能填哪些槽位类型。`create_structure` 用不上，见下方 superRefine */
    slotTypes: z.array(z.string().min(1)).default([]),
    /** §4.3 新增约束 1：必填。它是 Context 的 Skill Overview 段与模板详情页 skillSummary 的唯一数据源 */
    summary: z.string().min(1, 'summary 为必填（§4.3 新增约束 1）'),
    /** 自动注入 Context 的章节。其余章节靠模型主动 read_skill_section 取 */
    requiredSections: z
      .array(z.string().regex(SECTION_ID_PATTERN, 'Section ID 必须匹配 ^S\\d+$（§4.3 新增约束 2）'))
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    // fill_slot 的 Skill 不声明适用类型，就没法在模板编译期校验「绑定的类型该 Skill 管不管」，
    // 于是不匹配会一路漏到运行时——那时模型已经在按一份不适用的 Skill 干活了。
    if (value.operation === 'fill_slot' && value.slotTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slotTypes'],
        message: 'operation 为 fill_slot 时必须声明 slotTypes（模板编译期据此校验绑定是否匹配）',
      });
    }
    // 反过来，create_structure 的目标是整棵结构而非某个类型，写了 slotTypes 只能是误解，
    // 静默接受会让作者以为「结构 Skill 也能按类型挑」。
    if (value.operation === 'create_structure' && value.slotTypes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slotTypes'],
        message: 'operation 为 create_structure 的 Skill 不得声明 slotTypes（它的目标是整棵结构）',
      });
    }
  });

export interface SkillSection {
  /** 形如 `S1` */
  id: string;
  /** 标题中 ID 之后的部分，可能为空串 */
  title: string;
  /** 该 section 的正文，已去掉首尾空行；不含标题行本身 */
  content: string;
}

export interface LoadedSkill {
  id: string;
  version: string;
  operation: Operation;
  slotTypes: readonly string[];
  summary: string;
  requiredSections: readonly string[];
  /** frontmatter 之后、首个 `## S1` 之前的内容。随 Overview 一起注入（§4.3） */
  preamble: string;
  /** 保持文件中的出现顺序——注入顺序对模型的理解有影响，不能按 ID 排序 */
  sections: readonly SkillSection[];
  /** 按 ID 直取，供 `read_skill_section` 使用 */
  sectionIndex: Readonly<Record<string, SkillSection>>;
  /**
   * 全文哈希。快照冻结的锚点：M2 完成判据要求「创建任务后改 SKILL.md，
   * 旧任务读到的仍是旧内容」——这个值就是判断「改没改」的依据。
   */
  contentHash: string;
  /** 绝对路径。只用于报错定位，不进快照（路径随部署环境变化，进快照会破坏确定性） */
  sourcePath: string;
  /** 原始全文。snapshot-service 冻结的是它，不是解析结果 */
  raw: string;
}

function invalid(message: string, sourcePath: string): ForgeError {
  return new ForgeError(
    'TEMPLATE_INVALID',
    `SKILL.md 非法：${message}`,
    `skill:${path.basename(path.dirname(sourcePath))}`,
    '修正该 SKILL.md 后重新加载模板',
  );
}

/** 把 Zod 的 issue 列表压成一行可读文本。保留 path，否则「哪个字段错了」全靠猜 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(根)';
      return `${at}: ${issue.message}`;
    })
    .join('；');
}

/**
 * 切出 frontmatter 与正文。
 *
 * 只接受文件**以** `---` 行开头的写法：允许前置空行会让「忘了写 frontmatter、
 * 但正文里恰好有一条水平线」的文件被解析成一份诡异的 frontmatter。
 */
function splitFrontmatter(raw: string, sourcePath: string): { frontmatter: string; body: string } {
  // 用转义写 BOM：字面量的 U+FEFF 在编辑器里是隐形的，读代码的人只会看到一个空正则
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw invalid('文件必须以 `---` 起始的 YAML frontmatter 开头（§4.3）', sourcePath);
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    throw invalid('frontmatter 没有闭合的 `---`', sourcePath);
  }
  const frontmatter = text.slice(4, end + 1);
  // `\n---` 之后到行尾的部分丢弃（正常情况下是空的）
  const afterMarker = text.indexOf('\n', end + 1);
  const body = afterMarker === -1 ? '' : text.slice(afterMarker + 1);
  return { frontmatter, body };
}

/** 按 §4.3 的解析规则切 section。行级扫描，不引入 markdown 解析器——这里只关心二级标题 */
function parseSections(body: string, sourcePath: string): { preamble: string; sections: SkillSection[] } {
  const lines = body.split('\n');
  const sections: SkillSection[] = [];
  const preambleLines: string[] = [];
  let current: { id: string; title: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    sections.push({ id: current.id, title: current.title, content: current.lines.join('\n').trim() });
    current = null;
  };

  for (const line of lines) {
    const heading = SECTION_HEADING_PATTERN.exec(line);
    if (heading !== null) {
      flush();
      current = { id: heading[1] ?? '', title: (heading[2] ?? '').trim(), lines: [] };
      continue;
    }
    if (ANY_HEADING_PATTERN.test(line) && current !== null) {
      // 非 S 开头的同级（或更高级）标题：当前 section 到此为止，
      // 且它本身不属于任何 section——落回前言是错的，直接丢弃更错。
      // 取「终止当前 section 并把它算进后续无主内容」，无主内容不参与注入。
      flush();
      continue;
    }
    if (current === null) {
      preambleLines.push(line);
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const seen = new Set<string>();
  for (const section of sections) {
    if (seen.has(section.id)) {
      throw invalid(`section ID 重复：${section.id}`, sourcePath);
    }
    seen.add(section.id);
  }

  return { preamble: preambleLines.join('\n').trim(), sections };
}

/**
 * 解析一份 SKILL.md 全文。与 IO 分离，便于用字符串直接测各类非法输入。
 */
export function parseSkill(raw: string, sourcePath: string): LoadedSkill {
  const { frontmatter, body } = splitFrontmatter(raw, sourcePath);

  let frontmatterData: unknown;
  try {
    frontmatterData = parseYaml(frontmatter, { prettyErrors: true });
  } catch (error) {
    throw invalid(`frontmatter 不是合法 YAML：${(error as Error).message}`, sourcePath);
  }

  const parsed = SkillFrontmatterSchema.safeParse(frontmatterData);
  if (!parsed.success) {
    throw invalid(`frontmatter 字段不合法 —— ${formatIssues(parsed.error)}`, sourcePath);
  }
  const meta = parsed.data;

  const { preamble, sections } = parseSections(body, sourcePath);
  const sectionIndex: Record<string, SkillSection> = {};
  for (const section of sections) sectionIndex[section.id] = section;

  for (const required of meta.requiredSections) {
    if (sectionIndex[required] === undefined) {
      throw invalid(
        `requiredSections 声明了 ${required}，但文中没有对应的 \`## ${required}\` 章节`,
        sourcePath,
      );
    }
  }

  return {
    id: meta.id,
    version: meta.version,
    operation: meta.operation,
    slotTypes: meta.slotTypes,
    summary: meta.summary,
    requiredSections: meta.requiredSections,
    preamble,
    sections,
    sectionIndex,
    // 哈希原文而非解析结果：解析结果丢掉了空白与注释，而「改了 SKILL.md」
    // 这件事本身就该让 hash 变化——哪怕只改了一个换行。快照隔离要的是这个语义。
    // NFC 与 canonical.ts 的字符串处理保持一致，避免同一文本的两种 Unicode 表示得到两个 hash。
    contentHash: sha256Hex(raw.replace(/\r\n/g, '\n').normalize('NFC')),
    sourcePath,
    raw,
  };
}

/** 从文件读入并解析。文件不存在同样归为 TEMPLATE_INVALID——它是模板 `skills[].source` 指错了 */
export async function loadSkill(sourcePath: string): Promise<LoadedSkill> {
  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch (error) {
    throw new ForgeError(
      'TEMPLATE_INVALID',
      // 同 template-loader：绝对路径只进 cause，不进 message（§9.3）
      `Skill 文件读取失败：${path.basename(path.dirname(sourcePath))}/${path.basename(sourcePath)}`,
      `skill:${path.basename(path.dirname(sourcePath))}`,
      '检查 template.yaml 中 skills[].source 的路径',
      error,
    );
  }
  return parseSkill(raw, sourcePath);
}
