/**
 * 提交闸门（D-11）。
 *
 * REQ §12.3 只给了 Agent 一个正式写动作，而「提交之后不能再动」这件事**不能靠模型自觉**：
 * 模型完全可能在同一批 response 里并发发出 `complete_assignment` 和另外三个读工具，
 * 也完全可能在提交后继续输出。闸门是这条边界的物理实现——按 Assignment 创建，
 * 被所有工具闭包捕获，任何一个工具的第一行都要过它。
 *
 * **为什么 `assertOpen` 抛异常而不是返回 boolean**：返回值可以被忘记检查，
 * 而忘记检查的表现是「提交后的工具调用悄悄成功了」——这正是本类要防的那件事。
 * 抛出的 `TOOL_NOT_ALLOWED` 由工具分发器捕获并转成该次 tool call 的错误结果
 * （D-18 的实现陷阱一节），**不中断工具循环**：Provider 可能在同一批里发多个 tool call，
 * 要让它们各自拿到错误结果后自然收敛。
 */

import { ForgeError } from '@shared/errors.ts';

export class SubmissionGate {
  #closed = false;

  get isClosed(): boolean {
    return this.#closed;
  }

  /** 每个工具 handler 的第一行。`toolName` 只用于错误文案，不参与判定 */
  assertOpen(toolName: string): void {
    if (this.#closed) {
      throw new ForgeError(
        'TOOL_NOT_ALLOWED',
        `本次 Assignment 已提交，${toolName} 不再可用。本次工作已经结束，无需再做任何事。`,
      );
    }
  }

  /**
   * 幂等：重复 close 不报错。
   * 理由是关闭动作可能同时来自「提交成功」与「循环收敛时的兜底关闭」，
   * 让第二次调用炸掉只会把一个正常路径变成噪音。
   */
  close(): void {
    this.#closed = true;
  }
}
