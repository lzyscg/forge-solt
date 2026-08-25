/**
 * 模板相关端点（HANDOFF §5 契约速查表）。
 * 返回类型全部由契约 schema 推导，不手写。
 */

import {
  TemplateListResponseSchema,
  TemplateDetailSchema,
  TaskSummarySchema,
  type TemplateListResponse,
  type TemplateDetail,
  type TaskSummary,
} from '@shared/contracts.ts';
import { request } from './http.ts';
import { z } from 'zod';

export function listTemplates(): Promise<TemplateListResponse> {
  return request(TemplateListResponseSchema, { path: '/api/templates' });
}

export function getTemplate(templateId: string): Promise<TemplateDetail> {
  return request(TemplateDetailSchema, { path: `/api/templates/${encodeURIComponent(templateId)}` });
}

export function getTemplateTasks(templateId: string): Promise<TaskSummary[]> {
  return request(z.array(TaskSummarySchema), {
    path: `/api/templates/${encodeURIComponent(templateId)}/tasks`,
  });
}

/** 整目录重扫（`POST /api/templates/:id/reload`） */
export function reloadTemplate(templateId: string): Promise<TemplateDetail> {
  return request(TemplateDetailSchema, {
    path: `/api/templates/${encodeURIComponent(templateId)}/reload`,
    method: 'POST',
  });
}
