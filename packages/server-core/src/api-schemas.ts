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

export const taxFilingKindSchema = z.enum(['euer', 'e_bilanz', 'unternehmensregister']);
export const taxFilingProviderSchema = z.enum(['eric_euer', 'eric_e_bilanz', 'unternehmensregister']);
export const taxFilingStatusSchema = z.enum([
  'draft',
  'validated',
  'frozen',
  'pending_second_approval',
  'approved',
  'queued',
  'transmitting',
  'accepted',
  'rejected',
  'retryable_failed',
]);

export const taxFilingSnapshotSchema = z.object({
  kind: taxFilingKindSchema,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payload: z.record(z.unknown()),
});

export const taxFilingSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  kind: taxFilingKindSchema,
  provider: taxFilingProviderSchema,
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  status: taxFilingStatusSchema,
  snapshot: taxFilingSnapshotSchema,
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1),
  createdByActorId: z.string().min(1),
  validatedByActorId: z.string().min(1).optional(),
  frozenByActorId: z.string().min(1).optional(),
  approvedByActorId: z.string().min(1).optional(),
  queuedByActorId: z.string().min(1).optional(),
  transmittingByActorId: z.string().min(1).optional(),
  completedByActorId: z.string().min(1).optional(),
  lastMutationIdempotencyKey: z.string().min(1).optional(),
  lastMutationAction: z.string().min(1).optional(),
  providerSubmissionId: z.string().min(1).optional(),
  providerReference: z.string().min(1).optional(),
  failureCode: z.string().min(1).optional(),
  failureMessage: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  validatedAt: z.string().min(1).optional(),
  frozenAt: z.string().min(1).optional(),
  approvedAt: z.string().min(1).optional(),
  queuedAt: z.string().min(1).optional(),
  transmittingAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
});

export const taxFilingCreateRequestSchema = z.object({
  id: z.string().min(1).optional(),
  kind: taxFilingKindSchema,
  provider: taxFilingProviderSchema.optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1),
});

export const taxFilingMutationRequestSchema = z.object({
  reason: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type TaxFiling = z.infer<typeof taxFilingSchema>;
