/**
 * 工具集构建与分发（§7.5 / D-11 / D-18）。
 *
 * 分发器是 D-11 的第二道闸门。它必须做到三件事，缺一条都会有真实后果：
 *
 * 1. **兜住未知工具名** → `TOOL_NOT_ALLOWED`。一个拼错的工具名穿过去，
 *    表现是「工具静默没执行、模型以为执行了」，然后它基于不存在的结果继续写。
 * 2. **捕获 `ForgeError` 转成工具错误结果，不中断循环**。漏了这个 catch，
 *    `TOOL_NOT_ALLOWED` 会一路冒到 Fastify 的 `setErrorHandler`，
 *    变成一个用户可见的 HTTP 错误——而附录 A 明确标注它「非用户可见」。
 * 3. **非 `ForgeError` 一律向上冒泡**。那是实现 bug 或 `MAX_TOOL_CALLS_EXCEEDED`
 *    这种必须中断循环的信号，吞掉它等于让循环带病继续。
 */

import { ForgeError } from '@shared/errors.ts';
import { TOOL_NAMES } from '@shared/tools.ts';
import type { ProviderToolCall, ProviderToolDefinition, ProviderToolResult } from '../provider/provider-adapter.ts';
import type { TraceWriter } from '../trace-writer.ts';
import { createCompleteAssignment } from './complete-assignment.ts';
import { createReadSkillSection } from './read-skill-section.ts';
import { createReadSlot } from './read-slot.ts';
import { createReadStructureOutline } from './read-structure-outline.ts';
import { createReadTaskInput } from './read-task-input.ts';
import { createReportWork } from './report-work.ts';
import type { ToolsetContext } from './context.ts';
import type { ToolDefinition } from './tool-definition.ts';

export type { ToolsetContext, SubmissionRejection } from './context.ts';
export type { ToolDefinition } from './tool-definition.ts';
export { renderOutline } from './read-structure-outline.ts';

/**
 * 按 Assignment 建工具闭包。
 *
 * 返回顺序固定，且构建后立刻用 `TOOL_NAMES` 自检覆盖完整——§3.4 说
 * 「供 buildToolset 遍历注册，避免新增工具后忘记挂上去」，
 * 而只有真的检查一遍，那句注释才是约束。
 */
export function buildToolset(ctx: ToolsetContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadTaskInput(ctx),
    createReadSkillSection(ctx),
    createReadStructureOutline(ctx),
    createReadSlot(ctx),
    createReportWork(ctx),
    createCompleteAssignment(ctx),
  ];

  const built = new Set(tools.map((t) => t.name));
  const missing = TOOL_NAMES.filter((name) => !built.has(name));
  if (missing.length > 0) {
    throw new ForgeError('STORAGE_ERROR', `buildToolset 漏挂了工具：${missing.join(', ')}`);
  }
  return tools;
}

/** 转成给模型的 tool definition。JSON Schema 来自 Zod，不另写一份（§3.4） */
export function toProviderTools(tools: readonly ToolDefinition[]): ProviderToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export interface ToolDispatcherOptions {
  readonly tools: readonly ToolDefinition[];
  readonly trace: TraceWriter;
  readonly executionId: string;
}

/**
 * 单次工具调用的分发。返回值永远是一个 `ProviderToolResult`——
 * 除非抛的不是 `ForgeError`（见文件头第 3 条）。
 */
export async function dispatchToolCall(
  options: ToolDispatcherOptions,
  call: ProviderToolCall,
): Promise<ProviderToolResult> {
  const { tools, trace, executionId } = options;

  trace.write({
    executionId,
    actor: 'tool',
    kind: 'tool_call_started',
    title: `调用工具 ${call.name}`,
    summary: `工具调用 ${call.name}`,
    // 参数原文可能含大段正文（complete_assignment），只记长度
    payload: { toolName: call.name, toolCallId: call.id, argumentsLength: call.argumentsJson.length },
  });

  try {
    const tool = tools.find((t) => t.name === call.name);
    if (tool === undefined) {
      throw new ForgeError(
        'TOOL_NOT_ALLOWED',
        `不存在名为「${call.name}」的工具。可用工具：${tools.map((t) => t.name).join(', ')}`,
      );
    }

    const args = parseArguments(call.argumentsJson, call.name);
    const content = await tool.invoke(args);

    trace.write({
      executionId,
      actor: 'tool',
      kind: 'tool_call_completed',
      title: `工具 ${call.name} 完成`,
      summary: firstLine(content),
      payload: { toolName: call.name, toolCallId: call.id, ok: true, ...slotIdOf(args) },
    });
    return { toolCallId: call.id, content, isError: false };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;

    trace.write({
      executionId,
      actor: 'tool',
      kind: 'tool_call_completed',
      title: `工具 ${call.name} 被拒绝`,
      summary: firstLine(error.message),
      payload: { toolName: call.name, toolCallId: call.id, ok: false, code: error.code },
    });
    // 错误码一并回给模型：它是模型能识别的稳定信号，比自然语言更不容易被改写理解
    return { toolCallId: call.id, content: `[${error.code}] ${error.message}`, isError: true };
  }
}

/**
 * 把工具参数里的 `slotId` 记进 trace（R3 / D-31 / FR-CTX-005）。
 *
 * 返修那一轮的上下文要回答「上一轮读过哪些依赖槽位」，而这个事实只有工具调用现场知道。
 * 不落进 trace 的话，进程一重启它就没了——而 FR-CTX-005 的判定标准正是
 * 「清空进程内存后，只凭数据库与冻结快照能重建出逐字相同的上下文」。
 *
 * **只记 ID，绝不记工具返回的正文**：正文在 `slots.content_text` 里是权威的，
 * 存副本会与它漂移，还白白撑大 trace。
 *
 * 写成「参数里有字符串 slotId 就记」而不是「工具名等于 read_slot 才记」：
 * 分发器不该认识某一个具体工具的参数形状。
 */
function slotIdOf(args: unknown): { slotId?: string } {
  if (typeof args !== 'object' || args === null) return {};
  const value = (args as { slotId?: unknown }).slotId;
  return typeof value === 'string' ? { slotId: value } : {};
}

function parseArguments(argumentsJson: string, toolName: string): unknown {
  const trimmed = argumentsJson.trim();
  // 无参工具（read_structure_outline）在多数 Provider 上回的是空串而不是 "{}"
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new ForgeError(
      'TOOL_INPUT_INVALID',
      `${toolName} 的参数不是合法 JSON。请重新以合法 JSON 对象调用该工具。`,
    );
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
