import { z } from 'zod';
import {
  deploymentModeSchema,
  serverProductSchema,
  serverRoleSchema,
  supportedServerProducts,
  supportedServerRoles,
} from './shared/runtime-profile.js';
import { serverRoutes } from './shared/server-routes.js';
export * from './shared/server-routes.js';

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

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string().min(1),
  backend: z.literal('fastify'),
  mode: z.enum(['api', 'worker']),
  ts: z.string().min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const capabilitiesResponseSchema = z.object({
  backend: z.literal('fastify'),
  deploymentMode: z.literal('single-tenant'),
  desktopServerMode: z.literal(true),
  database: z.object({
    production: z.literal('postgres'),
    local: z.literal('sqlite'),
  }),
  auth: z.object({
    multiUser: z.literal(true),
    roles: z.array(serverRoleSchema),
  }),
  products: z.array(serverProductSchema),
});
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

export const bootstrapRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  fullName: z.string().min(1),
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  role: serverRoleSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResponseSchema = z.object({
  token: z.string().min(1),
  user: authUserSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const authSessionInfoSchema = z.object({
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: serverRoleSchema,
});
export type AuthSessionInfo = z.infer<typeof authSessionInfoSchema>;

export const bootstrapStatusSchema = z.object({
  bootstrapped: z.boolean(),
  userCount: z.number().int().nonnegative(),
});
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;

export const ensureServerApiSessionRequestSchema = bootstrapRequestSchema.extend({
  product: serverProductSchema.default('lite'),
});
export type EnsureServerApiSessionRequest = z.infer<typeof ensureServerApiSessionRequestSchema>;

export const serverApiSessionSchema = authResponseSchema.extend({
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: serverRoleSchema,
  via: z.enum(['bootstrap', 'login']),
});
export type ServerApiSession = z.infer<typeof serverApiSessionSchema>;

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
}

export const createServerApiClient = (baseUrl: string): ServerApiClient => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const buildAuthUrl = (path: string, product: ServerProduct): string => {
    const url = new URL(path, `${normalizedBaseUrl}/`);
    url.searchParams.set('product', product);
    return url.toString();
  };
  const requestJson = async <TResponse>(
    url: string,
    schema: z.ZodType<TResponse>,
    options?: {
      method?: 'GET' | 'POST';
      body?: unknown;
      token?: string;
    },
  ): Promise<TResponse> => {
    const response = await fetch(url, {
      method: options?.method ?? 'GET',
      headers: {
        ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return parseJsonResponse(response, schema);
  };
  return {
    async getHealth() {
      const response = await fetch(`${normalizedBaseUrl}/health`);
      return parseJsonResponse(response, healthResponseSchema);
    },
    async getCapabilities() {
      const response = await fetch(`${normalizedBaseUrl}${serverRoutes.meta.capabilities}`);
      return parseJsonResponse(response, capabilitiesResponseSchema);
    },
    async getBootstrapStatus() {
      return this.getBootstrapStatusFor('lite');
    },
    async getBootstrapStatusFor(product) {
      return requestJson(buildAuthUrl(serverRoutes.auth.bootstrapStatus, product), bootstrapStatusSchema);
    },
    async bootstrap(input) {
      return this.bootstrapFor('lite', input);
    },
    async bootstrapFor(product, input) {
      return requestJson(buildAuthUrl(serverRoutes.auth.bootstrap, product), authResponseSchema, {
        method: 'POST',
        body: bootstrapRequestSchema.parse(input),
      });
    },
    async login(input) {
      return this.loginFor('lite', input);
    },
    async loginFor(product, input) {
      return requestJson(buildAuthUrl(serverRoutes.auth.login, product), authResponseSchema, {
        method: 'POST',
        body: loginRequestSchema.parse(input),
      });
    },
    async getSessionInfo(args) {
      const parsed = z
        .object({
          token: z.string().min(1),
          product: serverProductSchema.default('lite'),
        })
        .parse(args);
      return requestJson(buildAuthUrl(serverRoutes.auth.me, parsed.product), authSessionInfoSchema, {
        token: parsed.token,
      });
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
  };
};
