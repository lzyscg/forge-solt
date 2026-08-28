/**
 * `complete_assignment`：唯一的正式写动作（REQ §12.3 / D-10 / D-11）。
 *
 * 本文件的顺序是有讲究的，逐条说明：
 *
 * 1. `gate.assertOpen` —— 第一行。已提交过就不可能再提交第二次。
 * 2. **kind 与 operation 必须匹配** —— 一个 fill_slot 的 Assignment 提交
 *    `kind: 'structure'` 是越权，不是参数错误：它想改的是整棵结构。
 * 3. **slotId 必须等于 targetSlotId**（AC-008） —— 在**进入事务之前**拦下。
 *    D-10 的条件 UPDATE 也会拦（`e.target_slot_id = slots.slot_id`），
 *    但那条语句给不出「你该写的是 scene_03」这种可执行反馈，
 *    而这正是模型能自己改对的一类错误。
 * 4. 交给 `CompletionPort` —— 事务、Token 校验、结构校验都在那一侧（D-10）。
 * 5. **成功之后才关闸门 + abort**。顺序反过来会出现「闸门关了但事务失败」的状态：
 *    模型再也交不上，而这次 Execution 什么都没保存。
 *
 * **三处预检在抛出前必须先 `onRejected`（M3-C 补，文档 §7.6 同步修订）**
 *
 * 预检发生在 `ctx.completion.submit` 之前，因此不经过 CompletionPort。
 * 若不在这里登记，`AssignmentRunner` 的 `rejectionRef` 就是空的，
 * 本次收敛会落到「压根没提交」那一支（`ASSIGNMENT_OUTPUT_INVALID` +
 * `noSubmission: true`），于是下一次 attempt 给模型追加的是
 * 「你上一次没有调用 complete_assignment」——而它明明调了，只是 slotId 写错了。
 * 给模型一句与事实相反的反馈，是这条链路上最坏的一种反馈。
 *
 * `gate.assertOpen` 的失败**不**走这条路：那是提交成功之后的重复调用，
 * 登记成「被拒」会让一次成功的 Assignment 带着一条拒绝记录收敛。
 */

import { ForgeError } from '@shared/errors.ts';
import { defineTool } from './tool-definition.ts';
import type { ToolDefinition } from './tool-definition.ts';
import type { ToolsetContext } from './context.ts';

export function createCompleteAssignment(ctx: ToolsetContext): ToolDefinition {
  return defineTool(
    'complete_assignment',
    '提交本次工作的正式产出。这是唯一会被保存的动作，调用成功后本次工作立即结束。',
    async (payload) => {
      ctx.gate.assertOpen('complete_assignment');

      // 显式标注成 `=> never`：TS 只对**带类型注解的**声明做「调用即不可达」的收窄，
      // 少了这行注解，下面三处 reject 之后 payload 的判别联合不会被收窄
      const reject: (error: ForgeError) => never = (error) => {
        ctx.onRejected({ code: error.code, message: error.message, violations: [] });
        throw error;
      };

      if (ctx.operation === 'create_structure' && payload.kind !== 'structure') {
        reject(
          new ForgeError(
            'ASSIGNMENT_OUTPUT_INVALID',
            '本次工作是创建结构（create_structure），必须提交 kind 为 "structure" 的结构提案，' +
              '不能提交槽位正文。',
          ),
        );
      }
      if (ctx.operation === 'fill_slot' && payload.kind !== 'slot_content') {
        reject(
          new ForgeError(
            'ASSIGNMENT_OUTPUT_INVALID',
            `本次工作是填充槽位「${ctx.targetSlotId ?? ''}」，必须提交 kind 为 "slot_content" 的正文，` +
              '不能提交结构。',
          ),
        );
      }
      if (ctx.operation === 'review_slot' && payload.kind !== 'review_result') {
        reject(
          new ForgeError(
            'ASSIGNMENT_OUTPUT_INVALID',
            `本次工作是审核槽位「${ctx.targetSlotId ?? ''}」，必须提交 kind 为 "review_result" 的审核结果，` +
              '不能提交结构或槽位正文。',
          ),
        );
      }
      if (payload.kind === 'slot_content' && payload.slotId !== ctx.targetSlotId) {
        reject(
          new ForgeError(
            'SLOT_TARGET_MISMATCH',
            `本次工作只能为槽位「${ctx.targetSlotId ?? ''}」撰写内容，` +
              `而提交的 slotId 是「${payload.slotId}」。请把 slotId 改为「${ctx.targetSlotId ?? ''}」后重新提交。`,
            ctx.targetSlotId === null ? null : `slot:${ctx.targetSlotId}`,
          ),
        );
      }
      /*
       * 审核结果的目标同样要对得上（R2 漏掉了这一条）。
       *
       * 少了它，一次审核可以把结果写到**别的槽位**头上：
       * `submitReviewResult` 拿 payload 里的 slotId 去 `getOrThrow`，取到的是另一个槽位，
       * 于是那个槽位的 slot_reviews 里多出一行本轮判据的记录。后果是双向的——
       * 被写的那个槽位可能因此被判返修，而真正被审的这个永远等不到自己的那一行，
       * 调度器每轮都重新选中它，同一条判据反复调用。
       *
       * R5 让这条路径从「几乎不会发生」变成「值得防」：结构审核的 prompt 里
       * 摆着整棵树的槽位 ID，模型顺手填一个场景的 ID 比填根容器的 ID 更自然。
       */
      if (payload.kind === 'review_result' && payload.slotId !== ctx.targetSlotId) {
        reject(
          new ForgeError(
            'SLOT_TARGET_MISMATCH',
            `本次审核的目标是「${ctx.targetSlotId ?? ''}」，` +
              `而提交的 slotId 是「${payload.slotId}」。请把 slotId 改为「${ctx.targetSlotId ?? ''}」后重新提交。`,
            ctx.targetSlotId === null ? null : `slot:${ctx.targetSlotId}`,
          ),
        );
      }

      ctx.trace.write({
        executionId: ctx.executionId,
        actor: 'agent',
        kind: 'assignment_submitted',
        title: '提交产出',
        summary:
          payload.kind === 'structure'
            ? `提交结构提案：${payload.slots.length} 个槽位，根槽位 ${payload.rootSlotId}`
            : payload.kind === 'slot_content'
              ? `提交槽位「${payload.slotId}」正文，共 ${payload.content.length} 字`
              : `提交槽位「${payload.slotId}」审核结果：${payload.verdict}`,
        // 正文与完整提案都不进 payload：前者可能上万字，后者会在校验失败时
        // 由 validation_failed 带上；trace 的 payload 是展开区不是仓库
        payload:
          payload.kind === 'structure'
            ? { kind: payload.kind, slotCount: payload.slots.length, rootSlotId: payload.rootSlotId }
            : payload.kind === 'slot_content'
              ? { kind: payload.kind, slotId: payload.slotId, contentLength: payload.content.length }
              : { kind: payload.kind, slotId: payload.slotId, verdict: payload.verdict, findingCount: payload.findings.length },
      });

      const outcome = await ctx.completion.submit({
        taskId: ctx.taskId,
        executionId: ctx.executionId,
        executionToken: ctx.executionToken,
        operation: ctx.operation,
        targetSlotId: ctx.targetSlotId,
        payload,
      });

      if (!outcome.ok) {
        ctx.onRejected({
          code: outcome.code,
          message: outcome.message,
          violations: outcome.violations,
        });
        ctx.trace.write({
          executionId: ctx.executionId,
          actor: 'system',
          kind: 'validation_failed',
          title: '提交未通过校验',
          summary: outcome.message,
          payload: {
            code: outcome.code,
            violations: outcome.violations.map((v) => ({
              rule: v.rule,
              message: v.message,
              slotIds: v.slotIds,
            })),
          },
        });
        // 抛出去让分发器转成工具错误结果：模型据此**增量修正**后可以在同一轮循环里
        // 再提交一次，省下一整次 attempt（§7.5 的理由）
        throw new ForgeError(
          outcome.code,
          [
            outcome.message,
            // 回给模型的是 agentHint 而不是 message：前者是可执行的修复指令（D-13），
            // 后者是给人看的现象描述
            ...outcome.violations.map((v, i) => `${i + 1}. [${v.rule}] ${v.agentHint}`),
            '请修正后重新提交完整产出。系统不保存部分结果。',
          ].join('\n'),
        );
      }

      ctx.onSubmitted();
      return '提交成功。本次工作已结束，后续输出不会被保存，无需再调用任何工具。';
    },
  );
}
