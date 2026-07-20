import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  addTenantUserRequestSchema,
  agentTokenCreateResponseSchema,
  agentTokenSummarySchema,
  authUserSchema,
  bootstrapRequestSchema,
  capabilitiesResponseSchema,
  clientSchema,
  createAgentTokenRequestSchema,
  createSingleTenantScope,
  createWorkspaceRequestSchema,
  calculateInvoiceTaxSnapshot,
  finalizeDocumentNumber,
  healthResponseSchema,
  invoiceSchema,
  isPortalUrlAllowed,
  loginRequestSchema,
  mobileDeviceLoginRequestSchema,
  mobileDeviceSchema,
  mobileDocumentFinalizeRequestSchema,
  mobileDocumentFinalizeResponseSchema,
  mobileHomeSchema,
  mobilePairingCodeSchema,
  mobilePairingExchangeRequestSchema,
  mobilePushRegistrationSchema,
  mobileSessionRefreshRequestSchema,
  mobileSessionSchema,
  offerSchema,
  platformAdminAuthResponseSchema,
  platformAdminLoginRequestSchema,
  platformTenantSummarySchema,
  platformTenantUserSummarySchema,
  recurringProfileSchema,
  receiptConfirmRequestSchema,
  receiptSchema,
  receiptUploadMetadataSchema,
  parsePortalAllowedOrigins,
  releaseDocumentNumber,
  resolveInvoiceTaxMode,
  reserveDocumentNumber,
  serverProductSchema,
  serverRoleSchema,
  supportedServerProducts,
  supportedServerRoles,
  type AuditEntryDraft,
  type MobileDocumentFinalizeResponse,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresBillingDependencies,
  createPostgresBillingUnitOfWork,
  createPostgresPool,
  createPostgresProAccountingCatalogRepository,
  createPostgresProWorkflowRepository,
  enqueueMobilePush,
  createPostgresAgentToken,
  consumeMobilePairingCode,
  createMobilePairingCode,
  createMobileRefreshToken,
  getMobileDocumentMutation,
  getPostgresReceipt,
  getServerActiveTemplates,
  getServerSettings,
  listServerArticles,
  listServerBankAccounts,
  listServerNumberReservations,
  listServerTemplates,
  readDatabaseUrl,
  runPostgresMigrations,
  saveServerActiveTemplates,
  saveServerArticle,
  saveServerBankAccount,
  saveServerNumberReservation,
  saveServerSettings,
  saveServerTemplate,
  listPostgresAgentTokens,
  listMobileDeviceSessions,
  listPostgresReceipts,
  insertDocumentDelivery,
  insertMobileDeviceSession,
  insertMobileDocumentMutation,
  insertMobilePairingCode,
  insertPostgresReceipt,
  registerMobilePushToken,
  revokeMobileDeviceSession,
  rotateMobileDeviceSession,
  updatePostgresReceipt,
  revokePostgresAgentToken,
  verifyPostgresAgentToken,
  withPostgresTransaction,
  type PostgresQueryable,
  type MobilePrincipal,
} from '@billme/server-data';
import {
  accountSchema,
  appSettingsSchema,
  articleSchema,
  ledgerAccountSchema,
  listTemplatesParamsSchema,
  proListAccountSuggestionRulesArgsSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema,
  templateKindSchema,
  templateSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { PlatformTokenService, SessionTokenService, type AuthSession, type AuthSessionInfo, type PlatformSession } from './auth.js';
import { createAuthStore, createPlatformAuthStore, type AuthStore, type PlatformAuthStore } from './authStore.js';
import { assertTenantCapability, type TenantCapability } from './authorization.js';
import { registerAuthRateLimit } from './auth-rate-limit.js';
import { ApiError, registerErrorHandler, typedRoute } from './http.js';

type Pool = ReturnType<typeof createPostgresPool>;
type AppSettings = z.infer<typeof appSettingsSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const entityIdParamsSchema = z.object({ id: z.string().min(1) });
const deletePayloadSchema = z.object({ reason: z.string().trim().min(1) });
const documentKindSchema = z.enum(['invoice', 'offer']);
const mobileBookingDraftSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  transactionId: z.string().min(1),
  workflowStatus: z.enum([
    'imported', 'suggested', 'incomplete', 'ready_for_review', 'pending_approval', 'approved',
    'posted', 'reversed', 'corrected', 'period_locked', 'integration_error',
  ]),
  postingDate: z.string().optional(),
  documentDate: z.string().optional(),
  bookingText: z.string().min(1),
  reference: z.string().optional(),
  period: z.string().min(1),
  fiscalYear: z.number().int(),
  lines: z.array(z.object({
    id: z.string().min(1), accountNumber: z.string().min(1), debitAmount: z.number(), creditAmount: z.number(),
    taxCode: z.string().optional(), taxCaseKey: z.string().optional(), taxRate: z.number().optional(),
    netAmount: z.number().optional(), taxAmount: z.number().optional(), grossAmount: z.number().optional(),
    countryCode: z.string().optional(), counterpartyVatId: z.string().optional(), evidenceType: z.string().optional(),
    evidenceReference: z.string().optional(), costCenter: z.string().optional(), memo: z.string().optional(),
  })).min(1),
  validationIssues: z.array(z.object({
    id: z.string().min(1), code: z.string().min(1), severity: z.enum(['error', 'warning', 'info']),
    message: z.string().min(1), fieldPath: z.string().optional(), blocking: z.boolean(),
    source: z.enum(['system', 'user', 'rule']),
  })).default([]),
  updatedAt: z.string().min(1),
});
const productAuthStatusQuerySchema = z.object({
  product: serverProductSchema.default('lite'),
});
const documentExportQuerySchema = z.object({
  kind: documentKindSchema,
});
const numberReserveBodySchema = z.object({
  kind: z.enum(['invoice', 'offer', 'customer']),
});
const numberReleaseBodySchema = z.object({
  reservationId: z.string().min(1),
});
const numberFinalizeBodySchema = z.object({
  reservationId: z.string().min(1),
  documentId: z.string().min(1),
});
const authSessionInfoSchema = z.object({
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: z.enum(supportedServerRoles),
});
const templateRecordSchema = z.object({
  id: z.string().min(1),
  kind: templateKindSchema,
  name: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  elements: templateSchema.shape.elements,
});

const clientWriteSchema = clientSchema.omit({
  tenantId: true,
});
const invoiceWriteSchema = invoiceSchema.omit({
  tenantId: true,
});
const offerWriteSchema = offerSchema.omit({
  tenantId: true,
});
const recurringWriteSchema = recurringProfileSchema.omit({
  tenantId: true,
});

const toAuditActor = (session: AuthSession) => ({
  type: 'user' as const,
  id: session.user.id,
  displayName: session.user.fullName,
});

const toSessionInfo = (session: AuthSession): AuthSessionInfo => ({
  user: session.user,
  tenantId: session.scope.tenantId,
  product: session.scope.product,
  role: session.role,
});

const buildAuditEntry = (
  scope: TenantScope,
  session: AuthSession,
  subject: 'client' | 'invoice' | 'offer' | 'recurring-profile' | 'receipt',
  entityId: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
): AuditEntryDraft => ({
  occurredAt: new Date().toISOString(),
  action,
  reason,
  actor: toAuditActor(session),
  subject: {
    entityType: subject,
    entityId,
    tenantId: scope.tenantId,
  },
  change: {
    before,
    after,
  },
});

const historyFromAudit = async (
  db: Pool,
  scope: TenantScope,
  entityType: 'invoice' | 'offer',
  entityId: string,
): Promise<Array<{ date: string; action: string }>> => {
  const auditLog = createPostgresBillingDependencies(db).auditLog;
  const entries = await auditLog.listBySubject(scope, {
    entityType,
    entityId,
    tenantId: scope.tenantId,
  });
  return entries.map((entry) => ({
    date: entry.occurredAt.split('T')[0] ?? entry.occurredAt,
    action: entry.reason ? `${entry.action} (${entry.reason})` : entry.action,
  }));
};

const withInvoiceHistory = async (db: Pool, scope: TenantScope, invoice: z.infer<typeof invoiceSchema>) => {
  return {
    ...invoice,
    history: await historyFromAudit(db, scope, 'invoice', invoice.id),
  };
};

const withOfferHistory = async (db: Pool, scope: TenantScope, offer: z.infer<typeof offerSchema>) => {
  return {
    ...offer,
    history: await historyFromAudit(db, scope, 'offer', offer.id),
  };
};

const csvEscape = (value: unknown): string => {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
};

const toCsv = (rows: Array<Record<string, unknown>>, columns: string[]): string => {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  return `${lines.join('\n')}\n`;
};

const parseStoredSettings = (record: Awaited<ReturnType<typeof getServerSettings>>) => {
  if (!record) {
    return null;
  }
  return appSettingsSchema.parse(JSON.parse(record.settingsJson));
};

const mapTemplateRecord = (record: Awaited<ReturnType<typeof listServerTemplates>>[number]) =>
  templateRecordSchema.parse({
    id: record.id,
    kind: record.kind,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    elements: JSON.parse(record.elementsJson),
  });

const mapArticleRecord = (record: Awaited<ReturnType<typeof listServerArticles>>[number]) =>
  articleSchema.parse({
    id: record.id,
    sku: record.sku,
    title: record.title,
    description: record.description,
    price: record.price,
    unit: record.unit,
    category: record.category,
    taxRate: record.taxRate,
  });

const mapAccountRecord = (record: Awaited<ReturnType<typeof listServerBankAccounts>>[number]) =>
  accountSchema.parse({
    id: record.id,
    name: record.name,
    iban: record.iban,
    balance: record.balance,
    defaultSkrAccountNumber: record.defaultSkrAccountNumber,
    transactions: [],
    type: record.type,
    color: record.color,
  });

const requireSession = async (
  app: FastifyInstance,
  product: 'lite' | 'pro',
  authHeader: string | undefined,
): Promise<AuthSession> => {
  const token = app.tokenService.readBearerToken(authHeader);
  if (!token) {
    throw new ApiError(401, 'Missing bearer token');
  }
  const session = app.tokenService.verify(token);
  if (session) {
    if (session.scope.product !== product) {
      throw new ApiError(403, `Token is not authorized for ${product}`);
    }
    return session;
  }
  if (app.serverPool) {
    const agent = await verifyPostgresAgentToken(app.serverPool, token, product);
    if (agent) {
      if (!agent.scopes.includes('read')) {
        throw new ApiError(403, 'Agent token is missing the read scope');
      }
      return {
        user: {
          id: agent.userId,
          email: agent.email,
          fullName: agent.fullName,
          role: agent.role,
        },
        scope: {
          tenantId: agent.tenantId,
          product: agent.product,
          deploymentMode: agent.deploymentMode,
        },
        role: agent.role,
        agentId: agent.id,
        agentScopes: agent.scopes,
      };
    }
  }
  throw new ApiError(401, 'Invalid or expired bearer token');
};

const requireCapability = async (
  app: FastifyInstance,
  product: 'lite' | 'pro',
  authHeader: string | undefined,
  capability: TenantCapability,
): Promise<AuthSession> => {
  const session = await requireSession(app, product, authHeader);
  try {
    assertTenantCapability(session.role, capability);
    if (session.agentScopes && !session.agentScopes.includes(capability)) {
      throw new ApiError(403, `Agent token is missing the ${capability} scope`);
    }
  } catch (error) {
    app.log.warn({ tenantId: session.scope.tenantId, role: session.role, capability }, 'Denied tenant capability');
    throw error;
  }
  return session;
};

const requireAgentManager = (session: AuthSession): AuthSession => {
  if (session.agentId || !['owner', 'admin'].includes(session.role)) {
    throw new ApiError(403, 'Only an owner or admin user session may manage agent tokens');
  }
  return session;
};

const login = async (app: FastifyInstance, product: 'lite' | 'pro', body: z.infer<typeof loginRequestSchema>) => {
  try {
    return await app.authStore.login(product, body);
  } catch {
    throw new ApiError(401, 'Invalid email or password');
  }
};

const timingSafeStringEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

const requirePlatformSession = async (
  app: FastifyInstance,
  authHeader: string | undefined,
): Promise<PlatformSession> => {
  const token = app.platformTokenService.readBearerToken(authHeader);
  if (!token) {
    throw new ApiError(401, 'Missing bearer token');
  }
  const session = app.platformTokenService.verify(token);
  if (!session) {
    throw new ApiError(401, 'Invalid or expired bearer token');
  }
  return session;
};

const requirePool = (app: FastifyInstance): Pool => {
  if (!app.serverPool) {
    throw new ApiError(503, 'DATABASE_URL is required for server billing routes');
  }
  return app.serverPool;
};

const createNumberingPortsForDb = (db: PostgresQueryable, scope: TenantScope) => ({
  tx: {
    async inTransaction<TResult>(work: () => Promise<TResult> | TResult): Promise<TResult> {
      return await work();
    },
  },
  async getSettings() {
    return parseStoredSettings(await getServerSettings(db, scope.tenantId, { forUpdate: true }));
  },
  async saveSettings(settings: AppSettings) {
    await saveServerSettings(db, {
      tenantId: scope.tenantId,
      settingsJson: JSON.stringify(appSettingsSchema.parse(settings)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async createReservation(reservation: {
    id: string;
    kind: 'invoice' | 'offer' | 'customer';
    number: string;
    counterValue: number;
    status: 'reserved' | 'released' | 'finalized';
    documentId: string | null;
  }) {
    await saveServerNumberReservation(db, {
      ...reservation,
      tenantId: scope.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async getReservationById(reservationId: string) {
    const reservations = await listServerNumberReservations(db, scope.tenantId);
    const reservation = reservations.find((entry) => entry.id === reservationId);
    return reservation
      ? {
          id: reservation.id,
          kind: reservation.kind,
          number: reservation.number,
          counterValue: reservation.counterValue,
          status: reservation.status,
          documentId: reservation.documentId,
        }
      : null;
  },
  async updateReservation(reservation: {
    id: string;
    kind: 'invoice' | 'offer' | 'customer';
    number: string;
    counterValue: number;
    status: 'reserved' | 'released' | 'finalized';
    documentId: string | null;
  }) {
    await saveServerNumberReservation(db, {
      ...reservation,
      tenantId: scope.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async isNumberTaken(kind: 'invoice' | 'offer' | 'customer', number: string) {
    const entityTable = kind === 'customer' ? 'clients' : kind === 'invoice' ? 'invoices' : 'offers';
    const entityColumn = kind === 'customer' ? 'customer_number' : 'number';
    const entityMatch = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${entityTable} WHERE tenant_id = $1 AND ${entityColumn} = $2) AS exists`,
      [scope.tenantId, number],
    );
    if (entityMatch.rows[0]?.exists) {
      return true;
    }
    const reservationMatch = await db.query<{ exists: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM number_reservations
          WHERE tenant_id = $1
            AND kind = $2
            AND number = $3
            AND status <> 'released'
        ) AS exists
      `,
      [scope.tenantId, kind, number],
    );
    return Boolean(reservationMatch.rows[0]?.exists);
  },
  async generateReservationId() {
    return randomUUID();
  },
});

const reserveNumberForScope = async (pool: Pool, scope: TenantScope, kind: 'invoice' | 'offer' | 'customer') => {
  return withPostgresTransaction(pool, async (client) => reserveDocumentNumber(createNumberingPortsForDb(client, scope), kind));
};

const releaseNumberForScope = async (pool: Pool, scope: TenantScope, reservationId: string) => {
  return withPostgresTransaction(pool, async (client) =>
    releaseDocumentNumber(createNumberingPortsForDb(client, scope), reservationId),
  );
};

const finalizeNumberForScope = async (pool: Pool, scope: TenantScope, reservationId: string, documentId: string) => {
  return withPostgresTransaction(pool, async (client) =>
    finalizeDocumentNumber(createNumberingPortsForDb(client, scope), reservationId, documentId),
  );
};

const mobileReceiptUploadBodySchema = z.object({
  metadata: receiptUploadMetadataSchema,
  dataBase64: z.string().min(4).max(21 * 1024 * 1024),
});

const mobileStorageRoot = (): string =>
  process.env.BILLME_DOCUMENT_STORAGE_PATH?.trim() || join(tmpdir(), 'billme-documents');

const receiptExtension = (mimeType: 'image/jpeg' | 'image/png' | 'application/pdf'): string =>
  mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : '.pdf';

const hasExpectedMagicBytes = (data: Buffer, mimeType: 'image/jpeg' | 'image/png' | 'application/pdf'): boolean => {
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return data.subarray(0, 5).toString('ascii') === '%PDF-';
};

const resolveMobilePrincipal = async (
  pool: Pool,
  principal: { tenantId: string; product: 'lite' | 'pro'; role: z.infer<typeof serverRoleSchema>; user: z.infer<typeof authUserSchema> },
): Promise<MobilePrincipal> => {
  const result = await pool.query<{ deployment_mode: 'single-tenant' | 'multi-tenant' }>(
    'SELECT deployment_mode FROM tenants WHERE id = $1 LIMIT 1',
    [principal.tenantId],
  );
  return {
    tenantId: principal.tenantId,
    userId: principal.user.id,
    product: principal.product,
    role: principal.role,
    deploymentMode: result.rows[0]?.deployment_mode ?? 'single-tenant',
    email: principal.user.email,
    fullName: principal.user.fullName,
  };
};

const buildMobileSession = (
  app: FastifyInstance,
  principal: MobilePrincipal,
  device: z.infer<typeof mobileDeviceSchema>,
  refreshToken: string,
  refreshTokenExpiresAt: string,
) => {
  const accessTokenExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return mobileSessionSchema.parse({
    accessToken: app.tokenService.sign({
      user: {
        id: principal.userId,
        email: principal.email,
        fullName: principal.fullName,
        role: principal.role,
      },
      scope: {
        tenantId: principal.tenantId,
        product: principal.product,
        deploymentMode: principal.deploymentMode,
      },
      role: principal.role,
    }, 15 * 60),
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    user: {
      id: principal.userId,
      email: principal.email,
      fullName: principal.fullName,
      role: principal.role,
    },
    tenantId: principal.tenantId,
    product: principal.product,
    role: principal.role,
    device,
  });
};

const createMobileSessionForPrincipal = async (
  app: FastifyInstance,
  principal: MobilePrincipal,
  input: { deviceName: string; platform: 'ios' | 'android' },
) => {
  const refreshToken = createMobileRefreshToken();
  const refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  const device = await insertMobileDeviceSession(requirePool(app), {
    ...principal,
    ...input,
    refreshToken,
    refreshExpiresAt: refreshTokenExpiresAt,
  });
  return buildMobileSession(app, principal, device, refreshToken, refreshTokenExpiresAt);
};

const registerPlatformRoutes = (app: FastifyInstance, prefix = '/api/v1/platform') => {
  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/login`,
    body: platformAdminLoginRequestSchema,
    response: platformAdminAuthResponseSchema,
    async handler({ body }) {
      const expectedEmail = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase();
      const expectedPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
      const candidateEmail = body.email.trim().toLowerCase();

      const emailMatches = expectedEmail.length > 0 && candidateEmail === expectedEmail;
      const passwordMatches =
        expectedPassword.length > 0 &&
        body.password.length === expectedPassword.length &&
        timingSafeStringEqual(body.password, expectedPassword);

      if (!emailMatches || !passwordMatches) {
        throw new ApiError(401, 'Invalid platform admin credentials');
      }

      return {
        token: app.platformTokenService.sign({ admin: { email: expectedEmail } }),
        admin: { adminId: 'platform-admin', email: expectedEmail },
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/tenants`,
    response: z.array(platformTenantSummarySchema),
    async handler({ request }) {
      await requirePlatformSession(app, request.headers.authorization);
      return app.platformAuthStore.listTenants();
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/tenants`,
    body: createWorkspaceRequestSchema,
    response: platformTenantSummarySchema,
    async handler({ request, body }) {
      await requirePlatformSession(app, request.headers.authorization);
      return app.platformAuthStore.createTenant(body);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/tenants/:tenantId/users`,
    params: z.object({ tenantId: z.string().min(1) }),
    response: z.array(platformTenantUserSummarySchema),
    async handler({ request, params }) {
      await requirePlatformSession(app, request.headers.authorization);
      return app.platformAuthStore.listTenantUsers(params.tenantId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/tenants/:tenantId/users`,
    params: z.object({ tenantId: z.string().min(1) }),
    body: addTenantUserRequestSchema,
    response: platformTenantUserSummarySchema,
    async handler({ request, params, body }) {
      await requirePlatformSession(app, request.headers.authorization);
      return app.platformAuthStore.addTenantUser(params.tenantId, body);
    },
  });
};

const registerAuthRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/auth/bootstrap/status`,
    response: z.object({
      bootstrapped: z.boolean(),
      userCount: z.number().int().nonnegative(),
    }),
    async handler() {
      return app.authStore.getBootstrapStatus(product);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/bootstrap`,
    body: bootstrapRequestSchema,
    response: z.object({
      token: z.string().min(1),
      user: authUserSchema,
    }),
    async handler({ body }) {
      const principal = await app.authStore.bootstrap(product, body);
      return {
        token: app.tokenService.sign({
          user: principal.user,
          scope: createSingleTenantScope(principal.tenantId, principal.product),
          role: principal.role,
        }),
        user: principal.user,
      };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/login`,
    body: loginRequestSchema,
    response: z.object({
      token: z.string().min(1),
      user: authUserSchema,
    }),
    async handler({ body }) {
      const principal = await login(app, product, body);
      return {
        token: app.tokenService.sign({
          user: principal.user,
          scope: createSingleTenantScope(principal.tenantId, principal.product),
          role: principal.role,
        }),
        user: principal.user,
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/auth/me`,
    response: authSessionInfoSchema,
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return toSessionInfo(session);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/auth/agent-tokens`,
    response: z.array(agentTokenSummarySchema),
    async handler({ request }) {
      const session = requireAgentManager(await requireSession(app, product, request.headers.authorization));
      return listPostgresAgentTokens(requirePool(app), session.scope.tenantId, product);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/agent-tokens`,
    body: createAgentTokenRequestSchema,
    response: agentTokenCreateResponseSchema,
    async handler({ request, body }) {
      const session = requireAgentManager(await requireSession(app, product, request.headers.authorization));
      if (!body.scopes.includes('read')) {
        throw new ApiError(400, 'Agent tokens must include the read scope');
      }
      return createPostgresAgentToken(requirePool(app), {
        ...body,
        tenantId: session.scope.tenantId,
        userId: session.user.id,
        product,
      });
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/auth/agent-tokens/:id`,
    params: entityIdParamsSchema,
    response: okSchema,
    async handler({ request, params }) {
      const session = requireAgentManager(await requireSession(app, product, request.headers.authorization));
      const revoked = await revokePostgresAgentToken(requirePool(app), session.scope.tenantId, product, params.id);
      if (!revoked) {
        throw new ApiError(404, 'Agent token not found');
      }
      return { ok: true as const };
    },
  });
};

const registerMobileAuthRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/device-sessions/login`,
    body: mobileDeviceLoginRequestSchema,
    response: mobileSessionSchema,
    async handler({ body }) {
      const authenticated = await login(app, product, body);
      const principal = await resolveMobilePrincipal(requirePool(app), authenticated);
      return createMobileSessionForPrincipal(app, principal, body);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/device-sessions/refresh`,
    body: mobileSessionRefreshRequestSchema,
    response: mobileSessionSchema,
    async handler({ body }) {
      const nextToken = createMobileRefreshToken();
      const nextExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
      const rotated = await rotateMobileDeviceSession(requirePool(app), body.refreshToken, nextToken, nextExpiresAt);
      if (!rotated || rotated.principal.product !== product) {
        throw new ApiError(401, 'Invalid or expired refresh token');
      }
      return buildMobileSession(app, rotated.principal, rotated.device, nextToken, nextExpiresAt);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/auth/device-sessions`,
    response: z.array(mobileDeviceSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.agentId) throw new ApiError(403, 'Agent tokens cannot manage mobile devices');
      return listMobileDeviceSessions(requirePool(app), session.scope.tenantId, session.user.id, product);
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/auth/device-sessions/:id`,
    params: entityIdParamsSchema,
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.agentId) throw new ApiError(403, 'Agent tokens cannot manage mobile devices');
      const revoked = await revokeMobileDeviceSession(
        requirePool(app), session.scope.tenantId, session.user.id, params.id,
      );
      if (!revoked) throw new ApiError(404, 'Mobile device not found');
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/device-sessions/:id/push`,
    params: entityIdParamsSchema,
    body: mobilePushRegistrationSchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.agentId) throw new ApiError(403, 'Agent tokens cannot register mobile devices');
      const registered = await registerMobilePushToken(
        requirePool(app), session.scope.tenantId, session.user.id, params.id, body.token, body.provider,
      );
      if (!registered) throw new ApiError(404, 'Mobile device not found');
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/pairing-codes`,
    response: mobilePairingCodeSchema,
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.agentId) throw new ApiError(403, 'Agent tokens cannot create pairing codes');
      const code = createMobilePairingCode();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const principal: MobilePrincipal = {
        tenantId: session.scope.tenantId,
        userId: session.user.id,
        product,
        role: session.role,
        deploymentMode: session.scope.deploymentMode,
        email: session.user.email,
        fullName: session.user.fullName,
      };
      await insertMobilePairingCode(requirePool(app), { code, principal, expiresAt });
      const configuredBase = process.env.BILLME_PUBLIC_URL?.trim().replace(/\/+$/, '');
      const requestBase = `${request.protocol}://${request.headers.host}`;
      const pairingUri = new URL('billme://pair');
      pairingUri.searchParams.set('server', configuredBase || requestBase);
      pairingUri.searchParams.set('product', product);
      pairingUri.searchParams.set('code', code);
      return { code, expiresAt, pairingUri: pairingUri.toString() };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/auth/pairing-codes/exchange`,
    body: mobilePairingExchangeRequestSchema,
    response: mobileSessionSchema,
    async handler({ body }) {
      const principal = await consumeMobilePairingCode(requirePool(app), body.code);
      if (!principal || principal.product !== product) throw new ApiError(401, 'Invalid or expired pairing code');
      return createMobileSessionForPrincipal(app, principal, body);
    },
  });
};

const registerMobileRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/mobile/home`,
    response: mobileHomeSchema,
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requirePool(app);
      const repositories = createPostgresBillingDependencies(pool);
      const [invoices, offers, receipts, bookingResult] = await Promise.all([
        repositories.invoiceRepo.list(session.scope),
        repositories.offerRepo.list(session.scope),
        listPostgresReceipts(pool, session.scope.tenantId),
        product === 'pro'
          ? pool.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM booking_drafts
               WHERE tenant_id = $1 AND workflow_status NOT IN ('posted', 'reversed')`,
              [session.scope.tenantId],
            )
          : Promise.resolve({ rows: [{ count: '0' }] }),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const openInvoices = invoices.filter((invoice) => ['open', 'overdue'].includes(invoice.status));
      const overdueInvoices = openInvoices.filter((invoice) => invoice.status === 'overdue' || invoice.dueDate < today);
      const draftDocuments = invoices.filter((invoice) => invoice.status === 'draft').length
        + offers.filter((offer) => offer.status === 'draft').length;
      const receiptsToReview = receipts.filter((receipt) => receipt.status === 'needs_review').length;
      const bookingReviews = Number(bookingResult.rows[0]?.count ?? 0);
      const actions = [
        ...overdueInvoices.map((invoice) => ({
          id: `overdue:${invoice.id}`,
          type: 'overdue_invoice' as const,
          title: `${invoice.number} is overdue`,
          detail: `${invoice.client} · due ${invoice.dueDate}`,
          amount: invoice.amount,
          dueAt: invoice.dueDate,
          severity: 'urgent' as const,
          route: `/documents/invoice/${invoice.id}`,
        })),
        ...receipts.filter((receipt) => receipt.status === 'needs_review').map((receipt) => ({
          id: `receipt:${receipt.id}`,
          type: 'receipt_review' as const,
          title: 'Review captured receipt',
          detail: receipt.suggestion?.merchant.value || receipt.originalName,
          amount: receipt.suggestion?.grossAmount.value ?? undefined,
          severity: 'attention' as const,
          route: `/receipts/${receipt.id}`,
        })),
        ...invoices.filter((invoice) => invoice.status === 'draft').slice(0, 5).map((invoice) => ({
          id: `invoice-draft:${invoice.id}`,
          type: 'draft_document' as const,
          title: 'Finish invoice draft',
          detail: invoice.client,
          amount: invoice.amount,
          severity: 'neutral' as const,
          route: `/documents/invoice/${invoice.id}`,
        })),
        ...offers.filter((offer) => offer.status === 'accepted').slice(0, 5).map((offer) => ({
          id: `offer-decision:${offer.id}`,
          type: 'offer_decision' as const,
          title: `${offer.number} was accepted`,
          detail: offer.client,
          amount: offer.amount,
          severity: 'attention' as const,
          route: `/documents/offer/${offer.id}`,
        })),
        ...(bookingReviews > 0 ? [{
          id: 'booking-reviews',
          type: 'booking_review' as const,
          title: `${bookingReviews} booking${bookingReviews === 1 ? '' : 's'} need review`,
          detail: 'Validate and approve accounting suggestions',
          severity: 'attention' as const,
          route: '/accounting/review',
        }] : []),
      ].sort((left, right) => {
        const rank = { urgent: 0, attention: 1, neutral: 2 } as const;
        return rank[left.severity] - rank[right.severity];
      }).slice(0, 20);
      const recentActivity = [
        ...invoices.map((invoice) => ({
          id: `invoice:${invoice.id}`,
          title: invoice.number,
          detail: `${invoice.client} · ${invoice.status}`,
          occurredAt: invoice.updatedAt ?? invoice.createdAt ?? `${invoice.date}T00:00:00.000Z`,
          route: `/documents/invoice/${invoice.id}`,
        })),
        ...offers.map((offer) => ({
          id: `offer:${offer.id}`,
          title: offer.number,
          detail: `${offer.client} · ${offer.status}`,
          occurredAt: offer.updatedAt ?? offer.createdAt ?? `${offer.date}T00:00:00.000Z`,
          route: `/documents/offer/${offer.id}`,
        })),
        ...receipts.map((receipt) => ({
          id: `receipt:${receipt.id}`,
          title: receipt.originalName,
          detail: receipt.status.replace('_', ' '),
          occurredAt: receipt.updatedAt,
          route: `/receipts/${receipt.id}`,
        })),
      ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 20);
      return mobileHomeSchema.parse({
        serverTime: new Date().toISOString(),
        summary: {
          openReceivables: openInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
          overdueReceivables: overdueInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
          draftDocuments,
          receiptsToReview,
          bookingReviews,
        },
        actions,
        recentActivity,
      });
    },
  });

  app.get(`${prefix}/documents/:kind/:id/pdf`, async (request, reply) => {
    const session = await requireSession(app, product, request.headers.authorization);
    const params = z.object({ kind: documentKindSchema, id: z.string().min(1) }).parse(request.params);
    const pool = requirePool(app);
    const document = params.kind === 'invoice'
      ? await createPostgresBillingDependencies(pool).invoiceRepo.getById(session.scope, params.id)
      : await createPostgresBillingDependencies(pool).offerRepo.getById(session.scope, params.id);
    if (!document) throw new ApiError(404, 'Document not found');
    const result = await pool.query<{ attachment_storage_key: string | null }>(
      `SELECT attachment_storage_key FROM document_deliveries
       WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3
       ORDER BY created_at DESC LIMIT 1`,
      [session.scope.tenantId, params.kind, params.id],
    );
    const storageKey = result.rows[0]?.attachment_storage_key;
    if (!storageKey) {
      if (!result.rows[0]) {
        await insertDocumentDelivery(pool, {
          tenantId: session.scope.tenantId,
          userId: session.user.id,
          documentType: params.kind,
          documentId: params.id,
          recipientEmail: session.user.email,
        });
      }
      return reply.code(202).send({ status: 'rendering' });
    }
    const data = await readFile(join(mobileStorageRoot(), storageKey));
    return reply.type('application/pdf')
      .header('content-disposition', `inline; filename="${document.number}.pdf"`)
      .header('cache-control', 'private, max-age=300')
      .send(data);
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/receipts`,
    response: z.array(receiptSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return listPostgresReceipts(requirePool(app), session.scope.tenantId);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/receipts/:id`,
    params: entityIdParamsSchema,
    response: receiptSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const receipt = await getPostgresReceipt(requirePool(app), session.scope.tenantId, params.id);
      if (!receipt) throw new ApiError(404, 'Receipt not found');
      return receipt;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/receipts`,
    body: mobileReceiptUploadBodySchema,
    response: receiptSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.role === 'viewer') throw new ApiError(403, 'Role is not authorized to upload receipts');
      const data = Buffer.from(body.dataBase64, 'base64');
      if (data.byteLength === 0 || data.byteLength > 15 * 1024 * 1024) {
        throw new ApiError(413, 'Receipt must be between 1 byte and 15 MB');
      }
      if (!hasExpectedMagicBytes(data, body.metadata.mimeType)) {
        throw new ApiError(400, 'Receipt content does not match its declared type');
      }
      const actualHash = createHash('sha256').update(data).digest('hex');
      if (!timingSafeStringEqual(actualHash, body.metadata.sha256)) {
        throw new ApiError(400, 'Receipt checksum does not match');
      }
      const relativeStorageKey = join(
        session.scope.tenantId,
        'receipts',
        `${body.metadata.id}${receiptExtension(body.metadata.mimeType)}`,
      );
      const absolutePath = join(mobileStorageRoot(), relativeStorageKey);
      await mkdir(join(mobileStorageRoot(), session.scope.tenantId, 'receipts'), { recursive: true });
      await writeFile(absolutePath, data, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const now = new Date().toISOString();
      return insertPostgresReceipt(requirePool(app), receiptSchema.parse({
        id: body.metadata.id,
        tenantId: session.scope.tenantId,
        product,
        originalName: body.metadata.originalName,
        mimeType: body.metadata.mimeType,
        byteSize: data.byteLength,
        sha256: actualHash,
        status: 'queued',
        storageKey: relativeStorageKey,
        createdAt: now,
        updatedAt: now,
      }));
    },
  });

  app.get(`${prefix}/receipts/:id/content`, async (request, reply) => {
    const session = await requireSession(app, product, request.headers.authorization);
    const params = entityIdParamsSchema.parse(request.params);
    const receipt = await getPostgresReceipt(requirePool(app), session.scope.tenantId, params.id);
    if (!receipt) throw new ApiError(404, 'Receipt not found');
    const data = await readFile(join(mobileStorageRoot(), receipt.storageKey));
    const query = z.object({ format: z.enum(['binary', 'base64']).default('binary') }).parse(request.query);
    if (query.format === 'base64') {
      return reply.header('cache-control', 'no-store').send({
        mimeType: receipt.mimeType,
        dataBase64: data.toString('base64'),
      });
    }
    return reply.type(receipt.mimeType).header('cache-control', 'private, max-age=300').send(data);
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/receipts/:id/retry`,
    params: entityIdParamsSchema,
    response: receiptSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.role === 'viewer') throw new ApiError(403, 'Role is not authorized to retry receipts');
      const receipt = await getPostgresReceipt(requirePool(app), session.scope.tenantId, params.id);
      if (!receipt) throw new ApiError(404, 'Receipt not found');
      if (receipt.status !== 'failed') throw new ApiError(409, 'Only failed receipts can be retried');
      return (await updatePostgresReceipt(requirePool(app), session.scope.tenantId, params.id, { status: 'queued' }))!;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/receipts/:id/confirm`,
    params: entityIdParamsSchema,
    body: receiptConfirmRequestSchema,
    response: receiptSchema,
    async handler({ request, params, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.role === 'viewer') throw new ApiError(403, 'Role is not authorized to confirm receipts');
      const pool = requirePool(app);
      return withPostgresTransaction(pool, async (client) => {
        const before = await getPostgresReceipt(client, session.scope.tenantId, params.id);
        if (!before) throw new ApiError(404, 'Receipt not found');
        if (before.status !== 'needs_review') throw new ApiError(409, 'Receipt is not ready for review');
        const saved = await updatePostgresReceipt(client, session.scope.tenantId, params.id, {
          status: 'confirmed',
          suggestion: body.suggestion,
          confirmedAt: new Date().toISOString(),
        });
        if (product === 'pro') {
          const gross = body.suggestion.grossAmount.value;
          const expenseAccount = body.suggestion.suggestedAccountNumber?.value;
          const bank = await client.query<{ default_skr_account_number: string }>(
            'SELECT default_skr_account_number FROM accounts WHERE tenant_id = $1 ORDER BY name ASC LIMIT 1',
            [session.scope.tenantId],
          );
          const clearingAccount = bank.rows[0]?.default_skr_account_number;
          const documentDate = body.suggestion.date.value ?? before.createdAt.slice(0, 10);
          const year = Number(documentDate.slice(0, 4)) || new Date().getFullYear();
          const issues = [
            ...(!gross || gross <= 0 ? [{ id: randomUUID(), code: 'receipt.amount_missing', severity: 'error' as const, message: 'Confirm a positive gross amount.', fieldPath: 'grossAmount', blocking: true, source: 'system' as const }] : []),
            ...(!expenseAccount ? [{ id: randomUUID(), code: 'receipt.expense_account_missing', severity: 'error' as const, message: 'Choose an expense account.', fieldPath: 'lines.0.accountNumber', blocking: true, source: 'system' as const }] : []),
            ...(!clearingAccount ? [{ id: randomUUID(), code: 'receipt.clearing_account_missing', severity: 'error' as const, message: 'Choose a bank or clearing account.', fieldPath: 'lines.1.accountNumber', blocking: true, source: 'system' as const }] : []),
          ];
          const now = new Date().toISOString();
          const draftId = randomUUID();
          const draft = mobileBookingDraftSchema.parse({
            id: draftId,
            tenantId: session.scope.tenantId,
            transactionId: `receipt:${before.id}`,
            workflowStatus: issues.length ? 'incomplete' : 'ready_for_review',
            postingDate: documentDate,
            documentDate,
            bookingText: body.suggestion.merchant.value || before.originalName,
            reference: body.suggestion.invoiceNumber.value || before.id,
            period: documentDate.slice(0, 7),
            fiscalYear: year,
            lines: [
              { id: randomUUID(), accountNumber: expenseAccount || 'UNASSIGNED', debitAmount: gross || 0, creditAmount: 0, grossAmount: gross ?? undefined, evidenceType: 'receipt', evidenceReference: before.id, memo: before.originalName },
              { id: randomUUID(), accountNumber: clearingAccount || 'UNASSIGNED', debitAmount: 0, creditAmount: gross || 0, grossAmount: gross ?? undefined, evidenceType: 'receipt', evidenceReference: before.id },
            ],
            validationIssues: issues,
            updatedAt: now,
          });
          await client.query(
            `INSERT INTO booking_drafts (id, tenant_id, transaction_id, workflow_status, draft_json, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, transaction_id) DO NOTHING`,
            [draftId, session.scope.tenantId, draft.transactionId, draft.workflowStatus, JSON.stringify(draft), now],
          );
        }
        await createPostgresBillingDependencies(client).auditLog.append(
          session.scope,
          buildAuditEntry(session.scope, session, 'receipt', params.id, 'receipt.confirm', body.reason, before, saved),
        );
        return saved!;
      });
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/documents/:kind/finalize`,
    params: z.object({ kind: documentKindSchema }),
    body: mobileDocumentFinalizeRequestSchema,
    response: mobileDocumentFinalizeResponseSchema,
    async handler({ request, params, body }) {
      if (params.kind !== body.draft.kind) throw new ApiError(400, 'Document kind does not match route');
      const capability = params.kind === 'invoice' ? 'documents:invoice:write' : 'documents:offer:write';
      const session = await requireCapability(app, product, request.headers.authorization, capability);
      const pool = requirePool(app);
      return withPostgresTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `mobile-document:${session.scope.tenantId}:${body.clientMutationId}`,
        ]);
        const replay = await getMobileDocumentMutation(client, session.scope.tenantId, body.clientMutationId);
        if (replay) return { ...replay, replayed: true };
        const reservation = await reserveDocumentNumber(createNumberingPortsForDb(client, session.scope), params.kind);
        const settings = parseStoredSettings(await getServerSettings(client, session.scope.tenantId, { forUpdate: true }));
        const taxSettings = settings ?? { legal: { smallBusinessRule: false, defaultVatRate: 19 } };
        const taxMode = resolveInvoiceTaxMode(body.draft.taxMode, taxSettings);
        const taxSnapshot = calculateInvoiceTaxSnapshot({
          items: body.draft.items,
          taxMode,
          taxMeta: body.draft.taxMeta,
        }, taxSettings);
        const repositories = createPostgresBillingDependencies(client);
        const document = body.draft.kind === 'invoice'
          ? await repositories.invoiceRepo.save(session.scope, invoiceSchema.parse({
              ...body.draft,
              tenantId: session.scope.tenantId,
              number: reservation.number,
              taxMode,
              taxSnapshot,
              amount: taxSnapshot.grossAmount,
            }))
          : await repositories.offerRepo.save(session.scope, offerSchema.parse({
              ...body.draft,
              tenantId: session.scope.tenantId,
              number: reservation.number,
              taxMode,
              taxSnapshot,
              amount: taxSnapshot.grossAmount,
            }));
        await finalizeDocumentNumber(createNumberingPortsForDb(client, session.scope), reservation.reservationId, document.id);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(session.scope, session, document.kind, document.id, `${document.kind}.finalize`, body.reason, null, document),
        );
        let delivery;
        if (body.delivery) {
          delivery = await insertDocumentDelivery(client, {
            tenantId: session.scope.tenantId,
            userId: session.user.id,
            documentType: document.kind,
            documentId: document.id,
            recipientEmail: body.delivery.recipientEmail,
          });
          const outbox = await repositories.emailOutboxRepo.enqueue(session.scope, {
            dedupeKey: `mobile:${body.clientMutationId}`,
            documentType: document.kind,
            documentId: document.id,
            documentNumber: document.number,
            recipientEmail: body.delivery.recipientEmail,
            recipientName: body.delivery.recipientName,
            subject: body.delivery.subject,
            bodyText: body.delivery.bodyText,
          });
          await client.query('UPDATE email_outbox SET delivery_id = $2 WHERE id = $1', [outbox.id, delivery.id]);
        }
        const response: MobileDocumentFinalizeResponse = mobileDocumentFinalizeResponseSchema.parse({
          document,
          delivery,
          replayed: false,
        });
        await insertMobileDocumentMutation(client, {
          tenantId: session.scope.tenantId,
          product,
          mutationId: body.clientMutationId,
          response,
        });
        return response;
      });
    },
  });
};

const registerInternalRenderRoutes = (app: FastifyInstance) => {
  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/internal/render-session',
    body: z.object({
      deliveryId: z.string().min(1),
      tenantId: z.string().min(1),
      userId: z.string().min(1),
      product: serverProductSchema,
      documentType: documentKindSchema,
      documentId: z.string().min(1),
    }),
    response: z.object({ token: z.string().min(1), user: authUserSchema }),
    async handler({ request, body }) {
      const configuredSecret = process.env.BILLME_RENDER_SECRET?.trim();
      const provided = typeof request.headers['x-billme-render-secret'] === 'string'
        ? request.headers['x-billme-render-secret']
        : '';
      if (!configuredSecret || !provided || !timingSafeStringEqual(configuredSecret, provided)) {
        throw new ApiError(401, 'Invalid render credentials');
      }
      const result = await requirePool(app).query<{
        email: string;
        full_name: string;
        role: z.infer<typeof serverRoleSchema>;
        deployment_mode: 'single-tenant' | 'multi-tenant';
      }>(
        `SELECT users.email, users.full_name, memberships.role, tenants.deployment_mode
         FROM document_deliveries delivery
         JOIN tenants ON tenants.id = delivery.tenant_id
         JOIN user_accounts users ON users.id = delivery.created_by_user_id
         JOIN tenant_memberships memberships
           ON memberships.tenant_id = delivery.tenant_id AND memberships.user_id = users.id
         WHERE delivery.id = $1 AND delivery.tenant_id = $2 AND delivery.created_by_user_id = $3
           AND tenants.product = $4 AND delivery.document_type = $5 AND delivery.document_id = $6
           AND delivery.status = 'rendering' AND users.status = 'active' AND tenants.status = 'active'
         LIMIT 1`,
        [body.deliveryId, body.tenantId, body.userId, body.product, body.documentType, body.documentId],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError(404, 'Render job not found');
      const user = authUserSchema.parse({
        id: body.userId,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
      });
      return {
        token: app.tokenService.sign({
          user,
          scope: {
            tenantId: body.tenantId,
            product: body.product,
            deploymentMode: row.deployment_mode,
          },
          role: row.role,
        }, 5 * 60),
        user,
      };
    },
  });
};

const registerBillingRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/clients`,
    response: z.array(clientSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      return dependencies.clientRepo.list(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/clients/:id`,
    params: entityIdParamsSchema,
    response: clientSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      return dependencies.clientRepo.getById(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/clients`,
    body: z.object({
      reason: z.string().trim().min(1),
      client: clientWriteSchema,
    }),
    response: clientSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'clients:write');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const nextClient = clientSchema.parse({
          ...body.client,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.clientRepo.getById(session.scope, nextClient.id);
        const saved = await repositories.clientRepo.save(session.scope, nextClient);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(
            session.scope,
            session,
            'client',
            saved.id,
            before ? 'client.update' : 'client.create',
            body.reason,
            before,
            saved,
          ),
        );
        return saved;
      });
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/clients/:id`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'delete');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const existing = await repositories.clientRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Client not found');
        }
        await repositories.clientRepo.remove(session.scope, params.id);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(session.scope, session, 'client', params.id, 'client.delete', body.reason, existing, null),
        );
        return { ok: true as const };
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/invoices`,
    response: z.array(invoiceSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requirePool(app);
      const dependencies = createPostgresBillingDependencies(pool);
      const invoices = await dependencies.invoiceRepo.list(session.scope);
      return Promise.all(invoices.map((invoice) => withInvoiceHistory(pool, session.scope, invoice)));
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/invoices/:id`,
    params: entityIdParamsSchema,
    response: invoiceSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requirePool(app);
      const dependencies = createPostgresBillingDependencies(pool);
      const invoice = await dependencies.invoiceRepo.getById(session.scope, params.id);
      return invoice ? withInvoiceHistory(pool, session.scope, invoice) : null;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/invoices`,
    body: z.object({
      reason: z.string().trim().min(1),
      invoice: invoiceWriteSchema,
    }),
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'documents:invoice:write');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      const saved = await unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const nextInvoice = invoiceSchema.parse({
          ...body.invoice,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.invoiceRepo.getById(session.scope, nextInvoice.id);
        const after = await repositories.invoiceRepo.save(session.scope, nextInvoice);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(
            session.scope,
            session,
            'invoice',
            after.id,
            before ? 'invoice.update' : 'invoice.create',
            body.reason,
            before,
            after,
          ),
        );
        return after;
      });
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/invoices/:id`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'delete');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const existing = await repositories.invoiceRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Invoice not found');
        }
        await repositories.invoiceRepo.remove(session.scope, params.id);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(session.scope, session, 'invoice', params.id, 'invoice.delete', body.reason, existing, null),
        );
        return { ok: true as const };
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/offers`,
    response: z.array(offerSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requirePool(app);
      const dependencies = createPostgresBillingDependencies(pool);
      const offers = await dependencies.offerRepo.list(session.scope);
      return Promise.all(offers.map((offer) => withOfferHistory(pool, session.scope, offer)));
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/offers/:id`,
    params: entityIdParamsSchema,
    response: offerSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requirePool(app);
      const dependencies = createPostgresBillingDependencies(pool);
      const offer = await dependencies.offerRepo.getById(session.scope, params.id);
      return offer ? withOfferHistory(pool, session.scope, offer) : null;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/offers`,
    body: z.object({
      reason: z.string().trim().min(1),
      offer: offerWriteSchema,
    }),
    response: offerSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'documents:offer:write');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      const saved = await unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const nextOffer = offerSchema.parse({
          ...body.offer,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.offerRepo.getById(session.scope, nextOffer.id);
        const after = await repositories.offerRepo.save(session.scope, nextOffer);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(
            session.scope,
            session,
            'offer',
            after.id,
            before ? 'offer.update' : 'offer.create',
            body.reason,
            before,
            after,
          ),
        );
        return after;
      });
      return withOfferHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/offers/:id`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'delete');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const existing = await repositories.offerRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Offer not found');
        }
        await repositories.offerRepo.remove(session.scope, params.id);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(session.scope, session, 'offer', params.id, 'offer.delete', body.reason, existing, null),
        );
        return { ok: true as const };
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/recurring`,
    response: z.array(recurringProfileSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      return dependencies.recurringProfileRepo.list(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/recurring/:id`,
    params: entityIdParamsSchema,
    response: recurringProfileSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      return dependencies.recurringProfileRepo.getById(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/recurring`,
    body: z.object({
      reason: z.string().trim().min(1),
      profile: recurringWriteSchema,
    }),
    response: recurringProfileSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'recurring:write');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const nextProfile = recurringProfileSchema.parse({
          ...body.profile,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.recurringProfileRepo.getById(session.scope, nextProfile.id);
        const saved = await repositories.recurringProfileRepo.save(session.scope, nextProfile);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(
            session.scope,
            session,
            'recurring-profile',
            saved.id,
            before ? 'recurring.update' : 'recurring.create',
            body.reason,
            before,
            saved,
          ),
        );
        return saved;
      });
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/recurring/:id`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'delete');
      const pool = requirePool(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const existing = await repositories.recurringProfileRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Recurring profile not found');
        }
        await repositories.recurringProfileRepo.remove(session.scope, params.id);
        await repositories.auditLog.append(
          session.scope,
          buildAuditEntry(
            session.scope,
            session,
            'recurring-profile',
            params.id,
            'recurring.delete',
            body.reason,
            existing,
            null,
          ),
        );
        return { ok: true as const };
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/settings`,
    response: appSettingsSchema.nullable(),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return parseStoredSettings(await getServerSettings(requirePool(app), session.scope.tenantId));
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/settings`,
    body: setSettingsPayloadSchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'settings:write');
      if (!isPortalUrlAllowed(body.settings.portal?.baseUrl, app.portalAllowedOrigins)) {
        throw new ApiError(400, 'Portal base URL is not permitted by server policy');
      }
      await saveServerSettings(requirePool(app), {
        tenantId: session.scope.tenantId,
        settingsJson: JSON.stringify(appSettingsSchema.parse(body.settings)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/reserve`,
    body: numberReserveBodySchema,
    response: z.object({
      reservationId: z.string().min(1),
      number: z.string().min(1),
    }),
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'numbers:write');
      return reserveNumberForScope(requirePool(app), session.scope, body.kind);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/release`,
    body: numberReleaseBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'numbers:write');
      return releaseNumberForScope(requirePool(app), session.scope, body.reservationId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/finalize`,
    body: numberFinalizeBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'numbers:write');
      return finalizeNumberForScope(requirePool(app), session.scope, body.reservationId, body.documentId);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/documents/:kind/:id`,
    params: z.object({
      kind: documentKindSchema,
      id: z.string().min(1),
    }),
    response: z.union([invoiceSchema, offerSchema]).nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      if (params.kind === 'invoice') {
        const invoice = await dependencies.invoiceRepo.getById(session.scope, params.id);
        return invoice ? withInvoiceHistory(requirePool(app), session.scope, invoice) : null;
      }
      const offer = await dependencies.offerRepo.getById(session.scope, params.id);
      return offer ? withOfferHistory(requirePool(app), session.scope, offer) : null;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/documents/:kind/:id/export.json`,
    params: z.object({
      kind: documentKindSchema,
      id: z.string().min(1),
    }),
    async handler({ request, reply, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      const payload =
        params.kind === 'invoice'
          ? await dependencies.invoiceRepo.getById(session.scope, params.id)
          : await dependencies.offerRepo.getById(session.scope, params.id);
      if (!payload) {
        throw new ApiError(404, `${params.kind} not found`);
      }
      const enriched =
        params.kind === 'invoice'
          ? await withInvoiceHistory(requirePool(app), session.scope, payload as z.infer<typeof invoiceSchema>)
          : await withOfferHistory(requirePool(app), session.scope, payload as z.infer<typeof offerSchema>);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${params.kind}-${params.id}.json"`);
      return enriched;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/documents/export.csv`,
    query: documentExportQuerySchema,
    async handler({ request, reply, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requirePool(app));
      const rows =
        query.kind === 'invoice'
          ? await dependencies.invoiceRepo.list(session.scope)
          : await dependencies.offerRepo.list(session.scope);
      const csv = toCsv(
        rows.map((row) => ({
          id: row.id,
          number: row.number,
          client: row.client,
          clientEmail: row.clientEmail,
          date: row.date,
          totalAmount: row.amount,
          status: row.status,
        })),
        ['id', 'number', 'client', 'clientEmail', 'date', 'totalAmount', 'status'],
      );
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${query.kind}s.csv"`);
      return csv;
    },
  });
};

const registerTemplateRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/templates`,
    query: listTemplatesParamsSchema,
    response: z.array(templateRecordSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const templates = await listServerTemplates(requirePool(app), session.scope.tenantId);
      return templates
        .filter((record) => !query.kind || record.kind === query.kind)
        .map(mapTemplateRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/templates`,
    body: upsertTemplatePayloadSchema,
    response: templateRecordSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'templates:write');
      const saved = await saveServerTemplate(requirePool(app), {
        id: body.template.id,
        tenantId: session.scope.tenantId,
        kind: body.template.kind,
        name: body.template.name,
        elementsJson: JSON.stringify(body.template.elements),
        createdAt: body.template.createdAt,
        updatedAt: body.template.updatedAt,
      });
      return mapTemplateRecord(saved);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/templates/active/:kind`,
    params: z.object({
      kind: templateKindSchema,
    }),
    response: templateRecordSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const active = await getServerActiveTemplates(requirePool(app), session.scope.tenantId);
      const templateId = params.kind === 'invoice' ? active?.invoiceTemplateId : active?.offerTemplateId;
      if (!templateId) {
        return null;
      }
      const templates = await listServerTemplates(requirePool(app), session.scope.tenantId);
      const template = templates.find((entry) => entry.id === templateId);
      return template ? mapTemplateRecord(template) : null;
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/templates/active`,
    body: setActiveTemplatePayloadSchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, product, request.headers.authorization, 'templates:write');
      const existing = await getServerActiveTemplates(requirePool(app), session.scope.tenantId);
      await saveServerActiveTemplates(requirePool(app), {
        tenantId: session.scope.tenantId,
        id: existing?.id ?? 1,
        invoiceTemplateId: body.kind === 'invoice' ? body.templateId ?? undefined : existing?.invoiceTemplateId,
        offerTemplateId: body.kind === 'offer' ? body.templateId ?? undefined : existing?.offerTemplateId,
      });
      return { ok: true as const };
    },
  });
};

const registerProRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/pro';

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/articles`,
    response: z.array(articleSchema),
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return (await listServerArticles(requirePool(app), session.scope.tenantId)).map(mapArticleRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/articles`,
    body: upsertArticlePayloadSchema,
    response: articleSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'articles:write');
      const saved = await saveServerArticle(requirePool(app), {
        id: body.article.id,
        tenantId: session.scope.tenantId,
        sku: body.article.sku,
        title: body.article.title,
        description: body.article.description,
        price: body.article.price,
        unit: body.article.unit,
        category: body.article.category,
        taxRate: body.article.taxRate,
      });
      return mapArticleRecord(saved);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounts`,
    response: z.array(accountSchema),
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return (await listServerBankAccounts(requirePool(app), session.scope.tenantId)).map(mapAccountRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounts`,
    body: upsertAccountPayloadSchema,
    response: accountSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'accounts:write');
      const saved = await saveServerBankAccount(requirePool(app), {
        id: body.account.id,
        tenantId: session.scope.tenantId,
        name: body.account.name,
        iban: body.account.iban,
        balance: body.account.balance,
        defaultSkrAccountNumber: body.account.defaultSkrAccountNumber,
        type: body.account.type,
        color: body.account.color,
      });
      return mapAccountRecord(saved);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/workflow`,
    response: z.array(
      z.object({
        transactionId: z.string().min(1),
        transactionJson: z.string().min(2),
        draftJson: z.string().min(2),
        updatedAt: z.string().min(1),
      }),
    ),
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProWorkflowRepository(requirePool(app)).list(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/review-queue`,
    response: z.array(mobileBookingDraftSchema),
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      const result = await requirePool(app).query<{ draft_json: string }>(
        `SELECT draft_json FROM booking_drafts
         WHERE tenant_id = $1 AND workflow_status NOT IN ('posted', 'reversed')
         ORDER BY updated_at ASC`,
        [session.scope.tenantId],
      );
      return result.rows.map((row) => mobileBookingDraftSchema.parse(JSON.parse(row.draft_json)));
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounting/booking-drafts/:id/actions`,
    params: entityIdParamsSchema,
    body: z.object({
      action: z.enum(['submit_for_review', 'approve', 'reject', 'post']),
      reason: z.string().trim().min(1).max(500),
    }),
    response: mobileBookingDraftSchema,
    async handler({ request, params, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'accounting:write');
      const outcome = await withPostgresTransaction(requirePool(app), async (client) => {
        const result = await client.query<{ workflow_status: string; draft_json: string }>(
          'SELECT workflow_status, draft_json FROM booking_drafts WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [session.scope.tenantId, params.id],
        );
        const row = result.rows[0];
        if (!row) throw new ApiError(404, 'Booking draft not found');
        const before = mobileBookingDraftSchema.parse(JSON.parse(row.draft_json));
        const allowed: Record<typeof body.action, string[]> = {
          submit_for_review: ['suggested', 'incomplete', 'ready_for_review', 'integration_error'],
          approve: ['pending_approval', 'ready_for_review'],
          reject: ['pending_approval', 'ready_for_review', 'approved'],
          post: ['approved'],
        };
        if (!allowed[body.action].includes(before.workflowStatus)) {
          throw new ApiError(409, `Cannot ${body.action} a ${before.workflowStatus} draft`);
        }
        const nextStatus = body.action === 'submit_for_review' ? 'pending_approval'
          : body.action === 'approve' ? 'approved'
          : body.action === 'reject' ? 'incomplete'
          : 'posted';
        const blockPost = async (message: string) => {
          await createPostgresBillingDependencies(client).auditLog.append(session.scope, {
            occurredAt: new Date().toISOString(),
            action: 'booking-draft.post-blocked',
            reason: `${body.reason}: ${message}`,
            actor: toAuditActor(session),
            subject: { entityType: 'booking-draft', entityId: before.id, tenantId: session.scope.tenantId },
            change: { before, after: before },
          });
          return { blocked: message } as const;
        };
        if (body.action === 'post') {
          if (before.validationIssues.some((issue) => issue.blocking)) {
            return blockPost('Resolve blocking validation issues before posting');
          }
          const debit = before.lines.reduce((sum, line) => sum + line.debitAmount, 0);
          const credit = before.lines.reduce((sum, line) => sum + line.creditAmount, 0);
          if (before.lines.length < 2 || Math.round(debit * 100) !== Math.round(credit * 100) || debit <= 0) {
            return blockPost('Journal lines must be balanced and non-zero');
          }
          const period = await client.query<{ status: string }>(
            'SELECT status FROM accounting_periods WHERE tenant_id = $1 AND period = $2 LIMIT 1',
            [session.scope.tenantId, before.period],
          );
          if (period.rows[0] && period.rows[0].status !== 'open') return blockPost('Accounting period is locked');
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal:${session.scope.tenantId}`]);
          const numberResult = await client.query<{ next: number }>(
            'SELECT COALESCE(MAX(entry_number), 0) + 1 AS next FROM journal_entries WHERE tenant_id = $1',
            [session.scope.tenantId],
          );
          const entryId = randomUUID();
          const now = new Date().toISOString();
          await client.query(
            `INSERT INTO journal_entries (
               id, tenant_id, entry_number, posting_date, document_date, booking_text, reference,
               period, fiscal_year, status, source_draft_id, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10,$11)`,
            [entryId, session.scope.tenantId, Number(numberResult.rows[0]?.next ?? 1),
              before.postingDate ?? now.slice(0, 10), before.documentDate ?? null, before.bookingText,
              before.reference ?? null, before.period, before.fiscalYear, before.id, now],
          );
          for (const [index, line] of before.lines.entries()) {
            await client.query(
              `INSERT INTO journal_lines (
                 id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount,
                 tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount,
                 country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [randomUUID(), session.scope.tenantId, entryId, index + 1, line.accountNumber,
                line.debitAmount, line.creditAmount, line.taxCode ?? null, line.taxCaseKey ?? null,
                line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null,
                line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null,
                line.evidenceReference ?? null, line.costCenter ?? null, line.memo ?? null],
            );
          }
        }
        const after = mobileBookingDraftSchema.parse({ ...before, workflowStatus: nextStatus, updatedAt: new Date().toISOString() });
        await client.query(
          'UPDATE booking_drafts SET workflow_status = $3, draft_json = $4, updated_at = $5 WHERE tenant_id = $1 AND id = $2',
          [session.scope.tenantId, params.id, nextStatus, JSON.stringify(after), after.updatedAt],
        );
        await createPostgresBillingDependencies(client).auditLog.append(session.scope, {
          occurredAt: after.updatedAt,
          action: `booking-draft.${body.action}`,
          reason: body.reason,
          actor: toAuditActor(session),
          subject: { entityType: 'booking-draft', entityId: before.id, tenantId: session.scope.tenantId },
          change: { before, after },
        });
        await enqueueMobilePush(client, {
          tenantId: session.scope.tenantId,
          product: 'pro',
          title: body.action === 'post' ? 'Booking posted' : 'Accounting review updated',
          body: 'Open Billme to view the accounting details.',
          route: '/accounting/review',
        });
        return { draft: after } as const;
      });
      if ('blocked' in outcome) throw new ApiError(409, outcome.blocked);
      return outcome.draft;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/workflow`,
    body: z.object({
      transactionId: z.string().min(1),
      transactionJson: z.string().min(2),
      draftJson: z.string().min(2),
    }),
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'accounting:write');
      return createPostgresProWorkflowRepository(requirePool(app)).upsert(session.scope, body);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/ledger/accounts`,
    query: z.object({
      chart: z.enum(['SKR03', 'SKR04']).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().positive().max(10_000).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    response: z.array(ledgerAccountSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requirePool(app)).listLedgerAccounts(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/ledger/stats`,
    response: z.object({
      total: z.number().int(),
      byChart: z.object({
        SKR03: z.number().int(),
        SKR04: z.number().int(),
      }),
    }),
    async handler({ request }) {
      await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requirePool(app)).getLedgerStats();
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/tax-cases`,
    query: proListTaxCasesArgsSchema,
    response: z.array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        mechanism: z.enum(['standard_vat', 'reverse_charge', 'zero_rate', 'exempt']),
        defaultRate: z.number(),
        requiresCounterpartyVatId: z.boolean(),
        requiresCountry: z.boolean(),
        requiresEvidence: z.boolean(),
        active: z.boolean(),
      }),
    ),
    async handler({ request, query }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requirePool(app)).listTaxCases(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/tax-case-account-mappings`,
    query: proListTaxCaseAccountMappingsArgsSchema,
    response: z.array(
      z.object({
        id: z.string().min(1),
        chart: z.enum(['SKR03', 'SKR04']),
        taxCaseKey: z.string().min(1),
        role: z.enum(['output_tax', 'input_tax', 'datev_bu']),
        accountNumber: z.string().min(1),
        datevBuKey: z.string().optional(),
        validFrom: z.string().optional(),
        validTo: z.string().optional(),
        updatedAt: z.string().min(1),
      }),
    ),
    async handler({ request, query }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requirePool(app)).listTaxCaseAccountMappings(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounting/tax-case-account-mappings`,
    body: proUpsertTaxCaseAccountMappingArgsSchema,
    response: z.object({
      id: z.string().min(1),
      chart: z.enum(['SKR03', 'SKR04']),
      taxCaseKey: z.string().min(1),
      role: z.enum(['output_tax', 'input_tax', 'datev_bu']),
      accountNumber: z.string().min(1),
      datevBuKey: z.string().optional(),
      validFrom: z.string().optional(),
      validTo: z.string().optional(),
      updatedAt: z.string().min(1),
    }),
    async handler({ request, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'accounting:write');
      return createPostgresProAccountingCatalogRepository(requirePool(app)).upsertTaxCaseAccountMapping(session.scope, body);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounting/account-suggestion-rules`,
    query: proListAccountSuggestionRulesArgsSchema,
    response: z.array(
      z.object({
        id: z.string().min(1),
        tenantId: z.string().min(1),
        chart: z.enum(['SKR03', 'SKR04']),
        priority: z.number().int(),
        field: z.enum(['counterparty', 'purpose', 'any']),
        operator: z.enum(['contains', 'equals', 'startsWith']),
        value: z.string().min(1),
        targetAccountNumber: z.string().min(1),
        flowType: z.enum(['income', 'expense', 'any']),
        active: z.boolean(),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
      }),
    ),
    async handler({ request, query }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requirePool(app)).listAccountSuggestionRules(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounting/account-suggestion-rules`,
    body: proUpsertAccountSuggestionRuleArgsSchema,
    response: z.object({
      id: z.string().min(1),
      tenantId: z.string().min(1),
      chart: z.enum(['SKR03', 'SKR04']),
      priority: z.number().int(),
      field: z.enum(['counterparty', 'purpose', 'any']),
      operator: z.enum(['contains', 'equals', 'startsWith']),
      value: z.string().min(1),
      targetAccountNumber: z.string().min(1),
      flowType: z.enum(['income', 'expense', 'any']),
      active: z.boolean(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    }),
    async handler({ request, body }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'accounting:write');
      return createPostgresProAccountingCatalogRepository(requirePool(app)).upsertAccountSuggestionRule(session.scope, body);
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/accounting/account-suggestion-rules/:id`,
    params: z.object({
      id: z.string().min(1),
    }),
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireCapability(app, 'pro', request.headers.authorization, 'delete');
      await createPostgresProAccountingCatalogRepository(requirePool(app)).deleteAccountSuggestionRule(session.scope, params.id);
      return { ok: true as const };
    },
  });
};

declare module 'fastify' {
  interface FastifyInstance {
    authStore: AuthStore;
    tokenService: SessionTokenService;
    platformTokenService: PlatformTokenService;
    platformAuthStore: PlatformAuthStore;
    portalAllowedOrigins: ReadonlySet<string>;
    serverPool?: Pool;
  }
}

const DEV_SESSION_SECRET_DEFAULT = 'billme-dev-session-secret';

const assertPlatformSecretIsSafe = (app: FastifyInstance) => {
  const platformAdminConfigured = Boolean(process.env.PLATFORM_ADMIN_EMAIL?.trim());
  if (!platformAdminConfigured) {
    return;
  }
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const platformSecret = process.env.PLATFORM_SESSION_SECRET?.trim();
  const usesUnsafeDefault =
    (!sessionSecret || sessionSecret === DEV_SESSION_SECRET_DEFAULT) &&
    (!platformSecret || platformSecret === DEV_SESSION_SECRET_DEFAULT);

  if (!usesUnsafeDefault) {
    return;
  }

  const message =
    'PLATFORM_ADMIN_EMAIL is set but SESSION_SECRET/PLATFORM_SESSION_SECRET are unset or use the dev default. This is unsafe for an admin-capable deployment.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  app.log.warn(message);
};

export const buildServerApi = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: true,
    bodyLimit: 22 * 1024 * 1024,
  });
  app.decorate('portalAllowedOrigins', parsePortalAllowedOrigins(process.env.BILLME_PORTAL_ALLOWED_ORIGINS));

  registerErrorHandler(app);

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  });
  registerAuthRateLimit(app);

  const databaseUrl = readDatabaseUrl(process.env);
  const pool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  if (pool) {
    await runPostgresMigrations(pool);
    app.decorate('serverPool', pool);
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  app.decorate('tokenService', new SessionTokenService(process.env.SESSION_SECRET));
  app.decorate('authStore', createAuthStore({ pool, env: process.env }));
  app.decorate('platformTokenService', new PlatformTokenService());
  app.decorate('platformAuthStore', createPlatformAuthStore({ pool, authStore: app.authStore }));

  assertPlatformSecretIsSafe(app);

  typedRoute(app, {
    method: 'GET',
    url: '/health',
    response: healthResponseSchema,
    async handler() {
      return {
        ok: true as const,
        service: 'billme-server-api',
        backend: 'fastify' as const,
        mode: 'api' as const,
        ts: new Date().toISOString(),
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/meta/capabilities',
    response: capabilitiesResponseSchema,
    async handler() {
      return {
        backend: 'fastify' as const,
        deploymentMode: 'single-tenant' as const,
        desktopServerMode: true as const,
        database: {
          production: 'postgres' as const,
          local: 'sqlite' as const,
        },
        auth: {
          multiUser: true as const,
          roles: [...supportedServerRoles],
        },
        products: [...supportedServerProducts],
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/auth/bootstrap/status',
    query: productAuthStatusQuerySchema,
    response: z.object({
      bootstrapped: z.boolean(),
      userCount: z.number().int().nonnegative(),
    }),
    async handler({ query }) {
      return app.authStore.getBootstrapStatus(query.product);
    },
  });

  registerPlatformRoutes(app);
  registerInternalRenderRoutes(app);
  registerAuthRoutes(app, 'lite', '/api/v1/lite');
  registerAuthRoutes(app, 'pro', '/api/v1/pro');
  registerMobileAuthRoutes(app, 'lite', '/api/v1/lite');
  registerMobileAuthRoutes(app, 'pro', '/api/v1/pro');
  registerMobileRoutes(app, 'lite', '/api/v1/lite');
  registerMobileRoutes(app, 'pro', '/api/v1/pro');
  registerBillingRoutes(app, 'lite', '/api/v1/lite');
  registerBillingRoutes(app, 'pro', '/api/v1/pro');
  registerTemplateRoutes(app, 'lite', '/api/v1/lite');
  registerTemplateRoutes(app, 'pro', '/api/v1/pro');
  registerProRoutes(app);

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    query: productAuthStatusQuerySchema,
    body: bootstrapRequestSchema,
    response: z.object({
      token: z.string().min(1),
      user: authUserSchema,
    }),
    async handler({ query, body }) {
      const principal = await app.authStore.bootstrap(query.product, body);
      return {
        token: app.tokenService.sign({
          user: principal.user,
          scope: createSingleTenantScope(principal.tenantId, principal.product),
          role: principal.role,
        }),
        user: principal.user,
      };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/login',
    query: productAuthStatusQuerySchema,
    body: loginRequestSchema,
    response: z.object({
      token: z.string().min(1),
      user: authUserSchema,
    }),
    async handler({ query, body }) {
      const principal = await login(app, query.product, body);
      return {
        token: app.tokenService.sign({
          user: principal.user,
          scope: createSingleTenantScope(principal.tenantId, principal.product),
          role: principal.role,
        }),
        user: principal.user,
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/auth/me',
    query: productAuthStatusQuerySchema,
    response: authSessionInfoSchema,
    async handler({ request, query }) {
      const session = await requireSession(app, query.product, request.headers.authorization);
      return toSessionInfo(session);
    },
  });

  return app;
};
