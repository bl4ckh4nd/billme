import { createHash, randomUUID } from 'node:crypto';
import {
  CANONICAL_TAX_CASES,
  type AccountingMutationContext,
  type AccountingSourceFact,
  type CorrectionDeltaInput,
  type ImmutableOriginalDocument,
  type LinkedCorrectionDocument,
  type TaxExportDirection,
  type TaxExportEntry,
  type TaxExportPreparation,
  type TaxExportPeriod,
} from '@billme/accounting-shared';
import {
  aggregateOss,
  aggregateZm,
  buildCarryForward,
  buildFiscalClose,
  buildFxValuation,
  buildInventoryClosingValuation,
  buildJournalCommand,
  buildSettlementJournalCommand,
  buildProvisionCommand,
  createLinkedCorrection,
  planAccrualSchedule,
  planLoanSchedule,
  prepareUstva,
  type TaxExportError,
  type SettlementCommandKind,
  validatePayrollBatch,
  validateShareholderFlow,
  type SettlementJournalAccounts,
} from '@billme/accounting-engine';
import type { TenantScope } from '@billme/server-core';
import { appendWithClient } from './audit.js';
import {
  isPostgresPool,
  withSerializablePostgresTransaction,
  type PostgresQueryable,
  type PostgresTransactionClient,
} from './connection.js';

type SourceRunStatus = 'posted' | 'prepared' | 'noop';
type TaxExportKind = 'ustva' | 'zm' | 'oss';

export interface AccountingSourceRunRecord {
  id: string;
  tenantId: string;
  sourceType: string;
  sourceId: string;
  sourceRevision: string;
  idempotencyKey: string;
  status: SourceRunStatus;
  source: unknown;
  result: unknown;
  journalEntryId?: string;
  sourceHash: string;
  createdBy?: string;
  reason: string;
  createdAt: string;
}

export interface CorrectionSettlementInput {
  id: string;
  idempotencyKey: string;
  correctionDate: string;
  taxEffectiveDate?: string;
  original: ImmutableOriginalDocument;
  deltas: readonly CorrectionDeltaInput[];
  documentType?: 'outgoing_invoice' | 'incoming_invoice';
  reason: string;
  postingDate?: string;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
}

export interface ClosingCommandInput {
  command?: string;
  commandType?: string;
  sourceId?: string;
  sourceRevision?: string;
  idempotencyKey?: string;
  input?: Record<string, unknown>;
  reason: string;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
  [key: string]: unknown;
}

export interface TaxExportPreparationInput {
  kind: TaxExportKind;
  period: string | TaxExportPeriod;
  year?: number;
  entries?: readonly TaxExportEntry[];
  catalog?: Parameters<typeof prepareUstva>[0]['catalog'];
  idempotencyKey?: string;
  reason: string;
  mutation?: AccountingMutationContext;
}

export interface AccountingSourceRunRepository {
  listAccountingSourceRuns(scope: TenantScope, args?: { sourceType?: string; limit?: number }): Promise<AccountingSourceRunRecord[]>;
  getAccountingSourceRun(scope: TenantScope, id: string): Promise<AccountingSourceRunRecord | null>;
  createCorrectionSettlement(scope: TenantScope, input: CorrectionSettlementInput): Promise<{ run: AccountingSourceRunRecord; document: LinkedCorrectionDocument; replayed: boolean }>;
  runClosingCommand(scope: TenantScope, input: ClosingCommandInput): Promise<{ run: AccountingSourceRunRecord; result: unknown; replayed: boolean }>;
  prepareTaxExport(scope: TenantScope, input: TaxExportPreparationInput): Promise<{ run: AccountingSourceRunRecord; artifact: TaxExportPreparation; replayed: boolean }>;
  getTaxExportArtifact(scope: TenantScope, kind: TaxExportKind, id: string): Promise<TaxExportPreparation>;
  exportTaxArtifact(scope: TenantScope, kind: TaxExportKind, id: string): Promise<Uint8Array>;
}

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const inTx = <T>(db: PostgresQueryable, work: (client: PostgresTransactionClient) => Promise<T>): Promise<T> =>
  isPostgresPool(db) ? withSerializablePostgresTransaction(db, work) : work(db as PostgresTransactionClient);
const tenant = (scope: TenantScope): string => scope.tenantId;
const now = (): string => new Date().toISOString();
const isoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const periodOf = (date: string): string => date.slice(0, 7);
const round = (value: unknown): number => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const parse = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) as T : value as T; } catch { return fallback; }
};
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
};
const stableJson = (value: unknown): string => JSON.stringify(canonical(value));
const hash = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');
const required = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};
const textValue = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const settlementAccounts = (
  mappings: Record<string, string>,
  facts: Record<string, unknown>,
): SettlementJournalAccounts => ({
  accountsReceivable: mappings.accounts_receivable,
  accountsPayable: mappings.accounts_payable,
  revenue: mappings.revenue,
  expense: mappings.expense,
  outputVat: mappings.output_vat,
  inputVat: mappings.input_vat,
  badDebtExpenseAccount: textValue(facts.badDebtExpenseAccount),
  advanceClearingReceivable: textValue(facts.advanceClearingReceivable),
  advanceClearingPayable: textValue(facts.advanceClearingPayable),
});

const mapRun = (row: any): AccountingSourceRunRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  sourceType: row.source_type,
  sourceId: row.source_id,
  sourceRevision: row.source_revision,
  idempotencyKey: row.idempotency_key,
  status: row.status,
  source: parse(row.source_json, {}),
  result: parse(row.result_json, {}),
  journalEntryId: row.journal_entry_id ?? undefined,
  sourceHash: row.source_hash,
  createdBy: row.created_by ?? undefined,
  reason: row.reason,
  createdAt: row.created_at,
});

const mutationReason = (input: { reason: string; mutation?: AccountingMutationContext }): string => {
  const reason = input.mutation?.reason?.trim() || input.reason.trim();
  if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
  return reason;
};

const assertPeriod = async (
  db: PostgresQueryable,
  scope: TenantScope,
  postingDate: string,
  period: string,
  fiscalYear: number,
  softLockOverride?: boolean,
  overrideReason?: string,
): Promise<void> => {
  if (!isoDate(postingDate)) throw new Error('INVALID_POSTING_DATE');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || period !== periodOf(postingDate)) throw new Error('INVALID_PERIOD');
  let rows = await q<any>(db, `SELECT status,fiscal_year FROM accounting_periods WHERE tenant_id=$1 AND period=$2 FOR UPDATE`, [tenant(scope), period]);
  if (!rows[0]) {
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7));
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await q(db, `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$7) ON CONFLICT (tenant_id,period) DO NOTHING`, [randomUUID(), tenant(scope), period, fiscalYear, `${period}-01`, end, now()]);
    rows = await q<any>(db, `SELECT status,fiscal_year FROM accounting_periods WHERE tenant_id=$1 AND period=$2 FOR UPDATE`, [tenant(scope), period]);
  }
  if (rows[0] && Number(rows[0].fiscal_year) !== fiscalYear) throw new Error('FISCAL_YEAR_PERIOD_MISMATCH');
  const status = rows[0]?.status ?? 'open';
  if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD');
  if (status === 'soft_locked' && (!softLockOverride || !overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
};

const activeChart = async (db: PostgresQueryable, scope: TenantScope): Promise<'SKR03' | 'SKR04'> => {
  const policy = (await q<any>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [tenant(scope)]))[0];
  return policy?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';
};

const assertAccounts = async (db: PostgresQueryable, scope: TenantScope, accounts: readonly string[]): Promise<void> => {
  const requested = [...new Set(accounts.filter(Boolean))];
  if (!requested.length) throw new Error('INVALID_ACCOUNT');
  const chart = await activeChart(db, scope);
  const rows = await q<any>(db, `SELECT account_number FROM ledger_accounts WHERE chart=$1 AND account_number = ANY($2::text[])`, [chart, requested]);
  // A fresh test/tenant database can be initialized before the optional
  // catalog projection. Existing posting code treats that state as open.
  if (!rows.length) {
    const count = await q<any>(db, `SELECT COUNT(*)::int AS count FROM ledger_accounts`);
    if (Number(count[0]?.count ?? 0) === 0) return;
  }
  const found = new Set(rows.map((row) => String(row.account_number)));
  const missing = requested.find((account) => !found.has(account));
  if (missing) throw new Error(`UNKNOWN_ACCOUNT:${missing}`);
};

const chartAndMappings = async (db: PostgresQueryable, scope: TenantScope): Promise<{ chart: string; mappings: Record<string, string> }> => {
  const chart = await activeChart(db, scope);
  const defaults = chart === 'SKR04'
    ? { accounts_receivable: '1200', accounts_payable: '3300', revenue: '4400', expense: '6300', output_vat: '3806', input_vat: '1406' }
    : { accounts_receivable: '1400', accounts_payable: '1600', revenue: '8400', expense: '4900', output_vat: '1776', input_vat: '1576' };
  const rows = await q<any>(db, `SELECT role,account_number FROM accounting_account_mappings WHERE tenant_id=$1 AND chart=$2`, [tenant(scope), chart]);
  for (const row of rows) if (row.role in defaults) defaults[row.role as keyof typeof defaults] = String(row.account_number);
  return { chart, mappings: defaults };
};

const createRun = async (
  db: PostgresQueryable,
  scope: TenantScope,
  input: {
    sourceType: string;
    sourceId: string;
    sourceRevision: string;
    idempotencyKey: string;
    status: SourceRunStatus;
    source: unknown;
    result: unknown;
    journalEntryId?: string;
    reason: string;
    mutation?: AccountingMutationContext;
  },
): Promise<{ run: AccountingSourceRunRecord; replayed: boolean }> => {
  const t = tenant(scope);
  const sourceHash = hash(input.source);
  const keyOwner = (await q<any>(db, `SELECT source_type,source_id,source_revision FROM accounting_source_runs WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [t, input.idempotencyKey]))[0];
  if (keyOwner && (keyOwner.source_type !== input.sourceType || keyOwner.source_id !== input.sourceId || keyOwner.source_revision !== input.sourceRevision)) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
  const existing = (await q<any>(db, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND source_revision=$4 FOR UPDATE`, [t, input.sourceType, input.sourceId, input.sourceRevision]))[0];
  if (existing) {
    if (existing.source_hash !== sourceHash || existing.idempotency_key !== input.idempotencyKey) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
    return { run: mapRun(existing), replayed: true };
  }
  const id = randomUUID();
  const createdAt = now();
  await q(db, `INSERT INTO accounting_source_runs (id,tenant_id,source_type,source_id,source_revision,idempotency_key,status,source_json,result_json,journal_entry_id,source_hash,created_by,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, t, input.sourceType, input.sourceId, input.sourceRevision, input.idempotencyKey, input.status, stableJson(input.source), stableJson(input.result), input.journalEntryId ?? null, sourceHash, input.mutation?.actor?.id ?? input.mutation?.actor?.displayName ?? null, input.reason, createdAt]);
  await appendWithClient(db as PostgresTransactionClient, scope, { occurredAt: createdAt, action: 'accounting_source_run.create', reason: input.reason, actor: input.mutation?.actor ?? { type: 'service', displayName: 'server-accounting' }, subject: { entityType: 'accounting_source_run', entityId: id, tenantId: t }, change: { before: undefined, after: { sourceType: input.sourceType, sourceId: input.sourceId, sourceRevision: input.sourceRevision, status: input.status, journalEntryId: input.journalEntryId } } });
  return { run: mapRun((await q<any>(db, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND id=$2`, [t, id]))[0]), replayed: false };
};

const insertCommand = async (
  db: PostgresQueryable,
  scope: TenantScope,
  command: any,
  options: { softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext },
): Promise<string> => {
  const entry = command.entry;
  await assertPeriod(db, scope, entry.postingDate, entry.period, entry.fiscalYear, options.softLockOverride, options.overrideReason);
  await assertAccounts(db, scope, entry.lines.map((line: any) => line.accountNumber));
  const existing = (await q<any>(db, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenant(scope), entry.id]))[0];
  if (existing) return existing.id;
  const numberRows = await q<any>(db, `SELECT COALESCE(MAX(entry_number),0)+1 AS next_number FROM journal_entries WHERE tenant_id=$1`, [tenant(scope)]);
  const entryNumber = Number(numberRows[0]?.next_number ?? 1);
  const createdAt = now();
  await q(db, `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10,$11,$12)`, [entry.id, tenant(scope), entryNumber, entry.postingDate, entry.documentDate ?? entry.postingDate, entry.bookingText, entry.reference ?? null, entry.period, entry.fiscalYear, entry.sourceType ?? 'standalone_source', entry.sourceKey ?? entry.id, createdAt]);
  for (const [index, line] of entry.lines.entries()) {
    await q(db, `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount,tax_case_key,tax_rate,net_amount,tax_amount,gross_amount,country_code,counterparty_vat_id,evidence_type,evidence_reference,datev_sachverhalt_ll,memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [line.id || `${entry.id}:line:${index + 1}`, tenant(scope), entry.id, index + 1, line.accountNumber, round(line.debitAmount), round(line.creditAmount), line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.datevSachverhaltLl ?? null, line.memo ?? null]);
  }
  for (const line of entry.lines.filter((candidate: any) => Number(candidate.taxAmount ?? 0) > 0 || Boolean(candidate.taxCaseKey && (candidate.evidenceType || candidate.evidenceReference || candidate.countryCode || candidate.counterpartyVatId)))) {
    await q(db, `INSERT INTO vat_evidence (id,tenant_id,draft_id,entry_id,line_id,tax_case_key,evidence_type,evidence_reference,country_code,counterparty_vat_id,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), tenant(scope), entry.sourceKey ?? entry.id, entry.id, line.id, line.taxCaseKey ?? 'standard_vat', line.evidenceType ?? null, line.evidenceReference ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, createdAt]);
  }
  return entry.id;
};

export const taxCaseForCorrectionRate = (rate: number): 'DE_STD_19' | 'DE_STD_7' | 'DE_ZERO_EXEMPT' => {
  if (rate === 19) return 'DE_STD_19';
  if (rate === 7) return 'DE_STD_7';
  if (rate === 0) return 'DE_ZERO_EXEMPT';
  throw new Error(`CORRECTION_TAX_CASE_UNSUPPORTED:${rate}`);
};

const correctionLines = async (db: PostgresQueryable, scope: TenantScope, document: LinkedCorrectionDocument, documentType: 'outgoing_invoice' | 'incoming_invoice'): Promise<any[]> => {
  const { mappings } = await chartAndMappings(db, scope);
  const lines: any[] = [];
  for (const [index, delta] of document.deltas.entries()) {
    const taxCaseKey = taxCaseForCorrectionRate(delta.rate);
    if (documentType === 'incoming_invoice') {
      lines.push({ id: `${document.id}:expense:${index}`, accountNumber: mappings.expense, debitAmount: 0, creditAmount: Math.abs(delta.netAmount), taxCaseKey, netAmount: delta.netAmount, taxRate: delta.rate, taxAmount: delta.taxAmount, grossAmount: delta.grossAmount, memo: 'Linked correction' });
      if (delta.taxAmount) lines.push({ id: `${document.id}:tax:${index}`, accountNumber: mappings.input_vat, debitAmount: 0, creditAmount: Math.abs(delta.taxAmount), taxCaseKey, taxRate: delta.rate, taxAmount: delta.taxAmount, grossAmount: delta.grossAmount, memo: 'Linked correction VAT' });
      lines.push({ id: `${document.id}:payable:${index}`, accountNumber: mappings.accounts_payable, debitAmount: Math.abs(delta.grossAmount), creditAmount: 0, memo: 'Linked correction payable' });
    } else {
      lines.push({ id: `${document.id}:revenue:${index}`, accountNumber: mappings.revenue, debitAmount: Math.abs(delta.netAmount), creditAmount: 0, taxCaseKey, netAmount: delta.netAmount, taxRate: delta.rate, taxAmount: delta.taxAmount, grossAmount: delta.grossAmount, memo: 'Linked correction' });
      if (delta.taxAmount) lines.push({ id: `${document.id}:tax:${index}`, accountNumber: mappings.output_vat, debitAmount: Math.abs(delta.taxAmount), creditAmount: 0, taxCaseKey, taxRate: delta.rate, taxAmount: delta.taxAmount, grossAmount: delta.grossAmount, memo: 'Linked correction VAT' });
      lines.push({ id: `${document.id}:receivable:${index}`, accountNumber: mappings.accounts_receivable, debitAmount: 0, creditAmount: Math.abs(delta.grossAmount), memo: 'Linked correction receivable' });
    }
  }
  return lines;
};

const correctionTaxBreakdown = (row: any, snapshot: any, lines: any[]): Array<{ rate: number; netAmount: number; taxAmount: number; grossAmount: number }> => {
  const supplied = snapshot?.vatBreakdown ?? snapshot?.breakdown;
  if (Array.isArray(supplied) && supplied.length) return supplied.map((entry: any) => ({ rate: Number(entry.rate), netAmount: Number(entry.netAmount), taxAmount: Number(entry.taxAmount ?? entry.vatAmount), grossAmount: Number(entry.grossAmount ?? entry.netAmount + (entry.taxAmount ?? entry.vatAmount)) }));
  const grouped = new Map<number, { netAmount: number; taxAmount: number; grossAmount: number }>();
  for (const line of lines) {
    if (line.tax_rate == null && line.taxRate == null) continue;
    const rate = Number(line.tax_rate ?? line.taxRate);
    const current = grouped.get(rate) ?? { netAmount: 0, taxAmount: 0, grossAmount: 0 };
    current.netAmount += Number(line.net_amount ?? line.netAmount ?? 0);
    current.taxAmount += Number(line.tax_amount ?? line.taxAmount ?? 0);
    current.grossAmount += Number(line.gross_amount ?? line.grossAmount ?? 0);
    grouped.set(rate, current);
  }
  if (grouped.size) return [...grouped.entries()].map(([rate, value]) => ({ rate, ...value }));
  const rate = Number(row.tax_rate ?? snapshot?.taxRate ?? 0);
  const netAmount = Number(row.net_amount ?? snapshot?.netAmount ?? snapshot?.net ?? 0);
  const taxAmount = Number(row.tax_amount ?? snapshot?.taxAmount ?? snapshot?.tax ?? 0);
  const grossAmount = Number(row.gross_amount ?? snapshot?.grossAmount ?? snapshot?.gross ?? netAmount + taxAmount);
  return [{ rate, netAmount, taxAmount, grossAmount }];
};

const resolveCorrectionOriginal = async (
  db: PostgresQueryable,
  scope: TenantScope,
  requested: ImmutableOriginalDocument,
  documentType: 'outgoing_invoice' | 'incoming_invoice',
): Promise<ImmutableOriginalDocument> => {
  const table = documentType === 'incoming_invoice' ? 'incoming_invoices' : 'invoices';
  const dateColumn = documentType === 'incoming_invoice' ? 'invoice_date' : 'date';
  const row = (await q<any>(db, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), requested.documentId]))[0];
  if (!row) throw new Error('ORIGINAL_DOCUMENT_NOT_FOUND');
  const ownedJournal = row.accounting_status === 'posted' && row.accounting_journal_entry_id
    ? (await q<any>(db, `SELECT status,source_type,source_key FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenant(scope), row.accounting_journal_entry_id]))[0]
    : undefined;
  if (row.accounting_status !== 'posted'
    || !row.accounting_journal_entry_id
    || ownedJournal?.status !== 'posted'
    || ownedJournal.source_type !== documentType
    || ownedJournal.source_key !== `${documentType}:${row.id}`) throw new Error('DOCUMENT_NOT_POSTED');
  if (row.number !== requested.documentNumber) throw new Error('ORIGINAL_CHANGED');
  const incomingLines = documentType === 'incoming_invoice'
    ? await q<any>(db, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [tenant(scope), row.id])
    : [];
  const accountingSnapshot = parse<any>(row.accounting_snapshot_json, undefined);
  const taxSnapshot = parse<any>(row.tax_snapshot_json, undefined);
  const snapshot = taxSnapshot ?? accountingSnapshot;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('ORIGINAL_SNAPSHOT_REQUIRED');
  const authoritativeLines = incomingLines.length ? incomingLines : (Array.isArray(accountingSnapshot?.lines) ? accountingSnapshot.lines : []);
  const canonicalHash = hash(snapshot);
  const revision = String(accountingSnapshot?.sourceVersion ?? snapshot.sourceVersion ?? canonicalHash);
  const proofs = new Set([canonicalHash, revision, hash({ snapshot, lines: authoritativeLines }), hash({ accountingSnapshot, taxSnapshot, lines: authoritativeLines })]);
  if (!proofs.has(requested.snapshotHash) || (requested.currentSnapshotHash !== undefined && requested.currentSnapshotHash !== requested.snapshotHash)) throw new Error('ORIGINAL_CHANGED');
  if (requested.revision !== revision && requested.revision !== canonicalHash) throw new Error('ORIGINAL_CHANGED');
  if (requested.taxEffectiveDate !== row[dateColumn]) throw new Error('ORIGINAL_CHANGED');
  const breakdown = correctionTaxBreakdown(row, snapshot, authoritativeLines);
  if (!breakdown.length || breakdown.some((entry) => !Number.isFinite(entry.rate) || !Number.isFinite(entry.netAmount) || !Number.isFinite(entry.taxAmount) || !Number.isFinite(entry.grossAmount))) throw new Error('ORIGINAL_SNAPSHOT_REQUIRED');
  return { documentId: row.id, documentNumber: row.number, revision, snapshotHash: canonicalHash, currentSnapshotHash: canonicalHash, taxEffectiveDate: row[dateColumn], taxBreakdown: breakdown };
};

type PersistedTaxSourceSemantics = {
  source_type?: string | null;
  source_key?: string | null;
  reversed_source_type?: string | null;
  account_role?: string | null;
};

/** Resolve tax direction from persisted ownership, never from the VAT rate. */
export const taxExportDirectionFromPersistedSource = (source: PersistedTaxSourceSemantics): TaxExportDirection => {
  const sourceType = source.reversed_source_type ?? source.source_type;
  if (sourceType === 'incoming_invoice' || source.account_role === 'expense' || source.account_role === 'asset' || source.account_role === 'input_vat') return 'input';
  if (sourceType === 'outgoing_invoice' || sourceType === 'payment_vat' || sourceType === 'asset_disposal' || source.account_role === 'revenue' || source.account_role === 'output_vat' || source.account_role === 'output_vat_deferred') return 'output';
  throw new Error('TAX_EXPORT_DIRECTION_UNRESOLVED');
};

const sourceEntries = async (db: PostgresQueryable, scope: TenantScope, supplied?: readonly TaxExportEntry[]): Promise<TaxExportEntry[]> => {
  if (supplied) return [...supplied];
  const rows = await q<any>(db, `SELECT je.id AS entry_id,je.posting_date,je.status,je.source_type,je.source_key,reversed_source.source_type AS reversed_source_type,aam.role AS account_role,jl.tax_case_key,jl.tax_rate,jl.net_amount,jl.tax_amount,jl.gross_amount,jl.country_code,jl.counterparty_vat_id,jl.evidence_type,jl.evidence_reference,jl.datev_sachverhalt_ll,jl.debit_amount,jl.credit_amount FROM journal_entries je JOIN journal_lines jl ON jl.tenant_id=je.tenant_id AND jl.entry_id=je.id LEFT JOIN journal_entries reversed_source ON reversed_source.tenant_id=je.tenant_id AND reversed_source.reversed_entry_id=je.id LEFT JOIN accounting_account_mappings aam ON aam.tenant_id=je.tenant_id AND aam.account_number=jl.account_number AND aam.chart=COALESCE((SELECT active_chart FROM accounting_policies WHERE tenant_id=je.tenant_id),'SKR03') WHERE je.tenant_id=$1 AND je.status IN ('posted','reversed') ORDER BY je.posting_date,je.entry_number,jl.line_no`, [tenant(scope)]);
  const grouped = new Map<string, TaxExportEntry>();
  for (const row of rows) {
    const key = `${row.posting_date}:${row.status}:${row.entry_id ?? ''}`;
    const current: TaxExportEntry = grouped.get(key) ?? { postingDate: row.posting_date, status: row.status, lines: [] };
    if (row.tax_case_key) current.lines.push({ taxCaseKey: row.tax_case_key, direction: taxExportDirectionFromPersistedSource(row), netAmount: row.net_amount == null ? undefined : Number(row.net_amount), taxAmount: row.tax_amount == null ? undefined : Number(row.tax_amount), grossAmount: row.gross_amount == null ? undefined : Number(row.gross_amount), taxRate: row.tax_rate == null ? undefined : Number(row.tax_rate), countryCode: row.country_code ?? undefined, counterpartyVatId: row.counterparty_vat_id ?? undefined, evidenceType: row.evidence_type ?? undefined, evidenceReference: row.evidence_reference ?? undefined, datevSachverhaltLl: row.datev_sachverhalt_ll ?? undefined });
    grouped.set(key, current);
  }
  return [...grouped.values()];
};

const defaultUstvaCatalog = (taxYear: number) => {
  const entries = CANONICAL_TAX_CASES.flatMap((entry, index) => ([
    { taxCaseKey: entry.key, kennziffer: String(index + 1).padStart(2, '0'), direction: 'output' as const },
    { taxCaseKey: entry.key, kennziffer: String(index + 1).padStart(2, '0'), direction: 'input' as const },
  ]));
  return { id: `billme-tax-catalog-${taxYear}`, taxYear, version: 'canonical-1', source: 'billme-canonical-tax-catalog', sourceHash: hash(entries), official: false, entries };
};

const closingSourceType = (command: string): string => ({ fiscal_close: 'fiscal_close', carry_forward: 'carry_forward', provision: 'provision', accrual: 'accrual', inventory_closing: 'inventory_closing', fx_valuation: 'fx_valuation', loan_schedule: 'loan_schedule', payroll_batch: 'payroll_batch', shareholder_flow: 'shareholder_flow', source_fact: 'standalone_source' }[command] ?? command);

const buildClosingResult = (command: string, input: Record<string, any>): any => {
  switch (command) {
    case 'source_fact': return buildJournalCommand(input as AccountingSourceFact);
    case 'fiscal_close': return buildFiscalClose(input as any);
    case 'carry_forward': return buildCarryForward(input as any);
    case 'provision': return buildProvisionCommand(input as any);
    case 'accrual': return planAccrualSchedule(input as any);
    case 'inventory_closing': return buildInventoryClosingValuation(input as any);
    case 'fx_valuation': return buildFxValuation(input as any);
    case 'loan_schedule': return planLoanSchedule(input as any);
    case 'payroll_batch': return validatePayrollBatch(input as any);
    case 'shareholder_flow': return validateShareholderFlow(input as any);
    default: throw new Error('UNKNOWN_CLOSING_COMMAND');
  }
};

const settlementDate = (input: Record<string, any>): string => required(input.postingDate ?? input.effectiveDate ?? input.adjustmentDate ?? input.facts?.adjustmentDate ?? input.finalInvoice?.taxEffectiveDate, 'SETTLEMENT_DATE_REQUIRED');

const settlementDocumentType = (facts: Record<string, any>): 'outgoing_invoice' | 'incoming_invoice' =>
  facts.documentType === 'incoming_invoice' || facts.direction === 'input' ? 'incoming_invoice' : 'outgoing_invoice';

const nestedSettlementFacts = (facts: Record<string, any>): Record<string, any> =>
  facts.facts && typeof facts.facts === 'object' ? facts.facts : {};

const settlementReference = (facts: Record<string, any>): string | undefined => {
  const nested = nestedSettlementFacts(facts);
  const original = facts.original && typeof facts.original === 'object' ? facts.original : {};
  return textValue(facts.originalDocumentId)
    ?? textValue(nested.originalDocumentId)
    ?? textValue(original.documentId);
};

const assertOpenItemEligible = async (db: PostgresQueryable, scope: TenantScope, item: any): Promise<void> => {
  if (!item || !['open', 'partially_paid'].includes(String(item.status)) || Number(item.residual_amount) <= 0) throw new Error('OPEN_ITEM_NOT_ELIGIBLE');
  if (!item.journal_entry_id) throw new Error('OPEN_ITEM_NOT_POSTED');
  const journal = (await q<any>(db, `SELECT status FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenant(scope), item.journal_entry_id]))[0];
  if (journal?.status !== 'posted') throw new Error('OPEN_ITEM_NOT_POSTED');
};

const findSettlementOpenItem = async (db: PostgresQueryable, scope: TenantScope, id: string, documentType?: string): Promise<any> => {
  const values: unknown[] = [tenant(scope), id];
  const typeClause = documentType ? ` AND source_type=$3` : '';
  if (documentType) values.push(documentType);
  const row = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND (id=$2 OR source_id=$2)${typeClause} FOR UPDATE`, values))[0];
  if (!row) throw new Error('OPEN_ITEM_NOT_FOUND');
  await assertOpenItemEligible(db, scope, row);
  return row;
};

const assertSettlementReferences = async (db: PostgresQueryable, scope: TenantScope, kind: SettlementCommandKind, facts: Record<string, any>): Promise<void> => {
  const documentType = settlementDocumentType(facts);
  const table = documentType === 'incoming_invoice' ? 'incoming_invoices' : 'invoices';
  let originalId = settlementReference(facts);
  if (kind !== 'advance_settlement') {
    const requestedOpenItemId = textValue(facts.openItemId);
    const referencedItem = !originalId && requestedOpenItemId
      ? await findSettlementOpenItem(db, scope, requestedOpenItemId, documentType)
      : undefined;
    originalId ??= referencedItem?.source_id;
    if (!originalId) throw new Error('ORIGINAL_DOCUMENT_REQUIRED');
    const original = (await q<any>(db, `SELECT id,number,accounting_status,accounting_journal_entry_id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), originalId]))[0];
    if (!original) throw new Error('ORIGINAL_DOCUMENT_NOT_FOUND');
    const journal = original.accounting_journal_entry_id
      ? (await q<any>(db, `SELECT status,source_type,source_key FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenant(scope), original.accounting_journal_entry_id]))[0]
      : undefined;
    if (original.accounting_status !== 'posted' || journal?.status !== 'posted' || journal.source_type !== documentType || journal.source_key !== `${documentType}:${original.id}`) throw new Error('DOCUMENT_NOT_POSTED');
    const item = referencedItem ?? await findSettlementOpenItem(db, scope, original.id, documentType);
    const nested = nestedSettlementFacts(facts);
    const requestedNumber = textValue(facts.originalDocumentNumber) ?? textValue(nested.originalDocumentNumber);
    if (requestedNumber && requestedNumber !== original.number) throw new Error('ORIGINAL_CHANGED');
    const requested = Number(kind === 'skonto' ? facts.skontoAmount : facts.writeOffGrossAmount);
    if (Number.isFinite(requested) && requested > Number(item.residual_amount) + 0.01) throw new Error('SETTLEMENT_EXCEEDS_OPEN_ITEM');
    return;
  }

  const finalInvoice = facts.finalInvoice && typeof facts.finalInvoice === 'object' ? facts.finalInvoice : {};
  const finalId = textValue(finalInvoice.id) ?? textValue(facts.finalInvoiceId) ?? originalId;
  if (!finalId) throw new Error('FINAL_INVOICE_REQUIRED');
  await findSettlementOpenItem(db, scope, finalId, documentType);
  const documents = [...(Array.isArray(facts.advances) ? facts.advances : []), ...(Array.isArray(facts.partialInvoices) ? facts.partialInvoices : [])];
  if (!documents.length) throw new Error('SETTLEMENT_DOCUMENT_REQUIRED');
  for (const document of documents) {
    const id = document && typeof document === 'object' ? textValue(document.id) : undefined;
    if (!id) throw new Error('SETTLEMENT_DOCUMENT_REQUIRED');
    const item = await findSettlementOpenItem(db, scope, id);
    const requested = Number(document.grossAmount);
    if (Number.isFinite(requested) && requested > Number(item.residual_amount) + 0.01) throw new Error('SETTLEMENT_EXCEEDS_OPEN_ITEM');
  }
};

export const createPostgresAccountingSourceRunRepository = (db: PostgresQueryable): AccountingSourceRunRepository => ({
  async listAccountingSourceRuns(scope, args = {}) {
    const values: unknown[] = [tenant(scope)];
    const condition = ['tenant_id=$1'];
    if (args.sourceType) { values.push(args.sourceType); condition.push(`source_type=$${values.length}`); }
    values.push(Math.min(500, Math.max(1, args.limit ?? 100)));
    return (await q<any>(db, `SELECT * FROM accounting_source_runs WHERE ${condition.join(' AND ')} ORDER BY created_at DESC LIMIT $${values.length}`, values)).map(mapRun);
  },
  async getAccountingSourceRun(scope, id) {
    const row = (await q<any>(db, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND id=$2`, [tenant(scope), id]))[0];
    return row ? mapRun(row) : null;
  },
  async createCorrectionSettlement(scope, input) {
    const reason = mutationReason(input);
    const id = required(input.id, 'CORRECTION_ID_REQUIRED');
    const idempotencyKey = required(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
    const sourceType = 'correction';
    return inTx(db, async (tx) => {
      const documentType = input.documentType ?? 'outgoing_invoice';
      const original = await resolveCorrectionOriginal(tx, scope, input.original, documentType);
      const correction = createLinkedCorrection({ id, idempotencyKey, correctionDate: input.correctionDate, taxEffectiveDate: input.taxEffectiveDate, original, deltas: input.deltas });
      const source = { ...input, mutation: undefined, reason: undefined, original, document: correction.document };
      const existing = (await q<any>(tx, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND source_revision=$4 FOR UPDATE`, [tenant(scope), sourceType, correction.document.id, correction.document.originalRevision]))[0];
      if (existing) {
        if (existing.source_hash !== hash(source) || existing.idempotency_key !== correction.document.idempotencyKey) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
        return { run: mapRun(existing), document: parse(existing.result_json, correction.document), replayed: true };
      }
      const keyOwner = (await q<any>(tx, `SELECT source_type,source_id,source_revision FROM accounting_source_runs WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenant(scope), correction.document.idempotencyKey]))[0];
      if (keyOwner) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
      // Existing corrections are the OPOS settlement ledger for this
      // original. Feed them back into the pure validator so a second
      // correction cannot credit more than the immutable original amount.
      const priorRows = await q<any>(tx, `SELECT result_json FROM accounting_source_runs WHERE tenant_id=$1 AND source_type=$2 FOR UPDATE`, [tenant(scope), sourceType]);
      const priorCorrections = priorRows
        .map((row) => parse<LinkedCorrectionDocument | undefined>(row.result_json, undefined))
        .filter((document): document is LinkedCorrectionDocument => document?.originalDocumentId === correction.document.originalDocumentId);
      const linked = createLinkedCorrection({ id: correction.document.id, idempotencyKey: correction.document.idempotencyKey, correctionDate: correction.document.correctionDate, taxEffectiveDate: correction.document.taxEffectiveDate, original, deltas: input.deltas, existing: priorCorrections });
      const postingDate = input.postingDate ?? correction.document.correctionDate;
      const lines = await correctionLines(tx, scope, linked.document, documentType);
      const command = { entry: { id: `correction:${linked.document.id}`, postingDate, documentDate: linked.document.taxEffectiveDate, bookingText: `Korrektur zu ${linked.document.originalDocumentNumber}`, reference: linked.document.originalDocumentNumber, period: periodOf(postingDate), fiscalYear: Number(postingDate.slice(0, 4)), status: 'posted', sourceType: 'standalone_source', sourceKey: `correction:${linked.document.id}`, lines } };
      const journalEntryId = await insertCommand(tx, scope, command, input);
      const run = await createRun(tx, scope, { sourceType, sourceId: linked.document.id, sourceRevision: linked.document.originalRevision, idempotencyKey: linked.document.idempotencyKey, status: 'posted', source, result: linked.document, journalEntryId, reason, mutation: input.mutation });
      const originalItem = (await q<any>(tx, `SELECT * FROM open_items WHERE tenant_id=$1 AND source_id=$2 AND source_type IN ('outgoing_invoice','incoming_invoice') FOR UPDATE`, [tenant(scope), correction.document.originalDocumentId]))[0];
      if (originalItem) {
        const correctionItemId = `correction-open-item:${linked.document.id}`;
        await q(tx, `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,$3,$4,'correction',$5,$6,$7,$7,$8,0,$8,'open',$9,$10,$10) ON CONFLICT (id) DO NOTHING`, [correctionItemId, tenant(scope), originalItem.party_type, originalItem.party_id, linked.document.id, `Korrektur ${linked.document.originalDocumentNumber}`, postingDate, linked.document.creditGrossAmount, journalEntryId, now()]);
      }
      return { run: run.run, document: linked.document, replayed: run.replayed };
    });
  },
  async runClosingCommand(scope, input) {
    const reason = mutationReason(input);
    const commandName = String(input.commandType ?? input.command ?? 'source_fact');
    const sourceInput = { ...(input.input ?? input) } as Record<string, any>;
    delete sourceInput.reason; delete sourceInput.command; delete sourceInput.commandType; delete sourceInput.input; delete sourceInput.mutation; delete sourceInput.idempotencyKey; delete sourceInput.softLockOverride; delete sourceInput.overrideReason;
    const sourceType = closingSourceType(commandName);
    const sourceId = required(input.sourceId ?? sourceInput.sourceId ?? sourceInput.batchId ?? sourceInput.flowId, 'MISSING_SOURCE_ID');
    const sourceRevision = required(input.sourceRevision ?? sourceInput.sourceRevision, 'MISSING_SOURCE_REVISION');
    sourceInput.sourceId ??= sourceId;
    sourceInput.sourceRevision ??= sourceRevision;
    const idempotencyKey = required(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
    return inTx(db, async (tx) => {
      const existing = (await q<any>(tx, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND source_revision=$4 FOR UPDATE`, [tenant(scope), sourceType, sourceId, sourceRevision]))[0];
      const source = { command: commandName, input: sourceInput };
      if (existing) {
        if (existing.source_hash !== hash(source) || existing.idempotency_key !== idempotencyKey) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
        return { run: mapRun(existing), result: parse(existing.result_json, {}), replayed: true };
      }
      const isSettlement = commandName === 'skonto' || commandName === 'bad_debt' || commandName === 'advance_settlement';
      if (isSettlement) await assertSettlementReferences(tx, scope, commandName as SettlementCommandKind, sourceInput);
      const built = isSettlement
        ? await (async () => {
          const date = settlementDate(sourceInput);
          const mappings = await chartAndMappings(tx, scope);
          const settlement = buildSettlementJournalCommand({
            kind: commandName as SettlementCommandKind,
            facts: sourceInput,
            source: {
              sourceId,
              sourceRevision,
              effectiveDate: String(sourceInput.effectiveDate ?? date),
              postingDate: date,
              period: String(sourceInput.period ?? periodOf(date)),
              fiscalYear: Number(sourceInput.fiscalYear ?? date.slice(0, 4)),
              currency: String(sourceInput.currency ?? 'EUR'),
              reference: textValue(sourceInput.reference),
            },
            accounts: settlementAccounts(mappings.mappings, sourceInput),
          });
          return { status: 'ready', value: { command: settlement.command, result: settlement.result } };
        })()
        : buildClosingResult(commandName, sourceInput);
      if (built.status === 'rejected' || built.status === 'invalid') throw new Error(`CLOSING_COMMAND_REJECTED:${built.errors?.[0]?.code ?? 'INVALID'}`);
      const value = built.value ?? built;
      // Source facts and single-command validators return the JournalCommand
      // directly, while schedules wrap all derived entries in `commands`.
      // Persist every derived command; never trust a submitted command list.
      const commands = [value.command, ...(value.commands ?? []), ...(value.entry ? [value] : [])].filter(Boolean) as any[];
      const resultJson = { command: commandName, result: value, status: built.status };
      const journalEntryIds: string[] = [];
      for (const derived of commands) journalEntryIds.push(await insertCommand(tx, scope, derived, input));
      const journalEntryId = journalEntryIds[0];
      const run = await createRun(tx, scope, { sourceType, sourceId, sourceRevision, idempotencyKey, status: journalEntryIds.length ? 'posted' : 'noop', source, result: { ...resultJson, journalEntryIds }, journalEntryId, reason, mutation: input.mutation });
      return { run: run.run, result: { ...resultJson, journalEntryIds }, replayed: run.replayed };
    });
  },
  async prepareTaxExport(scope, input) {
    const reason = mutationReason(input);
    const period = typeof input.period === 'string' ? { period: input.period, year: input.year } : input.period;
    const entries = await sourceEntries(db, scope, input.entries);
    const catalog = input.catalog ?? defaultUstvaCatalog(Number(String(period.period).slice(0, 4)));
    let artifact: TaxExportPreparation;
    try {
      artifact = input.kind === 'ustva'
        ? prepareUstva({ period, catalog, entries })
        : input.kind === 'zm'
          ? aggregateZm({ period, entries })
          : aggregateOss({ period, entries });
    } catch (error) {
      const taxError = error as TaxExportError;
      throw new Error(`${taxError.code ?? 'TAX_EXPORT_INVALID'}:${taxError.message ?? 'tax export preparation failed'}`);
    }
    const sourceType = `tax_export_${input.kind}`;
    const sourceId = period.period;
    const source = { kind: input.kind, period, catalog: input.kind === 'ustva' ? catalog : undefined, entries };
    const sourceRevision = hash(source);
    const idempotencyKey = required(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
    return inTx(db, async (tx) => {
      const existing = (await q<any>(tx, `SELECT * FROM accounting_source_runs WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND source_revision=$4 FOR UPDATE`, [tenant(scope), sourceType, sourceId, sourceRevision]))[0];
      if (existing) {
        if (existing.idempotency_key !== idempotencyKey) throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT');
        return { run: mapRun(existing), artifact: parse(existing.result_json, artifact), replayed: true };
      }
      const run = await createRun(tx, scope, { sourceType, sourceId, sourceRevision, idempotencyKey, status: 'prepared', source, result: artifact, reason, mutation: input.mutation });
      return { run: run.run, artifact, replayed: run.replayed };
    });
  },
  async getTaxExportArtifact(scope, kind, id) {
    const run = await this.getAccountingSourceRun(scope, id);
    if (!run || run.sourceType !== `tax_export_${kind}`) throw new Error('TAX_EXPORT_NOT_FOUND');
    return run.result as TaxExportPreparation;
  },
  async exportTaxArtifact(scope, kind, id) {
    const artifact = await this.getTaxExportArtifact(scope, kind, id);
    return new TextEncoder().encode(stableJson(artifact));
  },
});
