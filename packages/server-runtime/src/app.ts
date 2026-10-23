import { randomUUID } from 'node:crypto';
import { createNumberingPortsForDb } from './numbering.js';
import { convertServerOfferToInvoice } from './offerConversion.js';
import type { Invoice, InvoiceTaxSnapshot } from '@billme/server-core';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { z } from 'zod';
import {
  authUserSchema,
  bootstrapRequestSchema,
  bootstrapStatusSchema,
  capabilitiesResponseSchema,
  clientSchema,
  clientProjectSchema,
  calculateInvoiceTaxSnapshot,
  localIsoDate,
  resolveInvoiceTaxMode,
  resolveIssueTaxMode,
  prepareClientForUpsert,
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
  settleInvoiceStatusFromPayments,
  reserveDocumentNumber,
  serverProductSchema,
  supportedServerProducts,
  supportedServerRoles,
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
  convertLegacyServerTemplates,
  getServerSettings,
  listServerArticles,
  listServerBankAccounts,
  readDatabaseUrl,
  assertDrizzleSchemaCurrent,
  saveServerArticle,
  saveServerBankAccount,
  saveServerSettings,
  createPostgresProjectRepository,
  buildPostgresTaxAuditExportArtifact,
  type ServerDatabase,
  type ServerDatabaseSession,
} from '@billme/server-data';
import {
  accountSchema,
  appSettingsSchema,
  articleSchema,
  ledgerAccountSchema,
  proListAccountSuggestionRulesArgsSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  setSettingsPayloadSchema,
  upsertArticlePayloadSchema,
  projectSchema,
  taxAuditExportArtifactSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { SessionTokenService, checkSessionSecret, type AuthSession, type AuthSessionInfo } from './auth.js';
import { createAuthStore, resolveSetupToken } from './authStore.js';
import { buildAuditEntry, withInvoiceHistory, withOfferHistory } from './auditHistory.js';
import { assertOfferContentEditable, assertInvoiceContentEditable, cancelUnpaidRevisionSource, chainIssueBodySchema, settleCorrectedSource, settledInvoiceStatus, issueDocumentChain, issuableIn, lockChainSource, postOpenedBillingDocument } from './documentIssuance.js';
import { ApiError, registerErrorHandler, typedRoute } from './http.js';
import { registerServerApiOrpc } from './orpc.js';
import { registerProAccountingRoutes, type ProAccountingRouteOptions } from './proAccountingRoutes.js';
import { registerTaxFilingRoutes } from './taxFilingRoutes.js';
import { registerLiteEurRoutes } from './liteEurRoutes.js';
import { registerLiteCashRoutes } from './liteCashRoutes.js';
import { registerLiteVatRoutes } from './liteVatRoutes.js';
import { registerTransactionRoutes } from './transactionRoutes.js';
import { registerInvoicePaymentRoutes } from './invoicePaymentRoutes.js';
import { registerAutomationRoutes, type RegisterAutomationRoutesOptions } from './automationRoutes.js';
import { registerAuditRoutes } from './auditRoutes.js';
import { registerEurRuleRoutes } from './eurRuleRoutes.js';
import { registerDocumentTemplateRoutes } from './documentTemplateRoutes.js';
import { authenticateCliToken, isDeviceLoginPath, registerCliAccessRoutes } from './cliAccessRoutes.js';
import { createPlatformMailer, type PlatformMailer } from './platformMail.js';
import { registerWorkspaceRoutes } from './workspaceRoutes.js';
import {
  requireDatabase,
  requireAuditExportSession,
  createMutationContext,
  toMutationActor,
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
  /** Required to create the first owner; defaults to BILLME_SETUP_TOKEN. */
  readonly setupToken?: string;
  /** Sends invitation and password-reset mail; defaults to useSend from the environment. */
  readonly platformMailer?: PlatformMailer;
  readonly localAuth?: EmbeddedLocalAuthOptions;
  /** Embedded runtime: reported by `/health` so the CLI can verify a discovered port. */
  readonly instanceId?: string;
  readonly openRouterVlmService?: ProAccountingRouteOptions['openRouterVlmService'];
  readonly desktopIntegration?: RegisterAutomationRoutesOptions['desktopIntegration'];
  readonly renderDocumentPdf?: RegisterAutomationRoutesOptions['renderDocumentPdf'];
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
  includeArchived: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});
const projectWriteSchema = clientProjectSchema.extend({ budget: z.number().nonnegative() }).refine(
  (project) => !project.endDate || project.endDate >= project.startDate,
  { message: 'Das Enddatum darf nicht vor dem Startdatum liegen.', path: ['endDate'] },
);
const authSessionInfoSchema = z.object({
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: z.enum(supportedServerRoles),
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

const validateDocumentReservation = async (
  transaction: ServerDatabaseSession, scope: TenantScope, reservationId: string,
  document: { id: string; number: string }, kind: 'invoice' | 'offer',
) => {
  const reservation = await createNumberingPortsForDb(transaction, scope).getReservationById(reservationId);
  const owner = await transaction.query(`SELECT id FROM ${kind === 'invoice' ? 'invoices' : 'offers'} WHERE tenant_id=$1 AND number=$2 AND id<>$3`, [scope.tenantId, document.number, document.id]);
  if (owner.rows.length || !reservation || reservation.status === 'released' || reservation.kind !== kind || reservation.number !== document.number
    || (reservation.documentId !== null && reservation.documentId !== document.id)) {
    throw new ApiError(409, 'Die Nummernreservierung gehört nicht zu diesem Beleg. Bitte Beleg neu laden.');
  }
};

const toSessionInfo = (session: AuthSession): AuthSessionInfo => ({
  user: session.user,
  tenantId: session.scope.tenantId,
  product: session.scope.product,
  role: session.role,
});

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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      return pool.transaction({}, async (transaction) => {
        const numbering = createNumberingPortsForDb(transaction, session.scope);
        await numbering.getSettings();
        await transaction.query('SELECT id FROM clients WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, body.client.id]);
        const repositories = createPostgresBillingDependencies(transaction);
        const before = await repositories.clientRepo.getById(session.scope, body.client.id);
        const reservation = !body.client.customerNumber?.trim() && !before?.customerNumber?.trim()
          ? await reserveDocumentNumber(numbering, 'customer') : null;
        const clients = await repositories.clientRepo.list(session.scope);
        const customerNumber = body.client.customerNumber?.trim() || before?.customerNumber?.trim() || reservation?.number;
        if (clients.some((client) => client.id !== body.client.id && client.customerNumber?.trim() === customerNumber)) {
          throw new ApiError(409, 'Kundennummer bereits vergeben');
        }
        const prepared = prepareClientForUpsert(body.client, {
          existingCustomerNumber: before?.customerNumber,
          customerNumberExists: (number) => clients.some((client) => client.id !== body.client.id && client.customerNumber?.trim() === number),
          reserveCustomerNumber: () => reservation!,
        });
        const nextClient = clientSchema.parse({
          ...prepared,
          ...(!body.client.addresses?.length ? { address: body.client.address, addresses: body.client.addresses ?? [] } : {}),
          ...(!body.client.emails?.length ? { email: body.client.email, emails: body.client.emails ?? [] } : {}),
          projects: before?.projects ?? prepared.projects,
          tenantId: session.scope.tenantId,
        });
        const saved = await repositories.clientRepo.save(session.scope, nextClient);
        if (reservation) await finalizeDocumentNumber(numbering, reservation.reservationId, saved.id);
        await repositories.auditLog.append(session.scope, buildAuditEntry(
          session.scope, session, 'client', saved.id, before ? 'client.update' : 'client.create', body.reason, before, saved,
        ));
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
      reservationId: z.string().min(1).optional(),
    }),
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (transaction) => {
        await transaction.query('SELECT tenant_id FROM server_settings WHERE tenant_id=$1 FOR UPDATE', [session.scope.tenantId]);
        const repositories = createPostgresBillingDependencies(transaction);
        if (body.invoice.revisionOfId) await lockChainSource(transaction, session.scope, { invoiceId: body.invoice.revisionOfId });
        await transaction.query('SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, body.invoice.id]);
        const before = await repositories.invoiceRepo.getById(session.scope, body.invoice.id);
        const nextInvoice = settleInvoiceStatusFromPayments(invoiceSchema.parse({
          ...body.invoice,
          tenantId: session.scope.tenantId,
          payments: before?.payments ?? [],
          updatedAt: new Date().toISOString(),
        }));
        if (body.reservationId) await validateDocumentReservation(transaction, session.scope, body.reservationId, nextInvoice, 'invoice');
        assertInvoiceContentEditable(before, nextInvoice);
        if (!before || before.status === 'draft') {
          const settings = parseStoredSettings(await getServerSettings(transaction, session.scope.tenantId));
          if (!settings) throw new ApiError(409, 'Die Einstellungen müssen zuerst eingerichtet werden.');
          // The mode decides the VAT, so it is resolved before the snapshot (§19 UStG: a Kleinunternehmer shows none).
          nextInvoice.taxMode = resolveIssueTaxMode(nextInvoice.taxMode, settings);
          if (nextInvoice.status !== 'draft') Object.assign(nextInvoice, await issuableIn(transaction, session.scope, nextInvoice, settings));
          const taxSnapshot = keepChainTax(nextInvoice.taxSnapshot, calculateInvoiceTaxSnapshot(nextInvoice, settings));
          nextInvoice.taxSnapshot = taxSnapshot;
          nextInvoice.amount = taxSnapshot.grossAmount;
        }
        if (before && before.status !== 'draft') nextInvoice.status = await settledInvoiceStatus(transaction, session.scope, before);
        let issuanceReservationId: string | undefined;
        if ((!before || before.status === 'draft') && nextInvoice.status !== 'draft') {
          if (nextInvoice.status !== 'open') throw new ApiError(409, 'Ein Entwurf muss zuerst als Rechnung gestellt werden.');
          await cancelUnpaidRevisionSource(transaction, session, nextInvoice, body.reason);
          const reservation = (await transaction.query<{ id: string }>("SELECT id FROM number_reservations WHERE tenant_id=$1 AND kind='invoice' AND document_id=$2 AND number=$3 AND status IN ('reserved','finalized') ORDER BY created_at LIMIT 1", [session.scope.tenantId, nextInvoice.id, nextInvoice.number])).rows[0];
          const numbering = createNumberingPortsForDb(transaction, session.scope);
          if (body.reservationId) issuanceReservationId = body.reservationId;
          else if (reservation) issuanceReservationId = reservation.id;
          else {
            const reserved = await reserveDocumentNumber(numbering, 'invoice', new Date());
            nextInvoice.number = reserved.number; issuanceReservationId = reserved.reservationId;
          }
          await finalizeDocumentNumber(numbering, issuanceReservationId, nextInvoice.id);
        }
        const after = await repositories.invoiceRepo.save(session.scope, nextInvoice);
        // A draft only holds its number; it is finalized when the invoice is issued, so a deleted draft gives it back.
        if (body.reservationId && after.status === 'draft') {
          await transaction.query("UPDATE number_reservations SET document_id=$3 WHERE tenant_id=$1 AND id=$2 AND status='reserved'", [session.scope.tenantId, body.reservationId, after.id]);
        } else if (body.reservationId) await finalizeDocumentNumber(createNumberingPortsForDb(transaction, session.scope), body.reservationId, after.id);
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
        if (product === 'pro' && (!before || before.status === 'draft') && after.status === 'open' && billingKind) {
          if (!issuanceReservationId) throw new Error('FINALIZED_RESERVATION_REQUIRED');
          await postOpenedBillingDocument(transaction, session.scope, after, issuanceReservationId, createMutationContext(session, body.reason));
        }
        if ((!before || before.status === 'draft') && after.status === 'open') await settleCorrectedSource(transaction, session, after, body.reason);
        return after;
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  registerInvoicePaymentRoutes(app, product, prefix);

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
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (tx) => {
        await lockChainSource(tx, session.scope, { offerId: body.offerId });
        const repositories = createPostgresBillingDependencies(tx);
        return createOrderConfirmationFromOfferAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor });
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/delivery-notes`,
    body: deliveryNoteBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (tx) => {
        await lockChainSource(tx, session.scope, { orderId: body.orderId });
        const repositories = createPostgresBillingDependencies(tx);
        return createDeliveryNoteFromOrderAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor });
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/settlement-invoices`,
    body: settlementInvoiceBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (tx) => {
        await lockChainSource(tx, session.scope, { orderId: body.orderId });
        const repositories = createPostgresBillingDependencies(tx);
        return createSettlementInvoiceAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor });
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/corrections`,
    body: correctionBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (tx) => {
        await lockChainSource(tx, session.scope, { invoiceId: body.invoiceId });
        const repositories = createPostgresBillingDependencies(tx);
        const actor = createMutationContext(session, body.reason).actor;
        return body.kind === 'credit_note'
          ? createCreditNoteAsync(session.scope, repositories, { ...body, actor })
          : createCancellationInvoiceAsync(session.scope, repositories, { ...body, actor });
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/revisions`,
    body: revisionBodySchema,
    response: invoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const database = requireDatabase(app);
      const saved = await database.transaction({}, async (tx) => {
        await lockChainSource(tx, session.scope, { invoiceId: body.invoiceId });
        const repositories = createPostgresBillingDependencies(tx);
        return createInvoiceRevisionAsync(session.scope, repositories, { ...body, actor: createMutationContext(session, body.reason).actor });
      });
      return withInvoiceHistory(database, session.scope, saved);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/document-chain/issue`,
    body: chainIssueBodySchema,
    response: invoiceSchema.extend({ numberReservationId: z.string().min(1) }),
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      return issueDocumentChain(requireDatabase(app), session, body);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      return pool.transaction({}, async (transaction) => {
        await transaction.query('SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, params.id]);
        const repositories = createPostgresBillingDependencies(transaction);
        const existing = await repositories.invoiceRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Invoice not found');
        }
        if (existing.status !== 'draft') throw new ApiError(409, 'Gestellte Rechnungen können nicht gelöscht werden. Bitte eine Gutschrift oder Stornorechnung erstellen.');
        await repositories.invoiceRepo.remove(session.scope, params.id);
        // The draft's number goes back to the pool (older drafts carry a finalized reservation).
        await transaction.query(
          "UPDATE number_reservations SET status='released', updated_at=$3 WHERE tenant_id=$1 AND document_id=$2 AND kind IN ('invoice','order_confirmation','delivery_note') AND status<>'released'",
          [session.scope.tenantId, params.id, new Date().toISOString()],
        );
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
      reservationId: z.string().min(1).optional(),
    }),
    response: offerSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      const saved = await pool.transaction({}, async (transaction) => {
        await transaction.query('SELECT tenant_id FROM server_settings WHERE tenant_id=$1 FOR UPDATE', [session.scope.tenantId]);
        await transaction.query('SELECT id FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, body.offer.id]);
        const repositories = createPostgresBillingDependencies(transaction);
        const nextOffer = offerSchema.parse({
          ...body.offer,
          tenantId: session.scope.tenantId,
        });
        const before = await repositories.offerRepo.getById(session.scope, nextOffer.id);
        if (before?.share) {
          nextOffer.share = { ...before.share, ...nextOffer.share };
          if (before.share.token) nextOffer.share.token = before.share.token;
          if (before.share.publishedAt) nextOffer.share.publishedAt = before.share.publishedAt;
          if (before.share.decision || before.share.acceptedAt) {
            nextOffer.share = { ...nextOffer.share, decision: before.share.decision, acceptedAt: before.share.acceptedAt, acceptedBy: before.share.acceptedBy, acceptedEmail: before.share.acceptedEmail, acceptedUserAgent: before.share.acceptedUserAgent, decisionTextVersion: before.share.decisionTextVersion };
          }
        }
        assertOfferContentEditable(before, nextOffer);
        if (before?.share?.decision) nextOffer.status = before.status;
        const duplicate = await transaction.query('SELECT id FROM offers WHERE tenant_id=$1 AND number=$2 AND id<>$3', [session.scope.tenantId, nextOffer.number, nextOffer.id]);
        if (duplicate.rows.length) throw new ApiError(409, 'Angebotsnummer bereits vergeben.');
        if (body.reservationId) await validateDocumentReservation(transaction, session.scope, body.reservationId, nextOffer, 'offer');
        const after = await repositories.offerRepo.save(session.scope, nextOffer);
        if (body.reservationId) await finalizeDocumentNumber(createNumberingPortsForDb(transaction, session.scope), body.reservationId, after.id);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      return pool.transaction({}, async (transaction) => {
        await transaction.query('SELECT id FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, params.id]);
        const repositories = createPostgresBillingDependencies(transaction);
        const existing = await repositories.offerRepo.getById(session.scope, params.id);
        if (!existing) {
          throw new ApiError(404, 'Offer not found');
        }
        const references = await transaction.query('SELECT id FROM invoices WHERE tenant_id=$1 AND source_document_id=$2 UNION ALL SELECT invoice_id AS id FROM offer_invoice_conversions WHERE tenant_id=$1 AND offer_id=$2', [session.scope.tenantId, params.id]);
        if (references.rows.length) throw new ApiError(409, 'Das Angebot wird von einer Belegkette oder Rechnung verwendet und kann nicht gelöscht werden.');
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
      profile: recurringWriteSchema.extend({ taxMode: recurringProfileSchema.shape.taxMode.optional() }),
    }),
    response: recurringProfileSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      const pool = requireDatabase(app);
      return pool.transaction({}, async (transaction) => {
        await transaction.query('SELECT id FROM recurring_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, body.profile.id]);
        const repositories = createPostgresBillingDependencies(transaction);
        const before = await repositories.recurringProfileRepo.getById(session.scope, body.profile.id);
        const settings = parseStoredSettings(await getServerSettings(transaction, session.scope.tenantId));
        if (!settings) throw new ApiError(409, 'Die Einstellungen müssen zuerst eingerichtet werden.');
        const nextProfile = recurringProfileSchema.parse({
          ...body.profile,
          taxMode: body.profile.taxMode ?? before?.taxMode ?? resolveInvoiceTaxMode(undefined, settings),
          tenantId: session.scope.tenantId,
        });
        if (!await repositories.clientRepo.getById(session.scope, nextProfile.clientId)) throw new ApiError(404, 'Kunde nicht gefunden.');
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
    body: setSettingsPayloadSchema.extend({ reason: z.string().trim().min(1).default('Einstellungen aktualisiert') }),
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      await requireDatabase(app).transaction({}, async (transaction) => {
        await transaction.query('SELECT tenant_id FROM server_settings WHERE tenant_id=$1 FOR UPDATE', [session.scope.tenantId]);
        const before = parseStoredSettings(await getServerSettings(transaction, session.scope.tenantId));
        const after = appSettingsSchema.parse(body.settings);
        // Soll/Ist changes take effect from a period start, never retroactively for filed months:
        // without an explicit start the change applies from the first day of the current month.
        // Choosing the method during onboarding is no switch: it applies to the whole history.
        if (before?.onboardingCompleted && before.legal.taxAccountingMethod !== after.legal.taxAccountingMethod) {
          const explicit = after.legal.taxAccountingMethodSince && after.legal.taxAccountingMethodSince !== before.legal.taxAccountingMethodSince;
          after.legal.previousTaxAccountingMethod = before.legal.taxAccountingMethod;
          if (!explicit) after.legal.taxAccountingMethodSince = `${localIsoDate(new Date()).slice(0, 8)}01`;
        }
        await saveServerSettings(transaction, {
          tenantId: session.scope.tenantId,
          settingsJson: JSON.stringify(after),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await createPostgresBillingDependencies(transaction).auditLog.append(session.scope, buildAuditEntry(
          session.scope, session, 'settings', session.scope.tenantId, 'settings.update', body.reason, before, after,
        ));
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      return reserveNumberForScope(requireDatabase(app), session.scope, body.kind);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/release`,
    body: numberReleaseBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      return releaseNumberForScope(requireDatabase(app), session.scope, body.reservationId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/numbers/finalize`,
    body: numberFinalizeBodySchema,
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app), toMutationActor(session)).upsert(session.scope, body.project, body.reason);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/projects/:id/archive`,
    params: entityIdParamsSchema,
    body: deletePayloadSchema,
    response: projectSchema,
    async handler({ request, params, body }) {
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      return createPostgresProjectRepository(requireDatabase(app), toMutationActor(session)).archive(session.scope, params.id, body.reason);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
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
      const session = await requireMutationSessionFor(app, product, request.headers.authorization);
      await deleteServerBankAccount(requireDatabase(app), session.scope.tenantId, params.id);
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

/** Workflow entries are stored as text and parsed by every reader, so only JSON is accepted. */
const jsonTextSchema = z.string().min(2).refine((text) => {
  try { JSON.parse(text); return true; } catch { return false; }
}, 'Kein gültiges JSON.');

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
      transactionJson: jsonTextSchema,
      draftJson: jsonTextSchema,
    }),
    response: okSchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, 'pro', request.headers.authorization);
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
        hitCount: z.number().int().nonnegative().optional(),
        lastHitAt: z.string().optional(),
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

/**
 * A final invoice's tax is the order's tax minus the tax already invoiced, not
 * re-rounded from its net (§14 Abs. 5 UStG). When a draft of such a document
 * (a revision) is saved with the same net per rate, its stored tax stays;
 * any change to the lines recomputes it.
 */
const keepChainTax = (stored: InvoiceTaxSnapshot | undefined, fresh: InvoiceTaxSnapshot): InvoiceTaxSnapshot => {
  if (!stored?.vatBreakdown?.length || !fresh.vatBreakdown?.length) return fresh;
  const net = (entries: InvoiceTaxSnapshot['vatBreakdown']) =>
    new Map((entries ?? []).map((entry) => [entry.rate, Math.round(entry.netAmount * 100)]));
  const storedNet = net(stored.vatBreakdown);
  const freshNet = net(fresh.vatBreakdown);
  const sameNet = storedNet.size === freshNet.size && [...freshNet].every(([rate, value]) => storedNet.get(rate) === value);
  return sameNet && stored.label === fresh.label ? { ...fresh, vatBreakdown: stored.vatBreakdown, vatAmount: stored.vatAmount, grossAmount: stored.grossAmount, netAmount: stored.netAmount } : fresh;
};

export const buildServerApi = async (options: BuildServerApiOptions = {}): Promise<FastifyInstance> => {
  const runtime = options.runtime ?? 'server';
  const product = options.product ?? 'lite';
  const app = Fastify({
    logger: options.logger ?? true,
    // Behind a reverse proxy (Traefik on Coolify) request.ip is the proxy unless the forwarded header is trusted.
    trustProxy: process.env.BILLME_TRUST_PROXY === '1',
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

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    if (isDeviceLoginPath(request.url) || await authenticateCliToken(app, request)) return;
    if (runtime !== 'embedded') return;
    const localTokenHeader = request.headers['x-billme-local-token'];
    const localToken = typeof localTokenHeader === 'string' ? localTokenHeader : undefined;
    authorizeEmbeddedRequest(app, product, localToken);
    request.headers.authorization = `Bearer ${localToken}`;
  });

  if (app.serverDatabase) {
    // Retried on every boot until it succeeds; a failure must not block the API.
    await convertLegacyServerTemplates(app.serverDatabase).catch((error) => {
      app.log.error({ err: error }, 'Konvertierung der Alt-Vorlagen fehlgeschlagen');
    });
    if (runtime === 'server') {
      // Tenants bootstrapped before settings were seeded at bootstrap never saw onboarding; give them the same defaults.
      const seededAt = new Date().toISOString();
      await app.serverDatabase.query(
        `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
         SELECT id, $1, $2, $2 FROM tenants
         ON CONFLICT (tenant_id) DO NOTHING`,
        [JSON.stringify(DEFAULT_SETTINGS), seededAt],
      );
    }
  }

  app.decorate('tokenService', new SessionTokenService(options.sessionSecret ?? process.env.SESSION_SECRET));
  const authPool = runtime === 'server' && app.serverPool ? app.serverPool : undefined;
  app.decorate('authStore', createAuthStore({ pool: authPool, env: process.env, ...(options.setupToken ? { setupToken: options.setupToken } : {}) }));

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
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
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

  registerCliAccessRoutes(app, runtime === 'embedded' ? [product] : supportedServerProducts);

  if (runtime === 'server') {
    registerWorkspaceRoutes(app, {
      setupToken: options.setupToken ?? resolveSetupToken(),
      initialSettingsJson: JSON.stringify(DEFAULT_SETTINGS),
      mailer: options.platformMailer ?? createPlatformMailer(),
      webUrls: { lite: process.env.BILLME_PUBLIC_WEB_URL?.trim(), pro: process.env.BILLME_PUBLIC_WEB_PRO_URL?.trim() },
    });
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
      response: bootstrapStatusSchema,
      async handler({ query }) {
        return app.authStore.getBootstrapStatus(query.product);
      },
    });

    registerBillingRoutes(app, 'lite', '/api/v1/lite');
    registerBillingRoutes(app, 'pro', '/api/v1/pro');
    registerCatalogRoutes(app, 'lite', '/api/v1/lite');
    registerCatalogRoutes(app, 'pro', '/api/v1/pro');
    registerDocumentTemplateRoutes(app, 'lite', '/api/v1/lite');
    registerDocumentTemplateRoutes(app, 'pro', '/api/v1/pro');
    registerTransactionRoutes(app, 'lite');
    registerTransactionRoutes(app, 'pro');
    registerProRoutes(app);
    registerTaxAuditExportRoute(app);
    registerProAccountingRoutes(app, { openRouterVlmService: options.openRouterVlmService });
    registerLiteEurRoutes(app);
    registerLiteCashRoutes(app);
    registerLiteVatRoutes(app);
    registerAuditRoutes(app, 'lite');
    registerAuditRoutes(app, 'pro');
    registerEurRuleRoutes(app, 'lite');
    registerEurRuleRoutes(app, 'pro');
    registerTaxFilingRoutes(app, 'lite');
    registerTaxFilingRoutes(app, 'pro');
    registerAutomationRoutes(app, 'lite', '/api/v1/lite', {
      requireSession,
      requireDatabase,
      desktopIntegration: options.desktopIntegration,
      renderDocumentPdf: options.renderDocumentPdf,
    });
    registerAutomationRoutes(app, 'pro', '/api/v1/pro', {
      requireSession,
      requireDatabase,
      desktopIntegration: options.desktopIntegration,
      renderDocumentPdf: options.renderDocumentPdf,
    });
  } else {
    registerBillingRoutes(app, product, `/api/v1/${product}`);
    registerCatalogRoutes(app, product, `/api/v1/${product}`);
    registerDocumentTemplateRoutes(app, product, `/api/v1/${product}`);
    registerTransactionRoutes(app, product);
    if (product === 'pro') {
      registerProRoutes(app);
      registerTaxAuditExportRoute(app);
      registerProAccountingRoutes(app, { openRouterVlmService: options.openRouterVlmService });
      registerAuditRoutes(app, 'pro');
      registerEurRuleRoutes(app, 'pro');
    } else {
      registerLiteEurRoutes(app);
      registerLiteCashRoutes(app);
      registerLiteVatRoutes(app);
      registerAuditRoutes(app, 'lite');
      registerEurRuleRoutes(app, 'lite');
    }
    registerTaxFilingRoutes(app, product);
    registerAutomationRoutes(app, product, `/api/v1/${product}`, {
      requireSession,
      requireDatabase,
      desktopIntegration: options.desktopIntegration,
      renderDocumentPdf: options.renderDocumentPdf,
    });
  }

  if (runtime === 'server') {
    await registerServerApiOrpc(app);
  }

  return app;
};

export { requireDatabase, requireMutationSession, requirePool, requireSession } from './runtimeContext.js';
