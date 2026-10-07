import { z } from 'zod';
import { serverProductSchema, serverRoleSchema } from './shared/runtime-profile.js';

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string().min(1),
  backend: z.literal('fastify'),
  mode: z.enum(['api', 'worker']),
  ts: z.string().min(1),
  /** Embedded runtime only: identifies this start of the desktop app. */
  instanceId: z.string().min(1).optional(),
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
  /** Required when the server sets BILLME_SETUP_TOKEN; keeps a fresh public instance from being claimed by anyone. */
  setupToken: z.string().optional(),
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
  setupTokenRequired: z.boolean().optional(),
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

/** `full` acts with the approving user's own role; `read` is limited to GET requests. */
export const cliTokenScopeSchema = z.enum(['full', 'read']);
export type CliTokenScope = z.infer<typeof cliTokenScopeSchema>;

export const CLI_TOKEN_PREFIX = 'billme_cli_';

export const cliTokenSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  product: serverProductSchema,
  scope: cliTokenScopeSchema,
  createdAt: z.string().min(1),
  lastUsedAt: z.string().min(1).optional(),
});
export type CliTokenSummary = z.infer<typeof cliTokenSummarySchema>;

/** Members and open invitations of one workspace (hosted server mode). */
export const teamMemberSchema = z.object({
  userId: z.string().min(1),
  email: z.string(),
  fullName: z.string(),
  role: serverRoleSchema,
  joinedAt: z.string(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamInvitationSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  role: serverRoleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;

export const teamSchema = z.object({ members: z.array(teamMemberSchema), invitations: z.array(teamInvitationSchema) });

export const teamInviteResultSchema = z.object({
  invitation: teamInvitationSchema,
  /** Shown to the inviting person so they can pass it on when mail is not configured. */
  inviteUrl: z.string(),
  mailSent: z.boolean(),
});

export const workspaceSummarySchema = z.object({
  tenantId: z.string().min(1),
  name: z.string(),
  product: serverProductSchema,
  role: serverRoleSchema,
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

/** A session for one workspace, as sign-up, switching and invitations return it. */
export const workspaceSessionSchema = z.object({
  token: z.string().min(1),
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
});
export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

export const invitationPreviewSchema = z.object({
  email: z.string(),
  role: serverRoleSchema,
  workspaceName: z.string(),
  product: serverProductSchema,
  userExists: z.boolean(),
});

export const productAppsSchema = z.object({ lite: z.string().optional(), pro: z.string().optional() });
export const workspaceListSchema = z.array(workspaceSummarySchema);
export const sessionTenantSchema = z.object({ tenantId: z.string(), user: authUserSchema }).passthrough();
export const okResultSchema = z.object({ ok: z.literal(true) });

export const deviceLoginStartRequestSchema = z.object({
  product: serverProductSchema,
  label: z.string().trim().min(1).max(80),
  scope: cliTokenScopeSchema.default('full'),
});

export const deviceLoginStartResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  /** Absent where no browser page can take the code, e.g. the desktop app. */
  verificationUri: z.string().url().optional(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceLoginStartResponse = z.infer<typeof deviceLoginStartResponseSchema>;

export const deviceLoginTokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'denied', 'expired']) }),
  z.object({ status: z.literal('approved'), token: z.string().min(1), user: authUserSchema }),
]);
export type DeviceLoginTokenResponse = z.infer<typeof deviceLoginTokenResponseSchema>;

/** What the approving user sees before deciding on a CLI login request. */
export const cliAccessRequestSchema = z.object({
  userCode: z.string().min(1),
  label: z.string().min(1),
  scope: cliTokenScopeSchema,
  createdAt: z.string().min(1),
});
export type CliAccessRequest = z.infer<typeof cliAccessRequestSchema>;

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
  approvalRequestedByActorId: z.string().min(1).optional(),
  approvalRequestedAt: z.string().min(1).optional(),
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
