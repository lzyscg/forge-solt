/**
 * 可写的模板工作区夹具。
 *
 * 快照隔离（M2 完成判据 / AC-002）只有**真的去改磁盘上的文件**才算验过：
 * 拿一个假的 loader 返回两份不同的对象，验的是测试自己的替身，不是产品行为。
 * 因此这里把 `tests/fixtures/{templates,skills}` 整体拷进 `os.tmpdir()` 下的
 * 临时目录，测试可以随意改写，用完删掉，`tests/fixtures` 本身保持只读。
 *
 * 目录布局必须保持 `<root>/templates/...` 与 `<root>/skills/...`：
 * `template.yaml` 的 `skills[].source` 写的是 `skills/xxx/SKILL.md`，
 * template-loader 按 `dirname(SKILLS_DIR)` 解析它（见 resolveSkillPath）。
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = fileURLToPath(new URL('.', import.meta.url));

export interface TemplateWorkspace {
  root: string;
  templatesDir: string;
  skillsDir: string;
  /** 读某个 SKILL.md 的全文 */
  readSkill(skillId: string): Promise<string>;
  /** 覆盖某个 SKILL.md */
  writeSkill(skillId: string, content: string): Promise<void>;
  /** 就地替换 template.yaml 中的一段文本；找不到即抛，避免「改了个寂寞」的假绿 */
  patchTemplate(templateId: string, find: string, replace: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTemplateWorkspace(): Promise<TemplateWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-workspace-'));
  const templatesDir = path.join(root, 'templates');
  const skillsDir = path.join(root, 'skills');
  await cp(path.join(FIXTURE_ROOT, 'templates'), templatesDir, { recursive: true });
  await cp(path.join(FIXTURE_ROOT, 'skills'), skillsDir, { recursive: true });

  const skillPath = (skillId: string): string => path.join(skillsDir, skillId, 'SKILL.md');
  const templatePath = (templateId: string): string =>
    path.join(templatesDir, templateId, 'template.yaml');

  return {
    root,
    templatesDir,
    skillsDir,
    readSkill: (skillId) => readFile(skillPath(skillId), 'utf8'),
    writeSkill: (skillId, content) => writeFile(skillPath(skillId), content, 'utf8'),
    async patchTemplate(templateId, find, replace) {
      const file = templatePath(templateId);
      const text = await readFile(file, 'utf8');
      if (!text.includes(find)) {
        throw new Error(`patchTemplate 没找到待替换文本：${find}`);
      }
      await writeFile(file, text.replace(find, replace), 'utf8');
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
