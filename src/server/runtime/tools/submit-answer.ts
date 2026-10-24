import type { z } from 'zod';
import { ForgeError } from '@shared/errors.ts';
import { canonicalHash, canonicalJson } from '@server/domain/canonical.ts';
import {
  compileNarrativeAnswer,
  compileNarrativeAnswerV3,
  NarrativeAnswerSchema,
  NarrativeAnswerV3Schema,
  serializeNarrativePlanMarkdown,
} from '@server/domain/narrative-answer.ts';
import { defineDynamicTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

export function createSubmitAnswer(ctx: ToolsetContext): ToolDefinition {
  const prepared = ctx.preparedSubmission;
  if (prepared === undefined) {
    throw new ForgeError('STORAGE_ERROR', 'submit_answer 缺少已准备的业务回答契约');
  }

  return defineDynamicTool(
    'submit_answer',
    '提交本次工作的业务语义答案。目标、编号、展开、预算和展示格式由系统自动绑定与生成。',
    prepared.version === 2
      ? NarrativeAnswerSchema as z.ZodType<unknown>
      : NarrativeAnswerV3Schema as z.ZodType<unknown>,
    async (answer) => {
      ctx.gate.assertOpen('submit_answer');
      if (ctx.operation !== 'fill_slot' || ctx.targetSlotId === null) {
        return reject(ctx, new ForgeError(
          'ASSIGNMENT_OUTPUT_INVALID',
          'submit_answer 只允许用于带 Answer Contract 的 fill_slot 工作。',
        ));
      }

      const compiled = prepared.version === 2
        ? compileNarrativeAnswer({
            contract: prepared.contract,
            answer,
            storyBudget: prepared.storyBudget,
          })
        : compileNarrativeAnswerV3({
            contract: prepared.contract,
            answer,
            storyBudget: prepared.storyBudget,
          });
      if (!compiled.ok) {
        const message = compiled.violations.map((violation) => violation.message).join('；');
        ctx.onRejected({ code: 'ASSIGNMENT_OUTPUT_INVALID', message, violations: [] });
        ctx.trace.write({
          executionId: ctx.executionId,
          actor: 'system',
          kind: 'validation_failed',
          title: '业务答案未通过校验',
          summary: message,
          payload: {
            code: 'ASSIGNMENT_OUTPUT_INVALID',
            rules: compiled.violations.map((violation) => violation.rule),
          },
        });
        throw new ForgeError(
          'ASSIGNMENT_OUTPUT_INVALID',
          [
            '业务答案未通过校验：',
            ...compiled.violations.map((violation, index) =>
              `${index + 1}. [${violation.rule}] ${violation.message}`,
            ),
            '请修正业务判断后重新提交；编号、展开、预算和 Markdown 无需填写。',
          ].join('\n'),
          `slot:${ctx.targetSlotId}`,
        );
      }

      const content = serializeNarrativePlanMarkdown(compiled.plan, prepared.contract);
      const artifactJson = canonicalJson(compiled.plan);
      const artifactHash = canonicalHash(compiled.plan);
      const priorityCounts = { P0: 0, P1: 0, bridge: 0 };
      const capacityTotals = {
        dialogueTurns: 0,
        actionFeedbackLoops: 0,
        cognitionTurns: 0,
        aftermathBeats: 0,
      };
      for (const unit of compiled.plan.units) {
        priorityCounts[unit.priority] += 1;
        capacityTotals.dialogueTurns += unit.capacity.dialogueTurns;
        capacityTotals.actionFeedbackLoops += unit.capacity.actionFeedbackLoops;
        capacityTotals.cognitionTurns += unit.capacity.cognitionTurns;
        capacityTotals.aftermathBeats += unit.capacity.aftermathBeats;
      }
      ctx.trace.write({
        executionId: ctx.executionId,
        actor: 'agent',
        kind: 'assignment_submitted',
        title: '提交业务答案',
        summary: `提交 ${compiled.plan.units.length} 个叙事单元的业务答案`,
        payload: {
          kind: prepared.kind,
          version: prepared.version,
          slotId: ctx.targetSlotId,
          unitCount: compiled.plan.units.length,
          artifactHash,
          weightProfile: compiled.plan.weightProfile,
          sourceSegmentation: prepared.contract.sourceSegmentation,
          expansionPolicy: prepared.contract.expansionPolicy,
          priorityCounts,
          capacityTotals,
        },
      });

      const outcome = await ctx.completion.submit({
        taskId: ctx.taskId,
        executionId: ctx.executionId,
        executionToken: ctx.executionToken,
        operation: ctx.operation,
        targetSlotId: ctx.targetSlotId,
        domainArtifact: {
          kind: prepared.kind,
          version: prepared.version,
          json: artifactJson,
          hash: artifactHash,
        },
        payload: { kind: 'slot_content', slotId: ctx.targetSlotId, content },
      });
      if (!outcome.ok) {
        ctx.onRejected({
          code: outcome.code,
          message: outcome.message,
          violations: outcome.violations,
        });
        throw new ForgeError(outcome.code, outcome.message, `slot:${ctx.targetSlotId}`);
      }

      ctx.onSubmitted();
      return '提交成功。系统已生成正式编号、展开、预算与兼容视图，本次工作已结束。';
    },
  );
}

function reject(ctx: ToolsetContext, error: ForgeError): never {
  ctx.onRejected({ code: error.code, message: error.message, violations: [] });
  ctx.trace.write({
    executionId: ctx.executionId,
    actor: 'system',
    kind: 'validation_failed',
    title: '提交被预检拒绝',
    summary: error.message,
    payload: { code: error.code, stage: 'precheck' },
  });
  throw error;
}
