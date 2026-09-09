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
  accountingSourceFactSchema,
  articleSchema,
  eurRuleSchema,
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
  incomingInvoiceDocumentSchema,
  incomingInvoiceDocumentDownloadSchema,
  journalEntryEntitySchema,
  ledgerBalanceRowSchema,
  datevExportResultSchema,
  openItemSchema,
  projectSchema,
  vendorSchema,
  ledgerAccountSchema,
  proListAccountSuggestionRulesArgsSchema,
  proAccountingSourceRunSchema,
  proAccountingSourcePostResultSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  proWorkflowEntrySchema,
  reportSnapshotRecordSchema,
  setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema,
  taxAuditExportArtifactSchema,
  taxCaseAccountMappingSchema,
  taxCaseDefinitionSchema,
  templateKindSchema,
  templateSchema,
  transactionSchema,
  openRouterVlmAnalyzeInputSchema,
  openRouterVlmAnalyzeResultSchema,
  openRouterVlmConfigSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts-pro/schemas';
import {
  createBillmeApi,
  type BillmeApi,
  type IpcInvoke,
} from '@billme/desktop-contracts-pro/api';
import {
  ipcRoutes,
  type IpcArgs,
  type IpcResult,
  type IpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';
import { taxFilingRoutes } from '@billme/desktop-contracts/taxFiling';
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  formatAddressMultiline,
} from '@billme/server-core/services';
import {
  createBillingScope,
  toDomainInvoice,
  toDomainOffer,
  toLegacyInvoice,
  toLegacyOffer,
} from '@billme/desktop-data/billingDocumentMapping';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';
import { z } from 'zod';

type Parser<T> = { parse: (input: unknown) => T } | ((input: unknown) => T);
type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | null | undefined;

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
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

const serverTransactionMatchesSchema = z.object({
  transaction: transactionSchema,
  suggestions: z.array(z.object({
    invoice: invoiceSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    matchReasons: z.array(z.string()),
    amountDiff: z.number(),
  })),
});

const PRO_PRODUCT_QUERY = { product: 'pro' as const };
const EUR_RULE_MUTATION_REASON = 'EÜR-Klassifikationsregel gespeichert';
const EUR_RULE_DELETE_REASON = 'EÜR-Klassifikationsregel gelöscht';
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
const reportSnapshotSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  asOfDate: z.string().optional(),
  fiscalYear: z.number(),
  fiscalYearStart: z.string(),
  fiscalYearRange: z.object({ fiscalYear: z.number(), start: z.string(), end: z.string(), label: z.string() }).optional(),
  businessSize: z.enum(['micro', 'small']),
  ledgerEntryCount: z.number(),
  ledgerAccountCount: z.number(),
  cashEntryCount: z.number(),
});
const mappingHealthSchema = z.object({
  mappedAccounts: z.number(),
  inferredAccounts: z.number(),
  unmappedAccounts: z.array(z.string()),
  warnings: z.array(z.string()),
  blocking: z.boolean(),
});
const reportingLineSchema = z.object({
  position: z.string(),
  label: z.string(),
  amount: z.number(),
  accountNumbers: z.array(z.string()),
  accountRefs: z.array(z.string()).optional(),
  kind: z.enum(['heading', 'line', 'subtotal', 'result']).optional(),
  parentPosition: z.string().optional(),
  formula: z.string().optional(),
});
const guvReportSchema = z.object({
  kind: z.enum(['management-guv', 'hgb-guv']).optional(),
  rows: z.array(reportingLineSchema),
  netResult: z.number(),
  method: z.string().optional(),
  snapshot: reportSnapshotSchema,
  mappingHealth: mappingHealthSchema,
});
const guvClientReportSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  rows: z.array(reportingLineSchema),
  netResult: z.number(),
  mappingHealth: mappingHealthSchema,
});
const eurReportSchema = z.object({
  taxYear: z.union([z.literal(2025), z.literal(2026)]),
  from: z.string(),
  to: z.string(),
  rows: z.array(z.object({
    id: z.string(),
    kennziffer: z.string().optional(),
    providerPath: z.string().optional(),
    label: z.string(),
    kind: z.enum(['income', 'expense', 'computed']),
    exportable: z.boolean(),
    sortOrder: z.number(),
    computedFromIds: z.array(z.string()).optional(),
    computedTerms: z.array(z.object({ id: z.string(), sign: z.union([z.literal(1), z.literal(-1)]) })).optional(),
    total: z.number(),
  })),
  summary: z.object({ incomeTotal: z.number(), expenseTotal: z.number(), surplus: z.number() }),
  unclassifiedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  catalog: z.object({ id: z.string(), version: z.string(), sourceHash: z.string(), delivery: z.enum(['print-form-only', 'elster-ready']), elsterReady: z.boolean() }),
});
const eurCashItemSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string(),
  date: z.string(),
  amountGross: z.number(),
  amountNet: z.number(),
  flowType: z.enum(['income', 'expense']),
  accountId: z.string().optional(),
  linkedViaInvoice: z.boolean().optional(),
  counterparty: z.string(),
  purpose: z.string(),
  vatWarning: z.string().optional(),
  kind: z.enum(['income', 'expense', 'private-withdrawal', 'private-contribution', 'pass-through']).optional(),
  splits: z.array(z.object({
    amountNet: z.number().nonnegative(),
    deductibility: z.enum(['deductible', 'non-deductible']).optional(),
    classification: z.enum(['deductible', 'non-deductible']).optional(),
    deductible: z.boolean().optional(),
    lineId: z.string().optional(),
    reason: z.string().optional(),
    auditId: z.string().optional(),
  })).optional(),
  classification: z.object({
    id: z.string(), sourceType: z.enum(['transaction', 'invoice']), sourceId: z.string(), taxYear: z.union([z.literal(2025), z.literal(2026)]), eurLineId: z.string().optional(), excluded: z.boolean(), vatMode: z.enum(['none', 'default']), vatRate: z.number().optional(), note: z.string().optional(), updatedAt: z.string(),
  }).optional(),
});
const bwa01ReportSchema = z.object({
  kind: z.literal('bwa01'),
  rows: z.array(reportingLineSchema),
  totals: z.object({ revenue: z.number(), expenses: z.number(), operatingResult: z.number() }),
  snapshot: reportSnapshotSchema,
  mappingHealth: mappingHealthSchema,
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
  kind: z.literal('hgb-bilanz').optional(),
  assets: z.array(reportingLineSchema),
  liabilities: z.array(reportingLineSchema),
  totals: z.object({ assets: z.number(), liabilities: z.number(), delta: z.number() }),
  snapshot: reportSnapshotSchema,
  mappingHealth: mappingHealthSchema,
});
type AccountingSourceRun = z.infer<typeof proAccountingSourceRunSchema>;

const parseAccountingSourceRun = (input: unknown, fallbackFact?: unknown): AccountingSourceRun => {
  if (!isRecord(input) || input.fact !== undefined) {
    return proAccountingSourceRunSchema.parse(input);
  }

  const source = input.source;
  const sourceInput = isRecord(source) && source.input !== undefined ? source.input : undefined;
  const candidates = [source, sourceInput, fallbackFact];
  const fact = candidates
    .map((candidate) => accountingSourceFactSchema.safeParse(candidate))
    .find((parsed) => parsed.success)?.data;

  return proAccountingSourceRunSchema.parse(fact === undefined ? input : { ...input, fact });
};

const accountingSourceRunParser: Parser<AccountingSourceRun> = parseAccountingSourceRun;

const parseAccountingSourcePostResult = (input: unknown, fallbackFact?: unknown) => {
  if (isRecord(input) && typeof input.status === 'string' && Array.isArray(input.errors)) {
    const sourceRun = isRecord(input.sourceRun)
      ? parseAccountingSourceRun(input.sourceRun, fallbackFact)
      : undefined;
    return proAccountingSourcePostResultSchema.parse(sourceRun ? { ...input, sourceRun } : input);
  }
  if (!isRecord(input) || !isRecord(input.run)) {
    throw new Error('Die Serverantwort enthält kein Buchungsprotokoll.');
  }
  const run = parseAccountingSourceRun(input.run, fallbackFact);
  const status = input.replayed === true
    ? 'duplicate'
    : run.status === 'posted'
      ? 'posted'
      : run.status === 'rejected'
        ? 'rejected'
        : 'noop';
  const result = isRecord(input.result) ? input.result : undefined;
  const rawErrors = result && Array.isArray(result.errors) ? result.errors : [];
  const errors = rawErrors.flatMap((error) => {
    if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return [];
    return [{ code: error.code, message: error.message, ...(typeof error.field === 'string' ? { field: error.field } : {}), blocking: true as const }];
  });
  return proAccountingSourcePostResultSchema.parse({
    status,
    sourceRun: run,
    command: result?.command,
    errors,
    idempotencyKey: run.idempotencyKey,
  });
};

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
      throw new Error('Die Serverantwort enthält keine Liste.');
    }
    return input.map((item) => parseWith(itemParser, item));
  };
};

const parseSnapshotJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Die Serverantwort enthält einen ungültigen Report-Snapshot.');
  }
};

const reportSnapshotParser: Parser<z.infer<typeof reportSnapshotRecordSchema>> = (input) => {
  if (!isRecord(input)) throw new Error('Die Serverantwort enthält keinen Report-Snapshot.');
  return reportSnapshotRecordSchema.parse({
    id: input.id,
    reportType: input.reportType,
    args: input.args ?? parseSnapshotJson(input.argsJson ?? '{}'),
    payload: input.payload ?? parseSnapshotJson(input.payloadJson ?? null),
    createdAt: input.createdAt,
    sourceHash: input.sourceHash,
  });
};

const parseServerLegacyGuvReport = (input: unknown): z.infer<typeof guvClientReportSchema> => {
  const legacy = ipcRoutes['pro:getGuvReport'].result.parse(input);
  const unmappedAccounts = legacy.unmappedAccounts?.map((item) => item.accountNumber) ?? [];
  return guvClientReportSchema.parse({
    from: legacy.from,
    to: legacy.to,
    chart: legacy.chart,
    rows: legacy.rows.map((row) => ({
      position: row.positionKey,
      label: row.positionLabel,
      amount: row.amount,
      accountNumbers: row.accountRefs ?? [],
      accountRefs: row.accountRefs,
    })),
    netResult: legacy.netResult,
    mappingHealth: {
      mappedAccounts: Math.max(0, legacy.rows.length - unmappedAccounts.length),
      inferredAccounts: 0,
      unmappedAccounts,
      warnings: legacy.blocking ? ['REPORT_MAPPING_BLOCKED'] : [],
      blocking: legacy.blocking ?? false,
    },
  });
};

const authSessionInfoParser = (input: unknown) => {
  if (!isRecord(input)) {
      throw new Error('Die Serverantwort enthält keine Sitzungsdaten.');
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
  query?: Record<string, QueryValue>,
) => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
};

export type ProWebClientConfig = {
  baseUrl: string;
  getToken?: () => string | null;
  embeddedConnectionResolver?: () => Promise<EmbeddedConnection | null>;
  fetch?: typeof globalThis.fetch;
};

export type ProBlobDownloader = (blob: Blob, fileName: string) => void;

export class ProEmbeddedConnectionUnavailableError extends Error {
  readonly code = 'PRO_EMBEDDED_CONNECTION_UNAVAILABLE' as const;

  constructor() {
    super('Der eingebettete Pro-Server ist nicht verfügbar.');
    this.name = 'ProEmbeddedConnectionUnavailableError';
  }
}

const downloadBlobInBrowser: ProBlobDownloader = (blob, fileName) => {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || !document.body) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

type DatevExportReceiptMetadata = {
  id: string;
  recordCount: number;
  byteSize?: number;
  sha256?: string;
  contentSha256?: string;
};

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('DATEV-Export-Hashprüfung ist in dieser Umgebung nicht verfügbar.');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validateDatevExportReceipt = async (
  exported: { blob: Blob; exportId: string; contentSha256?: string; recordCount: number },
  receipt: DatevExportReceiptMetadata,
): Promise<void> => {
  if (receipt.id !== exported.exportId) throw new Error('DATEV-Exportbeleg stimmt nicht mit dem Export überein.');
  if (receipt.recordCount !== exported.recordCount) throw new Error('DATEV-Exportbeleg hat eine abweichende Datensatzanzahl.');

  const bytes = await exported.blob.arrayBuffer();
  if (receipt.byteSize !== undefined && receipt.byteSize !== bytes.byteLength) {
    throw new Error('DATEV-Exportbeleg hat eine abweichende Dateigröße.');
  }

  const expectedHashes = [exported.contentSha256, receipt.contentSha256, receipt.sha256].filter(
    (value): value is string => Boolean(value),
  );
  if (expectedHashes.length > 0) {
    const actualHash = await sha256Hex(bytes);
    if (expectedHashes.some((expectedHash) => expectedHash.toLowerCase() !== actualHash)) {
      throw new Error('DATEV-Exportbeleg hat einen abweichenden Datei-Hash.');
    }
  }
};

export const createProWebClient = ({
  baseUrl,
  getToken,
  embeddedConnectionResolver,
  fetch: requestFetch = globalThis.fetch,
}: ProWebClientConfig) => {
  const resolveRequestTarget = async (): Promise<{ baseUrl: string; headers: HeadersInit }> => {
    if (embeddedConnectionResolver) {
      const connection = await embeddedConnectionResolver();
      if (!connection) {
        throw new ProEmbeddedConnectionUnavailableError();
      }
      return {
        baseUrl: connection.baseUrl,
        headers: { 'x-billme-local-token': connection.token },
      };
    }

    const token = getToken?.();
    return {
      baseUrl,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
  };

  const requireFetch = (): typeof globalThis.fetch => {
    if (!requestFetch) {
      throw new Error('Keine Fetch-Implementierung verfügbar.');
    }
    return requestFetch;
  };

  const requestJson = async <T>({ method = 'GET', body, parser, query }: RequestOptions<T>, path: string): Promise<T> => {
    const target = await resolveRequestTarget();
    const headers = new Headers(target.headers);
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }

    const response = await requireFetch()(buildUrl(target.baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }

    if (!parser) {
      return payload as T;
    }
    return parseWith(parser, payload);
  };

  const requestText = async (
    path: string,
    query?: Record<string, QueryValue>,
  ): Promise<string> => {
    const target = await resolveRequestTarget();
    const response = await requireFetch()(buildUrl(target.baseUrl, path, query), {
      method: 'GET',
      headers: new Headers(target.headers),
    });
    const payload = await response.text();
    if (!response.ok) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(payload); } catch { /* keep text fallback */ }
      const message = isRecord(parsed) && typeof parsed.message === 'string'
        ? parsed.message
        : `Download fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload;
  };

  const requestBlob = async (
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<Blob> => {
    const target = await resolveRequestTarget();
    const headers = new Headers(target.headers);

    const response = await requireFetch()(buildUrl(target.baseUrl, path, query), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message =
        isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : `Download fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }

    return response.blob();
  };

  const requestBlobWithHeaders = async (
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<{ blob: Blob; headers: Headers }> => {
    const target = await resolveRequestTarget();
    const headers = new Headers(target.headers);
    const response = await requireFetch()(buildUrl(target.baseUrl, path, query), { method: 'GET', headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : `Download fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return { blob: await response.blob(), headers: response.headers };
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
    const source = input.source as Record<string, unknown>;
    const facts = isRecord(input.domainFacts) ? input.domainFacts : undefined;
    if (input.kind !== 'standalone' && (!isRecord(facts) || Object.keys(facts).length === 0)) {
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
      return requestJson({ method: 'POST', body: correction, parser: (payload) => payload as { run: AccountingSourceRun; result: unknown; replayed: boolean } }, '/api/v1/pro/accounting/corrections');
    }
    const commandKinds = new Set(['fiscal_close', 'carry_forward', 'provision', 'accrual', 'inventory_closing', 'fx_valuation', 'loan_schedule', 'payroll_batch', 'shareholder_flow']);
    const settlementKinds = new Set(['skonto', 'bad_debt', 'advance_settlement']);
    const commandInput = input.kind === 'standalone'
      ? { ...source, reference: source.reference ?? input.kind }
      : { ...(facts ?? {}), sourceId, sourceRevision, ...(settlementKinds.has(input.kind) ? { effectiveDate: source.effectiveDate, postingDate: source.postingDate ?? source.effectiveDate, currency: source.currency ?? 'EUR', period: source.period ?? String(source.effectiveDate ?? '').slice(0, 7), fiscalYear: source.fiscalYear ?? Number(String(source.effectiveDate ?? '').slice(0, 4)) } : {}) };
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
    return requestJson({ method: 'POST', body, parser: (payload) => payload as { run: AccountingSourceRun; result: unknown; replayed: boolean } }, '/api/v1/pro/accounting/closing');
  };

  const getLedgerStats = () => requestJson(
    {
      parser: (input) => ipcRoutes['pro:getLedgerStats'].result.parse(input),
    },
    '/api/v1/pro/accounting/ledger/stats',
  );

  const getOpenRouterVlmConfig = () => requestJson(
    { parser: openRouterVlmConfigSchema },
    '/api/v1/pro/accounting/vlm/config',
  );

  const analyzeTransactionDocument = (input: unknown) => {
    const parsed = openRouterVlmAnalyzeInputSchema.parse(input);
    return requestJson(
      {
        method: 'POST',
        body: parsed,
        parser: openRouterVlmAnalyzeResultSchema,
      },
      `/api/v1/pro/accounting/transactions/${encodeURIComponent(parsed.transaction.id)}/analyze-document`,
    );
  };

  const proBillingScope = createBillingScope('pro');
  const toServerInvoicePayload = (invoice: IpcResult<'invoices:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainInvoice(proBillingScope, invoice);
    return payload;
  };
  const toServerOfferPayload = (offer: IpcResult<'offers:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainOffer(proBillingScope, offer);
    return payload;
  };
  const buildProDraftFromClient = async (
    kind: 'invoice' | 'offer',
    client: z.output<typeof clientSchema>,
    settings: z.output<typeof appSettingsSchema> | null,
    reserveNumber: () => Promise<{ reservationId: string; number: string }>,
  ): Promise<IpcResult<'documents:createFromClient'>> => {
    const billingAddress = chooseDefaultBillingAddress(client.addresses);
    const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
    const billingEmail = chooseDefaultBillingEmail(client.emails);
    const activeProject =
      client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived')
      ?? client.projects.find((project) => project.status !== 'archived')
      ?? client.projects[0];
    const reservation = await reserveNumber();
    const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
    return ipcRoutes['documents:createFromClient'].result.parse({
      id: crypto.randomUUID(),
      clientId: client.id,
      clientNumber: client.customerNumber,
      projectId: activeProject?.id,
      number: reservation.number,
      numberReservationId: reservation.reservationId,
      client: client.company,
      clientEmail: billingEmail?.email ?? client.email,
      clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
      billingAddressJson: billingAddress ?? undefined,
      shippingAddressJson: shippingAddress ?? undefined,
      date: today,
      dueDate: kind === 'offer' ? today : (() => {
        if (!settings?.legal.paymentTermsDays) return today;
        const dueDate = new Date(today);
        dueDate.setDate(dueDate.getDate() + settings.legal.paymentTermsDays);
        return dueDate.toISOString().split('T')[0] ?? today;
      })(),
      amount: 0,
      status: 'draft',
      items: [],
      payments: [],
      history: [],
    });
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
    getTaxFilingStatus() {
      return requestJson({ parser: taxFilingRoutes['taxFiling:getStatus'].result }, '/api/v1/pro/tax-filing/status');
    },
    exportTaxAuditPackage(input: unknown) {
      return requestJson({
        method: 'POST',
        body: ipcRoutes['tax:auditExportPackage'].args.parse(input),
        parser: taxAuditExportArtifactSchema,
      }, '/api/v1/pro/tax/audit-export-package');
    },
    listTaxFilingRecords() {
      return requestJson({ parser: taxFilingRoutes['taxFiling:listRecords'].result }, '/api/v1/pro/tax-filing/records');
    },
    installTaxFilingCertificate(input: unknown) {
      return requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:installCertificate'].args.parse(input), parser: taxFilingRoutes['taxFiling:installCertificate'].result }, '/api/v1/pro/tax-filing/certificates');
    },
    removeTaxFilingCertificate(id: string) {
      return requestJson({ method: 'DELETE', parser: taxFilingRoutes['taxFiling:removeCertificate'].result }, `/api/v1/pro/tax-filing/certificates/${encodeURIComponent(id)}`);
    },
    validateTaxFiling(input: unknown) {
      return requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:validate'].args.parse(input), parser: taxFilingRoutes['taxFiling:validate'].result }, '/api/v1/pro/tax-filing/validate');
    },
    exportTaxFiling(input: unknown) {
      return requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:export'].args.parse(input), parser: taxFilingRoutes['taxFiling:export'].result }, '/api/v1/pro/tax-filing/export');
    },
    submitTaxFiling(input: unknown) {
      return requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:submit'].args.parse(input), parser: taxFilingRoutes['taxFiling:submit'].result }, '/api/v1/pro/tax-filing/submit');
    },
    listClients() {
      return requestJson({ parser: (input) => parseArray(clientSchema)(input).map((client) => client) }, '/api/v1/pro/clients');
    },
    saveClient(client: unknown) {
      return requestJson(
        {
          method: 'POST',
          body: { reason: 'Kunde gespeichert', client: ipcRoutes['clients:upsert'].args.parse({ client }).client },
          parser: clientSchema,
        },
        '/api/v1/pro/clients',
      );
    },
    deleteClient(id: string, reason = 'Kunde gelöscht') {
      return requestJson(
        { method: 'DELETE', body: { reason }, parser: (input) => input },
        `/api/v1/pro/clients/${encodeURIComponent(id)}`,
      );
    },
    listProjects(options?: { clientId?: string; includeArchived?: boolean }) {
      return requestJson(
        {
          parser: parseArray(projectSchema),
          query: options,
        },
        '/api/v1/pro/projects',
      );
    },
    getProject(id: string) {
      return requestJson(
        { parser: (input) => (input === null ? null : projectSchema.parse(input)) },
        `/api/v1/pro/projects/${encodeURIComponent(id)}`,
      );
    },
    saveProject(project: unknown, reason: string) {
      return requestJson(
        {
          method: 'POST',
          body: { reason, project: projectSchema.parse(project) },
          parser: projectSchema,
        },
        '/api/v1/pro/projects',
      );
    },
    archiveProject(id: string, reason: string) {
      return requestJson(
        {
          method: 'POST',
          body: { reason },
          parser: projectSchema,
        },
        `/api/v1/pro/projects/${encodeURIComponent(id)}/archive`,
      );
    },
    listInvoices() {
      return requestJson({ parser: parseArray(invoiceSchema) }, '/api/v1/pro/invoices');
    },
    listLegacyInvoices() {
      return requestJson({ parser: (input) => parseArray(invoiceSchema)(input).map(toLegacyInvoice) }, '/api/v1/pro/invoices');
    },
    saveInvoice(invoice: unknown, reason: string) {
      const parsed = ipcRoutes['invoices:upsert'].args.parse({ reason, invoice });
      return requestJson(
        {
          method: 'POST',
          body: { reason, invoice: toServerInvoicePayload(parsed.invoice) },
          parser: invoiceSchema,
        },
        '/api/v1/pro/invoices',
      );
    },
    createDocumentChain(input: unknown) {
      const parsed = ipcRoutes['documents:chainCreate'].args.parse(input);
      const endpoint = parsed.operation === 'order_confirmation'
        ? 'order-confirmations'
        : parsed.operation === 'delivery_note'
          ? 'delivery-notes'
          : parsed.operation === 'settlement_invoice'
            ? 'settlement-invoices'
            : parsed.operation === 'correction'
              ? 'corrections'
              : 'revisions';
      const { operation: _operation, ...body } = parsed;
      return requestJson({ method: 'POST', body, parser: invoiceSchema }, `/api/v1/pro/document-chain/${endpoint}`);
    },
    listDocumentChain(rootDocumentId: string) {
      return requestJson({ parser: parseArray(invoiceSchema) }, `/api/v1/pro/document-chain/${encodeURIComponent(rootDocumentId)}`);
    },
    deleteInvoice(id: string, reason: string) {
      return requestJson(
        { method: 'DELETE', body: { reason }, parser: (input) => input },
        `/api/v1/pro/invoices/${encodeURIComponent(id)}`,
      );
    },
    listOffers() {
      return requestJson({ parser: parseArray(offerSchema) }, '/api/v1/pro/offers');
    },
    listLegacyOffers() {
      return requestJson({ parser: (input) => parseArray(offerSchema)(input).map(toLegacyOffer) }, '/api/v1/pro/offers');
    },
    saveOffer(offer: unknown, reason: string) {
      const parsed = ipcRoutes['offers:upsert'].args.parse({ reason, offer });
      return requestJson(
        {
          method: 'POST',
          body: { reason, offer: toServerOfferPayload(parsed.offer) },
          parser: offerSchema,
        },
        '/api/v1/pro/offers',
      );
    },
    deleteOffer(id: string, reason: string) {
      return requestJson(
        { method: 'DELETE', body: { reason }, parser: (input) => input },
        `/api/v1/pro/offers/${encodeURIComponent(id)}`,
      );
    },
    listRecurringProfiles() {
      return requestJson({ parser: parseArray(recurringProfileSchema) }, '/api/v1/pro/recurring');
    },
    saveRecurringProfile(profile: unknown, reason = 'Wiederkehrendes Profil gespeichert') {
      const parsed = ipcRoutes['recurring:upsert'].args.parse({ profile });
      return requestJson(
        {
          method: 'POST',
          body: { reason, profile: parsed.profile },
          parser: recurringProfileSchema,
        },
        '/api/v1/pro/recurring',
      );
    },
    deleteRecurringProfile(id: string, reason = 'Wiederkehrendes Profil gelöscht') {
      return requestJson(
        { method: 'DELETE', body: { reason }, parser: (input) => input },
        `/api/v1/pro/recurring/${encodeURIComponent(id)}`,
      );
    },
    portalHealth(baseUrl: string) {
      return requestJson(
        { query: { baseUrl }, parser: ipcRoutes['portal:health'].result },
        '/api/v1/pro/portal/health',
      );
    },
    publishOfferToPortal(input: unknown) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['portal:publishOffer'].args.parse(input), parser: ipcRoutes['portal:publishOffer'].result },
        '/api/v1/pro/portal/publish-offer',
      );
    },
    publishInvoiceToPortal(input: unknown) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['portal:publishInvoice'].args.parse(input), parser: ipcRoutes['portal:publishInvoice'].result },
        '/api/v1/pro/portal/publish-invoice',
      );
    },
    syncOfferPortalStatus(offerId: string) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['portal:syncOfferStatus'].args.parse({ offerId }), parser: ipcRoutes['portal:syncOfferStatus'].result },
        '/api/v1/pro/portal/sync-offer-status',
      );
    },
    createCustomerAccessLink(input: unknown) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['portal:createCustomerAccessLink'].args.parse(input), parser: ipcRoutes['portal:createCustomerAccessLink'].result },
        '/api/v1/pro/portal/customer-access-link',
      );
    },
    rotateCustomerAccessLink(input: unknown) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['portal:rotateCustomerAccessLink'].args.parse(input), parser: ipcRoutes['portal:rotateCustomerAccessLink'].result },
        '/api/v1/pro/portal/customer-access-link/rotate',
      );
    },
    sendEmail(input: unknown) {
      return requestJson(
        { method: 'POST', body: ipcRoutes['email:send'].args.parse(input), parser: ipcRoutes['email:send'].result },
        '/api/v1/pro/email/send',
      );
    },
    testEmailConfig(input: unknown) {
      const parsed = ipcRoutes['email:testConfig'].args.parse(input);
      const { smtpPassword: _smtpPassword, resendApiKey: _resendApiKey, ...serverConfig } = parsed;
      return requestJson(
        { method: 'POST', body: serverConfig, parser: ipcRoutes['email:testConfig'].result },
        '/api/v1/pro/email/test-config',
      );
    },
    runDunningManually() {
      return requestJson(
        { method: 'POST', parser: ipcRoutes['dunning:manualRun'].result },
        '/api/v1/pro/dunning/manual-run',
      );
    },
    getDunningInvoiceStatus(invoiceId: string) {
      return requestJson(
        { parser: ipcRoutes['dunning:getInvoiceStatus'].result },
        `/api/v1/pro/dunning/invoices/${encodeURIComponent(invoiceId)}/status`,
      );
    },
    runRecurringManually() {
      return requestJson(
        { method: 'POST', parser: ipcRoutes['recurring:manualRun'].result },
        '/api/v1/pro/recurring/manual-run',
      );
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
    reserveNumber(kind: 'invoice' | 'offer' | 'customer') {
      return requestJson(
        {
          method: 'POST',
          body: ipcRoutes['numbers:reserve'].args.parse({ kind }),
          parser: (input) => ipcRoutes['numbers:reserve'].result.parse(input),
        },
        '/api/v1/pro/numbers/reserve',
      );
    },
    releaseNumber(reservationId: string) {
      return requestJson(
        {
          method: 'POST',
          body: ipcRoutes['numbers:release'].args.parse({ reservationId }),
          parser: (input) => ipcRoutes['numbers:release'].result.parse(input),
        },
        '/api/v1/pro/numbers/release',
      );
    },
    finalizeNumber(reservationId: string, documentId: string) {
      return requestJson(
        {
          method: 'POST',
          body: ipcRoutes['numbers:finalize'].args.parse({ reservationId, documentId }),
          parser: (input) => ipcRoutes['numbers:finalize'].result.parse(input),
        },
        '/api/v1/pro/numbers/finalize',
      );
    },
    async createDocumentFromClient(input: unknown) {
      const parsed = ipcRoutes['documents:createFromClient'].args.parse(input);
      const client = await requestJson(
        { parser: (payload) => clientSchema.nullable().parse(payload) },
        `/api/v1/pro/clients/${encodeURIComponent(parsed.clientId)}`,
      );
      if (!client) throw new Error('Kunde nicht gefunden.');
      return buildProDraftFromClient(parsed.kind, client, await this.getSettings(), () => this.reserveNumber(parsed.kind));
    },
    async convertOfferToInvoice(input: unknown) {
      const parsed = ipcRoutes['documents:convertOfferToInvoice'].args.parse(input);
      const saved = await requestJson({
        method: 'POST',
        body: { offerId: parsed.offerId, invoiceId: crypto.randomUUID() },
        parser: invoiceSchema,
      }, '/api/v1/pro/documents/convert-offer');
      return toLegacyInvoice(saved);
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
    deleteArticle(id: string) {
      return requestJson(
        { method: 'DELETE', parser: (input) => input },
        `/api/v1/pro/articles/${encodeURIComponent(id)}`,
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
    deleteAccount(id: string) {
      return requestJson(
        { method: 'DELETE', parser: (input) => input },
        `/api/v1/pro/accounts/${encodeURIComponent(id)}`,
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
    deleteTemplate(id: string) {
      return requestJson(
        { method: 'DELETE', parser: (input) => input },
        `/api/v1/pro/templates/${encodeURIComponent(id)}`,
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
    listTransactions(filters?: { accountId?: string; type?: 'income' | 'expense'; linkedOnly?: boolean; unlinkedOnly?: boolean }) {
      return requestJson({ parser: parseArray(transactionSchema), query: filters }, '/api/v1/pro/transactions');
    },
    findTransactionMatches(transactionId: string) {
      return requestJson({ parser: (input) => {
        const result = serverTransactionMatchesSchema.parse(input);
        return {
          transaction: result.transaction,
          suggestions: result.suggestions.map((suggestion) => ({ ...suggestion, invoice: toLegacyInvoice(suggestion.invoice) })),
        };
      } }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/matches`);
    },
    linkTransaction(transactionId: string, invoiceId: string, reason = 'Zahlung automatisch mit Rechnung verknüpft') {
      return requestJson({
        method: 'POST',
        body: { invoiceId, reason },
        parser: (input) => {
          const result = z.object({ success: z.literal(true), invoice: invoiceSchema }).parse(input);
          return { success: result.success, invoice: toLegacyInvoice(result.invoice) };
        },
      }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/link`);
    },
    unlinkTransaction(transactionId: string, reason = 'Zahlungsverknüpfung aufgehoben') {
      return requestJson({ method: 'POST', body: { reason }, parser: z.object({ success: z.literal(true) }) }, `/api/v1/pro/transactions/${encodeURIComponent(transactionId)}/unlink`);
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
    getAccountingDraftByTransactionId(transactionId: string) {
      return requestJson(
        { parser: (input) => (input === null ? null : bookingDraftEntitySchema.parse(input)) },
        `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`,
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
    getAccountingJournalEntryById(entryId: string) {
      return requestJson(
        { parser: (input) => (input === null ? null : journalEntryEntitySchema.parse(input)) },
        `/api/v1/pro/accounting/journal/${encodeURIComponent(entryId)}`,
      );
    },
    getAccountingBalances(query?: string | { asOfDate?: string; from?: string; to?: string }) {
      const normalized = typeof query === 'string' ? { asOfDate: query } : query;
      return requestJson({ parser: parseArray(ledgerBalanceRowSchema), query: normalized }, '/api/v1/pro/accounting/balances');
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
    getEurReport(query?: { taxYear?: number; from?: string; to?: string }) {
      return requestJson({ parser: eurReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/eur');
    },
    exportEurCsv(query?: { taxYear?: number; from?: string; to?: string }) {
      return requestText('/api/v1/pro/accounting/reports/eur/export.csv', query);
    },
    listEurRules(taxYear: number) {
      return requestJson({ parser: parseArray(eurRuleSchema), query: { taxYear } }, '/api/v1/pro/accounting/reports/eur/rules');
    },
    saveEurRule(input: IpcArgs<'eur:upsertRule'>) {
      return requestJson({ method: 'POST', body: { ...input, reason: EUR_RULE_MUTATION_REASON }, parser: eurRuleSchema }, '/api/v1/pro/accounting/reports/eur/rules');
    },
    deleteEurRule(id: string) {
      return requestJson({ method: 'DELETE', body: { reason: EUR_RULE_DELETE_REASON }, parser: z.object({ ok: z.literal(true) }) }, `/api/v1/pro/accounting/reports/eur/rules/${encodeURIComponent(id)}`);
    },
    verifyAudit() {
      return requestJson({ parser: z.object({ ok: z.boolean(), errors: z.array(z.object({ sequence: z.number(), message: z.string() })), count: z.number(), headHash: z.string().nullable() }) }, '/api/v1/pro/audit/verify');
    },
    exportAuditCsv() {
      return requestText('/api/v1/pro/audit/export.csv');
    },
    listEurCashItems(query?: Partial<IpcArgs<'eur:listItems'>>) {
      return requestJson({ parser: parseArray(eurCashItemSchema), query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/eur/items');
    },
    upsertEurClassification(input: { sourceType: 'transaction' | 'invoice'; sourceId: string; taxYear: number; eurLineId?: string; excluded?: boolean; vatMode?: 'none' | 'default'; vatRate?: number; note?: string; reason: string }) {
      return requestJson({ method: 'PUT', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/reports/eur/classifications');
    },
    saveEurCashFact(input: { sourceType: 'transaction' | 'invoice'; sourceId: string; taxYear: number; kind: string; amountNet: number; flowType?: 'income' | 'expense'; eurLineId?: string; splits?: unknown[]; reason: string; idempotencyKey?: string }) {
      return requestJson({ method: 'POST', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/reports/eur/facts/cash');
    },
    listEurCashFacts(taxYear: number) {
      return requestJson({ parser: parseArray((input) => input), query: { taxYear } }, '/api/v1/pro/accounting/reports/eur/facts/cash');
    },
    saveEurAnnexFact(input: { taxYear: number; annex: string; lineId: string; amount: number; sourceId?: string; date?: string; reason: string; idempotencyKey?: string }) {
      return requestJson({ method: 'POST', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/reports/eur/facts/annex');
    },
    listEurAnnexFacts(taxYear: number, annex?: string) {
      return requestJson({ parser: parseArray((input) => input), query: { taxYear, annex } }, '/api/v1/pro/accounting/reports/eur/facts/annex');
    },
    listAccountingSourceRuns() {
      return requestJson({ parser: parseArray(accountingSourceRunParser) }, '/api/v1/pro/accounting/source-runs');
    },
    getAccountingSourceRun(id: string) {
      return requestJson(
        { parser: (input) => (input === null ? null : parseAccountingSourceRun(input)) },
        `/api/v1/pro/accounting/source-runs/${encodeURIComponent(id)}`,
      );
    },
    postAccountingSource(input: Omit<AccountingCommandRequest, 'kind' | 'domainFacts'>) {
      return postAccountingCommand({ ...input, kind: 'standalone' });
    },
    postAccountingCommand,
    prepareTaxExport(input: { kind: 'ustva' | 'zm' | 'oss'; period: string; year?: number; reason: string; idempotencyKey?: string }) {
      return requestJson({ method: 'POST', body: { ...input, idempotencyKey: input.idempotencyKey ?? `tax:${input.kind}:${input.period}` }, parser: (payload) => payload as { artifact: unknown; run?: unknown; replayed?: boolean } }, '/api/v1/pro/accounting/tax-exports/prepare');
    },
    exportTaxArtifact(kind: 'ustva' | 'zm' | 'oss', id: string) {
      return requestBlob(`/api/v1/pro/accounting/tax-exports/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/export`);
    },
    getGuvReport(query?: unknown) {
      return requestJson({ parser: parseServerLegacyGuvReport, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/guv');
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
    getReportingReport(query: IpcArgs<'pro:getReportingReport'>) {
      const parsed = ipcRoutes['pro:getReportingReport'].args.parse(query);
      const pathByKind = {
        bwa01: '/api/v1/pro/accounting/reports/bwa01',
        'management-guv': '/api/v1/pro/accounting/reports/management-guv',
        'hgb-guv': '/api/v1/pro/accounting/reports/hgb-guv',
        'hgb-bilanz': '/api/v1/pro/accounting/reports/hgb-bilanz',
      } as const;
      const { kind, ...range } = parsed;
      return requestJson(
        { parser: (input) => ipcRoutes['pro:getReportingReport'].result.parse(input), query: range },
        pathByKind[kind],
      );
    },
    getBilanzReport(asOfDate?: string | { asOfDate?: string; chart?: 'SKR03' | 'SKR04'; profile?: string }) {
      const query = typeof asOfDate === 'string' ? { asOfDate } : asOfDate;
      return requestJson({ parser: bilanzReportSchema, query }, '/api/v1/pro/accounting/reports/bilanz');
    },
    listReportSnapshots(reportType?: string) {
      return requestJson({ parser: parseArray(reportSnapshotParser), query: reportType ? { reportType } : undefined }, '/api/v1/pro/accounting/reports/snapshots');
    },
    getReportSnapshot(id: string) {
      return requestJson({ parser: (input) => input }, `/api/v1/pro/accounting/reports/snapshots/${encodeURIComponent(id)}`);
    },
    createReportSnapshot(input: { reportType: string; taxYear?: 2025 | 2026; from?: string; to?: string; asOfDate?: string; chart?: 'SKR03' | 'SKR04'; profile?: string; reason: string }) {
      return requestJson({ method: 'POST', body: input, parser: reportSnapshotParser }, '/api/v1/pro/accounting/reports/snapshots');
    },
    getAccountMappingHealth(chart?: 'SKR03' | 'SKR04', reportType?: 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz', asOfDate?: string) {
      return requestJson({ parser: z.object({ chart: z.enum(['SKR03', 'SKR04']).optional(), unmapped: z.array(z.object({ accountNumber: z.string(), statementType: z.string() })).optional() }), query: chart || reportType || asOfDate ? { chart, reportType, asOfDate } : undefined }, '/api/v1/pro/accounting/mappings/health');
    },
    listReportMappingPositions(reportType: 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz', asOfDate: string) {
      return requestJson({ parser: parseArray(z.object({ key: z.string(), label: z.string(), kind: z.enum(['heading', 'line', 'subtotal', 'result']), side: z.enum(['asset', 'liability']).optional() })), query: { reportType, asOfDate } }, '/api/v1/pro/accounting/mappings/positions');
    },
    saveAccountMappingOverride(input: { chart: 'SKR03' | 'SKR04'; asOfDate: string; accountNumber: string; statementType: 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz'; positionKey: string; positionLabel: string; balanceSide?: 'asset' | 'liability'; reason: string }) {
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
      const { assetId } = args;
      const body = { ...args };
      return requestJson({ method: 'POST', body, parser: assetDepreciationResultSchema }, `/api/v1/pro/accounting/assets/${encodeURIComponent(assetId)}/depreciation`);
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
      const { assetId } = args;
      const body = { ...args };
      return requestJson({ method: 'POST', body, parser: assetDisposalResultSchema }, `/api/v1/pro/accounting/assets/${encodeURIComponent(assetId)}/dispose`);
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
      return requestJson({ parser: parseArray(datevExportResultSchema) }, '/api/v1/pro/accounting/datev/exports').then((rows) => (limit ? rows.slice(0, limit) : rows).map((row) => (
        row.sha256 === undefined && row.contentSha256 !== undefined
          ? { ...row, sha256: row.contentSha256 }
          : row
      )));
    },
    setAccountingPolicy(input: unknown, reason = 'Kontierungspolitik geändert') {
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
      return requestJson({
        method: 'POST',
        body: {
          vendor: vendorSchema.omit({ tenantId: true, createdAt: true, updatedAt: true }).parse(vendor),
          reason,
        },
        parser: vendorSchema,
      }, '/api/v1/pro/accounting/vendors');
    },
    listIncomingInvoices() {
      return requestJson({ parser: parseArray(incomingInvoiceSchema) }, '/api/v1/pro/accounting/incoming-invoices');
    },
    saveIncomingInvoice(invoice: unknown, reason: string) {
      return requestJson({
        method: 'POST',
        body: {
          invoice: incomingInvoiceSchema.omit({ tenantId: true, createdAt: true, updatedAt: true, accountingStatus: true, accountingSnapshot: true }).parse(invoice),
          reason,
        },
        parser: incomingInvoiceSchema,
      }, '/api/v1/pro/accounting/incoming-invoices');
    },
    listIncomingInvoiceDocuments(invoiceId: string) {
      return requestJson({ parser: parseArray(incomingInvoiceDocumentSchema) }, `/api/v1/pro/accounting/incoming-invoices/${encodeURIComponent(invoiceId)}/documents`);
    },
    uploadIncomingInvoiceDocument(input: { invoiceId: string; originalFilename: string; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; data: string; reason: string }) {
      return requestJson({ method: 'POST', body: { originalFilename: input.originalFilename, mimeType: input.mimeType, data: input.data, reason: input.reason }, parser: incomingInvoiceDocumentSchema }, `/api/v1/pro/accounting/incoming-invoices/${encodeURIComponent(input.invoiceId)}/documents`);
    },
    downloadIncomingInvoiceDocument(documentId: string) {
      return requestJson({ parser: incomingInvoiceDocumentDownloadSchema }, `/api/v1/pro/accounting/incoming-invoice-documents/${encodeURIComponent(documentId)}/download`);
    },
    reviewIncomingInvoiceDocument(input: { documentId: string; reviewStatus: 'accepted' | 'rejected'; reason: string }) {
      return requestJson({ method: 'POST', body: { reviewStatus: input.reviewStatus, reason: input.reason }, parser: incomingInvoiceDocumentSchema }, `/api/v1/pro/accounting/incoming-invoice-documents/${encodeURIComponent(input.documentId)}/review`);
    },
    listOpenItems() {
      return requestJson({ parser: parseArray(openItemSchema) }, '/api/v1/pro/accounting/open-items');
    },
    previewOutgoingInvoice(invoiceId: string, reason = 'Vorschau', options: Record<string, unknown> = {}) {
      return requestJson({ method: 'POST', body: { invoiceId, reason, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/outgoing-invoices/preview');
    },
    postOutgoingInvoice(invoiceId: string, reason: string, reservationId: string, options: Record<string, unknown> = {}) {
      if (!reservationId.trim()) throw new Error('Reservierungs-ID fehlt.');
      return requestJson({ method: 'POST', body: { invoiceId, reason, reservationId, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/outgoing-invoices/post');
    },
    previewIncomingInvoice(invoiceId: string, reason = 'Vorschau', options: Record<string, unknown> = {}) {
      return requestJson({ method: 'POST', body: { invoiceId, reason, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/incoming-invoices/preview');
    },
    postIncomingInvoice(invoiceId: string, reason: string, options: Record<string, unknown> = {}) {
      return requestJson({ method: 'POST', body: { invoiceId, reason, ...options }, parser: accountingPostingPreviewSchema }, '/api/v1/pro/accounting/incoming-invoices/post');
    },
    allocateOpenItemPayment(payment: ProOpenItemPaymentInput, reason: string) {
      if (typeof payment.allocationEventId !== 'string' || !payment.allocationEventId.trim()) throw new Error('Zuordnungs-ID fehlt.');
      return requestJson({ method: 'POST', body: { payment, reason }, parser: (input) => input }, '/api/v1/pro/accounting/open-items/payments');
    },
    allocateRemainingOpenItemPayment(paymentId: string, allocations: unknown, reason: string, allocationEventId: string) {
      if (!allocationEventId.trim()) throw new Error('Zuordnungs-ID fehlt.');
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
          body: proWorkflowEntrySchema.omit({ updatedAt: true }).parse(entry),
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
    getLedgerStats,
    getOpenRouterVlmConfig,
    analyzeTransactionDocument,
    async importSkr(input: unknown = {}) {
      ipcRoutes['pro:importSkr'].args.parse(input);
      const stats = await getLedgerStats();
      return ipcRoutes['pro:importSkr'].result.parse({
        source: 'none',
        sourceDetails: ['server://pglite-migrations'],
        inserted: 0,
        updated: 0,
        total: stats.total,
        skipped: 0,
        warnings: ['Der Kontenrahmen wird im Embedded-/PGlite-Modus durch Migrationen verwaltet; es wurde kein Import ausgeführt.'],
        stats,
      });
    },
    validateTaxCompliance(input: unknown, reason = 'Steuerliche Compliance geprüft') {
      const parsed = ipcRoutes['pro:validateTaxCompliance'].args.parse(input);
      return requestJson(
        {
          method: 'POST',
          body: { ...parsed, reason },
          parser: (payload) => ipcRoutes['pro:validateTaxCompliance'].result.parse(payload),
        },
        '/api/v1/pro/accounting/validate',
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
    financeImportPreview(input: unknown) {
      const parsed = ipcRoutes['finance:importPreview'].args.parse(input);
      return requestJson(
        {
          method: 'POST',
          body: parsed,
          parser: ipcRoutes['finance:importPreview'].result,
        },
        '/api/v1/pro/finance/import/preview',
      );
    },
    financeImportCommit(input: unknown) {
      const parsed = ipcRoutes['finance:importCommit'].args.parse(input);
      return requestJson(
        {
          method: 'POST',
          body: parsed,
          parser: ipcRoutes['finance:importCommit'].result,
        },
        '/api/v1/pro/finance/import/commit',
      );
    },
    financeListImportBatches(input: unknown) {
      const parsed = ipcRoutes['finance:listImportBatches'].args.parse(input);
      return requestJson(
        {
          query: parsed,
          parser: ipcRoutes['finance:listImportBatches'].result,
        },
        '/api/v1/pro/finance/import-batches',
      );
    },
    financeGetImportBatchDetails(input: unknown) {
      const parsed = ipcRoutes['finance:getImportBatchDetails'].args.parse(input);
      return requestJson(
        {
          parser: ipcRoutes['finance:getImportBatchDetails'].result,
        },
        `/api/v1/pro/finance/import-batches/${encodeURIComponent(parsed.batchId)}`,
      );
    },
    financeRollbackImportBatch(input: unknown) {
      const parsed = ipcRoutes['finance:rollbackImportBatch'].args.parse(input);
      return requestJson(
        {
          method: 'POST',
          body: { reason: parsed.reason },
          parser: ipcRoutes['finance:rollbackImportBatch'].result,
        },
        `/api/v1/pro/finance/import-batches/${encodeURIComponent(parsed.batchId)}/rollback`,
      );
    },
  };
};

export type ProWebClient = ReturnType<typeof createProWebClient>;

export type ProHttpApiOptions = ProWebClientConfig & {
  fallback?: IpcInvoke;
  /** Test seam for asserting fail-closed behavior on unknown contract keys. */
  onInvoke?: (invoke: IpcInvoke) => void;
  /** Optional browser download seam; DOM-less callers receive the receipt without a fake download. */
  downloadBlob?: ProBlobDownloader;
};

export type ProHttpBillmeApi = BillmeApi;

export const createProHttpBillmeApi = ({ fallback, onInvoke, downloadBlob, ...clientConfig }: ProHttpApiOptions): ProHttpBillmeApi => {
  const { embeddedConnectionResolver } = clientConfig;
  const client = createProWebClient(clientConfig);

  const invoke: IpcInvoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    if (!Object.prototype.hasOwnProperty.call(ipcRoutes, key)) {
      throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    }
    // Resolve availability before dispatching so an unsupported server-owned
    // route can never fall through to the legacy SQLite IPC adapter while the
    // embedded PGlite server is live. A missing embedded server still gets the
    // existing transition fallback below.
    if (embeddedConnectionResolver && isServerOwnedRoute(key)) {
      const connection = await embeddedConnectionResolver();
      if (!connection) {
        if (fallback) return fallback(key, args);
        throw new ProEmbeddedConnectionUnavailableError();
      }
    }
    try {
      switch (key) {
        case 'pro:listLedgerAccounts': {
          const parsedArgs = ipcRoutes[key].args.parse(args);
          const result = await client.listLedgerAccounts(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listTaxCases': {
          const parsedArgs = ipcRoutes[key].args.parse(args);
          const result = await client.listTaxCases(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listTaxCaseAccountMappings': {
          const parsedArgs = ipcRoutes[key].args.parse(args);
          const result = await client.listTaxCaseMappings(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertTaxCaseAccountMapping': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertTaxCaseAccountMapping'>;
          const result = await client.saveTaxCaseMapping({
            ...parsedArgs,
            reason: parsedArgs.reason ?? 'Steuerschlüssel-Zuordnung gespeichert',
          });
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listAccountSuggestionRules': {
          const parsedArgs = ipcRoutes[key].args.parse(args);
          const result = await client.listAccountSuggestionRules(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertAccountSuggestionRule': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAccountSuggestionRule'>;
          const result = await client.saveAccountSuggestionRule({
            ...parsedArgs,
            reason: parsedArgs.reason ?? 'Kontierungsvorschlagsregel gespeichert',
          });
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:deleteAccountSuggestionRule': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:deleteAccountSuggestionRule'>;
          const result = await client.deleteAccountSuggestionRule(parsedArgs.id, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertWorkflowEntry': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertWorkflowEntry'>;
          const result = await client.upsertWorkflowEntry(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:setAccountingPolicy': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:setAccountingPolicy'>;
          const result = await client.setAccountingPolicy(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertVendor': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertVendor'>;
          const result = await client.saveAccountingVendor(parsedArgs.vendor, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertIncomingInvoice': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertIncomingInvoice'>;
          const result = await client.saveIncomingInvoice(parsedArgs.invoice, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'documents:chainCreate': {
          const result = await client.createDocumentChain(args);
          return ipcRoutes[key].result.parse(toLegacyInvoice(result)) as IpcResult<K>;
        }
        case 'documents:chainList': {
          const parsed = ipcRoutes[key].args.parse(args) as IpcArgs<'documents:chainList'>;
          const result = await client.listDocumentChain(parsed.rootDocumentId);
          return ipcRoutes[key].result.parse(result.map(toLegacyInvoice)) as IpcResult<K>;
        }
        case 'pro:listIncomingInvoiceDocuments': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listIncomingInvoiceDocuments'>;
          const result = await client.listIncomingInvoiceDocuments(parsedArgs.invoiceId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:uploadIncomingInvoiceDocument': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:uploadIncomingInvoiceDocument'>;
          const result = await client.uploadIncomingInvoiceDocument(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:downloadIncomingInvoiceDocument': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:downloadIncomingInvoiceDocument'>;
          const result = await client.downloadIncomingInvoiceDocument(parsedArgs.documentId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:reviewIncomingInvoiceDocument': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:reviewIncomingInvoiceDocument'>;
          const result = await client.reviewIncomingInvoiceDocument(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:previewOutgoingInvoiceAccounting': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:previewOutgoingInvoiceAccounting'>;
          const { invoiceId, ...options } = parsedArgs;
          const result = await client.previewOutgoingInvoice(invoiceId, 'Vorschau', options);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:postOutgoingInvoiceAccounting': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postOutgoingInvoiceAccounting'>;
          const { invoiceId, reservationId, ...options } = parsedArgs;
          const result = await client.postOutgoingInvoice(invoiceId, 'Ausgangsrechnung gebucht', reservationId, options);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:previewIncomingInvoiceAccounting': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:previewIncomingInvoiceAccounting'>;
          const { invoiceId, ...options } = parsedArgs;
          const result = await client.previewIncomingInvoice(invoiceId, 'Vorschau', options);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:postIncomingInvoiceAccounting': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postIncomingInvoiceAccounting'>;
          const { invoiceId, reason, ...options } = parsedArgs;
          const result = await client.postIncomingInvoice(invoiceId, reason, options);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:allocateOpenItemPayment': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:allocateOpenItemPayment'>;
          const { reason, ...payment } = parsedArgs.payment;
          const result = await client.allocateOpenItemPayment(payment, reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:allocateRemainingPayment': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:allocateRemainingPayment'>;
          const result = await client.allocateRemainingOpenItemPayment(
            parsedArgs.paymentId,
            parsedArgs.allocations,
            parsedArgs.reason,
            parsedArgs.allocationEventId,
          );
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:reverseDocumentAccounting': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:reverseDocumentAccounting'>;
          const result = await client.reverseDocumentAccounting(parsedArgs, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:previewAccountingBackfill': {
          ipcRoutes[key].args.parse(args);
          const result = await client.previewAccountingBackfill();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:confirmAccountingBackfill': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:confirmAccountingBackfill'>;
          const result = await client.confirmAccountingBackfill(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listWorkflowEntries': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listWorkflowEntries();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getAccountingPolicy': {
          ipcRoutes[key].args.parse(args);
          const result = await client.getAccountingPolicy();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listVendors': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listAccountingVendors();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listIncomingInvoices': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listIncomingInvoices();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listOpenItems': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listOpenItems();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getAccountingHealth': {
          ipcRoutes[key].args.parse(args);
          const result = await client.getAccountingHealth();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getVatSummary': {
          const parsedArgs = ipcRoutes[key].args.parse(args);
          const result = await client.getVatSummary(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getLedgerStats': {
          ipcRoutes[key].args.parse(args);
          const result = await client.getLedgerStats();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getOpenRouterVlmConfig': {
          ipcRoutes[key].args.parse(args);
          const result = await client.getOpenRouterVlmConfig();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:analyzeTransactionDocument': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:analyzeTransactionDocument'>;
          const result = await client.analyzeTransactionDocument(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:validateTaxCompliance': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:validateTaxCompliance'>;
          const result = await client.validateTaxCompliance(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:importSkr': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:importSkr'>;
          const result = await client.importSkr(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listBankTransactions': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listAccountingTransactions();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'transactions:list': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:list'>;
          const result = await client.listTransactions(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'transactions:findMatches': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:findMatches'>;
          const result = await client.findTransactionMatches(parsedArgs.transactionId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'transactions:link': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:link'>;
          const result = await client.linkTransaction(parsedArgs.transactionId, parsedArgs.invoiceId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'transactions:unlink': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'transactions:unlink'>;
          const result = await client.unlinkTransaction(parsedArgs.transactionId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'finance:importPreview': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:importPreview'>;
          const result = await client.financeImportPreview(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'finance:importCommit': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:importCommit'>;
          const result = await client.financeImportCommit(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'finance:listImportBatches': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:listImportBatches'>;
          const result = await client.financeListImportBatches(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'finance:getImportBatchDetails': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:getImportBatchDetails'>;
          const result = await client.financeGetImportBatchDetails(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'finance:rollbackImportBatch': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'finance:rollbackImportBatch'>;
          const result = await client.financeRollbackImportBatch(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getDraftByTransactionId': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getDraftByTransactionId'>;
          const result = await client.getAccountingDraftByTransactionId(parsedArgs.transactionId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:saveDraft': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:saveDraft'>;
          const result = await client.saveAccountingDraft(parsedArgs.draft, 'Buchungsentwurf gespeichert');
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:dispatchDraftAction': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:dispatchDraftAction'>;
          const result = await client.dispatchAccountingDraftAction(
            parsedArgs.transactionId,
            parsedArgs.action,
            'Buchungsworkflow-Aktion ausgeführt',
            parsedArgs.rejectReason,
          );
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:postDraft': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postDraft'>;
          const { draftId, ...options } = parsedArgs;
          const result = await client.postAccountingDraft(draftId, {
            ...options,
            reason: 'Buchungsentwurf gebucht',
          });
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:reverseJournalEntry': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:reverseJournalEntry'>;
          const { entryId, ...options } = parsedArgs;
          const result = await client.reverseAccountingJournalEntry(entryId, options);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listJournalEntries': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listJournalEntries'>;
          const result = await client.listAccountingJournalEntries(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getJournalEntryById': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getJournalEntryById'>;
          const result = await client.getAccountingJournalEntryById(parsedArgs.entryId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getLedgerBalances': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getLedgerBalances'>;
          const result = await client.getAccountingBalances(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listAccountingSourceRuns': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listAccountingSourceRuns();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getAccountingSourceRun': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getAccountingSourceRun'>;
          const result = await client.getAccountingSourceRun(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:postAccountingSource': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postAccountingSource'>;
          const result = await client.postAccountingSource(parsedArgs);
          return ipcRoutes[key].result.parse(parseAccountingSourcePostResult(result, parsedArgs.source)) as IpcResult<K>;
        }
        case 'pro:postAccountingCommand': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:postAccountingCommand'>;
          const result = await client.postAccountingCommand(parsedArgs);
          return ipcRoutes[key].result.parse(parseAccountingSourcePostResult(result, parsedArgs.source)) as IpcResult<K>;
        }
        case 'pro:getSusaReport': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getSusaReport'>;
          const result = await client.getSusaReport(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getGuvReport': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getGuvReport'>;
          const result = await client.getGuvReport(parsedArgs);
          return ipcRoutes[key].result.parse({
            from: result.from,
            to: result.to,
            chart: result.chart,
            rows: result.rows.map((row) => ({ positionKey: row.position, positionLabel: row.label, amount: row.amount, accountRefs: row.accountRefs ?? row.accountNumbers })),
            netResult: result.netResult,
            unmappedAccounts: result.mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
            blocking: result.mappingHealth.blocking,
          }) as IpcResult<K>;
        }
        case 'pro:getBilanzReport': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getBilanzReport'>;
          const report = await client.getBilanzReport(parsedArgs);
          const result = {
            asOfDate: report.snapshot.asOfDate ?? parsedArgs.asOfDate ?? new Date().toISOString().slice(0, 10),
            assets: report.assets.flatMap((row) => row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount }))),
            liabilities: report.liabilities.flatMap((row) => row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount }))),
            totals: report.totals,
            unmappedAccounts: report.mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
            blocking: report.mappingHealth.blocking,
          };
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getReportingReport': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getReportingReport'>;
          const result = await client.getReportingReport(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listReportSnapshots': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listReportSnapshots'>;
          const result = await client.listReportSnapshots(parsedArgs.reportType);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:saveReportSnapshot': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:saveReportSnapshot'>;
          const snapshotArgs = isRecord(parsedArgs.args) ? parsedArgs.args : {};
          const result = await client.createReportSnapshot({
            reportType: parsedArgs.reportType,
            taxYear: snapshotArgs.taxYear === 2025 || snapshotArgs.taxYear === 2026 ? snapshotArgs.taxYear : undefined,
            from: typeof snapshotArgs.from === 'string' ? snapshotArgs.from : undefined,
            to: typeof snapshotArgs.to === 'string' ? snapshotArgs.to : undefined,
            asOfDate: typeof snapshotArgs.asOfDate === 'string' ? snapshotArgs.asOfDate : undefined,
            chart: snapshotArgs.chart === 'SKR03' || snapshotArgs.chart === 'SKR04' ? snapshotArgs.chart : undefined,
            profile: typeof snapshotArgs.profile === 'string' ? snapshotArgs.profile : undefined,
            reason: parsedArgs.reason,
          });
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getReportMappingHealth': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getReportMappingHealth'>;
          const report = await client.getAccountMappingHealth(parsedArgs.chart, parsedArgs.statement, parsedArgs.asOfDate);
          const result = {
            chart: report.chart,
            unmapped: (report.unmapped ?? []).map((item) => ({
              accountNumber: item.accountNumber,
              statement: parsedArgs.statement ?? item.statementType,
            })),
          };
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listReportMappingPositions': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listReportMappingPositions'>;
          const result = await client.listReportMappingPositions(parsedArgs.statement, parsedArgs.asOfDate);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertReportMappingOverride': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertReportMappingOverride'>;
          const result = await client.saveAccountMappingOverride({
            chart: parsedArgs.chart,
            asOfDate: parsedArgs.asOfDate,
            accountNumber: parsedArgs.accountNumber,
            statementType: parsedArgs.statement,
            positionKey: parsedArgs.position,
            positionLabel: parsedArgs.label,
            balanceSide: parsedArgs.side,
            reason: parsedArgs.reason,
          });
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listAssets': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listAssets();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertAsset': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAsset'>;
          const result = await client.upsertAsset(parsedArgs.asset, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:getDepreciationSchedule': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:getDepreciationSchedule'>;
          const result = await client.getDepreciationSchedule(parsedArgs.assetId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:runDepreciation': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:runDepreciation'>;
          const result = await client.runDepreciation(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:disposeAsset': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:disposeAsset'>;
          const result = await client.disposeAsset(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:exportDatevBuchungsstapel': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:exportDatevBuchungsstapel'>;
          if (!parsedArgs.from || !parsedArgs.to || parsedArgs.consultantNumber === undefined || parsedArgs.clientNumber === undefined || !parsedArgs.fiscalYearStart || parsedArgs.accountLength === undefined) {
            throw new Error('DATEV Export benötigt Beraternummer, Mandantennummer, Wirtschaftsjahresbeginn, Kontenlänge und einen Zeitraum.');
          }
          const exported = await client.exportDatevCsv({
            from: parsedArgs.from,
            to: parsedArgs.to,
            consultantNumber: String(parsedArgs.consultantNumber),
            clientNumber: String(parsedArgs.clientNumber),
            fiscalYearStart: parsedArgs.fiscalYearStart,
            accountLength: parsedArgs.accountLength,
            encoding: parsedArgs.encoding ?? 'cp1252',
            reason: 'DATEV-Buchungsstapel exportiert',
          });
          if (!exported.exportId) throw new Error('DATEV-Export ohne Serverbeleg-ID.');
          const history = await client.listDatevExports();
          const receipt = history.find((item) => item.id === exported.exportId);
          if (!receipt) throw new Error('DATEV-Export wurde nicht in der Serverhistorie gefunden.');
          const parsedReceipt = ipcRoutes[key].result.parse(receipt) as IpcResult<K>;
          await validateDatevExportReceipt(exported, parsedReceipt as DatevExportReceiptMetadata);
          (downloadBlob ?? downloadBlobInBrowser)(exported.blob, `datev-buchungsstapel-${parsedArgs.from}-${parsedArgs.to}.csv`);
          return parsedReceipt;
        }
        case 'pro:listDatevExports': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listDatevExports'>;
          const result = await client.listDatevExports(parsedArgs.limit);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:listAccountingAccountMappings': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listAccountingAccountMappings'>;
          const result = await client.listAccountingMappings(parsedArgs.chart);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:upsertAccountingAccountMapping': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:upsertAccountingAccountMapping'>;
          const result = await client.saveAccountingMapping(parsedArgs, 'Kontenzuordnung gespeichert');
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:getReport': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:getReport'>;
          const report = await client.getEurReport(parsedArgs);
          return ipcRoutes[key].result.parse({
            ...report,
            rows: report.rows.map(({ id, ...row }) => ({ ...row, lineId: id })),
          }) as IpcResult<K>;
        }
        case 'eur:exportCsv': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:exportCsv'>;
          const result = await client.exportEurCsv(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'audit:verify': {
          ipcRoutes[key].args.parse(args);
          const result = await client.verifyAudit();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'audit:exportCsv': {
          ipcRoutes[key].args.parse(args);
          const result = await client.exportAuditCsv();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:listRules': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listRules'>;
          const result = await client.listEurRules(parsedArgs.taxYear);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:upsertRule': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:upsertRule'>;
          const result = await client.saveEurRule(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:deleteRule': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:deleteRule'>;
          const result = await client.deleteEurRule(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:listItems': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listItems'>;
          const result = await client.listEurCashItems(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:upsertClassification': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:upsertClassification'>;
          const result = await client.upsertEurClassification(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:saveCashFact': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:saveCashFact'>;
          const result = await client.saveEurCashFact(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:listCashFacts': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listCashFacts'>;
          const result = await client.listEurCashFacts(parsedArgs.taxYear);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:saveAnnexFact': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:saveAnnexFact'>;
          const result = await client.saveEurAnnexFact(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'eur:listAnnexFacts': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'eur:listAnnexFacts'>;
          const result = await client.listEurAnnexFacts(parsedArgs.taxYear, parsedArgs.annex);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'invoices:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listLegacyInvoices();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'invoices:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'invoices:upsert'>;
          const result = await client.saveInvoice(parsedArgs.invoice, parsedArgs.reason);
          return ipcRoutes[key].result.parse(toLegacyInvoice(result)) as IpcResult<K>;
        }
        case 'invoices:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'invoices:delete'>;
          const result = await client.deleteInvoice(parsedArgs.id, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'offers:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listLegacyOffers();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'offers:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'offers:upsert'>;
          const result = await client.saveOffer(parsedArgs.offer, parsedArgs.reason);
          return ipcRoutes[key].result.parse(toLegacyOffer(result)) as IpcResult<K>;
        }
        case 'offers:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'offers:delete'>;
          const result = await client.deleteOffer(parsedArgs.id, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'clients:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listClients();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'clients:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'clients:upsert'>;
          const result = await client.saveClient(parsedArgs.client);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'clients:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'clients:delete'>;
          const result = await client.deleteClient(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:getStatus': {
          const result = await client.getTaxFilingStatus();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:listRecords': {
          const result = await client.listTaxFilingRecords();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:installCertificate': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'taxFiling:installCertificate'>;
          const result = await client.installTaxFilingCertificate(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:removeCertificate': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'taxFiling:removeCertificate'>;
          const result = await client.removeTaxFilingCertificate(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:validate': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'taxFiling:validate'>;
          const result = await client.validateTaxFiling(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:export': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'taxFiling:export'>;
          const result = await client.exportTaxFiling(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'taxFiling:submit': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'taxFiling:submit'>;
          const result = await client.submitTaxFiling(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'tax:auditExportPackage': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'tax:auditExportPackage'>;
          const artifact = await client.exportTaxAuditPackage(parsedArgs);
          if (fallback) {
            const saved = await fallback('tax:saveAuditExportPackage', artifact);
            return ipcRoutes[key].result.parse(saved) as IpcResult<K>;
          }
          const serverPath = `server://tax-audit/${encodeURIComponent(artifact.createdAt)}`;
          return ipcRoutes[key].result.parse({
            bundleDir: serverPath,
            manifestPath: `${serverPath}/manifest.json`,
            createdAt: artifact.createdAt,
            fileCount: artifact.files.length,
            files: artifact.files.map((file) => ({
              name: file.name,
              path: `${serverPath}/${encodeURIComponent(file.name)}`,
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
              rowCount: file.rowCount,
            })),
          }) as IpcResult<K>;
        }
        case 'projects:list': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:list'>;
          const result = await client.listProjects(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'projects:get': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:get'>;
          const result = await client.getProject(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'projects:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:upsert'>;
          const result = await client.saveProject(parsedArgs.project, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'projects:archive': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'projects:archive'>;
          const result = await client.archiveProject(parsedArgs.id, parsedArgs.reason);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'articles:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listArticles();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'articles:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'articles:upsert'>;
          const result = await client.saveArticle(parsedArgs.article);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'articles:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'articles:delete'>;
          const result = await client.deleteArticle(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'accounts:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listAccounts();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'accounts:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'accounts:upsert'>;
          const result = await client.saveAccount(parsedArgs.account);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'accounts:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'accounts:delete'>;
          const result = await client.deleteAccount(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'templates:list': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'templates:list'>;
          const result = await client.listTemplates(parsedArgs.kind);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'templates:active': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'templates:active'>;
          const result = await client.getActiveTemplate(parsedArgs.kind);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'templates:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'templates:upsert'>;
          const result = await client.saveTemplate(parsedArgs.template);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'templates:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'templates:delete'>;
          const result = await client.deleteTemplate(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'templates:setActive': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'templates:setActive'>;
          const result = await client.setActiveTemplate(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'recurring:list': {
          ipcRoutes[key].args.parse(args);
          const result = await client.listRecurringProfiles();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'recurring:upsert': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'recurring:upsert'>;
          const result = await client.saveRecurringProfile(parsedArgs.profile);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'recurring:delete': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'recurring:delete'>;
          const result = await client.deleteRecurringProfile(parsedArgs.id);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:health': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:health'>;
          const result = await client.portalHealth(parsedArgs.baseUrl);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:publishOffer': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:publishOffer'>;
          const result = await client.publishOfferToPortal(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:publishInvoice': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:publishInvoice'>;
          const result = await client.publishInvoiceToPortal(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:syncOfferStatus': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:syncOfferStatus'>;
          const result = await client.syncOfferPortalStatus(parsedArgs.offerId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:createCustomerAccessLink': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:createCustomerAccessLink'>;
          const result = await client.createCustomerAccessLink(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'portal:rotateCustomerAccessLink': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'portal:rotateCustomerAccessLink'>;
          const result = await client.rotateCustomerAccessLink(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'email:send': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'email:send'>;
          const result = await client.sendEmail(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'email:testConfig': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'email:testConfig'>;
          const result = await client.testEmailConfig(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'dunning:manualRun': {
          ipcRoutes[key].args.parse(args);
          const result = await client.runDunningManually();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'dunning:getInvoiceStatus': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'dunning:getInvoiceStatus'>;
          const result = await client.getDunningInvoiceStatus(parsedArgs.invoiceId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'recurring:manualRun': {
          ipcRoutes[key].args.parse(args);
          const result = await client.runRecurringManually();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'settings:get': {
          ipcRoutes[key].args.parse(args);
          const result = await client.getSettings();
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'settings:set': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'settings:set'>;
          const result = await client.saveSettings(parsedArgs.settings);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'numbers:reserve': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'numbers:reserve'>;
          const result = await client.reserveNumber(parsedArgs.kind);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'numbers:release': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'numbers:release'>;
          const result = await client.releaseNumber(parsedArgs.reservationId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'numbers:finalize': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'numbers:finalize'>;
          const result = await client.finalizeNumber(parsedArgs.reservationId, parsedArgs.documentId);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'documents:createFromClient': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'documents:createFromClient'>;
          const result = await client.createDocumentFromClient(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'documents:convertOfferToInvoice': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'documents:convertOfferToInvoice'>;
          const result = await client.convertOfferToInvoice(parsedArgs);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        default:
          if (fallback && isNativeElectronRoute(key)) return fallback(key, args);
          throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${key} nicht.`);
      }
    } catch (error) {
      if (error instanceof ProEmbeddedConnectionUnavailableError && fallback) {
        return fallback(key, args);
      }
      throw error;
    }
  };

  onInvoke?.(invoke);
  return createBillmeApi(invoke);
};
