/**
 * `read_skill_section`：按需读取 Skill 的其他章节（§7.4）。
 *
 * System Message 里只塞了 `requiredSections` 全文 + 其余章节的索引，
 * 本工具是「其余章节」的唯一取用途径。数据来自**冻结的 Skill 快照**（AC-002），
 * 磁盘上的 SKILL.md 改了也不影响正在跑的任务。
 *
 * 每次读取写一条 `skill_section_read` trace：UX §13.2 的「方法」筛选分组靠它，
 * 用户据此看出 Agent 到底翻了哪几节。
 */

import { ForgeError } from '@shared/errors.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

export function createReadSkillSection(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'read_skill_section',
    '按 Section ID 读取本次工作所用 Skill 的某一章节全文。',
    async ({ sectionId }) => {
      ctx.gate.assertOpen('read_skill_section');
      const section = ctx.skill.sectionIndex[sectionId];
      if (section === undefined) {
        const available = ctx.skill.sections.map((s) => s.id).join(', ');
        throw new ForgeError(
          'SKILL_SECTION_NOT_FOUND',
          `Skill ${ctx.skill.id} v${ctx.skill.version} 没有章节「${sectionId}」。` +
            `可读章节：${available || '（无）'}`,
        );
      }

      ctx.trace.write({
        executionId: ctx.executionId,
        actor: 'skill',
        kind: 'skill_section_read',
        title: `读取方法章节 ${section.id}`,
        summary: section.title,
        payload: {
          skillId: ctx.skill.id,
          skillVersion: ctx.skill.version,
          sectionId: section.id,
          // 只记长度不记正文：章节全文可能很长，而它在快照里已经有一份逐字副本
          contentLength: section.content.length,
        },
      });

      return `## ${section.id} ${section.title}\n\n${section.content}`;
    },
  );
}
