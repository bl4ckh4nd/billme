import {
  authResponseSchema,
  authUserSchema,
  bootstrapRequestSchema,
  bootstrapStatusSchema,
  capabilitiesResponseSchema,
  clientSchema,
  healthResponseSchema,
  invoiceSchema,
  loginRequestSchema,
  offerSchema,
  recurringProfileSchema,
  serverProductSchema,
  serverRoleSchema,
} from '@billme/server-core';
import {
  accountSchema,
  accountSuggestionRuleSchema,
  appSettingsSchema,
  articleSchema,
  bookingDraftEntitySchema,
  accountingPostingPreviewSchema,
  accountingPolicySchema,
  accountingAccountMappingSchema,
  accountingBackfillPreviewSchema,
  accountingBackfillResultSchema,
  assetDepreciationScheduleEntrySchema,
  assetSchema,
  assetUpsertSchema,
  incomingInvoiceSchema,
  journalEntryEntitySchema,
  ledgerBalanceRowSchema,
  datevExportResultSchema,
  openItemSchema,
  vendorSchema,
  ledgerAccountSchema,
  proListAccountSuggestionRulesArgsSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  proWorkflowEntrySchema,
  setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema,
  taxCaseAccountMappingSchema,
  taxCaseDefinitionSchema,
  templateKindSchema,
  templateSchema,
  transactionSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { z } from 'zod';

type Parser<T> = { parse: (input: unknown) => T } | ((input: unknown) => T);

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  parser?: Parser<T>;
};

export type ProOpenItemPaymentInput = {
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
  /** Stable retry key generated once at the user operation boundary. */
  allocationEventId: string;
};

const PRO_PRODUCT_QUERY = { product: 'pro' as const };
const susaReportSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  asOfDate: z.string(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  rows: z.array(ledgerBalanceRowSchema),
  totals: z.object({ debit: z.number(), credit: z.number(), balance: z.number() }),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
});
const guvReportSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  rows: z.array(z.object({ positionKey: z.string(), positionLabel: z.string(), amount: z.number(), accountRefs: z.array(z.string()).optional() })),
  netResult: z.number(),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
});
const bwa01ReportSchema = z.object({
  kind: z.literal('bwa01'),
  from: z.string().optional(),
  to: z.string().optional(),
  rows: z.array(z.object({ position: z.string(), label: z.string(), amount: z.number(), accountNumbers: z.array(z.string()) })),
  totals: z.object({ revenue: z.number(), expenses: z.number(), operatingResult: z.number() }),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })),
  mappingHealth: z.object({ mappedAccounts: z.number(), inferredAccounts: z.number(), unmappedAccounts: z.array(z.string()), warnings: z.array(z.string()), blocking: z.boolean() }),
});
const assetDepreciationResultSchema = z.object({
  asset: assetSchema,
  scheduleEntry: assetDepreciationScheduleEntrySchema,
  journalEntryId: z.string().min(1),
});
const assetDisposalResultSchema = z.object({
  asset: assetSchema,
  residualBookValue: z.number().nonnegative(),
  gainLoss: z.number(),
  journalEntryId: z.string().min(1),
});
const bilanzReportSchema = z.object({
  asOfDate: z.string(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  assets: z.array(z.object({ accountNumber: z.string(), amount: z.number() })),
  liabilities: z.array(z.object({ accountNumber: z.string(), amount: z.number() })),
  totals: z.object({ assets: z.number(), liabilities: z.number(), delta: z.number() }),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseWith = <T>(parser: Parser<T>, input: unknown): T => {
  if (typeof parser === 'function') {
    return parser(input);
  }
  return parser.parse(input);
};

const parseArray = <T>(itemParser: Parser<T>) => {
  return (input: unknown): T[] => {
    if (!Array.isArray(input)) {
      throw new Error('Expected array response');
    }
    return input.map((item) => parseWith(itemParser, item));
  };
};

const authSessionInfoParser = (input: unknown) => {
  if (!isRecord(input)) {
    throw new Error('Expected auth session info');
  }
  return {
    user: authUserSchema.parse(input.user),
    tenantId: typeof input.tenantId === 'string' ? input.tenantId : '',
    product: serverProductSchema.parse(input.product),
    role: serverRoleSchema.parse(input.role),
  };
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
) => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
};

export type ProWebClientConfig = {
  baseUrl: string;
  getToken: () => string | null;
};

export const createProWebClient = ({ baseUrl, getToken }: ProWebClientConfig) => {
  const requestJson = async <T>({ method = 'GET', body, parser, query }: RequestOptions<T>, path: string): Promise<T> => {
    const headers = new Headers();
    const token = getToken();
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }

    const response = await fetch(buildUrl(baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (!parser) {
      return payload as T;
    }
    return parseWith(parser, payload);
  };

  const requestBlob = async (
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<Blob> => {
    const headers = new Headers();
    const token = getToken();
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }

    const response = await fetch(buildUrl(baseUrl, path, query), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message =
        isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : `Download failed with status ${response.status}`;
      throw new Error(message);
    }

    return response.blob();
  };

  const requestBlobWithHeaders = async (
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<{ blob: Blob; headers: Headers }> => {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(buildUrl(baseUrl, path, query), { method: 'GET', headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : `Download failed with status ${response.status}`;
      throw new Error(message);
    }
    return { blob: await response.blob(), headers: response.headers };
  };

  return {
    getHealth() {
      return requestJson({ parser: healthResponseSchema }, '/health');
    },
    getCapabilities() {
      return requestJson({ parser: capabilitiesResponseSchema }, '/api/v1/meta/capabilities');
    },
    getBootstrapStatus() {
      return requestJson({ parser: bootstrapStatusSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/bootstrap/status');
    },
    bootstrap(input: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: bootstrapRequestSchema.parse(input),
          parser: authResponseSchema,
          query: PRO_PRODUCT_QUERY,
        },
        '/api/v1/auth/bootstrap',
      );
    },
    login(input: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: loginRequestSchema.parse(input),
          parser: authResponseSchema,
          query: PRO_PRODUCT_QUERY,
        },
        '/api/v1/auth/login',
      );
    },
    getSessionInfo() {
      return requestJson({ parser: authSessionInfoParser, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/me');
    },
    listClients() {
      return requestJson({ parser: parseArray(clientSchema) }, '/api/v1/pro/clients');
    },
    listInvoices() {
      return requestJson({ parser: parseArray(invoiceSchema) }, '/api/v1/pro/invoices');
    },
    listOffers() {
      return requestJson({ parser: parseArray(offerSchema) }, '/api/v1/pro/offers');
    },
    listRecurringProfiles() {
      return requestJson({ parser: parseArray(recurringProfileSchema) }, '/api/v1/pro/recurring');
    },
    getSettings() {
      return requestJson({ parser: (input) => (input === null ? null : appSettingsSchema.parse(input)) }, '/api/v1/pro/settings');
    },
    saveSettings(settings: unknown) {
      return requestJson(
        {
          method: 'PUT',
          body: setSettingsPayloadSchema.parse({ settings }),
          parser: (input) => input,
        },
        '/api/v1/pro/settings',
      );
    },
    listArticles() {
      return requestJson({ parser: parseArray(articleSchema) }, '/api/v1/pro/articles');
    },
    saveArticle(article: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: upsertArticlePayloadSchema.parse({ article }),
          parser: articleSchema,
        },
        '/api/v1/pro/articles',
      );
    },
    listAccounts() {
      return requestJson({ parser: parseArray(accountSchema) }, '/api/v1/pro/accounts');
    },
    saveAccount(account: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: upsertAccountPayloadSchema.parse({ account }),
          parser: accountSchema,
        },
        '/api/v1/pro/accounts',
      );
    },
    listTemplates(kind?: 'invoice' | 'offer') {
      return requestJson({ parser: parseArray(templateSchema), query: kind ? { kind } : undefined }, '/api/v1/pro/templates');
    },
    saveTemplate(template: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: upsertTemplatePayloadSchema.parse({ template }),
          parser: templateSchema,
        },
        '/api/v1/pro/templates',
      );
    },
    getActiveTemplate(kind: 'invoice' | 'offer') {
      return requestJson(
        {
          parser: (input) => (input === null ? null : templateSchema.parse(input)),
        },
        `/api/v1/pro/templates/active/${templateKindSchema.parse(kind)}`,
      );
    },
    setActiveTemplate(input: unknown) {
      return requestJson(
        {
          method: 'PUT',
          body: setActiveTemplatePayloadSchema.parse(input),
          parser: (payload) => payload,
        },
        '/api/v1/pro/templates/active',
      );
    },
    listWorkflowEntries() {
      return requestJson({ parser: parseArray(proWorkflowEntrySchema) }, '/api/v1/pro/workflow');
    },
    listAccountingTransactions() {
      return requestJson({ parser: parseArray(transactionSchema) }, '/api/v1/pro/accounting/transactions');
    },
    listAccountingDrafts(transactionIds: string[]) {
      return Promise.all(
        transactionIds.map((transactionId) =>
          requestJson(
            { parser: (input) => (input === null ? null : bookingDraftEntitySchema.parse(input)) },
            `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`,
          ),
        ),
      );
    },
    saveAccountingDraft(draft: unknown, reason: string) {
      return requestJson(
        {
          method: 'POST',
          body: { reason, draft: bookingDraftEntitySchema.parse(draft) },
          parser: bookingDraftEntitySchema,
        },
        '/api/v1/pro/accounting/drafts',
      );
    },
    dispatchAccountingDraftAction(transactionId: string, action: string, reason: string, rejectReason?: string) {
      return requestJson(
        {
          method: 'POST',
          body: { reason, action, rejectReason },
          parser: bookingDraftEntitySchema,
        },
        `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}/action`,
      );
    },
    postAccountingDraft(draftId: string, options: Record<string, unknown> & { reason: string }) {
      return requestJson(
        {
          method: 'POST',
          body: options,
          parser: (input) => input,
        },
        `/api/v1/pro/accounting/drafts/${encodeURIComponent(draftId)}/post`,
      );
    },
    reverseAccountingJournalEntry(entryId: string, options: Record<string, unknown> & { reason: string }) {
      return requestJson(
        {
          method: 'POST',
          body: options,
          parser: (input) => input,
        },
        `/api/v1/pro/accounting/journal/${encodeURIComponent(entryId)}/reverse`,
      );
    },
    listAccountingJournalEntries(query?: unknown) {
      const normalized = query && isRecord(query) ? query : undefined;
      return requestJson(
        { parser: parseArray(journalEntryEntitySchema), query: normalized as Record<string, string | number | boolean | null | undefined> | undefined },
        '/api/v1/pro/accounting/journal',
      );
    },
    getAccountingBalances(asOfDate?: string) {
      return requestJson({ parser: parseArray(ledgerBalanceRowSchema), query: { asOfDate } }, '/api/v1/pro/accounting/balances');
    },
    getAccountingHealth() {
      return requestJson({ parser: (input) => input }, '/api/v1/pro/accounting/health');
    },
    getVatSummary(query?: unknown) {
      return requestJson({ parser: (input) => input, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/vat/summary');
    },
    getSusaReport(query?: { from?: string; to?: string; asOfDate?: string; chart?: 'SKR03' | 'SKR04'; profile?: string }) {
      return requestJson({ parser: susaReportSchema, query }, '/api/v1/pro/accounting/reports/susa');
    },
    getGuvReport(query?: unknown) {
      return requestJson({ parser: guvReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/guv');
    },
    getBwa01Report(query?: unknown) {
      return requestJson({ parser: bwa01ReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/bwa01');
    },
    getManagementGuvReport(query?: unknown) {
      return requestJson({ parser: guvReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/management-guv');
    },
    getHgbGuvReport(query?: unknown) {
      return requestJson({ parser: guvReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/hgb-guv');
    },
    getBilanzReport(asOfDate?: string | { asOfDate?: string; chart?: 'SKR03' | 'SKR04'; profile?: string }) {
      const query = typeof asOfDate === 'string' ? { asOfDate } : asOfDate;
      return requestJson({ parser: bilanzReportSchema, query }, '/api/v1/pro/accounting/reports/bilanz');
    },
    listReportSnapshots(reportType?: 'susa' | 'guv' | 'management-guv' | 'hgb-guv' | 'bilanz' | 'hgb-bilanz' | 'bwa01') {
      return requestJson({ parser: (input) => input, query: reportType ? { reportType } : undefined }, '/api/v1/pro/accounting/reports/snapshots');
    },
    getReportSnapshot(id: string) {
      return requestJson({ parser: (input) => input }, `/api/v1/pro/accounting/reports/snapshots/${encodeURIComponent(id)}`);
    },
    createReportSnapshot(input: { reportType: 'susa' | 'guv' | 'management-guv' | 'hgb-guv' | 'bilanz' | 'hgb-bilanz' | 'bwa01'; from?: string; to?: string; asOfDate?: string; chart?: 'SKR03' | 'SKR04'; profile?: string; reason: string }) {
      return requestJson({ method: 'POST', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/reports/snapshots');
    },
    getAccountMappingHealth(chart?: 'SKR03' | 'SKR04') {
      return requestJson({ parser: (input) => input, query: chart ? { chart } : undefined }, '/api/v1/pro/accounting/mappings/health');
    },
    saveAccountMappingOverride(input: { chart: 'SKR03' | 'SKR04'; accountNumber: string; statementType: 'guv' | 'bilanz'; positionKey: string; positionLabel: string; balanceSide?: 'asset' | 'liability'; reason: string }) {
      return requestJson({ method: 'PUT', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/mappings/overrides');
    },
    getAccountingPolicy() {
      return requestJson({ parser: accountingPolicySchema }, '/api/v1/pro/accounting/policy');
    },
    listAssets() {
      return requestJson({ parser: parseArray(assetSchema) }, '/api/v1/pro/accounting/assets');
    },
    upsertAsset(asset: unknown, reason: string) {
      return requestJson(
        {
          method: 'POST',
          body: { asset: assetUpsertSchema.parse(asset), reason },
          parser: assetSchema,
        },
        '/api/v1/pro/accounting/assets',
      );
    },
    getDepreciationSchedule(assetId: string) {
      return requestJson(
        { parser: parseArray(assetDepreciationScheduleEntrySchema) },
        `/api/v1/pro/accounting/assets/${encodeURIComponent(assetId)}/schedule`,
      );
    },
    runDepreciation(args: {
      assetId: string;
      year: number;
      postingDate: string;
      reason: string;
      softLockOverride?: boolean;
      overrideReason?: string;
    }) {
      return requestJson({ method: 'POST', body: args, parser: assetDepreciationResultSchema }, `/api/v1/pro/accounting/assets/${encodeURIComponent(args.assetId)}/depreciation`);
    },
    disposeAsset(args: {
      assetId: string;
      disposalDate: string;
      proceeds: number;
      taxRate?: 0 | 7 | 19;
      proceedsAccountNumber?: string;
      reason: string;
      softLockOverride?: boolean;
      overrideReason?: string;
    }) {
      return requestJson({ method: 'POST', body: args, parser: assetDisposalResultSchema }, `/api/v1/pro/accounting/assets/${encodeURIComponent(args.assetId)}/dispose`);
    },
    downloadDatevCsv(query?: {
      from?: string;
      to?: string;
      consultantNumber?: string;
      clientNumber?: string;
      fiscalYearStart?: string;
      accountLength?: number;
      encoding?: 'cp1252' | 'utf8-bom';
    }) {
      return requestBlob('/api/v1/pro/accounting/datev/export.csv', query);
    },
    exportDatevCsv(query: {
      from: string;
      to: string;
      consultantNumber: string;
      clientNumber: string;
      fiscalYearStart: string;
      accountLength: number;
      encoding: 'cp1252' | 'utf8-bom';
      reason?: string;
    }) {
      return requestBlobWithHeaders('/api/v1/pro/accounting/datev/export.csv', query).then(({ blob, headers }) => ({
        blob,
        exportId: headers.get('x-billme-datev-export-id') ?? '',
        contentSha256: headers.get('x-billme-datev-content-sha256') ?? undefined,
        recordCount: Number(headers.get('x-billme-datev-record-count') ?? 0),
      }));
    },
    downloadDatevExport(exportId: string) {
      return requestBlob(`/api/v1/pro/accounting/datev/exports/${encodeURIComponent(exportId)}`);
    },
    listDatevExports(limit?: number) {
      return requestJson({ parser: parseArray(datevExportResultSchema) }, '/api/v1/pro/accounting/datev/exports').then((rows) => (limit ? rows.slice(0, limit) : rows));
    },
    setAccountingPolicy(input: unknown, reason: string) {
      return requestJson({ method: 'PUT', body: { ...accountingPolicySchema.omit({ tenantId: true, periodPolicy: true, updatedAt: true }).parse(input), reason }, parser: accountingPolicySchema }, '/api/v1/pro/accounting/policy');
    },
    listAccountingMappings(chart?: 'SKR03' | 'SKR04') {
      return requestJson({ parser: parseArray(accountingAccountMappingSchema), query: { chart } }, '/api/v1/pro/accounting/mappings');
    },
    saveAccountingMapping(mapping: unknown, reason: string) {
      return requestJson({ method: 'POST', body: { ...(isRecord(mapping) ? mapping : {}), reason }, parser: accountingAccountMappingSchema }, '/api/v1/pro/accounting/mappings');
    },
    listAccountingVendors() {
      return requestJson({ parser: parseArray(vendorSchema) }, '/api/v1/pro/accounting/vendors');
    },
    saveAccountingVendor(vendor: unknown, reason: string) {
      return requestJson({ method: 'POST', body: { vendor, reason }, parser: vendorSchema }, '/api/v1/pro/accounting/vendors');
    },
    listIncomingInvoices() {
      return requestJson({ parser: parseArray(incomingInvoiceSchema) }, '/api/v1/pro/accounting/incoming-invoices');
    },
    saveIncomingInvoice(invoice: unknown, reason: string) {
      return requestJson({ method: 'POST', body: { invoice, reason }, parser: incomingInvoiceSchema }, '/api/v1/pro/accounting/incoming-invoices');
    },
    listOpenItems() {
      return requestJson({ parser: parseArray(openItemSchema) }, '/api/v1/pro/accounting/open-items');
    },
    previewOutgoingInvoice(invoiceId: string, reason = 'Vorschau') {
      return requestJson({ method: 'POST', body: { invoiceId, reason }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/outgoing-invoices/preview');
    },
    postOutgoingInvoice(invoiceId: string, reason: string, reservationId: string, options: Record<string, unknown> = {}) {
      if (!reservationId.trim()) throw new Error('reservationId is required');
      return requestJson({ method: 'POST', body: { invoiceId, reason, reservationId, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/outgoing-invoices/post');
    },
    previewIncomingInvoice(invoiceId: string, reason = 'Vorschau') {
      return requestJson({ method: 'POST', body: { invoiceId, reason }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/incoming-invoices/preview');
    },
    postIncomingInvoice(invoiceId: string, reason: string, options: Record<string, unknown> = {}) {
      return requestJson({ method: 'POST', body: { invoiceId, reason, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/incoming-invoices/post');
    },
    allocateOpenItemPayment(payment: ProOpenItemPaymentInput, reason: string) {
      if (typeof payment.allocationEventId !== 'string' || !payment.allocationEventId.trim()) throw new Error('allocationEventId is required');
      return requestJson({ method: 'POST', body: { payment, reason }, parser: (input) => input }, '/api/v1/pro/accounting/open-items/payments');
    },
    allocateRemainingOpenItemPayment(paymentId: string, allocations: unknown, reason: string, allocationEventId: string) {
      if (!allocationEventId.trim()) throw new Error('allocationEventId is required');
      return requestJson({ method: 'POST', body: { paymentId, allocations, reason, allocationEventId }, parser: (input) => input }, `/api/v1/pro/accounting/open-items/payments/${encodeURIComponent(paymentId)}/remaining`);
    },
    reverseDocumentAccounting(input: unknown, reason: string) {
      return requestJson({ method: 'POST', body: { ...input as Record<string, unknown>, reason }, parser: (payload) => payload }, '/api/v1/pro/accounting/documents/reverse');
    },
    previewAccountingBackfill() {
      return requestJson({ parser: accountingBackfillPreviewSchema }, '/api/v1/pro/accounting/backfill/preview');
    },
    confirmAccountingBackfill(input: unknown) {
      return requestJson({ method: 'POST', body: input, parser: accountingBackfillResultSchema }, '/api/v1/pro/accounting/backfill/confirm');
    },
    upsertWorkflowEntry(entry: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: proWorkflowEntrySchema.parse(entry),
          parser: (payload) => payload,
        },
        '/api/v1/pro/workflow',
      );
    },
    listLedgerAccounts(query?: unknown) {
      const normalized = query && isRecord(query) ? query : undefined;
      return requestJson(
        {
          parser: parseArray(ledgerAccountSchema),
          query: normalized as Record<string, string | number | boolean | null | undefined> | undefined,
        },
        '/api/v1/pro/accounting/ledger/accounts',
      );
    },
    getLedgerStats() {
      return requestJson(
        {
          parser: (input) => {
            if (!isRecord(input) || !isRecord(input.byChart)) {
              throw new Error('Expected ledger stats response');
            }
            return {
              total: typeof input.total === 'number' ? input.total : 0,
              byChart: {
                SKR03: typeof input.byChart.SKR03 === 'number' ? input.byChart.SKR03 : 0,
                SKR04: typeof input.byChart.SKR04 === 'number' ? input.byChart.SKR04 : 0,
              },
            };
          },
        },
        '/api/v1/pro/accounting/ledger/stats',
      );
    },
    listTaxCases(query?: unknown) {
      const normalized = query ? proListTaxCasesArgsSchema.parse(query) : undefined;
      return requestJson(
        {
          parser: parseArray(taxCaseDefinitionSchema),
          query: normalized,
        },
        '/api/v1/pro/accounting/tax-cases',
      );
    },
    listTaxCaseMappings(query?: unknown) {
      const normalized = query ? proListTaxCaseAccountMappingsArgsSchema.parse(query) : undefined;
      return requestJson(
        {
          parser: parseArray(taxCaseAccountMappingSchema),
          query: normalized,
        },
        '/api/v1/pro/accounting/tax-case-account-mappings',
      );
    },
    saveTaxCaseMapping(mapping: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: proUpsertTaxCaseAccountMappingArgsSchema.parse(mapping),
          parser: taxCaseAccountMappingSchema,
        },
        '/api/v1/pro/accounting/tax-case-account-mappings',
      );
    },
    listAccountSuggestionRules(query?: unknown) {
      const normalized = query ? proListAccountSuggestionRulesArgsSchema.parse(query) : undefined;
      return requestJson(
        {
          parser: parseArray(accountSuggestionRuleSchema),
          query: normalized,
        },
        '/api/v1/pro/accounting/account-suggestion-rules',
      );
    },
    saveAccountSuggestionRule(rule: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: proUpsertAccountSuggestionRuleArgsSchema.parse(rule),
          parser: accountSuggestionRuleSchema,
        },
        '/api/v1/pro/accounting/account-suggestion-rules',
      );
    },
    deleteAccountSuggestionRule(id: string, reason = 'Kontierungsvorschlagsregel gelöscht') {
      return requestJson(
        {
          method: 'DELETE',
          query: { reason },
          parser: (payload) => payload,
        },
        `/api/v1/pro/accounting/account-suggestion-rules/${encodeURIComponent(id)}`,
      );
    },
    downloadDocumentJson(kind: 'invoice' | 'offer', id: string) {
      return requestBlob(`/api/v1/pro/documents/${kind}/${encodeURIComponent(id)}/export.json`);
    },
    downloadDocumentsCsv(kind: 'invoice' | 'offer') {
      return requestBlob('/api/v1/pro/documents/export.csv', { kind });
    },
    parseWorkflowTransaction(input: string) {
      return transactionSchema.parse(JSON.parse(input));
    },
    parseWorkflowDraft(input: string) {
      return bookingDraftEntitySchema.parse(JSON.parse(input));
    },
  };
};

export type ProWebClient = ReturnType<typeof createProWebClient>;
