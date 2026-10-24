import {
  accountSuggestionRuleSchema,
  appSettingsSchema,
  accountingSourceFactSchema,
  eurRuleSchema,
  bookingDraftEntitySchema,
  accountingPostingPreviewSchema,
  accountingPeriodSchema,
  accountingPeriodStatusChangeSchema,
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
  taxAuditExportArtifactSchema,
  taxCaseAccountMappingSchema,
  taxCaseDefinitionSchema,
  transactionSchema,
  openRouterVlmAnalyzeInputSchema,
  openRouterVlmAnalyzeResultSchema,
  openRouterVlmConfigSchema,
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
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';
import { createSharedHttpInvoke, isSharedHttpRoute } from './sharedHttpRoutes';
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
  const canonical = guvClientReportSchema.safeParse(input);
  if (canonical.success) {
    const snapshot = isRecord(input) ? reportSnapshotSchema.safeParse(input.snapshot) : undefined;
    return snapshot?.success ? { ...canonical.data, from: snapshot.data.from, to: snapshot.data.to } : canonical.data;
  }
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

const parseServerEurFact = (input: unknown) => {
  const { actor, ...fact } = z.object({ actor: z.object({ id: z.string(), displayName: z.string().optional() }) }).passthrough().parse(input);
  return { ...fact, actorId: actor.id, actorName: actor.displayName };
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

const createProTransport = ({
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

  return { requestJson, requestText, requestBlobWithHeaders };
};

export const createProWebClient = (config: ProWebClientConfig) => {
  const { requestJson, requestText, requestBlobWithHeaders } = createProTransport(config);

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

  return {
    exportTaxAuditPackage(input: unknown) {
      return requestJson({
        method: 'POST',
        body: ipcRoutes['tax:auditExportPackage'].args.parse(input),
        parser: taxAuditExportArtifactSchema,
      }, '/api/v1/pro/tax/audit-export-package');
    },
    getSettings() {
      return requestJson({ parser: (input) => (input === null ? null : appSettingsSchema.parse(input)) }, '/api/v1/pro/settings');
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
    listWorkflowEntries() {
      return requestJson({ parser: parseArray(proWorkflowEntrySchema) }, '/api/v1/pro/workflow');
    },
    listAccountingTransactions() {
      return requestJson({ parser: parseArray(transactionSchema) }, '/api/v1/pro/accounting/transactions');
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
    listEurCashItems(query?: Partial<IpcArgs<'eur:listItems'>>) {
      return requestJson({ parser: parseArray(eurCashItemSchema), query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/eur/items');
    },
    upsertEurClassification(input: { sourceType: 'transaction' | 'invoice'; sourceId: string; taxYear: number; eurLineId?: string; excluded?: boolean; vatMode?: 'none' | 'default'; vatRate?: number; note?: string; reason: string }) {
      return requestJson({ method: 'PUT', body: input, parser: (payload) => payload }, '/api/v1/pro/accounting/reports/eur/classifications');
    },
    saveEurCashFact(input: { sourceType: 'transaction' | 'invoice'; sourceId: string; taxYear: number; kind: string; amountNet: number; flowType?: 'income' | 'expense'; eurLineId?: string; splits?: unknown[]; reason: string; idempotencyKey?: string }) {
      return requestJson({ method: 'POST', body: input, parser: parseServerEurFact }, '/api/v1/pro/accounting/reports/eur/facts/cash');
    },
    listEurCashFacts(taxYear: number) {
      return requestJson({ parser: parseArray(parseServerEurFact), query: { taxYear } }, '/api/v1/pro/accounting/reports/eur/facts/cash');
    },
    saveEurAnnexFact(input: { taxYear: number; annex: string; lineId: string; amount: number; sourceId?: string; date?: string; reason: string; idempotencyKey?: string }) {
      return requestJson({ method: 'POST', body: input, parser: parseServerEurFact }, '/api/v1/pro/accounting/reports/eur/facts/annex');
    },
    listEurAnnexFacts(taxYear: number, annex?: string) {
      return requestJson({ parser: parseArray(parseServerEurFact), query: { taxYear, annex } }, '/api/v1/pro/accounting/reports/eur/facts/annex');
    },
    listAccountingSourceRuns() {
      return requestJson({ parser: parseArray(accountingSourceRunParser) }, '/api/v1/pro/accounting/source-runs');
    },
    listAccountingPeriods(year: number) {
      return requestJson({ parser: parseArray(accountingPeriodSchema), query: { year } }, '/api/v1/pro/accounting/periods');
    },
    setAccountingPeriodStatus(input: { period: string; status: 'open' | 'soft_locked' | 'closed'; reason: string }) {
      return requestJson({ method: 'POST', body: { status: input.status, reason: input.reason }, parser: accountingPeriodStatusChangeSchema }, `/api/v1/pro/accounting/periods/${encodeURIComponent(input.period)}/status`);
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
    getGuvReport(query?: unknown) {
      return requestJson({ parser: parseServerLegacyGuvReport, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/guv');
    },
    getBwa01Report(query?: unknown) {
      return requestJson({ parser: bwa01ReportSchema, query: query as Record<string, string | number | boolean | null | undefined> | undefined }, '/api/v1/pro/accounting/reports/bwa01');
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
    listIncomingInvoiceDocuments(invoiceId?: string) {
      return requestJson({ parser: parseArray(incomingInvoiceDocumentSchema) }, invoiceId
        ? `/api/v1/pro/accounting/incoming-invoices/${encodeURIComponent(invoiceId)}/documents`
        : '/api/v1/pro/accounting/incoming-invoice-documents');
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
  const transport = createProTransport(clientConfig);
  const sharedInvoke = createSharedHttpInvoke({
    product: 'pro',
    routes: ipcRoutes,
    reasons: {
      clientUpsert: 'Kunde gespeichert',
      clientDelete: 'Kunde gelöscht',
      recurringUpsert: 'Wiederkehrendes Profil gespeichert',
      recurringDelete: 'Wiederkehrendes Profil gelöscht',
    },
    transport: {
      requestJson: (method, path, parser, body, query) => transport.requestJson({ method, body, parser, query }, path),
      requestText: (path) => transport.requestText(path),
    },
  });

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
      if (isSharedHttpRoute(key)) {
        return await sharedInvoke(key, ipcRoutes[key].args.parse(args)) as IpcResult<K>;
      }
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
            parsedArgs.action === 'reject' && parsedArgs.rejectReason?.trim() ? parsedArgs.rejectReason : 'Buchungsworkflow-Aktion ausgeführt',
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
        case 'pro:listAccountingPeriods': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:listAccountingPeriods'>;
          const result = await client.listAccountingPeriods(parsedArgs.year);
          return ipcRoutes[key].result.parse(result) as IpcResult<K>;
        }
        case 'pro:setAccountingPeriodStatus': {
          const parsedArgs = ipcRoutes[key].args.parse(args) as IpcArgs<'pro:setAccountingPeriodStatus'>;
          const result = await client.setAccountingPeriodStatus(parsedArgs);
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
