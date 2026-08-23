import { z } from 'zod';
import {
  authResponseSchema, authUserSchema, bootstrapRequestSchema, bootstrapStatusSchema,
  capabilitiesResponseSchema, clientSchema, healthResponseSchema, invoiceSchema,
  loginRequestSchema, offerSchema, recurringProfileSchema, serverProductSchema, serverRoleSchema,
} from '@billme/server-core';
import {
  accountSchema, accountSuggestionRuleSchema, accountingAccountMappingSchema,
  accountingPolicySchema, accountingPostingPreviewSchema, accountingBackfillPreviewSchema,
  accountingBackfillResultSchema, appSettingsSchema, bookingDraftEntitySchema,
  articleSchema, assetDepreciationScheduleEntrySchema, assetSchema, assetUpsertSchema,
  datevExportResultSchema, incomingInvoiceSchema, journalEntryEntitySchema,
  ledgerAccountSchema, ledgerBalanceRowSchema, openItemSchema,
  eurAnnexFactSchema, eurCashFactSchema, eurClassificationSchema,
  eurRuleSchema, projectSchema, transactionSchema,
  proAccountingSourcePostResultSchema, proAccountingSourceRunSchema,
  proListAccountSuggestionRulesArgsSchema, proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema, proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema, proWorkflowEntrySchema,
  reportSnapshotRecordSchema, taxCaseAccountMappingSchema, taxCaseDefinitionSchema,
  vendorSchema, setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema, taxAuditExportArtifactSchema, templateKindSchema, templateSchema, upsertAccountPayloadSchema,
  upsertArticlePayloadSchema, upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { createBillmeApi, type BillmeApi, type IpcInvoke } from '@billme/desktop-contracts-pro/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts-pro/contract';
import { taxFilingRoutes } from '@billme/desktop-contracts/taxFiling';
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import { chooseDefaultBillingAddress, chooseDefaultBillingEmail, formatAddressMultiline } from '@billme/server-core/services';
import { createBillingScope, toDomainInvoice, toDomainOffer, toLegacyInvoice, toLegacyOffer } from '@billme/desktop-data/billingDomainCompat';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';

type Parser<T> = { parse: (input: unknown) => T } | ((input: unknown) => T);
type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | null | undefined;
type RequestOptions<T> = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, QueryValue>; parser?: Parser<T> };
type ProOpenItemPaymentInput = {
  paymentId?: string;
  sourceType: 'bank_transaction' | 'invoice_payment' | 'manual';
  sourceId: string;
  partyType: 'debtor' | 'creditor';
  partyId?: string;
  paymentDate: string;
  amount: number;
  bankAccountNumber: string;
  method?: string;
  allocations: Array<{ openItemId: string; amount: number }>;
  allocationEventId: string;
};
const PRO_PRODUCT_QUERY = { product: 'pro' as const };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const parseWith = <T>(parser: Parser<T>, input: unknown): T => typeof parser === 'function' ? parser(input) : parser.parse(input);
const parseArray = <T>(parser: Parser<T>): Parser<T[]> => (input) => {
  if (!Array.isArray(input)) throw new Error('Die Serverantwort enthält keine Liste.');
  return input.map((item) => parseWith(parser, item));
};
const serverTransactionMatchesSchema = z.object({
  transaction: transactionSchema,
  suggestions: z.array(z.object({
    invoice: invoiceSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    matchReasons: z.array(z.string()),
    amountDiff: z.number(),
  })),
});
const parseSourceRun = (input: unknown, fallbackFact?: unknown): z.infer<typeof proAccountingSourceRunSchema> => {
  if (isRecord(input) && input.fact === undefined && input.source !== undefined) {
    const source = isRecord(input.source) && isRecord(input.source.input) ? input.source.input : input.source;
    const fact = isRecord(fallbackFact) && isRecord(source) ? { ...fallbackFact, ...source } : source;
    return proAccountingSourceRunSchema.parse({ ...input, fact });
  }
  return proAccountingSourceRunSchema.parse(input);
};
const sourceRunParser: Parser<z.infer<typeof proAccountingSourceRunSchema>> = (input) => parseSourceRun(input);
const parseSourcePostResult = (input: unknown, fallbackFact?: unknown): z.infer<typeof proAccountingSourcePostResultSchema> => {
  if (isRecord(input) && typeof input.status === 'string' && Array.isArray(input.errors)) {
    return proAccountingSourcePostResultSchema.parse(input);
  }
  if (!isRecord(input) || !isRecord(input.run)) throw new Error('Die Serverantwort enthält kein Buchungsprotokoll.');
  const run = parseSourceRun(input.run, fallbackFact);
  const result = isRecord(input.result) ? input.result : undefined;
  const status = input.replayed === true ? 'duplicate' : run.status === 'posted' ? 'posted' : run.status === 'rejected' ? 'rejected' : 'noop';
  const errors = result && Array.isArray(result.errors) ? result.errors.flatMap((error) => isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string' ? [{ code: error.code, message: error.message, blocking: true as const }] : []) : [];
  return proAccountingSourcePostResultSchema.parse({ status, sourceRun: run, errors, idempotencyKey: run.idempotencyKey });
};
const reportSnapshotParser: Parser<z.infer<typeof reportSnapshotRecordSchema>> = (input) => {
  if (!isRecord(input)) throw new Error('Die Serverantwort enthält keinen Report-Snapshot.');
  const json = (value: unknown, fallback: unknown) => {
    if (typeof value !== 'string') return value ?? fallback;
    try { return JSON.parse(value) as unknown; } catch { throw new Error('Die Serverantwort enthält einen ungültigen Report-Snapshot.'); }
  };
  return reportSnapshotRecordSchema.parse({
    id: input.id, reportType: input.reportType,
    args: input.args ?? json(input.argsJson, {}), payload: input.payload ?? json(input.payloadJson, null),
    createdAt: input.createdAt, sourceHash: input.sourceHash,
  });
};
const eurReportServerParser: Parser<unknown> = (input) => {
  if (!isRecord(input)) throw new Error('Die Serverantwort enthält keinen EÜR-Bericht.');
  const rows = Array.isArray(input.rows) ? input.rows.map((row) => isRecord(row)
    ? { ...row, lineId: row.lineId ?? row.id }
    : row) : input.rows;
  return { ...input, rows };
};
const authSessionInfoParser = (input: unknown) => {
  if (!isRecord(input)) throw new Error('Die Serverantwort enthält keine Sitzungsdaten.');
  return {
    user: authUserSchema.parse(input.user),
    tenantId: typeof input.tenantId === 'string' ? input.tenantId : '',
    product: serverProductSchema.parse(input.product),
    role: serverRoleSchema.parse(input.role),
  };
};
const buildUrl = (baseUrl: string, path: string, query?: Record<string, QueryValue>): string => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
};

export type ProWebClientConfig = {
  baseUrl: string;
  getToken?: () => string | null;
  embeddedConnectionResolver?: () => Promise<EmbeddedConnection | null>;
  fetch?: typeof globalThis.fetch;
};
export class ProEmbeddedConnectionUnavailableError extends Error {
  readonly code = 'PRO_EMBEDDED_CONNECTION_UNAVAILABLE' as const;
  constructor() {
    super('Der eingebettete Pro-Server ist nicht verfügbar.');
    this.name = 'ProEmbeddedConnectionUnavailableError';
  }
}

export const createProWebClient = ({
  baseUrl, getToken, embeddedConnectionResolver, fetch: requestFetch = globalThis.fetch,
}: ProWebClientConfig) => {
  const resolveRequestTarget = async (): Promise<{ baseUrl: string; headers: HeadersInit }> => {
    if (embeddedConnectionResolver) {
      const connection = await embeddedConnectionResolver();
      if (!connection) throw new ProEmbeddedConnectionUnavailableError();
      return { baseUrl: connection.baseUrl, headers: { 'x-billme-local-token': connection.token } };
    }
    const token = getToken?.();
    return { baseUrl, headers: token ? { authorization: `Bearer ${token}` } : {} };
  };
  const requestJson = async <T>(options: RequestOptions<T>, path: string): Promise<T> => {
    if (!requestFetch) throw new Error('Keine Fetch-Implementierung verfügbar.');
    const target = await resolveRequestTarget();
    const headers = new Headers(target.headers);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await requestFetch(buildUrl(target.baseUrl, path, options.query), {
      method: options.method ?? 'GET', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.message === 'string'
        ? payload.message : `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return options.parser ? parseWith(options.parser, payload) : payload as T;
  };
  const requestBlobWithHeaders = async (path: string, query: Record<string, QueryValue>): Promise<{ blob: Blob; headers: Headers }> => {
    if (!requestFetch) throw new Error('Keine Fetch-Implementierung verfügbar.');
    const target = await resolveRequestTarget();
    const response = await requestFetch(buildUrl(target.baseUrl, path, query), { method: 'GET', headers: new Headers(target.headers) });
    if (!response.ok) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`);
    return { blob: await response.blob(), headers: response.headers };
  };
  const requestText = async (path: string, query?: Record<string, QueryValue>): Promise<string> => {
    if (!requestFetch) throw new Error('Keine Fetch-Implementierung verfügbar.');
    const target = await resolveRequestTarget();
    const response = await requestFetch(buildUrl(target.baseUrl, path, query), { method: 'GET', headers: new Headers(target.headers) });
    const payload = await response.text();
    if (!response.ok) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`);
    return payload;
  };
  type AccountingCommandRequest = {
    kind: string;
    source: unknown;
    domainFacts?: unknown;
    chart?: 'SKR03' | 'SKR04';
    softLockOverride?: boolean;
    overrideReason?: string;
    reason: string;
    provenance?: unknown;
  };
  const postAccountingCommand = async (input: AccountingCommandRequest) => {
    const source = isRecord(input.source) ? input.source : {};
    const facts = isRecord(input.domainFacts) ? input.domainFacts : undefined;
    if (input.kind !== 'standalone' && (!facts || Object.keys(facts).length === 0)) {
      throw new Error('Domain-Fakten sind für diesen Workflow erforderlich.');
    }
    const sourceId = String(source.sourceId ?? '');
    const sourceRevision = String(source.sourceRevision ?? '1');
    const idempotencyKey = `source:${sourceId || Date.now()}`;
    if (input.kind === 'correction') {
      const correction = {
        ...(facts ?? {}),
        id: facts?.id ?? sourceId,
        idempotencyKey: facts?.idempotencyKey ?? idempotencyKey,
        correctionDate: facts?.correctionDate ?? source.effectiveDate,
        reason: input.reason,
      };
      return requestJson({ method: 'POST', body: correction, parser: (payload) => payload }, '/api/v1/pro/accounting/corrections');
    }
    const commandKinds = new Set(['fiscal_close', 'carry_forward', 'provision', 'accrual', 'inventory_closing', 'fx_valuation', 'loan_schedule', 'payroll_batch', 'shareholder_flow']);
    const settlementKinds = new Set(['skonto', 'bad_debt', 'advance_settlement']);
    const commandInput = input.kind === 'standalone'
      ? { ...source, reference: source.reference ?? input.kind }
      : { ...(facts ?? {}), sourceId, sourceRevision, ...(settlementKinds.has(input.kind) ? {
        effectiveDate: source.effectiveDate,
        postingDate: source.postingDate ?? source.effectiveDate,
        currency: source.currency ?? 'EUR',
        period: source.period ?? String(source.effectiveDate ?? '').slice(0, 7),
        fiscalYear: source.fiscalYear ?? Number(String(source.effectiveDate ?? '').slice(0, 4)),
      } : {}) };
    const body = {
      ...(commandKinds.has(input.kind) ? { command: input.kind } : {}),
      ...(settlementKinds.has(input.kind) ? { commandType: input.kind } : {}),
      input: commandInput,
      sourceId,
      sourceRevision,
      idempotencyKey,
      reason: input.reason,
      ...(input.chart ? { chart: input.chart } : {}),
      ...(input.softLockOverride === undefined ? {} : { softLockOverride: input.softLockOverride }),
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    };
    return requestJson({ method: 'POST', body, parser: (payload) => payload }, '/api/v1/pro/accounting/closing');
  };
  const billingScope = createBillingScope('pro');
  const toServerInvoicePayload = (invoice: IpcResult<'invoices:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainInvoice(billingScope, invoice);
    return payload;
  };
  const toServerOfferPayload = (offer: IpcResult<'offers:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainOffer(billingScope, offer);
    return payload;
  };
  const getSettings = () => requestJson({
    parser: (input) => input === null ? null : appSettingsSchema.parse(input),
  }, '/api/v1/pro/settings');
  const reserveNumber = (kind: 'invoice' | 'offer' | 'customer') => requestJson({
    method: 'POST', body: ipcRoutes['numbers:reserve'].args.parse({ kind }),
    parser: ipcRoutes['numbers:reserve'].result,
  }, '/api/v1/pro/numbers/reserve');
  const releaseNumber = (reservationId: string) => requestJson({
    method: 'POST', body: ipcRoutes['numbers:release'].args.parse({ reservationId }),
    parser: ipcRoutes['numbers:release'].result,
  }, '/api/v1/pro/numbers/release');
  const buildDraftFromClient = async (kind: 'invoice' | 'offer', client: z.output<typeof clientSchema>): Promise<IpcResult<'documents:createFromClient'>> => {
    const settings = await getSettings();
    const reservation = await reserveNumber(kind);
    const billingAddress = chooseDefaultBillingAddress(client.addresses);
    const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
    const billingEmail = chooseDefaultBillingEmail(client.emails);
    const activeProject = client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived')
      ?? client.projects.find((project) => project.status !== 'archived') ?? client.projects[0];
    const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + (kind === 'offer' ? 0 : settings?.legal.paymentTermsDays ?? 0));
    return ipcRoutes['documents:createFromClient'].result.parse({
      id: crypto.randomUUID(), clientId: client.id, clientNumber: client.customerNumber, projectId: activeProject?.id,
      number: reservation.number, numberReservationId: reservation.reservationId, client: client.company,
      clientEmail: billingEmail?.email ?? client.email, clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
      billingAddressJson: billingAddress ?? undefined, shippingAddressJson: shippingAddress ?? undefined, date: today,
      dueDate: dueDate.toISOString().split('T')[0] ?? today, amount: 0, status: 'draft', items: [], payments: [], history: [],
    });
  };

  const client = {
    getHealth: () => requestJson({ parser: healthResponseSchema }, '/health'),
    getCapabilities: () => requestJson({ parser: capabilitiesResponseSchema }, '/api/v1/meta/capabilities'),
    getBootstrapStatus: () => requestJson({ parser: bootstrapStatusSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/bootstrap/status'),
    bootstrap: (input: unknown) => requestJson({ method: 'POST', body: bootstrapRequestSchema.parse(input), parser: authResponseSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/bootstrap'),
    login: (input: unknown) => requestJson({ method: 'POST', body: loginRequestSchema.parse(input), parser: authResponseSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/login'),
    getSessionInfo: () => requestJson({ parser: authSessionInfoParser, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/me'),

    getTaxFilingStatus: () => requestJson({ parser: taxFilingRoutes['taxFiling:getStatus'].result }, '/api/v1/pro/tax-filing/status'),
    exportTaxAuditPackage: (input: unknown) => requestJson({
      method: 'POST',
      body: ipcRoutes['tax:auditExportPackage'].args.parse(input),
      parser: taxAuditExportArtifactSchema,
    }, '/api/v1/pro/tax/audit-export-package'),
    listTaxFilingRecords: () => requestJson({ parser: taxFilingRoutes['taxFiling:listRecords'].result }, '/api/v1/pro/tax-filing/records'),
    installTaxFilingCertificate: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:installCertificate'].args.parse(input), parser: taxFilingRoutes['taxFiling:installCertificate'].result }, '/api/v1/pro/tax-filing/certificates'),
    removeTaxFilingCertificate: (id: string) => requestJson({ method: 'DELETE', parser: taxFilingRoutes['taxFiling:removeCertificate'].result }, `/api/v1/pro/tax-filing/certificates/${encodeURIComponent(id)}`),
    validateTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:validate'].args.parse(input), parser: taxFilingRoutes['taxFiling:validate'].result }, '/api/v1/pro/tax-filing/validate'),
    exportTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:export'].args.parse(input), parser: taxFilingRoutes['taxFiling:export'].result }, '/api/v1/pro/tax-filing/export'),
    submitTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:submit'].args.parse(input), parser: taxFilingRoutes['taxFiling:submit'].result }, '/api/v1/pro/tax-filing/submit'),

    listClients: () => requestJson({ parser: parseArray(clientSchema) }, '/api/v1/pro/clients'),
    saveClient: (input: unknown) => requestJson({ method: 'POST', body: { reason: 'Kunde gespeichert', client: ipcRoutes['clients:upsert'].args.parse({ client: input }).client }, parser: clientSchema }, '/api/v1/pro/clients'),
    deleteClient: (id: string, reason = 'Kunde gelöscht') => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/clients/${encodeURIComponent(id)}`),
    listInvoices: () => requestJson({ parser: parseArray(invoiceSchema) }, '/api/v1/pro/invoices'),
    saveInvoice: (input: unknown, reason: string) => {
      const parsed = ipcRoutes['invoices:upsert'].args.parse({ reason, invoice: input });
      return requestJson({ method: 'POST', body: { reason, invoice: toServerInvoicePayload(parsed.invoice) }, parser: invoiceSchema }, '/api/v1/pro/invoices');
    },
    deleteInvoice: (id: string, reason: string) => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/invoices/${encodeURIComponent(id)}`),
    listOffers: () => requestJson({ parser: parseArray(offerSchema) }, '/api/v1/pro/offers'),
    saveOffer: (input: unknown, reason: string) => {
      const parsed = ipcRoutes['offers:upsert'].args.parse({ reason, offer: input });
      return requestJson({ method: 'POST', body: { reason, offer: toServerOfferPayload(parsed.offer) }, parser: offerSchema }, '/api/v1/pro/offers');
    },
    deleteOffer: (id: string, reason: string) => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/offers/${encodeURIComponent(id)}`),
    listRecurringProfiles: () => requestJson({ parser: parseArray(recurringProfileSchema) }, '/api/v1/pro/recurring'),
    saveRecurringProfile: (profile: unknown, reason = 'Wiederkehrendes Profil gespeichert') => {
      const parsed = ipcRoutes['recurring:upsert'].args.parse({ profile });
      return requestJson({ method: 'POST', body: { reason, profile: parsed.profile }, parser: recurringProfileSchema }, '/api/v1/pro/recurring');
    },
    deleteRecurringProfile: (id: string, reason = 'Wiederkehrendes Profil gelöscht') => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/recurring/${encodeURIComponent(id)}`),
    portalHealth: (baseUrl: string) => requestJson({ query: { baseUrl }, parser: ipcRoutes['portal:health'].result }, '/api/v1/pro/portal/health'),
    publishOfferToPortal: (input: unknown) => requestJson({
      method: 'POST', body: ipcRoutes['portal:publishOffer'].args.parse(input), parser: ipcRoutes['portal:publishOffer'].result,
    }, '/api/v1/pro/portal/publish-offer'),
    publishInvoiceToPortal: (input: unknown) => requestJson({
      method: 'POST', body: ipcRoutes['portal:publishInvoice'].args.parse(input), parser: ipcRoutes['portal:publishInvoice'].result,
    }, '/api/v1/pro/portal/publish-invoice'),
    syncOfferPortalStatus: (offerId: string) => requestJson({
      method: 'POST', body: ipcRoutes['portal:syncOfferStatus'].args.parse({ offerId }), parser: ipcRoutes['portal:syncOfferStatus'].result,
    }, '/api/v1/pro/portal/sync-offer-status'),
    createCustomerAccessLink: (input: unknown) => requestJson({
      method: 'POST', body: ipcRoutes['portal:createCustomerAccessLink'].args.parse(input), parser: ipcRoutes['portal:createCustomerAccessLink'].result,
    }, '/api/v1/pro/portal/customer-access-link'),
    rotateCustomerAccessLink: (input: unknown) => requestJson({
      method: 'POST', body: ipcRoutes['portal:rotateCustomerAccessLink'].args.parse(input), parser: ipcRoutes['portal:rotateCustomerAccessLink'].result,
    }, '/api/v1/pro/portal/customer-access-link/rotate'),
    sendEmail: (input: unknown) => requestJson({
      method: 'POST', body: ipcRoutes['email:send'].args.parse(input), parser: ipcRoutes['email:send'].result,
    }, '/api/v1/pro/email/send'),
    testEmailConfig: (input: unknown) => {
      const parsed = ipcRoutes['email:testConfig'].args.parse(input);
      const { smtpPassword: _smtpPassword, resendApiKey: _resendApiKey, ...serverConfig } = parsed;
      return requestJson({ method: 'POST', body: serverConfig, parser: ipcRoutes['email:testConfig'].result }, '/api/v1/pro/email/test-config');
    },
    runDunningManually: () => requestJson({ method: 'POST', parser: ipcRoutes['dunning:manualRun'].result }, '/api/v1/pro/dunning/manual-run'),
    getDunningInvoiceStatus: (invoiceId: string) => requestJson({
      parser: ipcRoutes['dunning:getInvoiceStatus'].result,
    }, `/api/v1/pro/dunning/invoices/${encodeURIComponent(invoiceId)}/status`),
    runRecurringManually: () => requestJson({ method: 'POST', parser: ipcRoutes['recurring:manualRun'].result }, '/api/v1/pro/recurring/manual-run'),
    getSettings,
    saveSettings: (settings: unknown) => requestJson({ method: 'PUT', body: setSettingsPayloadSchema.parse({ settings }), parser: (input) => input }, '/api/v1/pro/settings'),
    reserveNumber,
    releaseNumber,
    finalizeNumber: (reservationId: string, documentId: string) => requestJson({ method: 'POST', body: ipcRoutes['numbers:finalize'].args.parse({ reservationId, documentId }), parser: ipcRoutes['numbers:finalize'].result }, '/api/v1/pro/numbers/finalize'),
    createDocumentFromClient: async (input: unknown) => {
      const parsed = ipcRoutes['documents:createFromClient'].args.parse(input);
      const found = await requestJson({ parser: (value) => clientSchema.nullable().parse(value) }, `/api/v1/pro/clients/${encodeURIComponent(parsed.clientId)}`);
      if (!found) throw new Error('Kunde nicht gefunden.');
      return buildDraftFromClient(parsed.kind, found);
    },
    convertOfferToInvoice: async (input: unknown) => {
      const parsed = ipcRoutes['documents:convertOfferToInvoice'].args.parse(input);
      const offer = await requestJson({ parser: (value) => offerSchema.nullable().parse(value) }, `/api/v1/pro/offers/${encodeURIComponent(parsed.offerId)}`);
      if (!offer) throw new Error('Angebot nicht gefunden.');
      const settings = await getSettings();
      const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
      const reservation = await reserveNumber('invoice');
      try {
        const legacyOffer = toLegacyOffer(offer);
        const dueDate = new Date(today);
        dueDate.setDate(dueDate.getDate() + (settings?.legal.paymentTermsDays ?? 0));
        const created = toDomainInvoice(billingScope, {
          ...legacyOffer, id: crypto.randomUUID(), number: reservation.number, date: today,
          dueDate: dueDate.toISOString().split('T')[0] ?? today, status: 'draft',
          history: [{ date: today, action: `Erstellt aus Angebot ${offer.number}` }, ...(offer.history ?? [])],
        });
        const { tenantId: _tenantId, ...invoice } = created;
        const saved = await requestJson({ method: 'POST', body: { reason: `Converted from offer ${offer.number}`, invoice }, parser: invoiceSchema }, '/api/v1/pro/invoices');
        await client.finalizeNumber(reservation.reservationId, saved.id);
        return toLegacyInvoice(saved);
      } catch (error) {
        await releaseNumber(reservation.reservationId).catch(() => undefined);
        throw error;
      }
    },

    listArticles: () => requestJson({ parser: parseArray(articleSchema) }, '/api/v1/pro/articles'),
    saveArticle: (article: unknown) => requestJson({ method: 'POST', body: upsertArticlePayloadSchema.parse({ article }), parser: articleSchema }, '/api/v1/pro/articles'),
    deleteArticle: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/articles/${encodeURIComponent(id)}`),
    listAccounts: () => requestJson({ parser: parseArray(accountSchema) }, '/api/v1/pro/accounts'),
    saveAccount: (account: unknown) => requestJson({ method: 'POST', body: upsertAccountPayloadSchema.parse({ account }), parser: accountSchema }, '/api/v1/pro/accounts'),
    deleteAccount: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/accounts/${encodeURIComponent(id)}`),
    listTemplates: (kind?: 'invoice' | 'offer') => requestJson({ parser: parseArray(templateSchema), query: kind ? { kind } : undefined }, '/api/v1/pro/templates'),
    getActiveTemplate: (kind: 'invoice' | 'offer') => requestJson({ parser: (input) => input === null ? null : templateSchema.parse(input) }, `/api/v1/pro/templates/active/${templateKindSchema.parse(kind)}`),
    saveTemplate: (template: unknown) => requestJson({ method: 'POST', body: upsertTemplatePayloadSchema.parse({ template }), parser: templateSchema }, '/api/v1/pro/templates'),
    deleteTemplate: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/templates/${encodeURIComponent(id)}`),
    listLedgerAccounts: (query?: unknown) => requestJson({
      parser: parseArray(ledgerAccountSchema),
      query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/ledger/accounts'),
    listTaxCases: (query?: unknown) => requestJson({
      parser: parseArray(taxCaseDefinitionSchema),
      query: query === undefined ? undefined : proListTaxCasesArgsSchema.parse(query),
    }, '/api/v1/pro/accounting/tax-cases'),
    listTaxCaseMappings: (query?: unknown) => requestJson({
      parser: parseArray(taxCaseAccountMappingSchema),
      query: query === undefined ? undefined : proListTaxCaseAccountMappingsArgsSchema.parse(query),
    }, '/api/v1/pro/accounting/tax-case-account-mappings'),
    saveTaxCaseMapping: (mapping: unknown) => requestJson({
      method: 'POST', body: proUpsertTaxCaseAccountMappingArgsSchema.parse(mapping), parser: taxCaseAccountMappingSchema,
    }, '/api/v1/pro/accounting/tax-case-account-mappings'),
    listAccountSuggestionRules: (query?: unknown) => requestJson({
      parser: parseArray(accountSuggestionRuleSchema),
      query: query === undefined ? undefined : proListAccountSuggestionRulesArgsSchema.parse(query),
    }, '/api/v1/pro/accounting/account-suggestion-rules'),
    saveAccountSuggestionRule: (rule: unknown) => requestJson({
      method: 'POST', body: proUpsertAccountSuggestionRuleArgsSchema.parse(rule), parser: accountSuggestionRuleSchema,
    }, '/api/v1/pro/accounting/account-suggestion-rules'),
    deleteAccountSuggestionRule: (id: string, reason = 'Kontierungsvorschlagsregel gelöscht') => requestJson({
      method: 'DELETE', query: { reason }, parser: (input) => input,
    }, `/api/v1/pro/accounting/account-suggestion-rules/${encodeURIComponent(id)}`),
    listWorkflowEntries: () => requestJson({ parser: parseArray(proWorkflowEntrySchema) }, '/api/v1/pro/workflow'),
    upsertWorkflowEntry: (entry: unknown) => requestJson({
      method: 'POST', body: proWorkflowEntrySchema.omit({ updatedAt: true }).parse(entry), parser: (input) => input,
    }, '/api/v1/pro/workflow'),
    getAccountingPolicy: () => requestJson({ parser: accountingPolicySchema }, '/api/v1/pro/accounting/policy'),
    setAccountingPolicy: (input: unknown, reason = 'Kontierungspolitik geändert') => requestJson({
      method: 'PUT',
      body: { ...accountingPolicySchema.omit({ tenantId: true, periodPolicy: true, updatedAt: true }).parse(input), reason },
      parser: accountingPolicySchema,
    }, '/api/v1/pro/accounting/policy'),
    listAccountingMappings: (chart?: 'SKR03' | 'SKR04') => requestJson({
      parser: parseArray(accountingAccountMappingSchema), query: chart ? { chart } : undefined,
    }, '/api/v1/pro/accounting/mappings'),
    saveAccountingMapping: (mapping: unknown, reason: string) => requestJson({
      method: 'POST', body: { ...(isRecord(mapping) ? mapping : {}), reason }, parser: accountingAccountMappingSchema,
    }, '/api/v1/pro/accounting/mappings'),
    listAccountingVendors: () => requestJson({ parser: parseArray(vendorSchema) }, '/api/v1/pro/accounting/vendors'),
    saveAccountingVendor: (vendor: unknown, reason: string) => requestJson({
      method: 'POST',
      body: { vendor: vendorSchema.omit({ tenantId: true, createdAt: true, updatedAt: true }).parse(vendor), reason },
      parser: vendorSchema,
    }, '/api/v1/pro/accounting/vendors'),
    listIncomingInvoices: () => requestJson({ parser: parseArray(incomingInvoiceSchema) }, '/api/v1/pro/accounting/incoming-invoices'),
    saveIncomingInvoice: (invoice: unknown, reason: string) => requestJson({
      method: 'POST',
      body: { invoice: incomingInvoiceSchema.omit({ tenantId: true, createdAt: true, updatedAt: true, accountingStatus: true, accountingSnapshot: true }).parse(invoice), reason },
      parser: incomingInvoiceSchema,
    }, '/api/v1/pro/accounting/incoming-invoices'),
    listOpenItems: () => requestJson({ parser: parseArray(openItemSchema) }, '/api/v1/pro/accounting/open-items'),
    previewOutgoingInvoice: (invoiceId: string, options: Record<string, unknown> = {}) => requestJson({
      method: 'POST', body: { invoiceId, reason: 'Vorschau', ...options }, parser: accountingPostingPreviewSchema,
    }, '/api/v1/pro/accounting/outgoing-invoices/preview'),
    postOutgoingInvoice: (invoiceId: string, reservationId: string, options: Record<string, unknown> = {}) => {
      if (!reservationId.trim()) throw new Error('Reservierungs-ID fehlt.');
      return requestJson({
        method: 'POST', body: { invoiceId, reservationId, reason: 'Ausgangsrechnung gebucht', ...options }, parser: accountingPostingPreviewSchema,
      }, '/api/v1/pro/accounting/outgoing-invoices/post');
    },
    previewIncomingInvoice: (invoiceId: string, options: Record<string, unknown> = {}) => requestJson({
      method: 'POST', body: { invoiceId, reason: 'Vorschau', ...options }, parser: accountingPostingPreviewSchema,
    }, '/api/v1/pro/accounting/incoming-invoices/preview'),
    postIncomingInvoice: (invoiceId: string, reason: string, options: Record<string, unknown> = {}) => requestJson({
      method: 'POST', body: { invoiceId, reason, ...options }, parser: accountingPostingPreviewSchema,
    }, '/api/v1/pro/accounting/incoming-invoices/post'),
    allocateOpenItemPayment: (payment: ProOpenItemPaymentInput, reason: string) => {
      if (!payment.allocationEventId.trim()) throw new Error('Zuordnungs-ID fehlt.');
      return requestJson({ method: 'POST', body: { payment, reason }, parser: (input) => input }, '/api/v1/pro/accounting/open-items/payments');
    },
    allocateRemainingOpenItemPayment: (paymentId: string, allocations: unknown, reason: string, allocationEventId: string) => {
      if (!allocationEventId.trim()) throw new Error('Zuordnungs-ID fehlt.');
      return requestJson({ method: 'POST', body: { paymentId, allocations, reason, allocationEventId }, parser: (input) => input }, `/api/v1/pro/accounting/open-items/payments/${encodeURIComponent(paymentId)}/remaining`);
    },
    reverseDocumentAccounting: (input: unknown, reason: string) => requestJson({
      method: 'POST', body: { ...(isRecord(input) ? input : {}), reason }, parser: (payload) => payload,
    }, '/api/v1/pro/accounting/documents/reverse'),
    previewAccountingBackfill: () => requestJson({ parser: accountingBackfillPreviewSchema }, '/api/v1/pro/accounting/backfill/preview'),
    confirmAccountingBackfill: (input: unknown) => requestJson({ method: 'POST', body: input, parser: accountingBackfillResultSchema }, '/api/v1/pro/accounting/backfill/confirm'),
    importSkr: async (input: unknown = {}) => {
      ipcRoutes['pro:importSkr'].args.parse(input);
      const stats = await requestJson({ parser: ipcRoutes['pro:getLedgerStats'].result }, '/api/v1/pro/accounting/ledger/stats');
      return ipcRoutes['pro:importSkr'].result.parse({
        source: 'none', sourceDetails: ['server://pglite-migrations'], inserted: 0, updated: 0,
        total: stats.total, skipped: 0,
        warnings: ['Der Kontenrahmen wird im Embedded-/PGlite-Modus durch Migrationen verwaltet; es wurde kein Import ausgeführt.'], stats,
      });
    },
    validateTaxCompliance: (input: unknown, reason = 'Steuerliche Compliance geprüft') => {
      const parsed = ipcRoutes['pro:validateTaxCompliance'].args.parse(input);
      return requestJson({
        method: 'POST', body: { ...parsed, reason }, parser: ipcRoutes['pro:validateTaxCompliance'].result,
      }, '/api/v1/pro/accounting/validate');
    },
    getAccountingHealth: () => requestJson({ parser: (input) => input }, '/api/v1/pro/accounting/health'),
    getVatSummary: (query?: unknown) => requestJson({
      parser: (input) => input,
      query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/vat/summary'),
    getLedgerStats: () => requestJson({ parser: (input) => input }, '/api/v1/pro/accounting/ledger/stats'),
    listAccountingJournalEntries: (query?: unknown) => requestJson({
      parser: parseArray(journalEntryEntitySchema),
      query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/journal'),
    getAccountingJournalEntryById: (id: string) => requestJson({
      parser: (input) => input === null ? null : journalEntryEntitySchema.parse(input),
    }, `/api/v1/pro/accounting/journal/${encodeURIComponent(id)}`),
    getAccountingBalances: (query?: unknown) => requestJson({
      parser: parseArray(ledgerBalanceRowSchema),
      query: typeof query === 'string' ? { asOfDate: query } : query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/balances'),
    listAccountingSourceRuns: () => requestJson({ parser: parseArray(sourceRunParser) }, '/api/v1/pro/accounting/source-runs'),
    getAccountingSourceRun: (id: string) => requestJson({
      parser: (input) => input === null ? null : sourceRunParser(input),
    }, `/api/v1/pro/accounting/source-runs/${encodeURIComponent(id)}`),
    postAccountingSource: (input: IpcArgs<'pro:postAccountingSource'>) => requestJson({
      method: 'POST',
      body: { input: input.source, sourceId: input.source.sourceId, sourceRevision: input.source.sourceRevision, idempotencyKey: `source:${input.source.sourceId}`, reason: input.reason, chart: input.chart, provenance: input.provenance },
      parser: (payload) => parseSourcePostResult(payload, input.source),
    }, '/api/v1/pro/accounting/closing'),
    postAccountingCommand: (input: IpcArgs<'pro:postAccountingCommand'>) => postAccountingCommand(input),
    listAssets: () => requestJson({ parser: parseArray(assetSchema) }, '/api/v1/pro/accounting/assets'),
    upsertAsset: (asset: unknown, reason: string) => requestJson({
      method: 'POST', body: { asset: assetUpsertSchema.parse(asset), reason }, parser: assetSchema,
    }, '/api/v1/pro/accounting/assets'),
    getDepreciationSchedule: (assetId: string) => requestJson({
      parser: parseArray(assetDepreciationScheduleEntrySchema),
    }, `/api/v1/pro/accounting/assets/${encodeURIComponent(assetId)}/schedule`),
    runDepreciation: (input: unknown) => requestJson({
      method: 'POST', body: input, parser: (payload) => payload,
    }, `/api/v1/pro/accounting/assets/${encodeURIComponent((input as { assetId: string }).assetId)}/depreciation`),
    disposeAsset: (input: unknown) => requestJson({
      method: 'POST', body: input, parser: (payload) => payload,
    }, `/api/v1/pro/accounting/assets/${encodeURIComponent((input as { assetId: string }).assetId)}/dispose`),
    listDatevExports: (limit?: number) => requestJson({
      parser: parseArray(datevExportResultSchema),
    }, '/api/v1/pro/accounting/datev/exports').then((rows) => limit ? rows.slice(0, limit) : rows),
    exportDatev: async (query: Record<string, QueryValue>) => {
      const { headers } = await requestBlobWithHeaders('/api/v1/pro/accounting/datev/export.csv', query);
      const id = headers.get('x-billme-datev-export-id');
      if (!id) throw new Error('DATEV-Export ohne Serverbeleg-ID.');
      const receipt = (await client.listDatevExports()).find((item) => item.id === id);
      if (!receipt) throw new Error('DATEV-Export wurde nicht in der Serverhistorie gefunden.');
      return receipt;
    },
    getSusaReport: (query?: unknown) => requestJson({
      parser: (input) => input, query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/reports/susa'),
    getGuvReport: (query?: unknown) => requestJson({
      parser: (input) => input, query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/reports/guv'),
    getBilanzReport: (query?: unknown) => requestJson({
      parser: (input) => input, query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/reports/bilanz'),
    getReportingReport: (query: { kind: 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz'; from?: string; to?: string; asOfDate?: string }) => {
      const paths = {
        bwa01: '/api/v1/pro/accounting/reports/bwa01',
        'management-guv': '/api/v1/pro/accounting/reports/management-guv',
        'hgb-guv': '/api/v1/pro/accounting/reports/hgb-guv',
        'hgb-bilanz': '/api/v1/pro/accounting/reports/hgb-bilanz',
      } as const;
      return requestJson({ parser: (input) => input, query }, paths[query.kind]);
    },
    listReportSnapshots: (reportType?: string) => requestJson({
      parser: parseArray(reportSnapshotParser), query: reportType ? { reportType } : undefined,
    }, '/api/v1/pro/accounting/reports/snapshots'),
    saveReportSnapshot: (input: unknown) => requestJson({
      method: 'POST', body: input, parser: reportSnapshotParser,
    }, '/api/v1/pro/accounting/reports/snapshots'),
    getReportMappingHealth: (query?: unknown) => requestJson({
      parser: (input) => input, query: query && isRecord(query) ? query as Record<string, QueryValue> : undefined,
    }, '/api/v1/pro/accounting/mappings/health'),
    listReportMappingPositions: (query: unknown) => requestJson({
      parser: (input) => input, query: query as Record<string, QueryValue>,
    }, '/api/v1/pro/accounting/mappings/positions'),
    saveReportMappingOverride: (input: unknown) => requestJson({
      method: 'PUT', body: input, parser: (payload) => payload,
    }, '/api/v1/pro/accounting/mappings/overrides'),
    getEurReport: (query: IpcArgs<'eur:getReport'>) => requestJson({
      parser: eurReportServerParser, query: query as Record<string, QueryValue>,
    }, '/api/v1/pro/accounting/reports/eur'),
    exportEurCsv: (query: IpcArgs<'eur:exportCsv'>) => requestText('/api/v1/pro/accounting/reports/eur/export.csv', query as Record<string, QueryValue>),
    verifyAudit: () => requestJson({ parser: ipcRoutes['audit:verify'].result }, '/api/v1/pro/audit/verify'),
    exportAuditCsv: () => requestText('/api/v1/pro/audit/export.csv'),
    listEurRules: (taxYear: number) => requestJson({
      parser: parseArray(eurRuleSchema), query: { taxYear },
    }, '/api/v1/pro/accounting/reports/eur/rules'),
    saveEurRule: (input: IpcArgs<'eur:upsertRule'>) => requestJson({
      method: 'POST', body: { ...input, reason: 'EÜR-Regel gespeichert' }, parser: eurRuleSchema,
    }, '/api/v1/pro/accounting/reports/eur/rules'),
    deleteEurRule: (id: string) => requestJson({
      method: 'DELETE', body: { reason: 'EÜR-Regel gelöscht' }, parser: z.object({ ok: z.literal(true) }),
    }, `/api/v1/pro/accounting/reports/eur/rules/${encodeURIComponent(id)}`),
    listEurCashItems: (query: IpcArgs<'eur:listItems'>) => requestJson({
      parser: (input) => input, query: query as Record<string, QueryValue>,
    }, '/api/v1/pro/accounting/reports/eur/items'),
    upsertEurClassification: (input: IpcArgs<'eur:upsertClassification'>) => requestJson({
      method: 'PUT', body: input, parser: eurClassificationSchema,
    }, '/api/v1/pro/accounting/reports/eur/classifications'),
    saveEurCashFact: (input: IpcArgs<'eur:saveCashFact'>) => requestJson({
      method: 'POST', body: input, parser: eurCashFactSchema,
    }, '/api/v1/pro/accounting/reports/eur/facts/cash'),
    listEurCashFacts: (taxYear: number) => requestJson({
      parser: parseArray(eurCashFactSchema), query: { taxYear },
    }, '/api/v1/pro/accounting/reports/eur/facts/cash'),
    saveEurAnnexFact: (input: IpcArgs<'eur:saveAnnexFact'>) => requestJson({
      method: 'POST', body: input, parser: eurAnnexFactSchema,
    }, '/api/v1/pro/accounting/reports/eur/facts/annex'),
    listEurAnnexFacts: (taxYear: number, annex?: string) => requestJson({
      parser: parseArray(eurAnnexFactSchema), query: { taxYear, annex },
    }, '/api/v1/pro/accounting/reports/eur/facts/annex'),
    listProjects: (options?: IpcArgs<'projects:list'>) => requestJson({
      parser: parseArray(projectSchema), query: options,
    }, '/api/v1/pro/projects'),
    getProject: (id: string) => requestJson({
      parser: (input) => input === null ? null : projectSchema.parse(input),
    }, `/api/v1/pro/projects/${encodeURIComponent(id)}`),
    saveProject: (project: unknown, reason: string) => requestJson({
      method: 'POST', body: { reason, project: projectSchema.parse(project) }, parser: projectSchema,
    }, '/api/v1/pro/projects'),
    archiveProject: (id: string, reason: string) => requestJson({
      method: 'POST', body: { reason }, parser: projectSchema,
    }, `/api/v1/pro/projects/${encodeURIComponent(id)}/archive`),
    listTransactions: (filters?: IpcArgs<'transactions:list'>) => requestJson({
      parser: parseArray(transactionSchema), query: filters,
    }, '/api/v1/pro/transactions'),
    findTransactionMatches: (transactionId: string) => requestJson({
      parser: (input) => {
        const result = serverTransactionMatchesSchema.parse(input);
        return { transaction: result.transaction, suggestions: result.suggestions.map((suggestion) => ({ ...suggestion, invoice: toLegacyInvoice(suggestion.invoice) })) };
      },
    }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/matches`),
    linkTransaction: (transactionId: string, invoiceId: string, reason = 'Zahlung automatisch mit Rechnung verknüpft') => requestJson({
      method: 'POST', body: { invoiceId, reason }, parser: (input) => {
        const result = z.object({ success: z.literal(true), invoice: invoiceSchema.optional() }).parse(input);
        return { success: result.success, ...(result.invoice ? { invoice: toLegacyInvoice(result.invoice) } : {}) };
      },
    }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/link`),
    unlinkTransaction: (transactionId: string, reason = 'Zahlungsverknüpfung aufgehoben') => requestJson({
      method: 'POST', body: { reason }, parser: z.object({ success: z.boolean() }),
    }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/unlink`),
    listAccountingTransactions: () => requestJson({ parser: parseArray(transactionSchema) }, '/api/v1/pro/accounting/transactions'),
    getAccountingDraftByTransactionId: (transactionId: string) => requestJson({
      parser: (input) => input === null ? null : bookingDraftEntitySchema.parse(input),
    }, `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`),
    saveAccountingDraft: (draft: unknown, reason: string) => requestJson({
      method: 'POST', body: { reason, draft: bookingDraftEntitySchema.parse(draft) }, parser: bookingDraftEntitySchema,
    }, '/api/v1/pro/accounting/drafts'),
    dispatchAccountingDraftAction: (transactionId: string, action: string, reason: string, rejectReason?: string) => requestJson({
      method: 'POST', body: { reason, action, rejectReason }, parser: bookingDraftEntitySchema,
    }, `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}/action`),
    postAccountingDraft: (draftId: string, options: Record<string, unknown> & { reason: string }) => requestJson({
      method: 'POST', body: options, parser: (input) => input,
    }, `/api/v1/pro/accounting/drafts/${encodeURIComponent(draftId)}/post`),
    reverseAccountingJournalEntry: (entryId: string, options: Record<string, unknown> & { reason: string }) => requestJson({
      method: 'POST', body: options, parser: (input) => input,
    }, `/api/v1/pro/accounting/journal/${encodeURIComponent(entryId)}/reverse`),
    financeImportPreview: (input: unknown) => {
      const parsed = ipcRoutes['finance:importPreview'].args.parse(input);
      return requestJson({ method: 'POST', body: parsed, parser: ipcRoutes['finance:importPreview'].result }, '/api/v1/pro/finance/import/preview');
    },
    financeImportCommit: (input: unknown) => {
      const parsed = ipcRoutes['finance:importCommit'].args.parse(input);
      return requestJson({ method: 'POST', body: parsed, parser: ipcRoutes['finance:importCommit'].result }, '/api/v1/pro/finance/import/commit');
    },
    financeListImportBatches: (input: unknown) => {
      const parsed = ipcRoutes['finance:listImportBatches'].args.parse(input);
      return requestJson({ query: parsed, parser: ipcRoutes['finance:listImportBatches'].result }, '/api/v1/pro/finance/import-batches');
    },
    financeGetImportBatchDetails: (input: unknown) => {
      const parsed = ipcRoutes['finance:getImportBatchDetails'].args.parse(input);
      return requestJson({ parser: ipcRoutes['finance:getImportBatchDetails'].result }, `/api/v1/pro/finance/import-batches/${encodeURIComponent(parsed.batchId)}`);
    },
    financeRollbackImportBatch: (input: unknown) => {
      const parsed = ipcRoutes['finance:rollbackImportBatch'].args.parse(input);
      return requestJson({ method: 'POST', body: { reason: parsed.reason }, parser: ipcRoutes['finance:rollbackImportBatch'].result }, `/api/v1/pro/finance/import-batches/${encodeURIComponent(parsed.batchId)}/rollback`);
    },
    setActiveTemplate: (input: unknown) => requestJson({ method: 'PUT', body: setActiveTemplatePayloadSchema.parse(input), parser: (input) => input }, '/api/v1/pro/templates/active'),
  };
  return client;
};

export type ProWebClient = ReturnType<typeof createProWebClient>;
export type ProHttpApiOptions = ProWebClientConfig & { fallback?: IpcInvoke; onInvoke?: (invoke: IpcInvoke) => void };
export type ProHttpBillmeApi = BillmeApi;

export const createProHttpBillmeApi = ({ fallback, onInvoke, ...clientConfig }: ProHttpApiOptions): ProHttpBillmeApi => {
  const client = createProWebClient(clientConfig);
  const embeddedConnectionResolver = clientConfig.embeddedConnectionResolver;
  const invoke: IpcInvoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    if (!Object.prototype.hasOwnProperty.call(ipcRoutes, key)) throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    if (embeddedConnectionResolver && isServerOwnedRoute(key)) {
      const connection = await embeddedConnectionResolver();
      if (!connection) {
        if (fallback) return fallback(key, args);
        throw new ProEmbeddedConnectionUnavailableError();
      }
    }
    switch (key) {
      case 'taxFiling:getStatus': return ipcRoutes[key].result.parse(await client.getTaxFilingStatus()) as IpcResult<K>;
      case 'taxFiling:listRecords': return ipcRoutes[key].result.parse(await client.listTaxFilingRecords()) as IpcResult<K>;
      case 'taxFiling:installCertificate': {
        const parsed = ipcRoutes['taxFiling:installCertificate'].args.parse(args) as IpcArgs<'taxFiling:installCertificate'>;
        return ipcRoutes[key].result.parse(await client.installTaxFilingCertificate(parsed)) as IpcResult<K>;
      }
      case 'taxFiling:removeCertificate': {
        const parsed = ipcRoutes['taxFiling:removeCertificate'].args.parse(args) as IpcArgs<'taxFiling:removeCertificate'>;
        return ipcRoutes[key].result.parse(await client.removeTaxFilingCertificate(parsed.id)) as IpcResult<K>;
      }
      case 'taxFiling:validate': return ipcRoutes[key].result.parse(await client.validateTaxFiling(ipcRoutes['taxFiling:validate'].args.parse(args) as IpcArgs<'taxFiling:validate'>)) as IpcResult<K>;
      case 'taxFiling:export': return ipcRoutes[key].result.parse(await client.exportTaxFiling(ipcRoutes['taxFiling:export'].args.parse(args) as IpcArgs<'taxFiling:export'>)) as IpcResult<K>;
      case 'taxFiling:submit': return ipcRoutes[key].result.parse(await client.submitTaxFiling(ipcRoutes['taxFiling:submit'].args.parse(args) as IpcArgs<'taxFiling:submit'>)) as IpcResult<K>;
      case 'invoices:list': return ipcRoutes[key].result.parse((await client.listInvoices()).map(toLegacyInvoice)) as IpcResult<K>;
      case 'invoices:upsert': {
        const parsed = ipcRoutes['invoices:upsert'].args.parse(args) as IpcArgs<'invoices:upsert'>;
        return ipcRoutes[key].result.parse(toLegacyInvoice(await client.saveInvoice(parsed.invoice, parsed.reason))) as IpcResult<K>;
      }
      case 'invoices:delete': {
        const parsed = ipcRoutes['invoices:delete'].args.parse(args) as IpcArgs<'invoices:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteInvoice(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'offers:list': return ipcRoutes[key].result.parse((await client.listOffers()).map(toLegacyOffer)) as IpcResult<K>;
      case 'offers:upsert': {
        const parsed = ipcRoutes['offers:upsert'].args.parse(args) as IpcArgs<'offers:upsert'>;
        return ipcRoutes[key].result.parse(toLegacyOffer(await client.saveOffer(parsed.offer, parsed.reason))) as IpcResult<K>;
      }
      case 'offers:delete': {
        const parsed = ipcRoutes['offers:delete'].args.parse(args) as IpcArgs<'offers:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteOffer(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'clients:list': return ipcRoutes[key].result.parse(await client.listClients()) as IpcResult<K>;
      case 'clients:upsert': {
        const parsed = ipcRoutes['clients:upsert'].args.parse(args) as IpcArgs<'clients:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveClient(parsed.client)) as IpcResult<K>;
      }
      case 'clients:delete': {
        const parsed = ipcRoutes['clients:delete'].args.parse(args) as IpcArgs<'clients:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteClient(parsed.id)) as IpcResult<K>;
      }
      case 'recurring:list': return ipcRoutes[key].result.parse(await client.listRecurringProfiles()) as IpcResult<K>;
      case 'recurring:upsert': {
        const parsed = ipcRoutes['recurring:upsert'].args.parse(args) as IpcArgs<'recurring:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveRecurringProfile(parsed.profile)) as IpcResult<K>;
      }
      case 'recurring:delete': {
        const parsed = ipcRoutes['recurring:delete'].args.parse(args) as IpcArgs<'recurring:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteRecurringProfile(parsed.id)) as IpcResult<K>;
      }
      case 'settings:get': return ipcRoutes[key].result.parse(await client.getSettings()) as IpcResult<K>;
      case 'settings:set': {
        const parsed = ipcRoutes['settings:set'].args.parse(args) as IpcArgs<'settings:set'>;
        return ipcRoutes[key].result.parse(await client.saveSettings(parsed.settings)) as IpcResult<K>;
      }
      case 'numbers:reserve': {
        const parsed = ipcRoutes['numbers:reserve'].args.parse(args) as IpcArgs<'numbers:reserve'>;
        return ipcRoutes[key].result.parse(await client.reserveNumber(parsed.kind)) as IpcResult<K>;
      }
      case 'numbers:release': {
        const parsed = ipcRoutes['numbers:release'].args.parse(args) as IpcArgs<'numbers:release'>;
        return ipcRoutes[key].result.parse(await client.releaseNumber(parsed.reservationId)) as IpcResult<K>;
      }
      case 'numbers:finalize': {
        const parsed = ipcRoutes['numbers:finalize'].args.parse(args) as IpcArgs<'numbers:finalize'>;
        return ipcRoutes[key].result.parse(await client.finalizeNumber(parsed.reservationId, parsed.documentId)) as IpcResult<K>;
      }
      case 'documents:createFromClient': return ipcRoutes[key].result.parse(await client.createDocumentFromClient(args)) as IpcResult<K>;
      case 'documents:convertOfferToInvoice': return ipcRoutes[key].result.parse(await client.convertOfferToInvoice(args)) as IpcResult<K>;
      case 'articles:list': return ipcRoutes[key].result.parse(await client.listArticles()) as IpcResult<K>;
      case 'articles:upsert': {
        const parsed = ipcRoutes['articles:upsert'].args.parse(args) as IpcArgs<'articles:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveArticle(parsed.article)) as IpcResult<K>;
      }
      case 'articles:delete': {
        const parsed = ipcRoutes['articles:delete'].args.parse(args) as IpcArgs<'articles:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteArticle(parsed.id)) as IpcResult<K>;
      }
      case 'accounts:list': return ipcRoutes[key].result.parse(await client.listAccounts()) as IpcResult<K>;
      case 'accounts:upsert': {
        const parsed = ipcRoutes['accounts:upsert'].args.parse(args) as IpcArgs<'accounts:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveAccount(parsed.account)) as IpcResult<K>;
      }
      case 'accounts:delete': {
        const parsed = ipcRoutes['accounts:delete'].args.parse(args) as IpcArgs<'accounts:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteAccount(parsed.id)) as IpcResult<K>;
      }
      case 'templates:list': {
        const parsed = ipcRoutes['templates:list'].args.parse(args) as IpcArgs<'templates:list'>;
        return ipcRoutes[key].result.parse(await client.listTemplates(parsed.kind)) as IpcResult<K>;
      }
      case 'templates:active': {
        const parsed = ipcRoutes['templates:active'].args.parse(args) as IpcArgs<'templates:active'>;
        return ipcRoutes[key].result.parse(await client.getActiveTemplate(parsed.kind)) as IpcResult<K>;
      }
      case 'templates:upsert': {
        const parsed = ipcRoutes['templates:upsert'].args.parse(args) as IpcArgs<'templates:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveTemplate(parsed.template)) as IpcResult<K>;
      }
      case 'templates:delete': {
        const parsed = ipcRoutes['templates:delete'].args.parse(args) as IpcArgs<'templates:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteTemplate(parsed.id)) as IpcResult<K>;
      }
      case 'templates:setActive': return ipcRoutes[key].result.parse(await client.setActiveTemplate(args)) as IpcResult<K>;
      case 'pro:listLedgerAccounts': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listLedgerAccounts'>;
        return ipcRoutes[key].result.parse(await client.listLedgerAccounts(parsed)) as IpcResult<K>;
      }
      case 'pro:listTaxCases': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listTaxCases'>;
        return ipcRoutes[key].result.parse(await client.listTaxCases(parsed)) as IpcResult<K>;
      }
      case 'pro:listTaxCaseAccountMappings': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listTaxCaseAccountMappings'>;
        return ipcRoutes[key].result.parse(await client.listTaxCaseMappings(parsed)) as IpcResult<K>;
      }
      case 'pro:upsertTaxCaseAccountMapping': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertTaxCaseAccountMapping'>;
        return ipcRoutes[key].result.parse(await client.saveTaxCaseMapping(parsed)) as IpcResult<K>;
      }
      case 'pro:listAccountSuggestionRules': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listAccountSuggestionRules'>;
        return ipcRoutes[key].result.parse(await client.listAccountSuggestionRules(parsed)) as IpcResult<K>;
      }
      case 'pro:upsertAccountSuggestionRule': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAccountSuggestionRule'>;
        return ipcRoutes[key].result.parse(await client.saveAccountSuggestionRule(parsed)) as IpcResult<K>;
      }
      case 'pro:deleteAccountSuggestionRule': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:deleteAccountSuggestionRule'>;
        return ipcRoutes[key].result.parse(await client.deleteAccountSuggestionRule(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'pro:listWorkflowEntries': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listWorkflowEntries()) as IpcResult<K>;
      }
      case 'pro:upsertWorkflowEntry': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertWorkflowEntry'>;
        return ipcRoutes[key].result.parse(await client.upsertWorkflowEntry(parsed)) as IpcResult<K>;
      }
      case 'pro:getAccountingPolicy': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.getAccountingPolicy()) as IpcResult<K>;
      }
      case 'pro:setAccountingPolicy': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:setAccountingPolicy'>;
        return ipcRoutes[key].result.parse(await client.setAccountingPolicy(parsed)) as IpcResult<K>;
      }
      case 'pro:listAccountingAccountMappings': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listAccountingAccountMappings'>;
        return ipcRoutes[key].result.parse(await client.listAccountingMappings(parsed.chart)) as IpcResult<K>;
      }
      case 'pro:upsertAccountingAccountMapping': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAccountingAccountMapping'>;
        return ipcRoutes[key].result.parse(await client.saveAccountingMapping(parsed, 'Kontenzuordnung gespeichert')) as IpcResult<K>;
      }
      case 'pro:listVendors': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listAccountingVendors()) as IpcResult<K>;
      }
      case 'pro:upsertVendor': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertVendor'>;
        return ipcRoutes[key].result.parse(await client.saveAccountingVendor(parsed.vendor, parsed.reason)) as IpcResult<K>;
      }
      case 'pro:listIncomingInvoices': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listIncomingInvoices()) as IpcResult<K>;
      }
      case 'pro:upsertIncomingInvoice': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertIncomingInvoice'>;
        return ipcRoutes[key].result.parse(await client.saveIncomingInvoice(parsed.invoice, parsed.reason)) as IpcResult<K>;
      }
      case 'pro:previewOutgoingInvoiceAccounting': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:previewOutgoingInvoiceAccounting'>;
        const { invoiceId, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.previewOutgoingInvoice(invoiceId, options)) as IpcResult<K>;
      }
      case 'pro:postOutgoingInvoiceAccounting': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postOutgoingInvoiceAccounting'>;
        const { invoiceId, reservationId, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.postOutgoingInvoice(invoiceId, reservationId, options)) as IpcResult<K>;
      }
      case 'pro:previewIncomingInvoiceAccounting': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:previewIncomingInvoiceAccounting'>;
        const { invoiceId, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.previewIncomingInvoice(invoiceId, options)) as IpcResult<K>;
      }
      case 'pro:postIncomingInvoiceAccounting': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postIncomingInvoiceAccounting'>;
        const { invoiceId, reason, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.postIncomingInvoice(invoiceId, reason, options)) as IpcResult<K>;
      }
      case 'pro:listOpenItems': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listOpenItems()) as IpcResult<K>;
      }
      case 'pro:getAccountingHealth': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.getAccountingHealth()) as IpcResult<K>;
      }
      case 'pro:getVatSummary': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getVatSummary'>;
        return ipcRoutes[key].result.parse(await client.getVatSummary(parsed)) as IpcResult<K>;
      }
      case 'pro:getLedgerStats': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.getLedgerStats()) as IpcResult<K>;
      }
      case 'pro:listJournalEntries': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listJournalEntries'>;
        return ipcRoutes[key].result.parse(await client.listAccountingJournalEntries(parsed)) as IpcResult<K>;
      }
      case 'pro:getJournalEntryById': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getJournalEntryById'>;
        return ipcRoutes[key].result.parse(await client.getAccountingJournalEntryById(parsed.entryId)) as IpcResult<K>;
      }
      case 'pro:getLedgerBalances': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getLedgerBalances'>;
        return ipcRoutes[key].result.parse(await client.getAccountingBalances(parsed)) as IpcResult<K>;
      }
      case 'pro:listAccountingSourceRuns': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listAccountingSourceRuns()) as IpcResult<K>;
      }
      case 'pro:getAccountingSourceRun': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getAccountingSourceRun'>;
        return ipcRoutes[key].result.parse(await client.getAccountingSourceRun(parsed.id)) as IpcResult<K>;
      }
      case 'pro:postAccountingSource': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postAccountingSource'>;
        return ipcRoutes[key].result.parse(await client.postAccountingSource(parsed)) as IpcResult<K>;
      }
      case 'pro:getSusaReport': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getSusaReport'>;
        return ipcRoutes[key].result.parse(await client.getSusaReport(parsed)) as IpcResult<K>;
      }
      case 'pro:getGuvReport': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getGuvReport'>;
        const report = await client.getGuvReport(parsed);
        const value = isRecord(report) && Array.isArray(report.rows) ? (() => {
          const health = isRecord(report.mappingHealth) ? report.mappingHealth : {};
          const unmapped = Array.isArray(health.unmappedAccounts)
            ? health.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 }))
            : undefined;
          return {
            from: report.from, to: report.to, chart: report.chart, netResult: report.netResult,
            rows: report.rows.map((row) => isRecord(row) ? {
              positionKey: row.positionKey ?? row.position,
              positionLabel: row.positionLabel ?? row.label,
              amount: row.amount,
              accountRefs: row.accountRefs ?? row.accountNumbers,
            } : row),
            unmappedAccounts: unmapped, blocking: health.blocking,
          };
        })() : report;
        return ipcRoutes[key].result.parse(value) as IpcResult<K>;
      }
      case 'pro:getBilanzReport': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getBilanzReport'>;
        const report = await client.getBilanzReport(parsed);
        const value = isRecord(report) && Array.isArray(report.assets) && Array.isArray(report.liabilities) ? {
          ...report,
          assets: report.assets.flatMap((row) => isRecord(row) && Array.isArray(row.accountNumbers) ? row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount })) : [row]),
          liabilities: report.liabilities.flatMap((row) => isRecord(row) && Array.isArray(row.accountNumbers) ? row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount })) : [row]),
          unmappedAccounts: isRecord(report.mappingHealth) && Array.isArray(report.mappingHealth.unmappedAccounts)
            ? report.mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })) : undefined,
          blocking: isRecord(report.mappingHealth) ? report.mappingHealth.blocking : undefined,
        } : report;
        return ipcRoutes[key].result.parse(value) as IpcResult<K>;
      }
      case 'pro:getReportingReport': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getReportingReport'>;
        return ipcRoutes[key].result.parse(await client.getReportingReport(parsed)) as IpcResult<K>;
      }
      case 'pro:listReportSnapshots': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listReportSnapshots'>;
        return ipcRoutes[key].result.parse(await client.listReportSnapshots(parsed.reportType)) as IpcResult<K>;
      }
      case 'pro:saveReportSnapshot': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:saveReportSnapshot'>;
        const snapshotArgs = isRecord(parsed.args) ? parsed.args : {};
        return ipcRoutes[key].result.parse(await client.saveReportSnapshot({ ...snapshotArgs, reportType: parsed.reportType, reason: parsed.reason })) as IpcResult<K>;
      }
      case 'pro:getReportMappingHealth': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getReportMappingHealth'>;
        return ipcRoutes[key].result.parse(await client.getReportMappingHealth({ chart: parsed.chart, reportType: parsed.statement, asOfDate: parsed.asOfDate })) as IpcResult<K>;
      }
      case 'pro:listReportMappingPositions': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listReportMappingPositions'>;
        return ipcRoutes[key].result.parse(await client.listReportMappingPositions({ reportType: parsed.statement, asOfDate: parsed.asOfDate })) as IpcResult<K>;
      }
      case 'pro:upsertReportMappingOverride': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertReportMappingOverride'>;
        return ipcRoutes[key].result.parse(await client.saveReportMappingOverride({
          chart: parsed.chart, asOfDate: parsed.asOfDate, accountNumber: parsed.accountNumber,
          statementType: parsed.statement, positionKey: parsed.position, positionLabel: parsed.label,
          balanceSide: parsed.side, reason: parsed.reason,
        })) as IpcResult<K>;
      }
      case 'pro:listAssets': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listAssets()) as IpcResult<K>;
      }
      case 'pro:upsertAsset': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAsset'>;
        return ipcRoutes[key].result.parse(await client.upsertAsset(parsed.asset, parsed.reason)) as IpcResult<K>;
      }
      case 'pro:getDepreciationSchedule': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getDepreciationSchedule'>;
        return ipcRoutes[key].result.parse(await client.getDepreciationSchedule(parsed.assetId)) as IpcResult<K>;
      }
      case 'pro:runDepreciation': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:runDepreciation'>;
        return ipcRoutes[key].result.parse(await client.runDepreciation(parsed)) as IpcResult<K>;
      }
      case 'pro:disposeAsset': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:disposeAsset'>;
        return ipcRoutes[key].result.parse(await client.disposeAsset(parsed)) as IpcResult<K>;
      }
      case 'pro:exportDatevBuchungsstapel': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:exportDatevBuchungsstapel'>;
        if (!parsed.from || !parsed.to || parsed.consultantNumber === undefined || parsed.clientNumber === undefined || !parsed.fiscalYearStart || parsed.accountLength === undefined) {
          throw new Error('DATEV Export benötigt Beraternummer, Mandantennummer, Wirtschaftsjahresbeginn, Kontenlänge und einen Zeitraum.');
        }
        return ipcRoutes[key].result.parse(await client.exportDatev({
          ...parsed, consultantNumber: String(parsed.consultantNumber), clientNumber: String(parsed.clientNumber),
          encoding: parsed.encoding ?? 'cp1252', reason: 'DATEV-Buchungsstapel exportiert',
        })) as IpcResult<K>;
      }
      case 'pro:listDatevExports': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listDatevExports'>;
        return ipcRoutes[key].result.parse(await client.listDatevExports(parsed.limit)) as IpcResult<K>;
      }
      case 'eur:getReport': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:getReport'>;
        return ipcRoutes[key].result.parse(await client.getEurReport(parsed)) as IpcResult<K>;
      }
      case 'eur:exportCsv': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:exportCsv'>;
        return ipcRoutes[key].result.parse(await client.exportEurCsv(parsed)) as IpcResult<K>;
      }
      case 'eur:listRules': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listRules'>;
        return ipcRoutes[key].result.parse(await client.listEurRules(parsed.taxYear)) as IpcResult<K>;
      }
      case 'eur:upsertRule': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:upsertRule'>;
        return ipcRoutes[key].result.parse(await client.saveEurRule(parsed)) as IpcResult<K>;
      }
      case 'eur:deleteRule': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:deleteRule'>;
        return ipcRoutes[key].result.parse(await client.deleteEurRule(parsed.id)) as IpcResult<K>;
      }
      case 'eur:listItems': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listItems'>;
        return ipcRoutes[key].result.parse(await client.listEurCashItems(parsed)) as IpcResult<K>;
      }
      case 'eur:upsertClassification': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:upsertClassification'>;
        return ipcRoutes[key].result.parse(await client.upsertEurClassification(parsed)) as IpcResult<K>;
      }
      case 'eur:saveCashFact': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:saveCashFact'>;
        return ipcRoutes[key].result.parse(await client.saveEurCashFact(parsed)) as IpcResult<K>;
      }
      case 'eur:listCashFacts': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listCashFacts'>;
        return ipcRoutes[key].result.parse(await client.listEurCashFacts(parsed.taxYear)) as IpcResult<K>;
      }
      case 'eur:saveAnnexFact': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:saveAnnexFact'>;
        return ipcRoutes[key].result.parse(await client.saveEurAnnexFact(parsed)) as IpcResult<K>;
      }
      case 'eur:listAnnexFacts': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listAnnexFacts'>;
        return ipcRoutes[key].result.parse(await client.listEurAnnexFacts(parsed.taxYear, parsed.annex)) as IpcResult<K>;
      }
      case 'projects:list': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:list'>;
        return ipcRoutes[key].result.parse(await client.listProjects(parsed)) as IpcResult<K>;
      }
      case 'projects:get': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:get'>;
        return ipcRoutes[key].result.parse(await client.getProject(parsed.id)) as IpcResult<K>;
      }
      case 'projects:upsert': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveProject(parsed.project, parsed.reason)) as IpcResult<K>;
      }
      case 'projects:archive': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:archive'>;
        return ipcRoutes[key].result.parse(await client.archiveProject(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'transactions:list': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:list'>;
        return ipcRoutes[key].result.parse(await client.listTransactions(parsed)) as IpcResult<K>;
      }
      case 'transactions:link': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:link'>;
        return ipcRoutes[key].result.parse(await client.linkTransaction(parsed.transactionId, parsed.invoiceId)) as IpcResult<K>;
      }
      case 'transactions:unlink': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:unlink'>;
        return ipcRoutes[key].result.parse(await client.unlinkTransaction(parsed.transactionId)) as IpcResult<K>;
      }
      case 'finance:importPreview': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:importPreview'>;
        return ipcRoutes[key].result.parse(await client.financeImportPreview(parsed)) as IpcResult<K>;
      }
      case 'finance:importCommit': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:importCommit'>;
        return ipcRoutes[key].result.parse(await client.financeImportCommit(parsed)) as IpcResult<K>;
      }
      case 'finance:listImportBatches': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:listImportBatches'>;
        return ipcRoutes[key].result.parse(await client.financeListImportBatches(parsed)) as IpcResult<K>;
      }
      case 'finance:getImportBatchDetails': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:getImportBatchDetails'>;
        return ipcRoutes[key].result.parse(await client.financeGetImportBatchDetails(parsed)) as IpcResult<K>;
      }
      case 'finance:rollbackImportBatch': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:rollbackImportBatch'>;
        return ipcRoutes[key].result.parse(await client.financeRollbackImportBatch(parsed)) as IpcResult<K>;
      }
      case 'audit:verify': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.verifyAudit()) as IpcResult<K>;
      }
      case 'audit:exportCsv': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.exportAuditCsv()) as IpcResult<K>;
      }
      case 'tax:auditExportPackage': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'tax:auditExportPackage'>;
        const artifact = await client.exportTaxAuditPackage(parsed);
        if (!fallback) throw new Error('Kein nativer Speicher für das Steuer-Audit-Paket verfügbar.');
        const saved = await fallback('tax:saveAuditExportPackage', artifact);
        return ipcRoutes[key].result.parse(saved) as IpcResult<K>;
      }
      case 'portal:health': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:health'>;
        return ipcRoutes[key].result.parse(await client.portalHealth(parsed.baseUrl)) as IpcResult<K>;
      }
      case 'portal:publishOffer': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:publishOffer'>;
        return ipcRoutes[key].result.parse(await client.publishOfferToPortal(parsed)) as IpcResult<K>;
      }
      case 'portal:publishInvoice': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:publishInvoice'>;
        return ipcRoutes[key].result.parse(await client.publishInvoiceToPortal(parsed)) as IpcResult<K>;
      }
      case 'portal:syncOfferStatus': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:syncOfferStatus'>;
        return ipcRoutes[key].result.parse(await client.syncOfferPortalStatus(parsed.offerId)) as IpcResult<K>;
      }
      case 'portal:createCustomerAccessLink': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:createCustomerAccessLink'>;
        return ipcRoutes[key].result.parse(await client.createCustomerAccessLink(parsed)) as IpcResult<K>;
      }
      case 'portal:rotateCustomerAccessLink': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:rotateCustomerAccessLink'>;
        return ipcRoutes[key].result.parse(await client.rotateCustomerAccessLink(parsed)) as IpcResult<K>;
      }
      case 'email:send': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'email:send'>;
        return ipcRoutes[key].result.parse(await client.sendEmail(parsed)) as IpcResult<K>;
      }
      case 'email:testConfig': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'email:testConfig'>;
        return ipcRoutes[key].result.parse(await client.testEmailConfig(parsed)) as IpcResult<K>;
      }
      case 'dunning:manualRun': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.runDunningManually()) as IpcResult<K>;
      }
      case 'dunning:getInvoiceStatus': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'dunning:getInvoiceStatus'>;
        return ipcRoutes[key].result.parse(await client.getDunningInvoiceStatus(parsed.invoiceId)) as IpcResult<K>;
      }
      case 'recurring:manualRun': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.runRecurringManually()) as IpcResult<K>;
      }
      case 'pro:importSkr': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:importSkr'>;
        return ipcRoutes[key].result.parse(await client.importSkr(parsed)) as IpcResult<K>;
      }
      case 'pro:listBankTransactions': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.listAccountingTransactions()) as IpcResult<K>;
      }
      case 'transactions:findMatches': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:findMatches'>;
        return ipcRoutes[key].result.parse(await client.findTransactionMatches(parsed.transactionId)) as IpcResult<K>;
      }
      case 'pro:getDraftByTransactionId': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getDraftByTransactionId'>;
        return ipcRoutes[key].result.parse(await client.getAccountingDraftByTransactionId(parsed.transactionId)) as IpcResult<K>;
      }
      case 'pro:saveDraft': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:saveDraft'>;
        return ipcRoutes[key].result.parse(await client.saveAccountingDraft(parsed.draft, 'Buchungsentwurf gespeichert')) as IpcResult<K>;
      }
      case 'pro:dispatchDraftAction': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:dispatchDraftAction'>;
        return ipcRoutes[key].result.parse(await client.dispatchAccountingDraftAction(parsed.transactionId, parsed.action, 'Buchungsworkflow-Aktion ausgeführt', parsed.rejectReason)) as IpcResult<K>;
      }
      case 'pro:postDraft': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postDraft'>;
        const { draftId, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.postAccountingDraft(draftId, { ...options, reason: 'Buchungsentwurf gebucht' })) as IpcResult<K>;
      }
      case 'pro:reverseJournalEntry': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:reverseJournalEntry'>;
        const { entryId, ...options } = parsed;
        return ipcRoutes[key].result.parse(await client.reverseAccountingJournalEntry(entryId, options)) as IpcResult<K>;
      }
      case 'pro:validateTaxCompliance': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:validateTaxCompliance'>;
        return ipcRoutes[key].result.parse(await client.validateTaxCompliance(parsed)) as IpcResult<K>;
      }
      case 'pro:allocateOpenItemPayment': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:allocateOpenItemPayment'>;
        const { reason, ...payment } = parsed.payment;
        return ipcRoutes[key].result.parse(await client.allocateOpenItemPayment(payment, reason)) as IpcResult<K>;
      }
      case 'pro:allocateRemainingPayment': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:allocateRemainingPayment'>;
        return ipcRoutes[key].result.parse(await client.allocateRemainingOpenItemPayment(parsed.paymentId, parsed.allocations, parsed.reason, parsed.allocationEventId)) as IpcResult<K>;
      }
      case 'pro:reverseDocumentAccounting': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:reverseDocumentAccounting'>;
        return ipcRoutes[key].result.parse(await client.reverseDocumentAccounting(parsed, parsed.reason)) as IpcResult<K>;
      }
      case 'pro:previewAccountingBackfill': {
        ipcRoutes[key].args.parse(args);
        return ipcRoutes[key].result.parse(await client.previewAccountingBackfill()) as IpcResult<K>;
      }
      case 'pro:confirmAccountingBackfill': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:confirmAccountingBackfill'>;
        return ipcRoutes[key].result.parse(await client.confirmAccountingBackfill(parsed)) as IpcResult<K>;
      }
      case 'pro:postAccountingCommand': {
        const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postAccountingCommand'>;
        return ipcRoutes[key].result.parse(parseSourcePostResult(await client.postAccountingCommand(parsed), parsed.source)) as IpcResult<K>;
      }
      default:
        if (fallback && isNativeElectronRoute(key)) return fallback(key, args);
        throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    }
  };
  onInvoke?.(invoke);
  return createBillmeApi(invoke);
};
