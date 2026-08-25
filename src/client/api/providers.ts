/**
 * Provider 相关端点（HANDOFF §5 契约速查表）。
 * 凭据只出「环境变量名 + 是否已配置」，绝不回显密钥值（REQ §13 / §17）。
 */

import {
  ProviderListResponseSchema,
  ProviderHealthSchema,
  ExecutionDefaultsSchema,
  type ProviderListResponse,
  type ProviderHealth,
  type ExecutionDefaults,
} from '@shared/contracts.ts';
import { request } from './http.ts';

export function listProviders(): Promise<ProviderListResponse> {
  return request(ProviderListResponseSchema, { path: '/api/providers' });
}

export function probeProvider(providerId: string): Promise<ProviderHealth> {
  return request(ProviderHealthSchema, {
    path: `/api/providers/${encodeURIComponent(providerId)}/probe`,
    method: 'POST',
  });
}

export function getDefaults(): Promise<ExecutionDefaults> {
  return request(ExecutionDefaultsSchema, { path: '/api/providers/defaults' });
}
