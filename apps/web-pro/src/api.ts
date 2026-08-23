import {
  createProWebClient as createSharedProWebClient,
  ProEmbeddedConnectionUnavailableError,
  type ProWebClient as SharedProWebClient,
  type ProWebClientConfig as SharedProWebClientConfig,
} from '@billme/desktop-services/proHttpApi';
import {
  bookingDraftEntitySchema,
  eurListItemSchema,
  eurReportResultSchema,
  transactionSchema,
} from '@billme/desktop-contracts-pro/schemas';

export type ProWebClientConfig = SharedProWebClientConfig;
export { ProEmbeddedConnectionUnavailableError };

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
  allocationEventId: string;
};

type Query = Record<string, string | number | boolean | null | undefined>;
type JsonRecord = Record<string, any>;
type WorkflowTransaction = (typeof transactionSchema)['_output'];
type WorkflowDraft = (typeof bookingDraftEntitySchema)['_output'];
type EurReportBase = (typeof eurReportResultSchema)['_output'];
type EurReport = Omit<EurReportBase, 'rows'> & { rows: Array<EurReportBase['rows'][number] & { id: string }> };
type EurCashItem = (typeof eurListItemSchema)['_output'];
type MappingHealth = { unmappedAccounts: string[]; warnings: string[]; blocking: boolean };
type StatementRow = { position: string; label: string; amount: number; accountNumbers: string[]; accountRefs?: string[]; kind?: string; parentPosition?: string };
type SusaRow = { accountNumber: string; openingBalance: number; closingBalance: number; debitTurnover: number; creditTurnover: number; hasWarnings?: boolean } & JsonRecord;
type StatementReport = { rows: StatementRow[]; netResult: number; mappingHealth: MappingHealth; totals: JsonRecord };
type BalanceReport = { assets: StatementRow[]; liabilities: StatementRow[]; mappingHealth: MappingHealth; totals: { assets: number; liabilities: number; delta: number } };

type CompatibilityMethods = {
  listAccountingDrafts: (transactionIds: string[]) => Promise<Array<WorkflowDraft | null>>;
  prepareTaxExport: (input: JsonRecord) => Promise<{ artifact: JsonRecord; run?: JsonRecord; replayed?: boolean }>;
  exportTaxArtifact: (kind: string, id: string) => Promise<Blob>;
  getBwa01Report: (query?: unknown) => Promise<StatementReport>;
  getManagementGuvReport: (query?: unknown) => Promise<StatementReport>;
  getHgbGuvReport: (query?: unknown) => Promise<StatementReport>;
  getReportSnapshot: (id: string) => Promise<JsonRecord>;
  createReportSnapshot: (input: JsonRecord) => Promise<JsonRecord>;
  getAccountMappingHealth: (chart?: string, reportType?: string, asOfDate?: string) => Promise<{ chart?: string; unmapped?: Array<{ accountNumber: string; statementType: string }> }>;
  saveAccountMappingOverride: (input: JsonRecord) => Promise<JsonRecord>;
  downloadDatevCsv: (query?: Query) => Promise<Blob>;
  exportDatevCsv: (query: Query) => Promise<{ blob: Blob; exportId: string; contentSha256?: string; recordCount: number }>;
  downloadDatevExport: (id: string) => Promise<Blob>;
  downloadDocumentJson: (kind: 'invoice' | 'offer', id: string) => Promise<Blob>;
  downloadDocumentsCsv: (kind: 'invoice' | 'offer') => Promise<Blob>;
  parseWorkflowTransaction: (input: string) => WorkflowTransaction;
  parseWorkflowDraft: (input: string) => WorkflowDraft;
};

type LooseMethods = {
  getLedgerStats: () => Promise<{ total: number; byChart: { SKR03: number; SKR04: number } }>;
  getEurReport: (query: unknown) => Promise<EurReport>;
  listEurCashItems: (query: unknown) => Promise<EurCashItem[]>;
  listReportMappingPositions: (statement: string, asOfDate: string) => Promise<Array<{ key: string; label: string; kind: 'heading' | 'line' | 'subtotal' | 'result'; side?: 'asset' | 'liability' }>>;
  getSusaReport: (query?: unknown) => Promise<{ rows: SusaRow[]; totals: { debit: number; credit: number; balance: number }; unmappedAccounts?: string[] }>;
  getGuvReport: (query?: unknown) => Promise<StatementReport>;
  getBilanzReport: (query?: unknown) => Promise<BalanceReport>;
  getBwa01Report: (query?: unknown) => Promise<StatementReport>;
  getManagementGuvReport: (query?: unknown) => Promise<StatementReport>;
  getHgbGuvReport: (query?: unknown) => Promise<StatementReport>;
  getAccountMappingHealth: (chart?: string, reportType?: string, asOfDate?: string) => Promise<{ chart?: string; unmapped?: Array<{ accountNumber: string; statementType: string }> }>;
  prepareTaxExport: (input: JsonRecord) => Promise<{ artifact: JsonRecord; run?: JsonRecord; replayed?: boolean }>;
  exportTaxArtifact: (kind: string, id: string) => Promise<Blob>;
  runDepreciation: (input: unknown) => Promise<any>;
  disposeAsset: (input: unknown) => Promise<any>;
  previewOutgoingInvoice: (invoiceId: string, reason?: string) => Promise<any>;
  postOutgoingInvoice: (invoiceId: string, reason: string, reservationId: string, options?: JsonRecord) => Promise<any>;
  previewIncomingInvoice: (invoiceId: string, reason?: string) => Promise<any>;
  postIncomingInvoice: (invoiceId: string, reason: string, options?: JsonRecord) => Promise<any>;
  allocateOpenItemPayment: (payment: ProOpenItemPaymentInput, reason: string) => Promise<any>;
  postAccountingCommand: (input: unknown) => Promise<{
    run: { status: string; sourceType: string; sourceId: string; sourceRevision?: string; result?: unknown };
    result?: unknown;
    replayed?: boolean;
  }>;
};

type CompatibilityKeys = keyof CompatibilityMethods | keyof LooseMethods;
export type ProWebClient = Omit<SharedProWebClient, CompatibilityKeys> & CompatibilityMethods & LooseMethods;

const asQuery = (value: unknown): Query | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Query;
};

const createRawRequest = (config: ProWebClientConfig) => {
  const requestFetch = config.fetch ?? globalThis.fetch;
  const resolveTarget = async () => {
    if (config.embeddedConnectionResolver) {
      const connection = await config.embeddedConnectionResolver();
      if (!connection) throw new ProEmbeddedConnectionUnavailableError();
      return { baseUrl: connection.baseUrl, headers: { 'x-billme-local-token': connection.token } as Record<string, string> };
    }
    const token = config.getToken?.();
    return { baseUrl: config.baseUrl, headers: token ? { authorization: `Bearer ${token}` } : {} as Record<string, string> };
  };
  const request = async (path: string, options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; query?: Query } = {}) => {
    if (!requestFetch) throw new Error('Keine Fetch-Implementierung verfügbar.');
    const target = await resolveTarget();
    const url = new URL(path, target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = new Headers(target.headers);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await requestFetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return response;
  };
  const json = async (path: string, options: Parameters<typeof request>[1] = {}) => {
    const response = await request(path, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload;
  };
  const blob = async (path: string, query?: Query) => {
    const response = await request(path, { query });
    if (!response.ok) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`);
    return { blob: await response.blob(), headers: response.headers };
  };
  return { json, blob };
};

export const createProWebClient = (config: ProWebClientConfig): ProWebClient => {
  const client = createSharedProWebClient(config);
  const raw = createRawRequest(config);
  return {
    ...client,
    listAccountingDrafts: (transactionIds: string[]) => Promise.all(transactionIds.map((id) => client.getAccountingDraftByTransactionId(id))),
    prepareTaxExport: async (input: JsonRecord) => {
      const kind = String(input.kind);
      const period = String(input.period);
      return raw.json('/api/v1/pro/accounting/tax-exports/prepare', {
        method: 'POST',
        body: { ...input, idempotencyKey: input.idempotencyKey ?? `tax:${kind}:${period}` },
      }) as Promise<{ artifact: JsonRecord; run?: JsonRecord; replayed?: boolean }>;
    },
    exportTaxArtifact: (kind: 'ustva' | 'zm' | 'oss', id: string) => raw.blob(`/api/v1/pro/accounting/tax-exports/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/export`).then(({ blob }) => blob),
    getBwa01Report: (query?: unknown) => client.getReportingReport({ kind: 'bwa01', ...(asQuery(query) ?? {}) } as never),
    getManagementGuvReport: (query?: unknown) => client.getReportingReport({ kind: 'management-guv', ...(asQuery(query) ?? {}) } as never),
    getHgbGuvReport: (query?: unknown) => client.getReportingReport({ kind: 'hgb-guv', ...(asQuery(query) ?? {}) } as never),
    listReportMappingPositions: (statement: string, asOfDate: string) => client.listReportMappingPositions({ reportType: statement, asOfDate } as never),
    getEurReport: async (query: unknown) => {
      const report = await client.getEurReport(query as never) as EurReportBase;
      return { ...report, rows: report.rows.map((row) => ({ ...row, id: row.lineId })) };
    },
    previewOutgoingInvoice: (invoiceId: string, reason = 'Vorschau') => client.previewOutgoingInvoice(invoiceId, { reason }),
    postOutgoingInvoice: (invoiceId: string, reason: string, reservationId: string, options: Record<string, unknown> = {}) => {
      if (!reservationId.trim()) throw new Error('Reservierungs-ID fehlt.');
      return client.postOutgoingInvoice(invoiceId, reservationId, { reason, ...options });
    },
    previewIncomingInvoice: (invoiceId: string, reason = 'Vorschau') => client.previewIncomingInvoice(invoiceId, { reason }),
    postIncomingInvoice: (invoiceId: string, reason: string, options: Record<string, unknown> = {}) => client.postIncomingInvoice(invoiceId, reason, options),
    allocateOpenItemPayment: (payment: ProOpenItemPaymentInput, reason: string) => {
      if (typeof payment.allocationEventId !== 'string' || !payment.allocationEventId.trim()) throw new Error('Zuordnungs-ID fehlt.');
      return client.allocateOpenItemPayment(payment, reason);
    },
    getReportSnapshot: (id: string) => raw.json(`/api/v1/pro/accounting/reports/snapshots/${encodeURIComponent(id)}`),
    createReportSnapshot: (input: unknown) => client.saveReportSnapshot(input),
    getAccountMappingHealth: (chart?: string, reportType?: string, asOfDate?: string) => client.getReportMappingHealth({ chart, reportType, asOfDate }),
    saveAccountMappingOverride: (input: unknown) => client.saveReportMappingOverride(input),
    downloadDatevCsv: (query?: Query) => raw.blob('/api/v1/pro/accounting/datev/export.csv', query).then(({ blob }) => blob),
    exportDatevCsv: (query: Query) => raw.blob('/api/v1/pro/accounting/datev/export.csv', query).then(({ blob, headers }) => ({
      blob,
      exportId: headers.get('x-billme-datev-export-id') ?? '',
      contentSha256: headers.get('x-billme-datev-content-sha256') ?? undefined,
      recordCount: Number(headers.get('x-billme-datev-record-count') ?? 0),
    })),
    downloadDatevExport: (id: string) => raw.blob(`/api/v1/pro/accounting/datev/exports/${encodeURIComponent(id)}`).then(({ blob }) => blob),
    downloadDocumentJson: (kind: 'invoice' | 'offer', id: string) => raw.blob(`/api/v1/pro/documents/${kind}/${encodeURIComponent(id)}/export.json`).then(({ blob }) => blob),
    downloadDocumentsCsv: (kind: 'invoice' | 'offer') => raw.blob('/api/v1/pro/documents/export.csv', { kind }).then(({ blob }) => blob),
    parseWorkflowTransaction: (input: string) => transactionSchema.parse(JSON.parse(input)),
    parseWorkflowDraft: (input: string) => bookingDraftEntitySchema.parse(JSON.parse(input)),
  } as ProWebClient;
};
