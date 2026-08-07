import { z } from 'zod';
import { serverProductSchema, serverRoleSchema } from './shared/runtime-profile.js';

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

export const vatValidationRequestSchema = z.object({
  countryCode: z.string().length(2).transform((value) => value.toUpperCase()),
  vatNumber: z.string().trim().min(4).max(32),
});
export type VatValidationRequest = z.input<typeof vatValidationRequestSchema>;
