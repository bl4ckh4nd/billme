import { randomUUID } from 'node:crypto';
import { createNumberingPortsForDb } from './numbering.js';
import { convertServerOfferToInvoice } from './offerConversion.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  authUserSchema,
  bootstrapRequestSchema,
  capabilitiesResponseSchema,
  clientSchema,
  createSingleTenantScope,
  createCancellationInvoiceAsync,
  createCreditNoteAsync,
  createDeliveryNoteFromOrderAsync,
  createInvoiceRevisionAsync,
  createOrderConfirmationFromOfferAsync,
  createSettlementInvoiceAsync,
  listDocumentChainAsync,
  listInvoiceRevisionsAsync,
  upsertRecurringProfile,
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
  type ServerRole,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresBillingDependencies,
  createPostgresBillingUnitOfWork,
  createPostgresPool,
  createPostgresServerDatabase,
  createPostgresProAccountingCatalogRepository,
  createPostgresProWorkflowRepository,
  deleteServerArticle,
  deleteServerBankAccount,
  deleteServerTemplate,
  getServerActiveTemplates,
  getServerSettings,
  listServerArticles,
  listServerBankAccounts,
  listServerTemplates,
  readDatabaseUrl,
  assertDrizzleSchemaCurrent,
  saveServerActiveTemplates,
  saveServerArticle,
  saveServerBankAccount,
  saveServerSettings,
  saveServerTemplate,
  createPostgresProjectRepository,
  createPostgresProAccountingRepository,
  buildPostgresTaxAuditExportArtifact,
  type ServerDatabase,
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
  upsertArticlePayloadSchema,
  upsertTemplatePayloadSchema,
  projectSchema,
  taxAuditExportArtifactSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { SessionTokenService, checkSessionSecret, type AuthSession, type AuthSessionInfo } from './auth.js';
import { createAuthStore } from './authStore.js';
import { ApiError, registerErrorHandler, typedRoute } from './http.js';
import { registerServerApiOrpc } from './orpc.js';
import { registerProAccountingRoutes, type ProAccountingRouteOptions } from './proAccountingRoutes.js';
import { registerTaxFilingRoutes } from './taxFilingRoutes.js';
import { registerLiteEurRoutes } from './liteEurRoutes.js';
import { registerTransactionRoutes } from './transactionRoutes.js';
import { registerAutomationRoutes } from './automationRoutes.js';
import { registerAuditRoutes } from './auditRoutes.js';
import { registerEurRuleRoutes } from './eurRuleRoutes.js';
import {
  requireDatabase,
  requireAuditExportSession,
  createMutationContext,
  requireMutationSession,
  requireMutationSessionFor,
  requireSession,
  authorizeEmbeddedRequest,
} from './runtimeContext.js';

type RuntimeProfile = 'server' | 'embedded';

export interface EmbeddedLocalAuthOptions {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role?: ServerRole;
}

export interface BuildServerApiOptions {
  readonly database?: ServerDatabase;
  readonly runtime?: RuntimeProfile;
  readonly product?: 'lite' | 'pro';
  readonly logger?: boolean;
  readonly sessionSecret?: string;
  readonly localAuth?: EmbeddedLocalAuthOptions;
  readonly openRouterVlmService?: ProAccountingRouteOptions['openRouterVlmService'];
}

const runtimeCapabilitiesResponseSchema = capabilitiesResponseSchema.extend({
  runtime: z.enum(['server', 'embedded']),
  database: capabilitiesResponseSchema.shape.database.extend({
    local: z.enum(['sqlite', 'pglite']),
  }),
  auth: capabilitiesResponseSchema.shape.auth.extend({
    multiUser: z.boolean(),
  }),
});

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
const chainCommonSchema = z.object({
  id: z.string().trim().min(1),
  number: z.string().trim().min(1),
  date: z.string().trim().min(1),
  dueDate: z.string().trim().min(1).optional(),
  servicePeriod: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
});
const orderConfirmationBodySchema = chainCommonSchema.extend({ offerId: z.string().trim().min(1) });
const deliveryNoteBodySchema = chainCommonSchema.extend({ orderId: z.string().trim().min(1), items: invoiceSchema.shape.items.optional() });
const settlementInvoiceBodySchema = chainCommonSchema.extend({
  orderId: z.string().trim().min(1),
  kind: z.enum(['advance_invoice', 'partial_invoice', 'final_invoice']),
  amount: z.number().finite().positive(),
  items: invoiceSchema.shape.items.optional(),
});
const correctionBodySchema = chainCommonSchema.extend({
  invoiceId: z.string().trim().min(1),
  kind: z.enum(['credit_note', 'cancellation_invoice']),
  amount: z.number().finite().positive().optional(),
  items: invoiceSchema.shape.items.optional(),
});
const revisionBodySchema = chainCommonSchema.extend({ invoiceId: z.string().trim().min(1) });
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
const taxAuditExportPackageArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  includeDocuments: z.boolean().optional(),
});
const projectListQuerySchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  includeArchived: z.coerce.boolean().optional(),
});
const projectWriteSchema = projectSchema.extend({ clientId: z.string().trim().min(1) });
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
): AuditEntryDraft => {
  const mutation = createMutationContext(session, reason);
  return {
    occurredAt: new Date().toISOString(),
    action,
    reason: mutation.reason,
    actor: mutation.actor,
    subject: {
      entityType: subject,
      entityId,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after,
    },
  };
};

const historyFromAudit = async (
  db: ServerDatabase,
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

const withInvoiceHistory = async (db: ServerDatabase, scope: TenantScope, invoice: z.infer<typeof invoiceSchema>) => {
  return {
    ...invoice,
    history: await historyFromAudit(db, scope, 'invoice', invoice.id),
  };
};

const withOfferHistory = async (db: ServerDatabase, scope: TenantScope, offer: z.infer<typeof offerSchema>) => {
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

// Lite has no SKR chart of accounts, so its accounts carry no default SKR
// number. Pro clients still send one and validate it against the strict Pro
// schema before the request, so the guarantee stays where it belongs.
const serverAccountSchema = accountSchema.extend({
  defaultSkrAccountNumber: z.string().min(1).optional(),
});
const serverUpsertAccountPayloadSchema = z.object({ account: serverAccountSchema });

const mapAccountRecord = (record: Awaited<ReturnType<typeof listServerBankAccounts>>[number]) =>
  serverAccountSchema.parse({
    id: record.id,
    name: record.name,
    iban: record.iban,
    balance: record.balance,
    defaultSkrAccountNumber: record.defaultSkrAccountNumber,
    transactions: [],
    type: record.type,
    color: record.color,
  });

const reserveNumberForScope = async (
  database: ServerDatabase,
  scope: TenantScope,
  kind: 'invoice' | 'offer' | 'customer',
) => {
  return database.transaction({}, async (session) =>
    reserveDocumentNumber(createNumberingPortsForDb(session, scope), kind),
  );
};

const releaseNumberForScope = async (
  database: ServerDatabase,
  scope: TenantScope,
  reservationId: string,
) => {
  return database.transaction({}, async (session) =>
    releaseDocumentNumber(createNumberingPortsForDb(session, scope), reservationId),
  );
};

const finalizeNumberForScope = async (
  database: ServerDatabase,
  scope: TenantScope,
  reservationId: string,
  documentId: string,
) => {
  return database.transaction({}, async (session) =>
    finalizeDocumentNumber(createNumberingPortsForDb(session, scope), reservationId, documentId),
  );
};

const registerBillingRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/clients`,
    response: z.array(clientSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (transaction) => {
        const repositories = createPostgresBillingDependencies(transaction);
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

        // Browser/server Pro uses the same persisted invoice aggregate as Lite.
        // Once a reserved number is finalized and the draft becomes open, post
        // the billing document in this transaction.  Non-billing chain
        // documents intentionally remain outside journal/OPOS and correction
        // posting is handled by the accounting repository's source relation.
        const billingKind = !['order_confirmation', 'delivery_note'].includes(nextInvoice.documentKind ?? 'invoice');
        if (product === 'pro' && before?.status === 'draft' && after.status === 'open' && billingKind) {
          const reservation = (await transaction.query<{ id: string }>(
            `SELECT id FROM number_reservations WHERE tenant_id=$1 AND kind='invoice' AND status='finalized' AND document_id=$2 AND number=$3 LIMIT 1`,
            [session.scope.tenantId, after.id, after.number],
          )).rows[0];
          if (!reservation) throw new Error('FINALIZED_RESERVATION_REQUIRED');
          const posted = await createPostgresProAccountingRepository(transaction).postOutgoingInvoice(
            session.scope,
            after.id,
            { reservationId: reservation.id, mutation: createMutationContext(session, body.reason) },
          );
          if (posted.status !== 'ready' || !posted.snapshot) {
            throw new Error(posted.reason ?? posted.issues[0]?.code ?? 'ACCOUNTING_POSTING_UNRESOLVED');
          }
        }
        return after;
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/documents/convert-offer`,
    body: z.object({ offerId: z.string().min(1), invoiceId: z.string().uuid() }),
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await convertServerOfferToInvoice(database, session.scope, body, createMutationContext(session, 'Converted from offer').actor);
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/order-confirmations`,
    body: orderConfirmationBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await createPostgresBillingUnitOfWork(pool).withTransaction(session.scope, async ({ repositories }) =>
        createOrderConfirmationFromOfferAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor }));
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/delivery-notes`,
    body: deliveryNoteBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await createPostgresBillingUnitOfWork(pool).withTransaction(session.scope, async ({ repositories }) =>
        createDeliveryNoteFromOrderAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor }));
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/settlement-invoices`,
    body: settlementInvoiceBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await createPostgresBillingUnitOfWork(pool).withTransaction(session.scope, async ({ repositories }) =>
        createSettlementInvoiceAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor }));
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/corrections`,
    body: correctionBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await createPostgresBillingUnitOfWork(pool).withTransaction(session.scope, async ({ repositories }) => {
        const actor = createMutationContext(session, body.reason).actor;
        return body.kind === 'credit_note'
          ? createCreditNoteAsync(session.scope, repositories, { ...body, actor })
          : createCancellationInvoiceAsync(session.scope, repositories, { ...body, actor });
      });
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/revisions`,
    body: revisionBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await createPostgresBillingUnitOfWork(pool).withTransaction(session.scope, async ({ repositories }) =>
        createInvoiceRevisionAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor }));
      return withInvoiceHistory(pool, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/document-chain/:rootDocumentId`,
    params: z.object({ rootDocumentId: z.string().trim().min(1) }),
    response: z.array(invoiceSchema),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const dependencies = createPostgresBillingDependencies(pool);
      return listDocumentChainAsync(session.scope, dependencies, params.rootDocumentId);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/document-chain/:invoiceId/revisions`,
    params: z.object({ invoiceId: z.string().trim().min(1) }),
    response: z.array(invoiceSchema),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const dependencies = createPostgresBillingDependencies(pool);
      return listInvoiceRevisionsAsync(session.scope, dependencies, params.invoiceId);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const pool = requireDatabase(app);
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
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
      const pool = requireDatabase(app);
      const unitOfWork = createPostgresBillingUnitOfWork(pool);
      return unitOfWork.withTransaction(session.scope, async ({ repositories }) => {
        const nextProfile = recurringProfileSchema.parse({
          ...body.profile,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.recurringProfileRepo.getById(session.scope, nextProfile.id);
        const saved = await upsertRecurringProfile(session.scope, {
          recurringProfileStore: repositories.recurringProfileRepo,
        }, nextProfile);
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
      const pool = requireDatabase(app);
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
      return parseStoredSettings(await getServerSettings(requireDatabase(app), session.scope.tenantId));
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/settings`,
    body: setSettingsPayloadSchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      await saveServerSettings(requireDatabase(app), {
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
      return reserveNumberForScope(requireDatabase(app), session.scope, body.kind);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/release`,
    body: numberReleaseBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return releaseNumberForScope(requireDatabase(app), session.scope, body.reservationId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/finalize`,
    body: numberFinalizeBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return finalizeNumberForScope(requireDatabase(app), session.scope, body.reservationId, body.documentId);
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
      if (params.kind === 'invoice') {
        const invoice = await dependencies.invoiceRepo.getById(session.scope, params.id);
        return invoice ? withInvoiceHistory(requireDatabase(app), session.scope, invoice) : null;
      }
      const offer = await dependencies.offerRepo.getById(session.scope, params.id);
      return offer ? withOfferHistory(requireDatabase(app), session.scope, offer) : null;
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
      const payload =
        params.kind === 'invoice'
          ? await dependencies.invoiceRepo.getById(session.scope, params.id)
          : await dependencies.offerRepo.getById(session.scope, params.id);
      if (!payload) {
        throw new ApiError(404, `${params.kind} not found`);
      }
      const enriched =
        params.kind === 'invoice'
          ? await withInvoiceHistory(requireDatabase(app), session.scope, payload as z.infer<typeof invoiceSchema>)
          : await withOfferHistory(requireDatabase(app), session.scope, payload as z.infer<typeof offerSchema>);
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
      const dependencies = createPostgresBillingDependencies(requireDatabase(app));
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

const registerCatalogRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/projects`,
    query: projectListQuerySchema,
    response: z.array(projectSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app)).list(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/projects/:id`,
    params: entityIdParamsSchema,
    response: projectSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app)).get(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/projects`,
    body: z.object({ reason: z.string().trim().min(1), project: projectWriteSchema }),
    response: projectSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app)).upsert(session.scope, body.project, body.reason);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/projects/:id/archive`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: projectSchema,
    async handler({ request, params, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app)).archive(session.scope, params.id, body.reason);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/articles`,
    response: z.array(articleSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return (await listServerArticles(requireDatabase(app), session.scope.tenantId)).map(mapArticleRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/articles`,
    body: upsertArticlePayloadSchema,
    response: articleSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const saved = await saveServerArticle(requireDatabase(app), {
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
    method: 'DELETE',
    url: `${prefix}/articles/:id`,
    params: entityIdParamsSchema,
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      await deleteServerArticle(requireDatabase(app), session.scope.tenantId, params.id);
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/accounts`,
    response: z.array(serverAccountSchema),
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return (await listServerBankAccounts(requireDatabase(app), session.scope.tenantId)).map(mapAccountRecord);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounts`,
    body: serverUpsertAccountPayloadSchema,
    response: serverAccountSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const saved = await saveServerBankAccount(requireDatabase(app), {
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
    method: 'DELETE',
    url: `${prefix}/accounts/:id`,
    params: entityIdParamsSchema,
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      await deleteServerBankAccount(requireDatabase(app), session.scope.tenantId, params.id);
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/templates`,
    query: listTemplatesParamsSchema,
    response: z.array(templateRecordSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const templates = await listServerTemplates(requireDatabase(app), session.scope.tenantId);
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
      const session = await requireSession(app, product, request.headers.authorization);
      const saved = await saveServerTemplate(requireDatabase(app), {
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
    method: 'DELETE',
    url: `${prefix}/templates/:id`,
    params: entityIdParamsSchema,
    response: okSchema,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      await deleteServerTemplate(requireDatabase(app), session.scope.tenantId, params.id);
      return { ok: true as const };
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
      const active = await getServerActiveTemplates(requireDatabase(app), session.scope.tenantId);
      const templateId = params.kind === 'invoice' ? active?.invoiceTemplateId : active?.offerTemplateId;
      if (!templateId) {
        return null;
      }
      const templates = await listServerTemplates(requireDatabase(app), session.scope.tenantId);
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
      const session = await requireSession(app, product, request.headers.authorization);
      const existing = await getServerActiveTemplates(requireDatabase(app), session.scope.tenantId);
      await saveServerActiveTemplates(requireDatabase(app), {
        tenantId: session.scope.tenantId,
        id: existing?.id ?? 1,
        invoiceTemplateId: body.kind === 'invoice' ? body.templateId ?? undefined : existing?.invoiceTemplateId,
        offerTemplateId: body.kind === 'offer' ? body.templateId ?? undefined : existing?.offerTemplateId,
      });
      return { ok: true as const };
    },
  });
};

const registerTaxAuditExportRoute = (app: FastifyInstance) => {
  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/pro/tax/audit-export-package',
    body: taxAuditExportPackageArgsSchema,
    response: taxAuditExportArtifactSchema,
    async handler({ request, body }) {
      const session = await requireAuditExportSession(app, 'pro', request.headers.authorization);
      return buildPostgresTaxAuditExportArtifact(
        requireDatabase(app),
        session.scope.tenantId,
        body,
      );
    },
  });
};

const registerProRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/pro';

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
      return createPostgresProWorkflowRepository(requireDatabase(app)).list(session.scope);
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
      return createPostgresProWorkflowRepository(requireDatabase(app)).upsert(session.scope, body);
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
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).listLedgerAccounts(session.scope, query);
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
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).getLedgerStats();
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
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).listTaxCases(session.scope, query);
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
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).listTaxCaseAccountMappings(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounting/tax-case-account-mappings`,
    body: proUpsertTaxCaseAccountMappingArgsSchema.extend({ reason: z.string().trim().min(1) }),
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
      const session = await requireMutationSession(app, request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).upsertTaxCaseAccountMapping(session.scope, {
        ...body,
        mutation: { ...createMutationContext(session, body.reason) },
      });
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
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).listAccountSuggestionRules(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/accounting/account-suggestion-rules`,
    body: proUpsertAccountSuggestionRuleArgsSchema.extend({ reason: z.string().trim().min(1) }),
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
      const session = await requireMutationSession(app, request.headers.authorization);
      return createPostgresProAccountingCatalogRepository(requireDatabase(app)).upsertAccountSuggestionRule(session.scope, { ...body, tenantId: undefined, mutation: createMutationContext(session, body.reason) });
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/accounting/account-suggestion-rules/:id`,
    params: z.object({
      id: z.string().min(1),
    }),
    query: z.object({ reason: z.string().trim().min(1) }),
    response: okSchema,
    async handler({ request, params, query }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      await createPostgresProAccountingCatalogRepository(requireDatabase(app)).deleteAccountSuggestionRule(session.scope, params.id, createMutationContext(session, query.reason));
      return { ok: true as const };
    },
  });
};

export const buildServerApi = async (options: BuildServerApiOptions = {}): Promise<FastifyInstance> => {
  const runtime = options.runtime ?? 'server';
  const product = options.product ?? 'lite';
  const app = Fastify({
    logger: options.logger ?? true,
  });

  app.decorate('runtimeProfile', runtime);
  app.decorate('runtimeProduct', runtime === 'embedded' ? product : undefined);

  registerErrorHandler(app);

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-billme-local-token'],
    exposedHeaders: [
      'x-billme-datev-export-id',
      'x-billme-datev-content-sha256',
      'x-billme-datev-record-count',
    ],
  });

  const secretEnv = {
    ...process.env,
    ...(options.sessionSecret ? { SESSION_SECRET: options.sessionSecret } : {}),
  };
  const secretVerdict = checkSessionSecret(secretEnv);
  if (!secretVerdict.ok) throw new Error(secretVerdict.error);
  if (secretVerdict.warning) app.log.warn(secretVerdict.warning);

  if (runtime === 'embedded') {
    if (!options.database) {
      throw new Error('Embedded server runtime requires an injected ServerDatabase');
    }
    if (!options.localAuth) {
      throw new Error('Embedded server runtime requires local auth material');
    }
    if (!options.sessionSecret) {
      throw new Error('Embedded server runtime requires an explicit session secret');
    }

    await options.database.migrate();
    await options.database.assertCurrent();
    app.decorate('serverDatabase', options.database);
    app.decorate('localAccessTokenSecret', options.localAuth.accessToken);
    app.decorate('localSession', {
      user: {
        id: options.localAuth.userId,
        email: options.localAuth.email,
        fullName: options.localAuth.fullName,
        role: options.localAuth.role ?? 'owner',
      },
      scope: createSingleTenantScope(options.localAuth.tenantId, product),
      role: options.localAuth.role ?? 'owner',
    });
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/')) return;
      const localTokenHeader = request.headers['x-billme-local-token'];
      const localToken = typeof localTokenHeader === 'string' ? localTokenHeader : undefined;
      authorizeEmbeddedRequest(app, product, localToken);
      request.headers.authorization = `Bearer ${localToken}`;
    });
    app.addHook('onClose', async () => {
      await options.database?.close();
    });
  } else {
    const databaseUrl = readDatabaseUrl(process.env);
    const pool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
    if (pool) {
      await assertDrizzleSchemaCurrent(pool);
      const database = createPostgresServerDatabase(pool);
      app.decorate('serverPool', pool);
      app.decorate('serverDatabase', database);
      app.addHook('onClose', async () => {
        await database.close();
      });
    }
  }

  app.decorate('tokenService', new SessionTokenService(options.sessionSecret ?? process.env.SESSION_SECRET));
  const authPool = runtime === 'server' && app.serverPool ? app.serverPool : undefined;
  app.decorate('authStore', createAuthStore({ pool: authPool, env: process.env }));

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
    response: runtimeCapabilitiesResponseSchema,
    async handler() {
      return {
        backend: 'fastify' as const,
        deploymentMode: 'single-tenant' as const,
        desktopServerMode: true as const,
        runtime,
        database: {
          production: 'postgres' as const,
          local: runtime === 'embedded' ? 'pglite' as const : 'sqlite' as const,
        },
        auth: {
          multiUser: runtime === 'server' as const,
          roles: runtime === 'server' ? [...supportedServerRoles] : ['owner' as const],
        },
        products: runtime === 'embedded' ? [product] : [...supportedServerProducts],
      };
    },
  });

  if (runtime === 'server') {
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

    registerBillingRoutes(app, 'lite', '/api/v1/lite');
    registerBillingRoutes(app, 'pro', '/api/v1/pro');
    registerCatalogRoutes(app, 'lite', '/api/v1/lite');
    registerCatalogRoutes(app, 'pro', '/api/v1/pro');
    registerTransactionRoutes(app, 'lite');
    registerTransactionRoutes(app, 'pro');
    registerProRoutes(app);
    registerTaxAuditExportRoute(app);
    registerProAccountingRoutes(app, { openRouterVlmService: options.openRouterVlmService });
    registerLiteEurRoutes(app);
    registerAuditRoutes(app, 'lite');
    registerAuditRoutes(app, 'pro');
    registerEurRuleRoutes(app, 'lite');
    registerEurRuleRoutes(app, 'pro');
    registerTaxFilingRoutes(app, 'lite');
    registerTaxFilingRoutes(app, 'pro');
    registerAutomationRoutes(app, 'lite', '/api/v1/lite', {
      requireSession,
      requireDatabase,
    });
    registerAutomationRoutes(app, 'pro', '/api/v1/pro', {
      requireSession,
      requireDatabase,
    });
  } else {
    registerBillingRoutes(app, product, `/api/v1/${product}`);
    registerCatalogRoutes(app, product, `/api/v1/${product}`);
    registerTransactionRoutes(app, product);
    if (product === 'pro') {
      registerProRoutes(app);
      registerTaxAuditExportRoute(app);
      registerProAccountingRoutes(app, { openRouterVlmService: options.openRouterVlmService });
      registerAuditRoutes(app, 'pro');
      registerEurRuleRoutes(app, 'pro');
    } else {
      registerLiteEurRoutes(app);
      registerAuditRoutes(app, 'lite');
      registerEurRuleRoutes(app, 'lite');
    }
    registerTaxFilingRoutes(app, product);
    registerAutomationRoutes(app, product, `/api/v1/${product}`, {
      requireSession,
      requireDatabase,
    });
  }

  if (runtime === 'server') {
    await registerServerApiOrpc(app);
  }

  return app;
};

export { requireDatabase, requireMutationSession, requirePool, requireSession } from './runtimeContext.js';
