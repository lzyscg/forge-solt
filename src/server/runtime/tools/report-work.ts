/**
 * `report_work`：发布可公开的工作说明（§7.4）。
 *
 * 这是 Agent 唯一能主动往 Trace 里写东西的通道，也是 UX §13.2「工作」分组的数据来源。
 * 它**不影响产出**：写了不等于做了，不写也不影响提交。这一点在 System Message
 * 里对模型明说，因为模型很容易把 report_work 当成提交动作的替代品。
 *
 * `type → kind` 的映射用 `@shared/tools.ts` 的 `REPORT_WORK_TRACE_KIND`，
 * 不在这里另写 switch——那张表已经 `satisfies Record<ReportWorkInput['type'], TraceKind>`，
 * 新增一种 type 会在契约层就编译失败。
 */

import { REPORT_WORK_TRACE_KIND } from '@shared/tools.ts';
import type { ReportWorkInput } from '@shared/tools.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

const TITLE: Record<ReportWorkInput['type'], string> = {
  understanding: '理解任务',
  plan: '工作计划',
  decision: '关键决定',
  progress: '进展说明',
  completion: '完成说明',
};

export function createReportWork(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'report_work',
    '发布一条可公开的工作说明，让用户看到你的思路。它不保存任何产出，也不代表任务完成。',
    async (input) => {
      ctx.gate.assertOpen('report_work');
      ctx.trace.write({
        executionId: ctx.executionId,
        actor: 'agent',
        kind: REPORT_WORK_TRACE_KIND[input.type],
        title: TITLE[input.type],
        summary: input.summary,
        payload: {
          relatedSkillSectionIds: input.relatedSkillSectionIds ?? [],
          relatedSlotIds: input.relatedSlotIds ?? [],
        },
      });
      // 回给模型的确认里再说一次「不是提交」——AC-014 的失败样本几乎都是
      // 模型发了一条 completion 类型的 report_work 就以为自己交付了
      return '工作说明已记录。注意：它不保存任何产出，只有 complete_assignment 才是提交。';
    },
  );
}
