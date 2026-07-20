import {
  platformAdminAuthResponseSchema,
  platformTenantSummarySchema,
  platformTenantUserSummarySchema,
  type AddTenantUserRequest,
  type CreateWorkspaceRequest,
  type PlatformAdminAuthResponse,
  type PlatformTenantSummary,
  type PlatformTenantUserSummary,
} from '@billme/server-core';
import { z } from 'zod';

const getBaseUrl = (): string => window.billmeRuntimeConfig?.serverApiUrl?.replace(/\/+$/, '') ?? '';

const request = async <T>(
  path: string,
  schema: import('zod').ZodType<T>,
  options: { method?: 'GET' | 'POST'; body?: unknown; token?: string } = {},
): Promise<T> => {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return schema.parse(payload);
};

export const platformClient = {
  async login(email: string, password: string): Promise<PlatformAdminAuthResponse> {
    return request('/api/v1/platform/auth/login', platformAdminAuthResponseSchema, {
      method: 'POST',
      body: { email, password },
    });
  },
  async listTenants(token: string): Promise<PlatformTenantSummary[]> {
    return request('/api/v1/platform/tenants', z.array(platformTenantSummarySchema), { token });
  },
  async createTenant(token: string, input: CreateWorkspaceRequest): Promise<PlatformTenantSummary> {
    return request('/api/v1/platform/tenants', platformTenantSummarySchema, {
      method: 'POST',
      body: input,
      token,
    });
  },
  async listTenantUsers(token: string, tenantId: string): Promise<PlatformTenantUserSummary[]> {
    return request(`/api/v1/platform/tenants/${tenantId}/users`, z.array(platformTenantUserSummarySchema), { token });
  },
  async addTenantUser(token: string, tenantId: string, input: AddTenantUserRequest): Promise<PlatformTenantUserSummary> {
    return request(`/api/v1/platform/tenants/${tenantId}/users`, platformTenantUserSummarySchema, {
      method: 'POST',
      body: input,
      token,
    });
  },
};
