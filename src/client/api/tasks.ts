/**
 * 任务相关端点（HANDOFF §5 契约速查表）。
 *
 * 注意两条时序约定：
 * - `start` 是 query 参数，不进 body（契约 §9.1）。
 * - 命令端点（start/stop/resume/retry）**立刻返回**，不等生产。
 */

import { z } from 'zod';
import {
  TaskSummarySchema,
  TaskDetailSchema,
  TaskCommandResultSchema,
  SlotViewSchema,
  SlotDetailSchema,
  SlotFlowViewSchema,
  ExecutionViewSchema,
  TraceListResponseSchema,
  ArtifactViewSchema,
  CreateTaskRequestSchema,
  type TaskSummary,
  type TaskDetail,
  type TaskCommandResult,
  type SlotView,
  type SlotDetail,
  type SlotFlowView,
  type ExecutionView,
  type TraceListResponse,
  type ArtifactView,
  type CreateTaskRequest,
} from '@shared/contracts.ts';
import { request, qs } from './http.ts';

export type TaskCommand = 'start' | 'stop' | 'resume' | 'retry';

export function listTasks(limit?: number): Promise<TaskSummary[]> {
  return request(z.array(TaskSummarySchema), { path: `/api/tasks${qs({ limit })}` });
}

export function getTask(taskId: string): Promise<TaskDetail> {
  return request(TaskDetailSchema, { path: `/api/tasks/${encodeURIComponent(taskId)}` });
}

/** `POST /api/tasks[?start=true]` → 201 + Location，返回 TaskCommandResult */
export function createTask(body: CreateTaskRequest, start: boolean): Promise<TaskCommandResult> {
  const parsed = CreateTaskRequestSchema.parse(body);
  return request(TaskCommandResultSchema, {
    path: `/api/tasks${qs({ start: start ? 'true' : undefined })}`,
    method: 'POST',
    body: parsed,
  });
}

export function taskCommand(taskId: string, command: TaskCommand): Promise<TaskCommandResult> {
  return request(TaskCommandResultSchema, {
    path: `/api/tasks/${encodeURIComponent(taskId)}/${command}`,
    method: 'POST',
  });
}

export function getSlots(taskId: string): Promise<SlotView[]> {
  return request(z.array(SlotViewSchema), { path: `/api/tasks/${encodeURIComponent(taskId)}/slots` });
}

export function getSlotDetail(taskId: string, slotId: string): Promise<SlotDetail> {
  return request(SlotDetailSchema, {
    path: `/api/tasks/${encodeURIComponent(taskId)}/slots/${encodeURIComponent(slotId)}`,
  });
}

/**
 * 右栏「生产过程」视图的骨架：轮次、判据、结算。
 * 单独一个端点而不是塞进 slot detail——见服务端 `getSlotFlow` 的注释。
 */
export function getSlotFlow(taskId: string, slotId: string): Promise<SlotFlowView> {
  return request(SlotFlowViewSchema, {
    path: `/api/tasks/${encodeURIComponent(taskId)}/slots/${encodeURIComponent(slotId)}/flow`,
  });
}

export function getExecutions(taskId: string): Promise<ExecutionView[]> {
  return request(z.array(ExecutionViewSchema), {
    path: `/api/tasks/${encodeURIComponent(taskId)}/executions`,
  });
}

/**
 * `GET /api/tasks/:id/traces?after=&limit=`。
 * SSE 首连不补发历史（§9.4），所以工作台打开时必须先调它拉全量作时间线种子。
 */
export function getTraces(
  taskId: string,
  opts: { after?: number; limit?: number } = {},
): Promise<TraceListResponse> {
  return request(TraceListResponseSchema, {
    path: `/api/tasks/${encodeURIComponent(taskId)}/traces${qs({ after: opts.after, limit: opts.limit })}`,
  });
}

export function getArtifact(taskId: string): Promise<ArtifactView> {
  return request(ArtifactViewSchema, { path: `/api/tasks/${encodeURIComponent(taskId)}/artifact` });
}

/** SSE 端点 URL（交给 EventSource）。`after` 用游标补发 */
export function streamUrl(taskId: string, after?: number): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/stream${qs({ after })}`;
}

/** 产物下载是 `text/markdown` + Content-Disposition，直接给 <a> 用 */
export function artifactDownloadUrl(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/artifact/download`;
}
