import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  authUserSchema,
  bootstrapRequestSchema,
  capabilitiesResponseSchema,
  clientSchema,
  createSingleTenantScope,
  finalizeDocumentNumber,
  healthResponseSchema,
  invoiceSchema,
  loginRequestSchema,
  offerSchema,
  recurringProfileSchema,
  releaseDocumentNumber,
  reserveDocumentNumber,
  serverProductSchema,
  supportedServerProducts,
  supportedServerRoles,
  type AuditEntryDraft,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresBillingDependencies,
  createPostgresBillingUnitOfWork,
  createPostgresPool,
  createPostgresProAccountingCatalogRepository,
  createPostgresProWorkflowRepository,
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
  withPostgresTransaction,
  type PostgresQueryable,
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
import { SessionTokenService, checkSessionSecret, type AuthSession, type AuthSessionInfo } from './auth.js';
import { createAuthStore, type AuthStore } from './authStore.js';
import { ApiError, registerErrorHandler, typedRoute } from './http.js';

type Pool = ReturnType<typeof createPostgresPool>;
type AppSettings = z.infer<typeof appSettingsSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const entityIdParamsSchema = z.object({ id: z.string().min(1) });
const deletePayloadSchema = z.object({ reason: z.string().trim().min(1) });
const documentKindSchema = z.enum(['invoice', 'offer']);
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
  subject: 'client' | 'invoice' | 'offer' | 'recurring-profile',
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
  if (!session) {
    throw new ApiError(401, 'Invalid or expired bearer token');
  }
  if (session.scope.product !== product) {
    throw new ApiError(403, `Token is not authorized for ${product}`);
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
    return parseStoredSettings(await getServerSettings(db, scope.tenantId));
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
      const principal = await app.authStore.login(product, body);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, product, request.headers.authorization);
      return reserveNumberForScope(requirePool(app), session.scope, body.kind);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/release`,
    body: numberReleaseBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return releaseNumberForScope(requirePool(app), session.scope, body.reservationId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/finalize`,
    body: numberFinalizeBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
    url: `${prefix}/templates`,
    query: listTemplatesParamsSchema,
    response: z.array(templateRecordSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
    method: 'POST',
    url: `${prefix}/workflow`,
    body: z.object({
      transactionId: z.string().min(1),
      transactionJson: z.string().min(2),
      draftJson: z.string().min(2),
    }),
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
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
      const session = await requireSession(app, 'pro', request.headers.authorization);
      await createPostgresProAccountingCatalogRepository(requirePool(app)).deleteAccountSuggestionRule(session.scope, params.id);
      return { ok: true as const };
    },
  });
};

declare module 'fastify' {
  interface FastifyInstance {
    authStore: AuthStore;
    tokenService: SessionTokenService;
    serverPool?: Pool;
  }
}

export const buildServerApi = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: true,
  });

  registerErrorHandler(app);

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  const secretVerdict = checkSessionSecret(process.env);
  if (!secretVerdict.ok) throw new Error(secretVerdict.error);
  if (secretVerdict.warning) app.log.warn(secretVerdict.warning);

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

  registerAuthRoutes(app, 'lite', '/api/v1/lite');
  registerAuthRoutes(app, 'pro', '/api/v1/pro');
  registerBillingRoutes(app, 'lite', '/api/v1/lite');
  registerBillingRoutes(app, 'pro', '/api/v1/pro');
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
      const principal = await app.authStore.login(query.product, body);
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
