import { z } from 'zod';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import {
  deploymentModeSchema,
  serverProductSchema,
  serverRoleSchema,
  supportedServerProducts,
  supportedServerRoles,
} from './shared/runtime-profile.js';
import { vatValidationResultSchema, type VatValidationResult } from './services/vatValidation.js';
import {
  healthResponseSchema,
  capabilitiesResponseSchema,
  bootstrapRequestSchema,
  loginRequestSchema,
  authResponseSchema,
  authSessionInfoSchema,
  bootstrapStatusSchema,
  ensureServerApiSessionRequestSchema,
  serverApiSessionSchema,
  vatValidationRequestSchema,
} from './api-schemas.js';
import { serverApiContract } from './orpc/contract.js';
import type {
  HealthResponse,
  CapabilitiesResponse,
  BootstrapStatus,
  BootstrapRequest,
  AuthResponse,
  LoginRequest,
  AuthSessionInfo,
  EnsureServerApiSessionRequest,
  ServerApiSession,
} from './api-schemas.js';

export {
  deploymentModeSchema,
  serverProductSchema,
  serverRoleSchema,
  supportedServerProducts,
  supportedServerRoles,
};
export * from './domain/index.js';
export * from './ports/index.js';
export * from './services/index.js';
export type ServerProduct = z.infer<typeof serverProductSchema>;
export type ServerRole = z.infer<typeof serverRoleSchema>;

export * from './api-schemas.js';
export * from './orpc/contract.js';
const parseJsonResponse = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
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

export interface ServerApiClient {
  getHealth: () => Promise<HealthResponse>;
  getCapabilities: () => Promise<CapabilitiesResponse>;
  getBootstrapStatus: () => Promise<BootstrapStatus>;
  getBootstrapStatusFor: (product: ServerProduct) => Promise<BootstrapStatus>;
  bootstrap: (input: BootstrapRequest) => Promise<AuthResponse>;
  bootstrapFor: (product: ServerProduct, input: BootstrapRequest) => Promise<AuthResponse>;
  login: (input: LoginRequest) => Promise<AuthResponse>;
  loginFor: (product: ServerProduct, input: LoginRequest) => Promise<AuthResponse>;
  getSessionInfo: (args: { token: string; product?: ServerProduct }) => Promise<AuthSessionInfo>;
  ensureSession: (input: EnsureServerApiSessionRequest) => Promise<ServerApiSession>;
  validateVatId: (args: { token: string; product: ServerProduct; countryCode: string; vatNumber: string }) => Promise<VatValidationResult>;
}

export const createServerApiClient = (baseUrl: string): ServerApiClient => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const createOrpcClient = (token?: string): ContractRouterClient<typeof serverApiContract> => {
    const link = new OpenAPILink(serverApiContract, {
      url: normalizedBaseUrl,
      headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
    });
    return createORPCClient<ContractRouterClient<typeof serverApiContract>>(link);
  };
  return {
    async getHealth() {
      const response = await fetch(`${normalizedBaseUrl}/health`);
      return parseJsonResponse(response, healthResponseSchema);
    },
    async getCapabilities() {
      const response = await createOrpcClient().meta.capabilities({});
      return capabilitiesResponseSchema.parse(response);
    },
    async getBootstrapStatus() {
      return this.getBootstrapStatusFor('lite');
    },
    async getBootstrapStatusFor(product) {
      const response = await createOrpcClient()[product].auth.bootstrapStatus({});
      return bootstrapStatusSchema.parse(response);
    },
    async bootstrap(input) {
      return this.bootstrapFor('lite', input);
    },
    async bootstrapFor(product, input) {
      const response = await createOrpcClient()[product].auth.bootstrap(bootstrapRequestSchema.parse(input));
      return authResponseSchema.parse(response);
    },
    async login(input) {
      return this.loginFor('lite', input);
    },
    async loginFor(product, input) {
      const response = await createOrpcClient()[product].auth.login(loginRequestSchema.parse(input));
      return authResponseSchema.parse(response);
    },
    async getSessionInfo(args) {
      const parsed = z
        .object({
          token: z.string().min(1),
          product: serverProductSchema.default('lite'),
        })
        .parse(args);
      const response = await createOrpcClient(parsed.token)[parsed.product].auth.me({});
      return authSessionInfoSchema.parse(response);
    },
    async ensureSession(input) {
      const parsed = ensureServerApiSessionRequestSchema.parse(input);
      const status = await this.getBootstrapStatusFor(parsed.product);
      const authResponse = status.bootstrapped
        ? await this.loginFor(parsed.product, parsed)
        : await this.bootstrapFor(parsed.product, parsed);
      const sessionInfo = await this.getSessionInfo({
        token: authResponse.token,
        product: parsed.product,
      });
      return serverApiSessionSchema.parse({
        ...authResponse,
        tenantId: sessionInfo.tenantId,
        product: sessionInfo.product,
        role: sessionInfo.role,
        via: status.bootstrapped ? 'login' : 'bootstrap',
      });
    },
    async validateVatId(args) {
      const parsed = vatValidationRequestSchema.parse(args);
      const response = await createOrpcClient(args.token)[args.product].tax.validateVatId(parsed);
      return vatValidationResultSchema.parse(response);
    },
  };
};
