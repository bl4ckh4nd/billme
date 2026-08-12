import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  buildDepreciationSchedule,
  computeAssetDisposal,
  DEPRECIATION_EXPENSE_ACCOUNTS,
  resolveDepreciationMethod,
} from '@billme/accounting-engine';
import type {
  AccountingAccountMapping, AccountingBackfillConfirmation, AccountingBackfillPreview, AccountingBackfillResult,
  AccountingDocumentSource, AccountingPostingPreview, AccountingSnapshot, IncomingInvoiceEntity,
  IncomingInvoiceLineEntity, OpenItemEntity, OpenItemPaymentEntity, OpenItemPaymentInput, VendorEntity,
  BookingDraftEntity, JournalEntryEntity, JournalLineEntity, LedgerBalance, ValidationIssue, AccountingMutationContext, DatevExportContent, DatevExportSourceSnapshot,
} from '@billme/accounting-shared';
import type {
  TenantScope, ProAccountingAssetRepository, ProAccountingRepository, PostDraftOptions, ProDraftActionRequest, ReverseJournalEntryOptions,
  AssetDepreciationInput, AssetDepreciationResult, AssetDepreciationScheduleEntry, AssetDisposalInput, AssetDisposalResult,
  AssetItem, AssetMutationOptions, AssetStatus, AssetUpsertInput,
} from '@billme/server-core';
import type { PostgresQueryable, PostgresTransactionClient } from './connection.js';
import { withSerializablePostgresTransaction } from './connection.js';
import { appendWithClient } from './audit.js';

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const isPool = (db: PostgresQueryable): db is Pool => typeof (db as Pool).connect === 'function';
const inTx = <T>(db: PostgresQueryable, work: (client: PostgresTransactionClient) => Promise<T>): Promise<T> =>
  isPool(db) ? withSerializablePostgresTransaction(db, work) : work(db as PostgresTransactionClient);
const tenant = (scope: TenantScope): string => scope.tenantId;
const now = (): string => new Date().toISOString();
const round = (n: unknown): number => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const cents = (n: unknown): number | null => { const value = Number(n); if (!Number.isFinite(value)) return null; const c = Math.round(value * 100); return Math.abs(value - c / 100) < 1e-8 ? c : null; };
const isoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const period = (date: string): string => date.slice(0, 7);
const parse = <T>(value: unknown, fallback: T): T => { if (value == null) return fallback; try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T); } catch { return fallback; } };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issue = (code: string, message: string, fieldPath?: string): ValidationIssue => ({ id: randomUUID(), code, severity: 'error', message, fieldPath, blocking: true, source: 'system' });
const defaultActor = { type: 'service' as const, displayName: 'server-accounting' };

const audit = (client: PostgresTransactionClient, scope: TenantScope, entityType: string, entityId: string, action: string, reason: string, before: unknown, after: unknown, mutation?: AccountingMutationContext): Promise<unknown> => {
  const suppliedReason = mutation?.reason?.trim();
  if (mutation && !suppliedReason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
  return appendWithClient(client, scope, { occurredAt: now(), action, reason: suppliedReason || reason, actor: mutation?.actor ?? defaultActor, subject: { entityType, entityId, tenantId: tenant(scope) }, change: { before, after } });
};

export const insertJournalPostingPair = (db: PostgresQueryable, values: readonly unknown[]) => q(db, `INSERT INTO journal_posting_pairs (id,tenant_id,entry_id,debit_line_id,credit_line_id,amount,tax_case_key,datev_bu_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [...values]);

const mapLine = (row: any): JournalLineEntity => ({
  id: row.id, accountNumber: row.account_number, debitAmount: Number(row.debit_amount || 0), creditAmount: Number(row.credit_amount || 0),
  taxCode: row.tax_code ?? undefined, taxCaseKey: row.tax_case_key ?? undefined, taxRate: row.tax_rate == null ? undefined : Number(row.tax_rate),
  netAmount: row.net_amount == null ? undefined : Number(row.net_amount), taxAmount: row.tax_amount == null ? undefined : Number(row.tax_amount), grossAmount: row.gross_amount == null ? undefined : Number(row.gross_amount),
  countryCode: row.country_code ?? undefined, counterpartyVatId: row.counterparty_vat_id ?? undefined, evidenceType: row.evidence_type ?? undefined,
  evidenceReference: row.evidence_reference ?? undefined, costCenter: row.cost_center ?? undefined, memo: row.memo ?? undefined,
});
const loadEntry = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<JournalEntryEntity | null> => {
  const rows = await q<any>(db, `SELECT * FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenant(scope), id]);
  const row = rows[0]; if (!row) return null;
  const lines = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [tenant(scope), id]);
  return { id: row.id, tenantId: row.tenant_id, entryNumber: Number(row.entry_number), postingDate: row.posting_date, documentDate: row.document_date ?? undefined, bookingText: row.booking_text, reference: row.reference ?? undefined, period: row.period, fiscalYear: Number(row.fiscal_year), status: row.status === 'reversed' ? 'reversed' : 'posted', sourceDraftId: row.source_draft_id ?? undefined, sourceType: row.source_type ?? undefined, sourceKey: row.source_key ?? undefined, reversedEntryId: row.reversed_entry_id ?? undefined, createdAt: row.created_at, lines: lines.map(mapLine) };
};

const draftFromRows = (row: any, lines: any[], issues: any[], scope: TenantScope): BookingDraftEntity => {
  const value = parse<Partial<BookingDraftEntity>>(row.draft_json, {});
  return {
    id: row.id, tenantId: tenant(scope), transactionId: row.transaction_id, workflowStatus: row.workflow_status,
    postingDate: value.postingDate, documentDate: value.documentDate, bookingText: value.bookingText ?? '', reference: value.reference,
    period: value.period ?? period(value.postingDate ?? now().slice(0, 10)), fiscalYear: Number(value.fiscalYear ?? new Date().getUTCFullYear()),
    lines: lines.map((line) => ({ id: line.id, accountNumber: line.account_number, debitAmount: Number(line.debit_amount || 0), creditAmount: Number(line.credit_amount || 0), taxCode: line.tax_code ?? undefined, taxCaseKey: line.tax_case_key ?? undefined, taxRate: line.tax_rate == null ? undefined : Number(line.tax_rate), netAmount: line.net_amount == null ? undefined : Number(line.net_amount), taxAmount: line.tax_amount == null ? undefined : Number(line.tax_amount), grossAmount: line.gross_amount == null ? undefined : Number(line.gross_amount), countryCode: line.country_code ?? undefined, counterpartyVatId: line.counterparty_vat_id ?? undefined, evidenceType: line.evidence_type ?? undefined, evidenceReference: line.evidence_reference ?? undefined, costCenter: line.cost_center ?? undefined, memo: line.memo ?? undefined })),
    validationIssues: issues.map((item) => parse<ValidationIssue>(item.issue_json, { id: item.id, code: item.code, severity: item.severity, message: item.message, fieldPath: item.field_path ?? undefined, blocking: Boolean(item.blocking), source: item.source })), updatedAt: row.updated_at,
  };
};
const getDraft = async (db: PostgresQueryable, scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null> => {
  const t = tenant(scope);
  const rows = await q<any>(db, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND transaction_id=$2`, [t, transactionId]);
  if (!rows[0]) return null;
  const lines = await q<any>(db, `SELECT * FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2 ORDER BY line_no`, [t, rows[0].id]);
  const issues = await q<any>(db, `SELECT * FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2 ORDER BY created_at`, [t, rows[0].id]);
  return draftFromRows(rows[0], lines, issues, scope);
};
const ensurePeriod = async (db: PostgresQueryable, t: string, key: string, status = 'open'): Promise<string> => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new Error('INVALID_PERIOD');
  const year = Number(key.slice(0, 4)); const existing = await q<any>(db, `SELECT status FROM accounting_periods WHERE tenant_id=$1 AND period=$2 FOR UPDATE`, [t, key]);
  if (existing[0]) return existing[0].status;
  const start = `${key}-01`; const endDate = new Date(Date.UTC(year, Number(key.slice(5)), 0)); const end = endDate.toISOString().slice(0, 10);
  await q(db, `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (tenant_id,period) DO NOTHING`, [randomUUID(), t, key, year, status, start, end, now()]);
  return status;
};
const policy = async (db: PostgresQueryable, t: string): Promise<{ activeChart: 'SKR03'|'SKR04'; vatMethod: 'soll'|'ist'; periodPolicy: 'calendar_month'; updatedAt: string; tenantId: string }> => {
  const rows = await q<any>(db, `SELECT * FROM accounting_policies WHERE tenant_id=$1`, [t]); const row = rows[0];
  return { tenantId: t, activeChart: row?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03', vatMethod: row?.vat_method === 'ist' ? 'ist' : 'soll', periodPolicy: 'calendar_month', updatedAt: row?.updated_at ?? '' };
};
const defaults: Record<'SKR03'|'SKR04', Record<string, string>> = {
  SKR03: { accounts_receivable: '1400', accounts_payable: '1600', bank: '1200', revenue: '8400', expense: '4900', asset: '0480', output_vat: '1776', output_vat_deferred: '1780', input_vat: '1576' },
  SKR04: { accounts_receivable: '1200', accounts_payable: '3300', bank: '1800', revenue: '4400', expense: '6300', asset: '0670', output_vat: '3806', output_vat_deferred: '3810', input_vat: '1406' },
};
const mappings = async (db: PostgresQueryable, t: string, chart: 'SKR03'|'SKR04'): Promise<Record<string, string>> => {
  const rows = await q<any>(db, `SELECT role,account_number FROM accounting_account_mappings WHERE tenant_id=$1 AND chart=$2`, [t, chart]);
  const out = { ...defaults[chart] }; for (const row of rows) if (row.role in out) out[row.role] = row.account_number; return out;
};
const taxCaseAccount = async (db: PostgresQueryable, t: string, chart: string, taxCaseKey: string | undefined, role: 'output_tax' | 'input_tax', fallback: string, date?: string): Promise<string> => {
  if (!taxCaseKey) return fallback;
  const rows = await q<any>(db, `SELECT account_number FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=$2 AND tax_case_key=$3 AND role=$4 AND (valid_from IS NULL OR valid_from <= COALESCE($5,CURRENT_DATE::text)) AND (valid_to IS NULL OR valid_to >= COALESCE($5,CURRENT_DATE::text)) ORDER BY (tenant_id IS NULL) ASC, valid_from DESC NULLS LAST, updated_at DESC LIMIT 1`, [t, chart, taxCaseKey, role, date ?? null]);
  return rows[0]?.account_number ?? fallback;
};
const backfillConfig = async (db: PostgresQueryable, t: string): Promise<unknown> => {
  const p = await policy(db, t);
  const rows = await q<any>(db, `SELECT chart,role,account_number FROM accounting_account_mappings WHERE tenant_id=$1 ORDER BY chart,role,account_number`, [t]);
  // Tax-case mappings are global but still part of the posting configuration:
  // a change to a date-valid account or DATEV BU must invalidate a preview.
  // Keep every row for the active chart, rather than only today's winner, so
  // candidates with different document dates are protected as well.
  const taxCaseMappings = await q<any>(db, `SELECT tenant_id,chart,tax_case_key,role,account_number,datev_bu_key,valid_from,valid_to,updated_at,id FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=$2 ORDER BY (tenant_id IS NULL),tax_case_key,role,valid_from NULLS FIRST,valid_to NULLS LAST,updated_at,id`, [t, p.activeChart]);
  return { policy: p, mappings: rows, taxCaseMappings };
};
const accountExists = async (db: PostgresQueryable, chart: string, account: string): Promise<boolean> => {
  const count = await q<any>(db, `SELECT COUNT(*)::int AS c FROM ledger_accounts WHERE chart=$1`, [chart]);
  if (!Number(count[0]?.c)) return true; return Boolean((await q(db, `SELECT 1 FROM ledger_accounts WHERE chart=$1 AND account_number=$2 LIMIT 1`, [chart, account]))[0]);
};
const validateDraft = async (db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, periodStatus: string, chart: 'SKR03'|'SKR04'): Promise<ValidationIssue[]> => {
  const out: ValidationIssue[] = []; const debit = draft.lines.reduce((sum, l) => sum + (cents(l.debitAmount) ?? 0), 0); const credit = draft.lines.reduce((sum, l) => sum + (cents(l.creditAmount) ?? 0), 0);
  if (!isoDate(draft.postingDate)) out.push(issue('INVALID_POSTING_DATE', 'Buchungsdatum ist ungültig.', 'postingDate'));
  else if (draft.period !== period(draft.postingDate) || draft.fiscalYear !== Number(draft.postingDate.slice(0, 4))) out.push(issue('POSTING_PERIOD_MISMATCH', 'Periode und Geschäftsjahr müssen zum Buchungsdatum passen.', 'period'));
  if (!isoDate(draft.documentDate ?? draft.postingDate)) out.push(issue('INVALID_DOCUMENT_DATE', 'Belegdatum ist ungültig.', 'documentDate'));
  if (debit !== credit || debit <= 0) out.push(issue('UNBALANCED_ENTRY', 'Soll und Haben sind nicht ausgeglichen.'));
  if (draft.lines.length < 2) out.push(issue('MISSING_ACCOUNT', 'Mindestens zwei Buchungszeilen sind erforderlich.'));
  const ids = new Set<string>();
  for (const [index, line] of draft.lines.entries()) {
    if (!line.accountNumber) out.push(issue('MISSING_ACCOUNT', 'Sachkonto fehlt.', `lines[${index}].accountNumber`));
    if (ids.has(line.id)) out.push(issue('DUPLICATE_LINE_ID', 'Buchungszeilen müssen eindeutige IDs haben.', `lines[${index}].id`)); ids.add(line.id);
    const d = cents(line.debitAmount); const c = cents(line.creditAmount);
    if (d === null || c === null || d < 0 || c < 0 || (d > 0) === (c > 0)) out.push(issue('INVALID_LINE_AMOUNT', 'Beträge müssen Centbeträge mit genau einer Seite sein.', `lines[${index}]`));
    if (line.accountNumber && !(await accountExists(db, chart, line.accountNumber))) out.push(issue('UNKNOWN_ACCOUNT', `Sachkonto ${line.accountNumber} ist im Kontenrahmen nicht vorhanden.`, `lines[${index}].accountNumber`));
  }
  if (periodStatus === 'closed') out.push(issue('POSTING_DATE_IN_CLOSED_PERIOD', 'Periode ist geschlossen.'));
  return out;
};
const saveDraftTarget = async (db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, mutation?: AccountingMutationContext): Promise<BookingDraftEntity> => {
  const draftMutation = mutation ?? (draft as BookingDraftEntity & { mutation?: AccountingMutationContext }).mutation;
  const { mutation: _ignoredMutation, ...draftData } = draft as BookingDraftEntity & { mutation?: AccountingMutationContext };
  const t = tenant(scope); const transactionOwner = (await q<any>(db, `SELECT tenant_id FROM bank_transactions WHERE id=$1`, [draft.transactionId]))[0]; if (transactionOwner && transactionOwner.tenant_id !== t) throw new Error('BANK_TRANSACTION_NOT_FOUND'); const foreignDraft = (await q<any>(db, `SELECT tenant_id FROM booking_drafts WHERE id=$1 AND tenant_id<>$2`, [draft.id, t]))[0]; if (foreignDraft) throw new Error('DRAFT_NOT_FOUND'); const p = await policy(db, t); const normalized = { ...draftData, tenantId: t, lines: (draft.lines ?? []).map((line, i) => ({ ...line, id: line.id || `${draft.id}-${i + 1}`, debitAmount: round(line.debitAmount), creditAmount: round(line.creditAmount) })), period: draft.period || period(draft.postingDate ?? now().slice(0, 10)), fiscalYear: draft.fiscalYear || Number((draft.period || period(now().slice(0, 10))).slice(0, 4)), updatedAt: now() };
  const periodStatus = await ensurePeriod(db, t, normalized.period); normalized.validationIssues = await validateDraft(db, scope, normalized, periodStatus, p.activeChart); normalized.workflowStatus = normalized.validationIssues.some((x) => x.blocking) ? periodStatus === 'closed' ? 'period_locked' : 'incomplete' : normalized.workflowStatus;
  await q(db, `INSERT INTO booking_drafts (id,tenant_id,transaction_id,workflow_status,draft_json,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id,workflow_status=EXCLUDED.workflow_status,draft_json=EXCLUDED.draft_json,updated_at=EXCLUDED.updated_at`, [normalized.id, t, normalized.transactionId, normalized.workflowStatus, JSON.stringify(normalized), normalized.updatedAt]);
  await q(db, `DELETE FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2`, [t, normalized.id]); await q(db, `DELETE FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [t, normalized.id]);
  for (const [index, line] of normalized.lines.entries()) await q(db, `INSERT INTO booking_draft_lines (id,tenant_id,draft_id,line_no,account_number,debit_amount,credit_amount,tax_code,tax_case_key,tax_rate,net_amount,tax_amount,gross_amount,country_code,counterparty_vat_id,evidence_type,evidence_reference,cost_center,memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [line.id, t, normalized.id, index + 1, line.accountNumber, line.debitAmount, line.creditAmount, line.taxCode ?? null, line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.costCenter ?? null, line.memo ?? null]);
  for (const item of normalized.validationIssues) await q(db, `INSERT INTO draft_validation_issues (id,tenant_id,draft_id,code,severity,message,field_path,blocking,source,issue_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [item.id, t, normalized.id, item.code, item.severity, item.message, item.fieldPath ?? null, item.blocking, item.source, JSON.stringify(item), normalized.updatedAt]);
  await audit(db as PostgresTransactionClient, scope, 'booking_draft', normalized.id, 'save', 'Booking draft changed', null, { transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus }, draftMutation);
  return normalized;
};

const pairLines = (lines: JournalLineEntity[]): Array<{ debit: JournalLineEntity; credit: JournalLineEntity; amount: number; taxCaseKey?: string }> => {
  const debits = lines.filter((l) => Number(l.debitAmount) > 0).map((l) => ({ l, n: round(l.debitAmount) })); const credits = lines.filter((l) => Number(l.creditAmount) > 0).map((l) => ({ l, n: round(l.creditAmount) })); const out: Array<{ debit: JournalLineEntity; credit: JournalLineEntity; amount: number; taxCaseKey?: string }> = [];
  for (const debit of debits) for (const credit of credits) { if (debit.n <= 0 || credit.n <= 0) continue; const amount = round(Math.min(debit.n, credit.n)); out.push({ debit: debit.l, credit: credit.l, amount, taxCaseKey: debit.l.taxCaseKey ?? credit.l.taxCaseKey }); debit.n = round(debit.n - amount); credit.n = round(credit.n - amount); }
  return out.filter((x) => x.amount > 0);
};
const insertEntry = async (db: PostgresQueryable, scope: TenantScope, sourceType: string, sourceKey: string, postingDate: string, bookingText: string, lines: JournalLineEntity[], options: { documentDate?: string; reference?: string; sourceDraftId?: string; softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext; datevBuKeys?: Array<string | null> }): Promise<string> => {
  const t = tenant(scope); const sourceLockKey = options.sourceDraftId ? `billme:draft:${t}:${options.sourceDraftId}` : `billme:source:${t}:${sourceType}:${sourceKey}`; await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [sourceLockKey]); const existing = await q<any>(db, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND ((source_type=$2 AND source_key=$3) OR ($4::text IS NOT NULL AND source_draft_id=$4))`, [t, sourceType, sourceKey, options.sourceDraftId ?? null]); if (existing[0]) return existing[0].id;
  if (!isoDate(postingDate)) throw new Error('INVALID_POSTING_DATE'); const status = await ensurePeriod(db, t, period(postingDate)); if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD'); if (status === 'soft_locked' && (!options.softLockOverride || !options.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
  if (!lines.length) throw new Error('EMPTY_ENTRY'); const totalDebit = lines.reduce((sum, l) => sum + (cents(l.debitAmount) ?? -1), 0); const totalCredit = lines.reduce((sum, l) => sum + (cents(l.creditAmount) ?? -1), 0); if (totalDebit <= 0 || totalDebit !== totalCredit) throw new Error('UNBALANCED_ENTRY');
  for (const line of lines) { if (!line.accountNumber || (cents(line.debitAmount) ?? -1) < 0 || (cents(line.creditAmount) ?? -1) < 0 || (Number(line.debitAmount) > 0 && Number(line.creditAmount) > 0)) throw new Error(`INVALID_JOURNAL_LINE:${line.accountNumber}`); }
  await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`billme:entry-number:${t}`]); const nr = await q<any>(db, `SELECT COALESCE(MAX(entry_number),0)+1 AS n FROM journal_entries WHERE tenant_id=$1`, [t]); const entryNumber = Number(nr[0].n); const id = randomUUID(); const stamp = now();
  await q(db, `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_draft_id,source_type,source_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10,$11,$12,$13)`, [id, t, entryNumber, postingDate, options.documentDate ?? postingDate, bookingText, options.reference ?? null, period(postingDate), Number(postingDate.slice(0, 4)), options.sourceDraftId ?? null, sourceType, sourceKey, stamp]);
  for (const [index, line] of lines.entries()) await q(db, `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount,tax_code,tax_case_key,tax_rate,net_amount,tax_amount,gross_amount,evidence_type,evidence_reference,memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [line.id || randomUUID(), t, id, index + 1, line.accountNumber, round(line.debitAmount), round(line.creditAmount), line.taxCode ?? null, line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.memo ?? null]);
  const dbLines = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, id]); const byId = new Map(dbLines.map((line) => [line.id, line]));
  for (const [pairIndex, pair] of pairLines(lines).entries()) { const debit = byId.get(pair.debit.id); const credit = byId.get(pair.credit.id); if (debit && credit) { const mapping = options.datevBuKeys?.[pairIndex]; const configured = mapping === undefined ? (await q<any>(db, `SELECT datev_bu_key FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=COALESCE((SELECT active_chart FROM accounting_policies WHERE tenant_id=$1),'SKR03') AND tax_case_key=$2 AND role='datev_bu' AND (valid_from IS NULL OR valid_from <= $3) AND (valid_to IS NULL OR valid_to >= $3) ORDER BY (tenant_id IS NULL),valid_from DESC NULLS LAST,updated_at DESC LIMIT 1`, [t, pair.taxCaseKey ?? '', postingDate]))[0]?.datev_bu_key ?? null : mapping; await insertJournalPostingPair(db, [randomUUID(), t, id, debit.id, credit.id, pair.amount, pair.taxCaseKey ?? null, configured, stamp]); } }
  for (const line of lines.filter((l) => Number(l.taxAmount || 0) > 0 || l.evidenceType || l.evidenceReference)) await q(db, `INSERT INTO vat_evidence (id,tenant_id,entry_id,line_id,tax_case_key,evidence_type,evidence_reference,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), t, id, line.id, line.taxCaseKey ?? 'standard_vat', line.evidenceType ?? null, line.evidenceReference ?? null, stamp]);
  await audit(db as PostgresTransactionClient, scope, 'pro_journal_entry', id, 'post', options.overrideReason?.trim() || 'Accounting posting', null, { sourceType, sourceKey, entryNumber, postingDate }, options.mutation); return id;
};

const readInvoice = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<any | null> => (await q<any>(db, `SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), id]))[0] ?? null;
const invoiceLines = (row: any): Array<{ total: number; taxRate: number }> => {
  const raw = parse<any[]>(row.items_json, []); return raw.map((line) => ({ total: Number(line.total ?? line.amount ?? line.grossAmount ?? 0), taxRate: Number(line.taxRate ?? line.tax_rate ?? 0) })).filter((line) => Number.isFinite(line.total));
};
const taxCaseFor = (row: any, rate: number, category?: string): string => {
  const mode = String(row.tax_mode ?? '').toLowerCase();
  if (mode === 'small_business_19_ustg') return 'DE_KU19';
  if (mode === 'reverse_charge_13b') return 'DE_RC_13B_DOMESTIC';
  if (mode === 'intra_eu_supply_6a') return 'EU_IGL_GOODS_0';
  if (mode === 'intra_eu_service_reverse_charge') return 'EU_B2B_SERVICE_RC';
  if (mode === 'export_third_country') return 'NON_EU_EXPORT_0';
  if (mode === 'vat_exempt_4_ustg') return 'DE_ZERO_EXEMPT';
  if (mode === 'non_taxable_outside_scope') return 'NON_EU_SERVICE_RC';
  if (category === 'K') return 'EU_IGL_GOODS_0';
  if (category === 'G') return 'NON_EU_EXPORT_0';
  if (category === 'AE') return 'DE_RC_13B_DOMESTIC';
  if (category === 'E' || category === 'O' || rate === 0) return 'DE_ZERO_EXEMPT';
  return Math.abs(rate - 7) < .01 ? 'DE_STD_7' : 'DE_STD_19';
};
type TaxBreakdown = { rate: number; net: number; tax: number; gross: number; taxCaseKey: string };
const taxSnapshot = (row: any, incoming = false, sourceLines: any[] = []): { net: number; tax: number; gross: number; rate: number; breakdown: TaxBreakdown[] } | null => {
  const snap = parse<any>(row.tax_snapshot_json ?? row.accounting_snapshot_json, null);
  const category = snap?.einvoiceCategoryCode ?? parse<any>(row.tax_meta_json, null)?.einvoiceCategoryCode;
  const explicitBreakdown = Array.isArray(snap?.vatBreakdown) ? snap.vatBreakdown : [];
  const rawLines = sourceLines.length ? sourceLines.map((line) => ({ total: Number(line.gross_amount ?? line.total ?? 0), taxRate: Number(line.tax_rate ?? line.taxRate ?? 0), net: Number(line.net_amount ?? 0), tax: Number(line.tax_amount ?? 0) })) : (incoming ? [] : invoiceLines(row).map((line) => ({ total: line.total, taxRate: line.taxRate, net: 0, tax: 0 })));
  let net = Number(snap?.netAmount ?? row.net_amount);
  let tax = Number(snap?.vatAmount ?? snap?.taxAmount ?? row.tax_amount);
  let gross = Number(snap?.grossAmount ?? row.gross_amount ?? row.amount);
  if (!Number.isFinite(net) || !Number.isFinite(tax) || !Number.isFinite(gross)) {
    if (!rawLines.length) return null;
    gross = round(rawLines.reduce((sum, line) => sum + line.total, 0));
    net = round(rawLines.reduce((sum, line) => sum + (line.net > 0 ? line.net : line.total / (1 + line.taxRate / 100)), 0));
    tax = round(gross - net);
  }
  if (gross < 0 || net < 0 || tax < 0 || Math.abs(gross - net - tax) > .02) return null;
  const breakdown: TaxBreakdown[] = (explicitBreakdown.length ? explicitBreakdown.map((entry: any) => ({ rate: Number(entry.rate), net: round(entry.netAmount), tax: round(entry.vatAmount ?? entry.taxAmount), gross: round(Number(entry.netAmount) + Number(entry.vatAmount ?? entry.taxAmount)), taxCaseKey: typeof entry.taxCaseKey === 'string' ? entry.taxCaseKey : undefined })) : rawLines.length ? [...rawLines.reduce((map, line) => { const current = map.get(line.taxRate) ?? { rate: line.taxRate, net: 0, tax: 0, gross: 0 }; const lineNet = line.net > 0 ? line.net : line.total / (1 + line.taxRate / 100); current.net += lineNet; current.tax += line.tax > 0 ? line.tax : line.total - lineNet; current.gross += line.total; map.set(line.taxRate, current); return map; }, new Map<number, { rate: number; net: number; tax: number; gross: number }>()).values()] : [{ rate: Number(snap?.vatBreakdown?.[0]?.rate ?? row.tax_rate ?? 19), net, tax, gross }]).map((entry: any) => ({ ...entry, net: round(entry.net), tax: round(entry.tax), gross: round(entry.gross), taxCaseKey: entry.taxCaseKey ?? (row.tax_case_key && (explicitBreakdown.length === 1 || rawLines.every((line) => Math.abs(line.taxRate - entry.rate) < .01)) ? row.tax_case_key : taxCaseFor(row, entry.rate, category)) }));
  if (Math.abs(round(breakdown.reduce((sum: number, entry: TaxBreakdown) => sum + entry.net, 0)) - net) > .02 || Math.abs(round(breakdown.reduce((sum: number, entry: TaxBreakdown) => sum + entry.tax, 0)) - tax) > .02) return null;
  return { net: round(net), tax: round(tax), gross: round(gross), rate: breakdown[0]?.rate ?? 0, breakdown };
};
const sourceVersion = (row: any, lines: unknown): string => hash({ id: row.id, tenantId: row.tenant_id, number: row.number, date: row.date ?? row.invoice_date, dueDate: row.due_date, amount: row.amount ?? row.gross_amount, net: row.net_amount, tax: row.tax_amount, gross: row.gross_amount, taxMode: row.tax_mode, taxMeta: parse(row.tax_meta_json, null), taxSnapshot: parse(row.tax_snapshot_json, null), lines });
type FinalizedInvoiceReservation = { id: string; kind: string; number: string; status: string; document_id: string };
const finalizedInvoiceReservation = async (db: PostgresQueryable, t: string, row: any): Promise<FinalizedInvoiceReservation | null> =>
  (await q<FinalizedInvoiceReservation>(db, `SELECT id,kind,number,status,document_id FROM number_reservations WHERE tenant_id=$1 AND kind='invoice' AND status='finalized' AND document_id=$2 AND number=$3 LIMIT 1`, [t, row.id, row.number]))[0] ?? null;
const backfillOutgoingSourceVersion = (row: any, documentVersion: string, reservation: FinalizedInvoiceReservation | null): string =>
  hash({ documentVersion, eligibility: { status: row.status, accountingStatus: row.accounting_status, reservation: reservation && { id: reservation.id, kind: reservation.kind, number: reservation.number, status: reservation.status, documentId: reservation.document_id } } });
const incomingBackfillSourceVersion = (row: any, documentVersion: string): string =>
  hash({ documentVersion, eligibility: { status: row.status, accountingStatus: row.accounting_status } });
const postingPreview = async (db: PostgresQueryable, scope: TenantScope, row: any, type: 'outgoing_invoice'|'incoming_invoice'): Promise<AccountingPostingPreview> => {
  const t = tenant(scope); const p = await policy(db, t); const m = await mappings(db, t, p.activeChart); const category = parse<any>(row.tax_snapshot_json ?? row.accounting_snapshot_json, null)?.einvoiceCategoryCode ?? parse<any>(row.tax_meta_json, null)?.einvoiceCategoryCode; const incomingLines = type === 'incoming_invoice' ? (row.__incomingLines ?? await q<any>(db, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, row.id])) : []; const tax = taxSnapshot(row, type === 'incoming_invoice', incomingLines); const id = row.id;
  if (!tax) return { sourceType: type, sourceId: id, status: 'unresolved', reason: 'AMBIGUOUS_TAX_SNAPSHOT', issues: [{ code: 'AMBIGUOUS_TAX_SNAPSHOT', message: 'Netto, Steuer und Brutto konnten nicht sicher ermittelt werden.', blocking: true }] };
  const lines: AccountingSnapshot['lines'] = [{ accountNumber: type === 'outgoing_invoice' ? m.accounts_receivable : (incomingLines[0]?.account_number ?? incomingLines[0]?.asset_account_number ?? m.expense), debitAmount: type === 'outgoing_invoice' ? tax.gross : tax.net, creditAmount: 0 }];
  if (type === 'outgoing_invoice') {
    for (const entry of tax.breakdown) {
      const outputAccount = p.vatMethod === 'ist' ? m.output_vat_deferred : await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'output_tax', m.output_vat, row.date);
      // Ist VAT is deferred and must not appear in the initial VAT report.
      // Preserve the case only in the stable basis memo for payment-time
      // recognition; the control line itself remains unkeyed.
      lines.push(p.vatMethod === 'ist'
        ? { accountNumber: m.revenue, debitAmount: 0, creditAmount: entry.net, memo: `UStBasis ${entry.taxCaseKey}` }
        : { accountNumber: m.revenue, debitAmount: 0, creditAmount: entry.net, taxCaseKey: entry.taxCaseKey, netAmount: entry.net, taxAmount: entry.tax, grossAmount: entry.gross });
      if (entry.tax > 0) lines.push({ accountNumber: outputAccount, debitAmount: 0, creditAmount: entry.tax, memo: `USt ${entry.taxCaseKey}` });
    }
  } else {
    // Incoming expense/asset lines are independent debit bases.  The first
    // line must not absorb the whole invoice: doing so double-counts mixed
    // rates (e.g. 100@19% + 100@7%) and leaves the journal unbalanced.
    const expenseLines = incomingLines.length
      ? incomingLines.map((line: any) => {
        const rate = Number(line.tax_rate ?? 0);
        const gross = Number(line.gross_amount ?? 0);
        const net = Number(line.net_amount ?? (gross > 0 ? gross / (1 + rate / 100) : 0));
        const taxAmount = Number(line.tax_amount ?? (gross - net));
        const entry = tax.breakdown.find((candidate) => Math.abs(candidate.rate - rate) < .01);
        return { accountNumber: line.asset_account_number ?? line.account_number ?? m.expense, debitAmount: round(net), creditAmount: 0, taxCaseKey: entry?.taxCaseKey ?? taxCaseFor(row, rate, category), netAmount: round(net), taxRate: rate, taxAmount: round(taxAmount), grossAmount: round(gross || net + taxAmount), memo: line.description };
      })
      : tax.breakdown.map((entry) => ({ accountNumber: m.expense, debitAmount: entry.net, creditAmount: 0, taxCaseKey: entry.taxCaseKey, netAmount: entry.net, taxRate: entry.rate, taxAmount: entry.tax, grossAmount: entry.gross }));
    lines.splice(0, lines.length, ...expenseLines);
    for (const entry of tax.breakdown) if (entry.tax > 0) lines.push({ accountNumber: await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'input_tax', m.input_vat, row.invoice_date), debitAmount: entry.tax, creditAmount: 0, memo: `Vorsteuer ${entry.taxCaseKey}` });
    lines.push({ accountNumber: m.accounts_payable, debitAmount: 0, creditAmount: tax.gross });
  }
  const snapshot: AccountingSnapshot = { sourceType: type, sourceId: id, sourceVersion: sourceVersion(row, type === 'incoming_invoice' ? incomingLines : invoiceLines(row)), chart: p.activeChart, vatMethod: p.vatMethod, netAmount: tax.net, taxAmount: tax.tax, grossAmount: tax.gross, lines, capturedAt: now() };
  const accounts = [...new Set(lines.map((line) => line.accountNumber))]; const missing: string[] = []; for (const account of accounts) if (!(await accountExists(db, p.activeChart, account))) missing.push(account); if (missing.length) return { sourceType: type, sourceId: id, status: 'unresolved', reason: 'UNKNOWN_ACCOUNT', snapshot, issues: [{ code: 'UNKNOWN_ACCOUNT', message: `Konten fehlen: ${missing.join(', ')}`, blocking: true }] };
  return { sourceType: type, sourceId: id, status: 'ready', snapshot, issues: [] };
};
const rowVendor = (row: any): VendorEntity => ({ id: row.id, tenantId: row.tenant_id, vendorNumber: row.vendor_number ?? undefined, name: row.name, email: row.email ?? undefined, address: row.address ?? undefined, vatId: row.vat_id ?? undefined, iban: row.iban ?? undefined, defaultExpenseAccount: row.default_expense_account ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const rowIncoming = (row: any, lines: any[]): IncomingInvoiceEntity => ({ id: row.id, tenantId: row.tenant_id, vendorId: row.vendor_id, number: row.number, invoiceDate: row.invoice_date, dueDate: row.due_date, servicePeriod: row.service_period ?? undefined, netAmount: Number(row.net_amount), taxAmount: Number(row.tax_amount), grossAmount: Number(row.gross_amount), status: row.status, taxRate: Number(row.tax_rate), taxCaseKey: row.tax_case_key ?? undefined, notes: row.notes ?? undefined, lines: lines.map((l) => ({ id: l.id, incomingInvoiceId: l.incoming_invoice_id, position: Number(l.position), description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), netAmount: Number(l.net_amount), taxRate: Number(l.tax_rate), taxAmount: Number(l.tax_amount), grossAmount: Number(l.gross_amount), accountNumber: l.account_number ?? undefined, assetAccountNumber: l.asset_account_number ?? undefined })), accountingStatus: row.accounting_status, accountingSnapshot: parse(row.accounting_snapshot_json, undefined), createdAt: row.created_at, updatedAt: row.updated_at });
const rowOpenItem = (row: any): OpenItemEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id, sourceType: row.source_type, sourceId: row.source_id, documentNumber: row.document_number, documentDate: row.document_date, dueDate: row.due_date, originalAmount: Number(row.original_amount), allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const rowPayment = (row: any): OpenItemPaymentEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at });
const requireAllocationEventId = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('ALLOCATION_EVENT_ID_REQUIRED');
  return normalized;
};
const assertOpenItemSource = async (db: PostgresQueryable, t: string, item: any): Promise<void> => {
  if (item.source_type === 'outgoing_invoice') {
    const source = (await q<any>(db, `SELECT accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, item.source_id]))[0];
    if (!source) throw new Error('INVOICE_NOT_FOUND');
    if (source.accounting_status !== 'posted') throw new Error('DOCUMENT_NOT_POSTED');
  } else if (item.source_type === 'incoming_invoice') {
    const source = (await q<any>(db, `SELECT accounting_status FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, item.source_id]))[0];
    if (!source) throw new Error('INCOMING_INVOICE_NOT_FOUND');
    if (source.accounting_status !== 'posted') throw new Error('DOCUMENT_NOT_POSTED');
  }
};

const reverseEntryInTransaction = async (db: PostgresQueryable, scope: TenantScope, entryId: string, reason: string, options: ReverseJournalEntryOptions & { allowDocumentSource?: boolean } = {}): Promise<{ ok: true; reversalEntryId: string }> => {
  const t = tenant(scope); const entry = (await q<any>(db, `SELECT * FROM journal_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, entryId]))[0]; if (!entry) throw new Error('Journal entry not found'); if (!reason.trim()) throw new Error('Reversal reason is required'); if (!options.allowDocumentSource && (entry.source_type === 'outgoing_invoice' || entry.source_type === 'incoming_invoice')) throw new Error('DOCUMENT_REVERSAL_REQUIRED: reverseDocumentAccounting must be used for document-owned entries'); if (entry.source_type === 'asset_activation' || entry.source_type === 'asset_depreciation' || entry.source_type === 'asset_disposal') throw new Error('ASSET_REVERSAL_REQUIRED: use the asset-specific correction flow'); if (entry.source_type === 'payment' || entry.source_type === 'payment_vat') throw new Error('PAYMENT_REVERSAL_REQUIRED: use payment-specific reversal with allocation reversal'); if (entry.status === 'reversed' || entry.reversed_entry_id || entry.source_type === 'reversal') throw new Error('Journal entry cannot be reversed again');
  const postingDate = options.postingDate ?? now().slice(0, 10); if (!isoDate(postingDate)) throw new Error('Invalid reversal posting date'); const lines = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, entryId]); if (!lines.length) throw new Error('Journal entry has no lines');
  const originalPairs = await q<any>(db, `SELECT jp.amount,jp.tax_case_key,jp.datev_bu_key,dl.account_number AS debit_account,cl.account_number AS credit_account FROM journal_posting_pairs jp JOIN journal_lines dl ON dl.id=jp.debit_line_id AND dl.tenant_id=jp.tenant_id JOIN journal_lines cl ON cl.id=jp.credit_line_id AND cl.tenant_id=jp.tenant_id WHERE jp.tenant_id=$1 AND jp.entry_id=$2`, [t, entryId]);
  const reversalLines = lines.map((line) => ({ ...mapLine(line), id: randomUUID(), debitAmount: Number(line.credit_amount), creditAmount: Number(line.debit_amount), netAmount: line.net_amount == null ? undefined : -Number(line.net_amount), taxAmount: line.tax_amount == null ? undefined : -Number(line.tax_amount), grossAmount: line.gross_amount == null ? undefined : -Number(line.gross_amount) }));
  const originalBu = new Map(originalPairs.map((pair) => [`${pair.amount}|${pair.tax_case_key ?? ''}|${pair.credit_account}|${pair.debit_account}`, pair.datev_bu_key ?? null]));
  const datevBuKeys = pairLines(reversalLines).map((pair) => originalBu.get(`${pair.amount}|${pair.taxCaseKey ?? ''}|${pair.debit.accountNumber}|${pair.credit.accountNumber}`) ?? null);
  const reversalEntryId = await insertEntry(db, scope, 'reversal', `reversal:${entryId}`, postingDate, `Storno ${entry.entry_number}: ${entry.booking_text}`, reversalLines, { documentDate: entry.document_date, reference: reason.trim(), softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation, datevBuKeys });
  await q(db, `UPDATE journal_entries SET status='reversed',reversed_entry_id=$1 WHERE tenant_id=$2 AND id=$3`, [reversalEntryId, t, entryId]); await audit(db as PostgresTransactionClient, scope, 'pro_journal_entry', entryId, 'reverse', reason.trim(), { status: 'posted' }, { status: 'reversed', reversalEntryId, postingDate }, options.mutation); return { ok: true, reversalEntryId };
};

const buildLegacyDatevRows = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string } = {}) => {
  const values: unknown[] = [tenant(scope)]; const conditions = ['tenant_id=$1']; if (args.from) { values.push(args.from); conditions.push(`posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); conditions.push(`posting_date <= $${values.length}`); }
  const entries = await q<any>(db, `SELECT * FROM journal_entries WHERE ${conditions.join(' AND ')} AND status IN ('posted','reversed') ORDER BY posting_date,entry_number`, values); const result: any[] = [];
  for (const entry of entries) { const rows = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [tenant(scope), entry.id]); for (const pair of pairLines(rows.map(mapLine))) result.push({ date: entry.posting_date, belegfeld1: String(entry.entry_number), buchungstext: entry.booking_text, konto: pair.debit.accountNumber, gegenkonto: pair.credit.accountNumber, sollHabenKennzeichen: 'S' as const, buSchluessel: undefined, umsatz: round(pair.amount) }); }
  return result;
};

const recognizeIstVat = async (
  db: PostgresQueryable,
  scope: TenantScope,
  item: any,
  paymentId: string,
  allocationId: string,
  allocationAmount: number,
  beforeAllocated: number,
  allocated: number,
  paymentDate: string,
): Promise<void> => {
  if (item.source_type !== 'outgoing_invoice') return;
  const p = await policy(db, tenant(scope));
  if (p.vatMethod !== 'ist') return;
  const source = (await q<any>(db, `SELECT accounting_snapshot_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), item.source_id]))[0];
  const snapshot = parse<AccountingSnapshot | undefined>(source?.accounting_snapshot_json, undefined);
  if (!snapshot || snapshot.grossAmount <= 0) return;
  const m = await mappings(db, tenant(scope), p.activeChart);
  const basisLines = snapshot.lines.filter((line) => line.creditAmount > 0 && line.memo?.startsWith('UStBasis '));
  const taxByCase = new Map<string, { accountNumber: string; taxAmount: number }>();
  for (const line of snapshot.lines.filter((candidate) => candidate.creditAmount > 0 && candidate.memo?.startsWith('USt '))) {
    taxByCase.set(line.memo!.slice('USt '.length), { accountNumber: line.accountNumber, taxAmount: round(line.creditAmount) });
  }
  const fallbackCase = basisLines[0]?.memo?.slice('UStBasis '.length) ?? 'DE_STD_19';
  const fallbackTax = snapshot.taxAmount ?? 0;
  const bases = basisLines.length ? basisLines : [{ creditAmount: snapshot.netAmount, memo: `UStBasis ${fallbackCase}` } as AccountingSnapshot['lines'][number]];
  const payableLines: JournalLineEntity[] = [];
  for (const basis of bases) {
    const taxCaseKey = (basis.memo?.slice('UStBasis '.length) ?? fallbackCase) as any;
    const control = taxByCase.get(taxCaseKey);
    const taxForBasis = control?.taxAmount ?? (bases.length === 1 ? fallbackTax : 0);
    const basisGross = control ? round(basis.creditAmount + taxForBasis) : (basis.grossAmount ?? round(basis.creditAmount + taxForBasis));
    const previousRecognized = round((taxForBasis * Math.min(beforeAllocated, snapshot.grossAmount) * basisGross) / (snapshot.grossAmount * basisGross));
    const recognized = round((taxForBasis * Math.min(allocated, snapshot.grossAmount) * basisGross) / (snapshot.grossAmount * basisGross));
    const delta = round(recognized - previousRecognized);
    if (delta <= 0) continue;
    const grossShare = round((Math.min(allocationAmount, snapshot.grossAmount) * basisGross) / snapshot.grossAmount);
    const netShare = round(grossShare - delta);
    const deferred = control?.accountNumber ?? m.output_vat_deferred;
    const output = await taxCaseAccount(db, tenant(scope), p.activeChart, taxCaseKey, 'output_tax', m.output_vat, paymentDate);
    payableLines.push({ id: randomUUID(), accountNumber: deferred, debitAmount: delta, creditAmount: 0, taxCaseKey, netAmount: netShare, taxAmount: delta, grossAmount: grossShare });
    payableLines.push({ id: randomUUID(), accountNumber: output, debitAmount: 0, creditAmount: delta });
  }
  if (payableLines.length) await insertEntry(db, scope, 'payment_vat', `payment-vat:${paymentId}:${allocationId}`, paymentDate, 'USt Vereinnahmung', payableLines, {});
};

export const createPostgresProAccountingRepository = (db: PostgresQueryable): ProAccountingRepository & ProAccountingAssetRepository => ({
  async listBankTransactions(scope) { return (await q<any>(db, `SELECT * FROM bank_transactions WHERE tenant_id=$1 ORDER BY date DESC,id`, [tenant(scope)])).map((r) => ({ id: r.id, tenantId: r.tenant_id, accountId: r.account_id, date: r.date, amount: Number(r.amount), type: r.type === 'income' ? 'income' : 'expense', counterparty: r.counterparty, purpose: r.purpose, status: r.status === 'booked' ? 'booked' : 'pending', linkedInvoiceId: r.linked_invoice_id ?? undefined })); },
  async getDraftByTransactionId(scope, transactionId) { return inTx(db, async (tx) => { const existing = await getDraft(tx, scope, transactionId); if (existing) return existing; const row = (await q<any>(tx, `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND id=$2`, [tenant(scope), transactionId]))[0]; if (!row) return null; const p = await policy(tx, tenant(scope)); const m = await mappings(tx, tenant(scope), p.activeChart); const amount = round(Math.abs(row.amount)); const draft: BookingDraftEntity = { id: `draft-${row.id}`, tenantId: tenant(scope), transactionId: row.id, workflowStatus: row.status === 'booked' ? 'posted' : 'imported', postingDate: row.date, documentDate: row.date, bookingText: row.purpose || (row.type === 'income' ? 'Einnahme' : 'Ausgabe'), reference: row.id, period: period(row.date), fiscalYear: Number(row.date.slice(0,4)), lines: [{ id: `draft-${row.id}-1`, accountNumber: row.type === 'income' ? m.bank : m.expense, debitAmount: row.type === 'income' ? amount : 0, creditAmount: row.type === 'income' ? 0 : amount }, { id: `draft-${row.id}-2`, accountNumber: row.type === 'income' ? m.revenue : m.bank, debitAmount: row.type === 'income' ? 0 : amount, creditAmount: row.type === 'income' ? amount : 0 }], validationIssues: [], updatedAt: now() }; return saveDraftTarget(tx, scope, draft); }); },
  async saveDraft(scope, draft) { return inTx(db, (tx) => saveDraftTarget(tx, scope, draft, draft.mutation)); },
  async dispatchDraftAction(scope, args) { return inTx(db, async (tx) => { const draft = await getDraft(tx, scope, args.transactionId); if (!draft) throw new Error('Draft not found'); const transitions: Record<string, string[]> = { imported: ['suggested','incomplete','pending_approval'], suggested: ['suggested','incomplete','pending_approval'], incomplete: ['suggested','incomplete','pending_approval'], ready_for_review: ['pending_approval'], pending_approval: ['approved','incomplete'], approved: ['approved'], posted: ['reversed'], reversed: ['corrected'], corrected: ['suggested','incomplete'], period_locked: ['incomplete','suggested'], integration_error: ['incomplete','suggested'] }; const targets: Record<string, string> = { save_draft: 'suggested', submit_for_review: 'pending_approval', approve: 'approved', reject: 'incomplete', post: 'approved', reverse: 'reversed', create_correction: 'corrected', request_receipt: 'incomplete' }; const target = targets[args.action]; if (!transitions[draft.workflowStatus]?.includes(target)) throw new Error(`Invalid workflow transition: ${draft.workflowStatus} -> ${target}`); return saveDraftTarget(tx, scope, { ...draft, workflowStatus: target as BookingDraftEntity['workflowStatus'], validationIssues: args.action === 'reject' && args.rejectReason ? [{ id: randomUUID(), code: 'MANUAL_REVIEW_REJECTED', severity: 'warning', message: args.rejectReason, blocking: false, source: 'user' }] : draft.validationIssues }, args.mutation); }); },
  async validateTaxCompliance(scope, args) { const draft = args.draftId ? (await q<any>(db, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND id=$2`, [tenant(scope), args.draftId]))[0] : args.transactionId ? await getDraft(db, scope, args.transactionId) : null; if (!draft) throw new Error('Draft not found'); if ('draft_json' in draft) { const lines = await q<any>(db, `SELECT * FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2 ORDER BY line_no`, [tenant(scope), draft.id]); const issues = await q<any>(db, `SELECT * FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [tenant(scope), draft.id]); const parsed = draftFromRows(draft, lines, issues, scope); const saved = await inTx(db, (tx) => saveDraftTarget(tx, scope, parsed, args.mutation)); return { ok: !saved.validationIssues.some((x) => x.blocking), issues: saved.validationIssues }; } return { ok: !(draft as BookingDraftEntity).validationIssues.some((x) => x.blocking), issues: (draft as BookingDraftEntity).validationIssues }; },
  async postDraft(scope, draftId, options: PostDraftOptions = {}) { return inTx(db, async (tx) => { const t = tenant(scope); const sourceKey = options.idempotencyKey?.trim() || `booking-draft:${draftId}`; const existing = await q<any>(tx, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND source_type='booking_draft' AND source_key=$2`, [t, sourceKey]); if (existing[0]) return { entry: (await loadEntry(tx, scope, existing[0].id))!, issues: [] }; const rows = await q<any>(tx, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND id=$2`, [t, draftId]); if (!rows[0]) throw new Error('Draft not found'); const lines = await q<any>(tx, `SELECT * FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2 ORDER BY line_no`, [t, draftId]); const savedIssues = await q<any>(tx, `SELECT * FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [t, draftId]); const draft = draftFromRows(rows[0], lines, savedIssues, scope); const postingDate = options.postingDate ?? draft.postingDate; const p = await policy(tx, t); const periodStatus = postingDate && isoDate(postingDate) ? await ensurePeriod(tx, t, period(postingDate)) : 'open'; const issues = await validateDraft(tx, scope, { ...draft, postingDate, period: postingDate ? period(postingDate) : draft.period, fiscalYear: postingDate ? Number(postingDate.slice(0, 4)) : draft.fiscalYear }, periodStatus, p.activeChart); if (rows[0].workflow_status !== 'approved') issues.push(issue('DRAFT_NOT_APPROVED', 'Nur freigegebene Entwürfe dürfen gebucht werden.')); if (periodStatus === 'soft_locked' && (!options.softLockOverride || !options.overrideReason?.trim())) issues.push(issue('SOFT_LOCK_OVERRIDE_REQUIRED', 'Vorläufig gesperrte Periode benötigt Freigabe und Begründung.')); if (issues.some((x) => x.blocking)) return { entry: { id: '', tenantId: t, entryNumber: 0, postingDate: postingDate ?? '', bookingText: draft.bookingText, period: draft.period, fiscalYear: draft.fiscalYear, status: 'posted', createdAt: now(), lines: [] }, issues }; const normalized = { ...draft, postingDate: postingDate!, period: period(postingDate!), fiscalYear: Number(postingDate!.slice(0, 4)) }; const entryId = await insertEntry(tx, scope, 'booking_draft', sourceKey, postingDate!, normalized.bookingText, normalized.lines, { documentDate: normalized.documentDate, reference: normalized.reference, sourceDraftId: normalized.id, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation }); await q(tx, `UPDATE booking_drafts SET workflow_status='posted',draft_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify({ ...normalized, workflowStatus: 'posted' }), now(), t, draftId]); await q(tx, `UPDATE bank_transactions SET status='booked',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), t, draft.transactionId]); return { entry: (await loadEntry(tx, scope, entryId))!, issues: [] }; }); },
  async reverseJournalEntry(scope, entryId, reason, options: ReverseJournalEntryOptions = {}) { return inTx(db, (tx) => reverseEntryInTransaction(tx, scope, entryId, reason, options)); },
  async listJournalEntries(scope, args = {}) { const t = tenant(scope); const values: unknown[] = [t]; const where = ['tenant_id=$1']; if (args.from) { values.push(args.from); where.push(`posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); where.push(`posting_date <= $${values.length}`); } if (args.accountNumbers?.length) { values.push(args.accountNumbers); where.push(`id IN (SELECT entry_id FROM journal_lines WHERE tenant_id=$1 AND account_number = ANY($${values.length}))`); } values.push(Math.max(1, Math.min(5000, args.limit ?? 500)), Math.max(0, args.offset ?? 0)); const rows = await q<any>(db, `SELECT * FROM journal_entries WHERE ${where.join(' AND ')} ORDER BY posting_date DESC,entry_number DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values); return Promise.all(rows.map((r) => loadEntry(db, scope, r.id))).then((items) => items.filter(Boolean) as JournalEntryEntity[]); },
  async getLedgerBalances(scope, args = {}) { const values: unknown[] = [tenant(scope)]; const conditions = [`jl.tenant_id=$1`, `je.status IN ('posted','reversed')`]; const asOf = args.to ?? args.asOfDate; const from = args.fromDate ?? args.from ?? (asOf ? `${asOf.slice(0, 4)}-01-01` : undefined); if (asOf) { values.push(asOf); conditions.push(`je.posting_date <= $${values.length}`); } if (from) values.push(from); const rangeParam = from ? `$${values.length}` : ''; const rows = await q<any>(db, `SELECT jl.account_number,COALESCE(SUM(CASE WHEN ${from ? `je.posting_date < ${rangeParam}` : 'FALSE'} THEN jl.debit_amount ELSE 0 END),0) opening_debit,COALESCE(SUM(CASE WHEN ${from ? `je.posting_date < ${rangeParam}` : 'FALSE'} THEN jl.credit_amount ELSE 0 END),0) opening_credit,COALESCE(SUM(CASE WHEN ${from ? `je.posting_date >= ${rangeParam}` : 'TRUE'} THEN jl.debit_amount ELSE 0 END),0) debit,COALESCE(SUM(CASE WHEN ${from ? `je.posting_date >= ${rangeParam}` : 'TRUE'} THEN jl.credit_amount ELSE 0 END),0) credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE ${conditions.join(' AND ')} GROUP BY jl.account_number ORDER BY jl.account_number`, values); return rows.map((r) => ({ accountNumber: r.account_number, openingBalance: round(Number(r.opening_debit) - Number(r.opening_credit)), debitTurnover: round(r.debit), creditTurnover: round(r.credit), closingBalance: round(Number(r.opening_debit) - Number(r.opening_credit) + Number(r.debit) - Number(r.credit)) } as LedgerBalance)); },
  async getSusaReport(scope, args = {}) { const fromDate = args.fromDate ?? args.from; const asOfDate = args.to ?? args.asOfDate; const rows = await this.getLedgerBalances(scope, { ...args, fromDate, asOfDate }); return { from: fromDate, to: asOfDate, asOfDate: asOfDate ?? now().slice(0, 10), rows, totals: { debit: round(rows.reduce((s, r) => s + r.debitTurnover, 0)), credit: round(rows.reduce((s, r) => s + r.creditTurnover, 0)), balance: round(rows.reduce((s, r) => s + r.closingBalance, 0)) } }; },
  async getGuvReport(scope, args = {}) { const p = await policy(db, tenant(scope)); const values: unknown[] = [tenant(scope), p.activeChart]; const date: string[] = []; if (args.from) { values.push(args.from); date.push(`je.posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); date.push(`je.posting_date <= $${values.length}`); } const rows = await q<any>(db, `SELECT COALESCE(am.position_key,'unmapped:'||jl.account_number) position_key,COALESCE(am.position_label,'Nicht zugeordnet ('||jl.account_number||')') position_label,SUM(jl.credit_amount-jl.debit_amount) amount FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id LEFT JOIN account_mappings_hgb am ON am.tenant_id=jl.tenant_id AND am.chart=$2 AND am.account_number=jl.account_number AND am.statement_type='guv' WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed')${date.length ? ` AND ${date.join(' AND ')}` : ''} GROUP BY COALESCE(am.position_key,'unmapped:'||jl.account_number),COALESCE(am.position_label,'Nicht zugeordnet ('||jl.account_number||')') ORDER BY position_key`, values); const mapped = rows.map((r) => ({ positionKey: r.position_key, positionLabel: r.position_label, amount: round(r.amount) })); return { from: args.from, to: args.to, rows: mapped, netResult: round(mapped.filter((r) => r.positionKey === 'revenue').reduce((s, r) => s + r.amount, 0) - mapped.filter((r) => r.positionKey === 'expense').reduce((s, r) => s + Math.abs(r.amount), 0)) }; },
  async getBilanzReport(scope, args = {}) { const p = await policy(db, tenant(scope)); const values: unknown[] = [tenant(scope), p.activeChart]; let date = ''; if (args.asOfDate) { values.push(args.asOfDate); date = ` AND je.posting_date <= $${values.length}`; } const rows = await q<any>(db, `SELECT am.balance_side,jl.account_number,SUM(jl.debit_amount-jl.credit_amount) amount FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id LEFT JOIN account_mappings_hgb am ON am.tenant_id=jl.tenant_id AND am.chart=$2 AND am.account_number=jl.account_number AND am.statement_type='bilanz' WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed')${date} GROUP BY am.balance_side,jl.account_number ORDER BY jl.account_number`, values); const assets = rows.filter((r) => r.balance_side === 'asset').map((r) => ({ accountNumber: r.account_number, amount: round(r.amount) })); const liabilities = rows.filter((r) => r.balance_side === 'liability').map((r) => ({ accountNumber: r.account_number, amount: round(Math.abs(Number(r.amount))) })); const unmappedAccounts = rows.filter((r) => !r.balance_side).map((r) => ({ accountNumber: r.account_number, amount: round(Number(r.amount)) })); const a = assets.reduce((s, r) => s + r.amount, 0); const l = liabilities.reduce((s, r) => s + r.amount, 0); return { asOfDate: args.asOfDate ?? now().slice(0, 10), assets, liabilities, unmappedAccounts, totals: { assets: round(a), liabilities: round(l), delta: round(a - l) } }; },
  async listDatevExports(scope) { return (await q<any>(db, `SELECT * FROM datev_exports WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant(scope)])).map((r) => { const metadata = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(r.meta_json, {}); return { id: r.id, filePath: r.file_path, recordCount: Number(r.record_count), fromDate: r.from_date ?? undefined, toDate: r.to_date ?? undefined, createdAt: r.created_at, contentSha256: metadata.contentSha256, encoding: metadata.encoding, headerVersion: metadata.headerVersion, formatVersion: metadata.formatVersion, chart: metadata.chart, sourceSnapshotHash: metadata.sourceSnapshot ? createHash('sha256').update(JSON.stringify(metadata.sourceSnapshot)).digest('hex') : undefined }; }); },
  async getDatevExportContent(scope, exportId): Promise<DatevExportContent> { const row = (await q<any>(db, `SELECT * FROM datev_exports WHERE tenant_id=$1 AND id=$2`, [tenant(scope), exportId]))[0]; if (!row) throw new Error('DATEV_EXPORT_NOT_FOUND'); if (!row.content_bytes) throw new Error('DATEV_EXPORT_CONTENT_UNAVAILABLE'); const content = new Uint8Array(row.content_bytes); const contentSha256 = createHash('sha256').update(content).digest('hex'); const metadata = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(row.meta_json, {}); if (metadata.contentSha256 && metadata.contentSha256 !== contentSha256) throw new Error('DATEV_EXPORT_HASH_MISMATCH'); return { id: row.id, filePath: row.file_path, recordCount: Number(row.record_count), fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined, createdAt: row.created_at, contentSha256, content, encoding: metadata.encoding, headerVersion: metadata.headerVersion, formatVersion: metadata.formatVersion, chart: metadata.chart, sourceSnapshotHash: metadata.sourceSnapshot ? createHash('sha256').update(JSON.stringify(metadata.sourceSnapshot)).digest('hex') : undefined }; },
  async insertDatevExport(scope, args) { return inTx(db, async (tx) => { const existing = (await q<any>(tx, `SELECT * FROM datev_exports WHERE tenant_id=$1 AND file_path=$2`, [tenant(scope), args.filePath]))[0]; if (existing) { const existingMeta = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(existing.meta_json, {}); return { id: existing.id, filePath: existing.file_path, recordCount: Number(existing.record_count), fromDate: existing.from_date ?? undefined, toDate: existing.to_date ?? undefined, createdAt: existing.created_at, contentSha256: existingMeta.contentSha256, encoding: existingMeta.encoding, headerVersion: existingMeta.headerVersion, formatVersion: existingMeta.formatVersion, chart: existingMeta.chart }; } const id = randomUUID(); const createdAt = now(); if (!args.content) throw new Error('DATEV_EXPORT_CONTENT_REQUIRED'); const content = Buffer.from(args.content); const contentSha256 = createHash('sha256').update(content).digest('hex'); if (args.contentSha256 && args.contentSha256 !== contentSha256) throw new Error('DATEV_EXPORT_HASH_MISMATCH'); const metadata = { immutable: true, contentSha256, encoding: args.encoding, headerVersion: args.headerVersion, formatVersion: args.formatVersion, chart: args.chart, sourceSnapshot: args.sourceSnapshot }; await q(tx, `INSERT INTO datev_exports (id,tenant_id,file_path,record_count,from_date,to_date,created_at,meta_json,content_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, tenant(scope), args.filePath, args.recordCount, args.fromDate ?? null, args.toDate ?? null, createdAt, JSON.stringify(metadata), content]); await audit(tx as PostgresTransactionClient, scope, 'pro_datev_export', id, 'export', 'DATEV export recorded', null, { ...args, content: undefined, contentSha256, mutation: undefined }, args.mutation); return { id, filePath: args.filePath, recordCount: args.recordCount, fromDate: args.fromDate, toDate: args.toDate, createdAt, contentSha256, encoding: args.encoding, headerVersion: args.headerVersion, formatVersion: args.formatVersion, chart: args.chart }; }); },
  async getAccountingHealth(scope) { const t = tenant(scope); const [draft, posted, reversed, unbalanced, last] = await Promise.all([q<any>(db, `SELECT COUNT(*)::int c FROM booking_drafts WHERE tenant_id=$1`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND status='posted'`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND status='reversed'`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM draft_validation_issues WHERE tenant_id=$1 AND code='UNBALANCED_ENTRY' AND blocking=true`, [t]), q<any>(db, `SELECT created_at FROM datev_exports WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [t])]); const lineAccounts = new Set((await q<any>(db, `SELECT DISTINCT account_number FROM journal_lines WHERE tenant_id=$1`, [t])).map((r) => r.account_number)); const mappingsRows = await q<any>(db, `SELECT DISTINCT account_number FROM account_mappings_hgb WHERE tenant_id=$1`, [t]); const mapped = new Set(mappingsRows.map((r) => r.account_number)); return { draftCount: Number(draft[0]?.c || 0), postedCount: Number(posted[0]?.c || 0), reversedCount: Number(reversed[0]?.c || 0), unbalancedDraftCount: Number(unbalanced[0]?.c || 0), unmappedAccountCount: [...lineAccounts].filter((a) => !mapped.has(a)).length, lastDatevExportAt: last[0]?.created_at }; },
  async getVatSummary(scope, args = {}) { const values: unknown[] = [tenant(scope)]; const date: string[] = []; if (args.from) { values.push(args.from); date.push(`je.posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); date.push(`je.posting_date <= $${values.length}`); } const rows = await q<any>(db, `SELECT jl.tax_case_key,SUM(jl.net_amount) net,SUM(jl.tax_amount) tax,SUM(COALESCE(jl.gross_amount,CASE WHEN jl.debit_amount>0 THEN jl.debit_amount ELSE jl.credit_amount END)) gross,COUNT(*)::int line_count FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND jl.tax_case_key IS NOT NULL AND je.status IN ('posted','reversed')${date.length ? ` AND ${date.join(' AND ')}` : ''} GROUP BY jl.tax_case_key ORDER BY jl.tax_case_key`, values); return { from: args.from, to: args.to, rows: rows.map((r) => ({ taxCaseKey: r.tax_case_key, netAmount: round(r.net), taxAmount: round(r.tax), grossAmount: round(r.gross), lineCount: Number(r.line_count) })) }; },
  async buildDatevRows(scope, args = {}) {
    const values: unknown[] = [tenant(scope)]; const date: string[] = [];
    if (args.from) { values.push(args.from); date.push(`posting_date >= $${values.length}`); }
    if (args.to) { values.push(args.to); date.push(`posting_date <= $${values.length}`); }
    const entries = await q<any>(db, `SELECT * FROM journal_entries WHERE tenant_id=$1 AND status IN ('posted','reversed')${date.length ? ` AND ${date.join(' AND ')}` : ''} ORDER BY posting_date,entry_number`, values);
    const result: any[] = [];
    for (const entry of entries) {
      const persisted = await q<any>(db, `SELECT jp.amount,jp.tax_case_key,jp.datev_bu_key,dl.account_number konto,cl.account_number gegenkonto FROM journal_posting_pairs jp JOIN journal_lines dl ON dl.id=jp.debit_line_id AND dl.tenant_id=jp.tenant_id JOIN journal_lines cl ON cl.id=jp.credit_line_id AND cl.tenant_id=jp.tenant_id WHERE jp.tenant_id=$1 AND jp.entry_id=$2 ORDER BY jp.id`, [tenant(scope), entry.id]);
      const pairs = persisted.length ? persisted.map((pair) => ({ amount: Number(pair.amount), debit: pair.konto, credit: pair.gegenkonto, bu: pair.datev_bu_key })) : pairLines((await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [tenant(scope), entry.id])).map(mapLine)).map((pair) => ({ amount: pair.amount, debit: pair.debit.accountNumber, credit: pair.credit.accountNumber, bu: undefined }));
      for (const pair of pairs) result.push({ date: entry.posting_date, belegfeld1: String(entry.entry_number), buchungstext: entry.booking_text, konto: pair.debit, gegenkonto: pair.credit, sollHabenKennzeichen: 'S', buSchluessel: pair.bu ?? undefined, umsatz: round(pair.amount) });
    }
    return result;
  },
  async getAccountingPolicy(scope) { return policy(db, tenant(scope)); },
  async setAccountingPolicy(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const stamp = now(); await q(tx, `INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,$2,$3,'calendar_month',$4) ON CONFLICT (tenant_id) DO UPDATE SET active_chart=EXCLUDED.active_chart,vat_method=EXCLUDED.vat_method,updated_at=EXCLUDED.updated_at`, [t, input.activeChart, input.vatMethod, stamp]); await audit(tx as PostgresTransactionClient, scope, 'accounting_policy', t, 'update', 'Accounting policy changed', null, { activeChart: input.activeChart, vatMethod: input.vatMethod }, input.mutation); return policy(tx, t); }); },
  async listAccountingAccountMappings(scope, chart) { const rows = await q<any>(db, `SELECT * FROM accounting_account_mappings WHERE tenant_id=$1${chart ? ' AND chart=$2' : ''} ORDER BY chart,role`, chart ? [tenant(scope), chart] : [tenant(scope)]); return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, chart: r.chart, role: r.role, accountNumber: r.account_number, updatedAt: r.updated_at })); },
  async upsertAccountingAccountMapping(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const id = input.id ?? randomUUID(); const stamp = now(); await q(tx, `INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,chart,role) DO UPDATE SET account_number=EXCLUDED.account_number,updated_at=EXCLUDED.updated_at`, [id, t, input.chart, input.role, input.accountNumber.trim(), stamp]); await audit(tx as PostgresTransactionClient, scope, 'accounting_mapping', id, 'update', 'Accounting mapping changed', null, { chart: input.chart, role: input.role, accountNumber: input.accountNumber }, input.mutation); const row = (await q<any>(tx, `SELECT * FROM accounting_account_mappings WHERE tenant_id=$1 AND chart=$2 AND role=$3`, [t, input.chart, input.role]))[0]; return { id: row.id, tenantId: row.tenant_id, chart: row.chart, role: row.role, accountNumber: row.account_number, updatedAt: row.updated_at }; }); },
  async listVendors(scope) { return (await q<any>(db, `SELECT * FROM vendors WHERE tenant_id=$1 ORDER BY name,id`, [tenant(scope)])).map(rowVendor); },
  async upsertVendor(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const id = input.id || randomUUID(); const stamp = now(); const existing = (await q<any>(tx, `SELECT * FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, id]))[0]; const foreign = (await q<any>(tx, `SELECT tenant_id FROM vendors WHERE id=$1 AND tenant_id<>$2`, [id, t]))[0]; if (foreign) throw new Error('VENDOR_NOT_FOUND'); if (existing && (await q<any>(tx, `SELECT accounting_status FROM incoming_invoices WHERE tenant_id=$1 AND vendor_id=$2 AND accounting_status='posted' LIMIT 1`, [t, id]))[0]) throw new Error('VENDOR_HAS_POSTED_DOCUMENTS'); await q(tx, `INSERT INTO vendors (id,tenant_id,vendor_number,name,email,address,vat_id,iban,default_expense_account,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT (id) DO UPDATE SET vendor_number=EXCLUDED.vendor_number,name=EXCLUDED.name,email=EXCLUDED.email,address=EXCLUDED.address,vat_id=EXCLUDED.vat_id,iban=EXCLUDED.iban,default_expense_account=EXCLUDED.default_expense_account,updated_at=EXCLUDED.updated_at`, [id, t, input.vendorNumber ?? null, input.name, input.email ?? null, input.address ?? null, input.vatId ?? null, input.iban ?? null, input.defaultExpenseAccount ?? null, stamp]); await audit(tx as PostgresTransactionClient, scope, 'vendor', id, 'upsert', 'Vendor changed', existing ?? null, { ...input, mutation: undefined }, input.mutation); return rowVendor((await q<any>(tx, `SELECT * FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, id]))[0]); }); },
  async listIncomingInvoices(scope) { const rows = await q<any>(db, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 ORDER BY invoice_date DESC,number`, [tenant(scope)]); return Promise.all(rows.map(async (r) => rowIncoming(r, await q(db, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [tenant(scope), r.id])))); },
  async upsertIncomingInvoice(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const existing = (await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.id]))[0]; const foreign = (await q<any>(tx, `SELECT tenant_id FROM incoming_invoices WHERE id=$1 AND tenant_id<>$2`, [input.id, t]))[0]; if (foreign) throw new Error('INCOMING_INVOICE_NOT_FOUND'); if (existing?.accounting_status === 'posted' || existing?.accounting_status === 'reversed') { const oldLines = await q(tx, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, input.id]); return rowIncoming(existing, oldLines); } const vendor = (await q<any>(tx, `SELECT id FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, input.vendorId]))[0]; if (!vendor) throw new Error('VENDOR_NOT_FOUND'); const stamp = now(); await q(tx, `INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,service_period,net_amount,tax_amount,gross_amount,status,tax_rate,tax_case_key,notes,accounting_status,accounting_snapshot_json,accounting_journal_entry_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'unposted',NULL,NULL,$15,$16) ON CONFLICT (id) DO UPDATE SET vendor_id=EXCLUDED.vendor_id,number=EXCLUDED.number,invoice_date=EXCLUDED.invoice_date,due_date=EXCLUDED.due_date,service_period=EXCLUDED.service_period,net_amount=EXCLUDED.net_amount,tax_amount=EXCLUDED.tax_amount,gross_amount=EXCLUDED.gross_amount,status=EXCLUDED.status,tax_rate=EXCLUDED.tax_rate,tax_case_key=EXCLUDED.tax_case_key,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at`, [input.id, t, input.vendorId, input.number, input.invoiceDate, input.dueDate, input.servicePeriod ?? null, input.netAmount, input.taxAmount, input.grossAmount, input.status, input.taxRate, input.taxCaseKey ?? null, input.notes ?? null, input.createdAt || stamp, stamp]); await q(tx, `DELETE FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2`, [t, input.id]); for (const line of input.lines) await q(tx, `INSERT INTO incoming_invoice_lines (id,tenant_id,incoming_invoice_id,position,description,quantity,unit_price,net_amount,tax_rate,tax_amount,gross_amount,account_number,asset_account_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [line.id, t, input.id, line.position, line.description, line.quantity, line.unitPrice, line.netAmount, line.taxRate, line.taxAmount, line.grossAmount, line.accountNumber ?? null, line.assetAccountNumber ?? null]); await audit(tx as PostgresTransactionClient, scope, 'incoming_invoice', input.id, 'upsert', 'Incoming invoice changed', existing ?? null, { ...input, accountingStatus: undefined, accountingSnapshot: undefined, mutation: undefined }, input.mutation); return rowIncoming((await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.id]))[0], await q(tx, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, input.id])); }); },
  async previewOutgoingInvoice(scope, invoiceId) { const row = await readInvoice(db, scope, invoiceId); if (!row) throw new Error('INVOICE_NOT_FOUND'); return postingPreview(db, scope, row, 'outgoing_invoice'); },
  async postOutgoingInvoice(scope, invoiceId, options = {}) { return inTx(db, (tx) => postDocument(tx, scope, 'outgoing_invoice', invoiceId, options)); },
  async previewIncomingInvoice(scope, invoiceId) { const row = (await q<any>(db, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), invoiceId]))[0]; if (!row) throw new Error('INCOMING_INVOICE_NOT_FOUND'); return postingPreview(db, scope, row, 'incoming_invoice'); },
  async postIncomingInvoice(scope, invoiceId, options = {}) { return inTx(db, (tx) => postDocument(tx, scope, 'incoming_invoice', invoiceId, options)); },
  async listOpenItems(scope) { return (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 ORDER BY due_date,id`, [tenant(scope)])).map(rowOpenItem); },
  async allocateOpenItemPayment(scope, input) { requireAllocationEventId(input.allocationEventId); return inTx(db, (tx) => allocatePayment(tx, scope, input)); },
  async allocateRemainingOpenItemPayment(scope, paymentId, allocations, allocationEventId, mutation) { const eventId = requireAllocationEventId(allocationEventId); return inTx(db, async (tx) => { const row = (await q<any>(tx, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), paymentId]))[0]; if (!row) throw new Error('PAYMENT_NOT_FOUND'); return allocatePayment(tx, scope, { paymentId, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocations, allocationEventId: eventId, reason: mutation?.reason ?? 'Allocate remaining open item payment', mutation }); }); },
  async reverseDocumentAccounting(scope, input) { return inTx(db, async (tx) => { const table = input.documentType === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices'; const row = (await q<any>(tx, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), input.documentId]))[0]; if (!row || row.accounting_status !== 'posted' || !row.accounting_journal_entry_id) throw new Error('DOCUMENT_NOT_POSTED'); if ((await q<any>(tx, `SELECT id FROM assets WHERE tenant_id=$1 AND (activation_journal_entry_id=$2 OR source_incoming_invoice_id=$3) LIMIT 1`, [tenant(scope), row.accounting_journal_entry_id, input.documentId]))[0]) throw new Error('ASSET_CORRECTION_REQUIRED: correct linked asset before reversing its source document'); const item = (await q<any>(tx, `SELECT * FROM open_items WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR UPDATE`, [tenant(scope), input.documentType, input.documentId]))[0]; if (item && Number((await q<any>(tx, `SELECT COUNT(*)::int c FROM open_item_allocations WHERE tenant_id=$1 AND open_item_id=$2`, [tenant(scope), item.id]))[0]?.c)) throw new Error('DOCUMENT_HAS_ALLOCATIONS'); const reversal = await reverseEntryInTransaction(tx, scope, row.accounting_journal_entry_id, input.reason, { postingDate: input.postingDate, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation, allowDocumentSource: true }); if (item) await q(tx, `UPDATE open_items SET status='unresolved',allocated_amount=original_amount,residual_amount=0,updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), tenant(scope), item.id]); await q(tx, `UPDATE ${table} SET accounting_status='reversed',status='cancelled',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), tenant(scope), input.documentId]); return reversal; }); },
  async previewAccountingBackfill(scope) { return inTx(db, async (tx) => { const candidates: AccountingBackfillPreview['candidates'] = []; const config = await backfillConfig(tx, tenant(scope)); const outgoing = await q<any>(tx, `SELECT i.* FROM invoices i JOIN number_reservations nr ON nr.tenant_id=i.tenant_id AND nr.kind='invoice' AND nr.status='finalized' AND nr.document_id=i.id AND nr.number=i.number WHERE i.tenant_id=$1 AND COALESCE(i.accounting_status,'unposted') NOT IN ('posted','reversed') AND i.status NOT IN ('draft','cancelled') ORDER BY i.id`, [tenant(scope)]); for (const row of outgoing) { const reservation = await finalizedInvoiceReservation(tx, tenant(scope), row); const preview = await postingPreview(tx, scope, row, 'outgoing_invoice'); const documentVersion = preview.snapshot?.sourceVersion ?? hash(row); candidates.push({ sourceType: 'outgoing_invoice', sourceId: row.id, status: preview.status, reason: preview.reason, sourceVersion: backfillOutgoingSourceVersion(row, documentVersion, reservation), snapshot: preview.snapshot ? { ...preview.snapshot, capturedAt: '' } : undefined }); } const incoming = await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND accounting_status NOT IN ('posted','reversed') AND status NOT IN ('draft','cancelled') ORDER BY id`, [tenant(scope)]); for (const row of incoming) { const preview = await postingPreview(tx, scope, row, 'incoming_invoice'); const documentVersion = preview.snapshot?.sourceVersion ?? hash(row); candidates.push({ sourceType: 'incoming_invoice', sourceId: row.id, status: preview.status, reason: preview.reason, sourceVersion: incomingBackfillSourceVersion(row, documentVersion), snapshot: preview.snapshot ? { ...preview.snapshot, capturedAt: '' } : undefined }); } const legacy = await q<any>(tx, `SELECT id,date,amount,type,counterparty,purpose FROM transactions WHERE tenant_id=$1 ORDER BY id`, [tenant(scope)]); for (const row of legacy) candidates.push({ sourceType: 'legacy_transaction', sourceId: row.id, status: 'unresolved', reason: 'Legacy transaction requires explicit review.', sourceVersion: hash(row), snapshot: row }); const confirmationHash = hash({ tenantId: tenant(scope), config, candidates }); const runId = randomUUID(); await q(tx, `INSERT INTO accounting_backfill_runs (id,tenant_id,status,candidates_json,confirmation_hash,created_at,config_json) VALUES ($1,$2,'preview',$3,$4,$5,$6)`, [runId, tenant(scope), JSON.stringify(candidates), confirmationHash, now(), JSON.stringify(config)]); await audit(tx as PostgresTransactionClient, scope, 'accounting_backfill', runId, 'preview', 'dry-run accounting backfill', null, { confirmationHash }); return { runId, status: 'preview', candidates, readyCount: candidates.filter((x) => x.status === 'ready').length, unresolvedCount: candidates.filter((x) => x.status === 'unresolved').length, confirmationHash }; }); },
  async confirmAccountingBackfill(scope, input) { return inTx(db, async (tx) => { if (!input.reason.trim()) throw new Error('BACKFILL_REASON_REQUIRED'); const run = (await q<any>(tx, `SELECT * FROM accounting_backfill_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), input.runId]))[0]; if (!run) throw new Error('BACKFILL_RUN_NOT_FOUND'); if (run.status === 'completed') return parse<AccountingBackfillResult>(run.result_json, { runId: input.runId, postedCount: 0, unresolvedCount: 0, status: 'completed' }); if (run.confirmation_hash !== input.confirmationHash) throw new Error('BACKFILL_CONFIRMATION_HASH_MISMATCH'); const config = await backfillConfig(tx, tenant(scope)); if (hash(config) !== hash(parse(run.config_json, null))) throw new Error('BACKFILL_STALE_PREVIEW'); const candidates = parse<AccountingBackfillPreview['candidates']>(run.candidates_json, []); let postedCount = 0; let unresolvedCount = 0; for (const candidate of candidates) { if (candidate.status !== 'ready') { unresolvedCount += 1; continue; } if (candidate.sourceType === 'outgoing_invoice') { const row = await readInvoice(tx, scope, candidate.sourceId); const reservation = row ? await finalizedInvoiceReservation(tx, tenant(scope), row) : null; if (!row || row.status === 'draft' || row.status === 'cancelled' || row.accounting_status === 'reversed' || !reservation) throw new Error('BACKFILL_STALE_PREVIEW'); const preview = await postingPreview(tx, scope, row, 'outgoing_invoice'); const documentVersion = preview.snapshot?.sourceVersion ?? hash(row); if (backfillOutgoingSourceVersion(row, documentVersion, reservation) !== candidate.sourceVersion) throw new Error('BACKFILL_STALE_PREVIEW'); const result = await postDocument(tx, scope, 'outgoing_invoice', candidate.sourceId, { reservationId: reservation.id, mutation: input.mutation }); if (result.status === 'ready') postedCount += 1; else unresolvedCount += 1; continue; } const row = (await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), candidate.sourceId]))[0]; const preview = row ? await postingPreview(tx, scope, row, 'incoming_invoice') : null; const documentVersion = preview?.snapshot?.sourceVersion ?? (row ? hash(row) : hash({ missing: candidate.sourceId })); if (!row || row.status === 'draft' || row.status === 'cancelled' || row.accounting_status === 'posted' || row.accounting_status === 'reversed' || incomingBackfillSourceVersion(row, documentVersion) !== candidate.sourceVersion) throw new Error('BACKFILL_STALE_PREVIEW'); const result = await postDocument(tx, scope, 'incoming_invoice', candidate.sourceId, { mutation: input.mutation }); if (result.status === 'ready') postedCount += 1; else unresolvedCount += 1; } const result = { runId: input.runId, postedCount, unresolvedCount, status: 'completed' as const }; await q(tx, `UPDATE accounting_backfill_runs SET status='completed',result_json=$1,confirmed_at=$2,completed_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(result), now(), tenant(scope), input.runId]); await audit(tx as PostgresTransactionClient, scope, 'accounting_backfill', input.runId, 'confirm', input.reason, { status: 'preview' }, result, input.mutation); return result; }); },
  async listAssets(scope) {
    const rows = await q<AssetDbRow>(db, `SELECT * FROM assets WHERE tenant_id=$1 ORDER BY asset_number,id`, [tenant(scope)]);
    return Promise.all(rows.map(async (row) => mapAsset(row, await assetSchedule(db, scope, row.id))));
  },
  async upsertAsset(scope, input, reason, options: AssetMutationOptions = {}) {
    if (!reason.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    const result = await inTx(db, async (tx) => {
      const t = tenant(scope); const stamp = now();
      const existingById = input.id ? (await q<AssetDbRow>(tx, `SELECT * FROM assets WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, input.id]))[0] : undefined;
      const existingByNumber = !input.id ? (await q<any>(tx, `SELECT id FROM assets WHERE tenant_id=$1 AND asset_number=$2`, [t, input.assetNumber]))[0] : undefined;
      const id = input.id ?? existingByNumber?.id ?? randomUUID();
      const existing = existingById ?? (existingByNumber ? await assetRow(tx, scope, existingByNumber.id, true) : undefined);
      const method = resolveDepreciationMethod(assetInputFor(input));
      const schedule = buildDepreciationSchedule({ ...assetInputFor(input), method });
      const oldSchedule = existing ? await assetSchedule(tx, scope, id) : [];
      if (existing && (oldSchedule.some((entry) => entry.status === 'posted') || (await q<any>(tx, `SELECT 1 FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 LIMIT 1`, [t, id]))[0])) {
        const financialChanged = input.assetNumber !== existing.asset_number || input.assetClass !== existing.asset_class || input.activationDate !== existing.activation_date || round(input.acquisitionCost) !== round(existing.acquisition_cost) || (input.usefulLifeYears ?? null) !== existing.useful_life_years || method !== existing.depreciation_method || input.assetAccountNumber !== existing.asset_account_number || (input.acquisitionOffsetAccountNumber !== undefined && input.acquisitionOffsetAccountNumber !== existing.acquisition_offset_account_number) || (input.sourceIncomingInvoiceId !== undefined && input.sourceIncomingInvoiceId !== existing.source_incoming_invoice_id);
        if (financialChanged) throw new Error('ACCOUNTING_ASSET_FIELDS_IMMUTABLE');
      }
      if (input.status === 'aktiv' && !existing?.activation_journal_entry_id) {
        if (!isoDate(input.activationDate)) throw new Error('INVALID_ACTIVATION_DATE');
        const periodStatus = await ensurePeriod(tx, t, period(input.activationDate));
        if (periodStatus === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD');
        if (periodStatus === 'soft_locked' && (!options.softLockOverride || !options.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
      }
      await q(tx, `INSERT INTO assets (id,tenant_id,asset_number,name,asset_class,status,activation_date,acquisition_cost,useful_life_years,depreciation_method,cost_center,location,receipt_linked,supplier,invoice_ref,asset_account_number,disposal_date,disposal_proceeds,acquisition_offset_account_number,source_incoming_invoice_id,activation_journal_entry_id,accounting_repair_required,accounting_repair_reason,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) ON CONFLICT (id) DO UPDATE SET asset_number=EXCLUDED.asset_number,name=EXCLUDED.name,asset_class=EXCLUDED.asset_class,status=EXCLUDED.status,activation_date=EXCLUDED.activation_date,acquisition_cost=EXCLUDED.acquisition_cost,useful_life_years=EXCLUDED.useful_life_years,depreciation_method=EXCLUDED.depreciation_method,cost_center=EXCLUDED.cost_center,location=EXCLUDED.location,receipt_linked=EXCLUDED.receipt_linked,supplier=EXCLUDED.supplier,invoice_ref=EXCLUDED.invoice_ref,asset_account_number=EXCLUDED.asset_account_number,acquisition_offset_account_number=EXCLUDED.acquisition_offset_account_number,source_incoming_invoice_id=EXCLUDED.source_incoming_invoice_id,updated_at=EXCLUDED.updated_at`, [id, t, input.assetNumber, input.name, input.assetClass, input.status, input.activationDate, round(input.acquisitionCost), input.usefulLifeYears ?? null, method, input.costCenter, input.location, input.receiptLinked, input.supplier ?? null, input.invoiceRef ?? null, input.assetAccountNumber, existing?.disposal_date ?? null, existing?.disposal_proceeds ?? null, input.acquisitionOffsetAccountNumber ?? existing?.acquisition_offset_account_number ?? null, input.sourceIncomingInvoiceId ?? existing?.source_incoming_invoice_id ?? null, existing?.activation_journal_entry_id ?? null, existing?.accounting_repair_required ?? false, existing?.accounting_repair_reason ?? null, existing?.created_at ?? stamp, stamp]);
      let activationJournalEntryId = existing?.activation_journal_entry_id ?? null;
      let activationSourceType: string | null = activationJournalEntryId ? (await q<any>(tx, `SELECT source_type FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [t, activationJournalEntryId]))[0]?.source_type ?? null : null;
      let activationSourceKey: string | null = activationJournalEntryId ? (await q<any>(tx, `SELECT source_key FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [t, activationJournalEntryId]))[0]?.source_key ?? null : null;
      let offset = input.acquisitionOffsetAccountNumber ?? existing?.acquisition_offset_account_number ?? null;
      if (input.status === 'aktiv' && !activationJournalEntryId) {
        const linked = input.sourceIncomingInvoiceId ? (await q<any>(tx, `SELECT accounting_status,accounting_journal_entry_id FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.sourceIncomingInvoiceId]))[0] : undefined;
        if (input.sourceIncomingInvoiceId && (!linked || linked.accounting_status !== 'posted' || !linked.accounting_journal_entry_id || !(await q(tx, `SELECT 1 FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 AND asset_account_number=$3 AND ABS(net_amount-$4)<0.005 LIMIT 1`, [t, input.sourceIncomingInvoiceId, input.assetAccountNumber, input.acquisitionCost]))[0])) throw new Error('INCOMING_INVOICE_ASSET_LINE_MISMATCH');
        if (linked?.accounting_journal_entry_id) { activationJournalEntryId = linked.accounting_journal_entry_id; activationSourceType = 'incoming_invoice'; activationSourceKey = `incoming-invoice:${input.sourceIncomingInvoiceId}`; }
        else { const posted = await postAssetActivation(tx, scope, input, id, reason, options, (await policy(tx, t)).activeChart); activationJournalEntryId = posted.journalEntryId; offset = posted.offset; activationSourceType = 'asset_activation'; activationSourceKey = `asset_activation:${id}`; }
        await q(tx, `UPDATE assets SET activation_journal_entry_id=$1,acquisition_offset_account_number=$2,updated_at=$3 WHERE tenant_id=$4 AND id=$5`, [activationJournalEntryId, offset, stamp, t, id]);
        if (!(await movementSourceExists(tx, scope, activationSourceType!, activationSourceKey!))) await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'activation',$4,$5,NULL,NULL,$6,$7,$8,$9,$10)`, [randomUUID(), t, id, input.activationDate, round(input.acquisitionCost), activationJournalEntryId, activationSourceType, activationSourceKey, reason, stamp]);
        await insertAssetSchedule(tx, scope, id, schedule);
      } else if (input.status === 'aktiv') await insertAssetSchedule(tx, scope, id, schedule);
      const afterRow = await assetRow(tx, scope, id);
      const afterSchedule = await assetSchedule(tx, scope, id);
      await audit(tx as PostgresTransactionClient, scope, 'asset', id, existing ? 'update' : 'create', reason, existing ? { asset: assetSnapshot(existing), schedule: oldSchedule } : null, { asset: assetSnapshot(afterRow), schedule: afterSchedule }, options.mutation);
      return mapAsset(afterRow, afterSchedule);
    });
    return result;
  },
  async getDepreciationSchedule(scope, assetId) { await assetRow(db, scope, assetId); return assetSchedule(db, scope, assetId); },
  async runDepreciation(scope, input): Promise<AssetDepreciationResult> {
    if (!input.reason.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    return inTx(db, async (tx) => {
      const row = await assetRow(tx, scope, input.assetId, true); const schedule = await assetSchedule(tx, scope, row.id, true); const entry = schedule.find((item) => item.year === input.year);
      if (!entry) throw new Error('DEPRECIATION_SCHEDULE_NOT_FOUND');
      const sourceKey = `asset_depreciation:${row.id}:${input.year}`;
      if (entry.status === 'posted' && entry.journalEntryId) return { asset: mapAsset(row, schedule), scheduleEntry: entry, journalEntryId: entry.journalEntryId };
      if (entry.status === 'cancelled') throw new Error('DEPRECIATION_SCHEDULE_CANCELLED');
      if (row.accounting_repair_required) throw new Error('ASSET_ACTIVATION_REPAIR_REQUIRED');
      if (row.status === 'entwurf' || !row.activation_journal_entry_id) throw new Error('ASSET_NOT_ACTIVE');
      if (!isoDate(input.postingDate)) throw new Error('INVALID_POSTING_DATE');
      const status = await ensurePeriod(tx, tenant(scope), period(input.postingDate));
      if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD');
      if (status === 'soft_locked' && (!input.softLockOverride || !input.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
      const chart = (await policy(tx, tenant(scope))).activeChart; const expense = DEPRECIATION_EXPENSE_ACCOUNTS[chart]; await assertAccounts(tx, chart, [expense, row.asset_account_number], 'DEPRECIATION_ACCOUNT_NOT_IN_CHART');
      const journalEntryId = await insertEntry(tx, scope, 'asset_depreciation', sourceKey, input.postingDate, `AfA ${row.asset_number} ${input.year}`, [
        { id: `${row.id}-expense-${input.year}`, accountNumber: expense, debitAmount: entry.amount, creditAmount: 0, evidenceType: 'asset_depreciation', evidenceReference: row.invoice_ref ?? row.asset_number, costCenter: row.cost_center, memo: input.reason },
        { id: `${row.id}-asset-${input.year}`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: entry.amount, costCenter: row.cost_center, memo: input.reason },
      ], { reference: row.asset_number, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation });
      const stamp = now();
      await q(tx, `UPDATE asset_depreciation_schedule SET status='posted',journal_entry_id=$1,source_type='asset_depreciation',source_key=$2,posted_at=$3 WHERE tenant_id=$4 AND id=$5 AND status='planned'`, [journalEntryId, sourceKey, stamp, tenant(scope), entry.id]);
      if (!(await movementSourceExists(tx, scope, 'asset_depreciation', sourceKey))) await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'depreciation',$4,$5,NULL,NULL,$6,'asset_depreciation',$7,$8,$9)`, [randomUUID(), tenant(scope), row.id, input.postingDate, entry.amount, journalEntryId, sourceKey, input.overrideReason?.trim() || input.reason, stamp]);
      const afterSchedule = await assetSchedule(tx, scope, row.id); if (afterSchedule.length > 0 && afterSchedule.every((item) => item.status === 'posted')) await q(tx, `UPDATE assets SET status='voll_abgeschrieben',updated_at=$1 WHERE tenant_id=$2 AND id=$3 AND status='aktiv'`, [stamp, tenant(scope), row.id]);
      const afterRow = await assetRow(tx, scope, row.id); await audit(tx as PostgresTransactionClient, scope, 'asset', row.id, 'depreciation_posted', input.reason, { asset: assetSnapshot(row), schedule }, { asset: assetSnapshot(afterRow), schedule: afterSchedule, journalEntryId, sourceType: 'asset_depreciation', sourceKey }, input.mutation);
      return { asset: mapAsset(afterRow, afterSchedule), scheduleEntry: afterSchedule.find((item) => item.year === input.year)!, journalEntryId };
    });
  },
  async disposeAsset(scope, input): Promise<AssetDisposalResult> {
    if (!input.reason.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    return inTx(db, async (tx) => {
      const row = await assetRow(tx, scope, input.assetId, true); const sourceKey = `asset_disposal:${row.id}`;
      const existing = (await q<any>(tx, `SELECT journal_entry_id,amount,gain_loss,proceeds FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 AND source_type='asset_disposal' AND source_key=$3 LIMIT 1`, [tenant(scope), row.id, sourceKey]))[0];
      if (existing?.journal_entry_id) return { asset: await getAsset(tx, scope, row.id), residualBookValue: round(existing.amount), gainLoss: round(existing.gain_loss ?? Number(existing.proceeds) - Number(existing.amount)), journalEntryId: existing.journal_entry_id };
      if (!isoDate(input.disposalDate)) throw new Error('INVALID_DISPOSAL_DATE');
      const status = await ensurePeriod(tx, tenant(scope), period(input.disposalDate)); if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD'); if (status === 'soft_locked' && (!input.softLockOverride || !input.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
      if (row.depreciation_method === 'pool') throw new Error('POOL_INDIVIDUAL_DISPOSAL_NOT_SUPPORTED');
      if (row.accounting_repair_required) throw new Error('ASSET_ACTIVATION_REPAIR_REQUIRED'); if (row.status === 'entwurf' || !row.activation_journal_entry_id) throw new Error('ASSET_NOT_ACTIVE'); if (row.disposal_date) throw new Error('ASSET_ALREADY_DISPOSED'); if (input.proceeds > 0 && input.taxRate === undefined) throw new Error('TAX_RATE_REQUIRED_FOR_PROCEEDS');
      const residualBookValue = await postedDepreciationAmount(tx, scope, row).then((posted) => round(Math.max(0, Number(row.acquisition_cost) - posted)));
      const disposal = computeAssetDisposal({ ...assetInputFor(row), disposalDate: input.disposalDate, proceeds: input.proceeds });
      if (Math.abs(disposal.residualBookValue - residualBookValue) > 0.01) throw new Error('ASSET_DISPOSAL_PROJECTION_MISMATCH');
      const chart = (await policy(tx, tenant(scope))).activeChart; const accounts = disposalAccounts(chart); const proceedsAccount = input.proceedsAccountNumber || await accountFor(tx, scope, chart, 'bank'); if (input.proceeds > 0 && !proceedsAccount) throw new Error('PROCEEDS_ACCOUNT_REQUIRED');
      const taxAccount = input.taxRate && input.taxRate > 0 ? await taxCaseAccount(tx, tenant(scope), chart, input.taxRate === 7 ? 'DE_STD_7' : 'DE_STD_19', 'output_tax', outputTaxAccount(chart, input.taxRate), input.disposalDate) : undefined; await assertAccounts(tx, chart, [row.asset_account_number, accounts.loss, accounts.gain, ...(input.proceeds > 0 && proceedsAccount ? [proceedsAccount] : []), ...(taxAccount ? [taxAccount] : [])], 'DISPOSAL_ACCOUNT_NOT_IN_CHART');
      const gainLoss = round(input.proceeds - residualBookValue); const gross = round(input.proceeds * (1 + (input.taxRate ?? 0) / 100)); const vat = round(gross - input.proceeds); const lines: JournalLineEntity[] = [];
      if (input.proceeds > 0) lines.push({ id: `${row.id}-proceeds`, accountNumber: proceedsAccount!, debitAmount: gross, creditAmount: 0, memo: input.reason });
      if (gainLoss < 0) lines.push({ id: `${row.id}-loss`, accountNumber: accounts.loss, debitAmount: -gainLoss, creditAmount: 0, memo: input.reason });
      if (gainLoss > 0) lines.push({ id: `${row.id}-gain`, accountNumber: accounts.gain, debitAmount: 0, creditAmount: gainLoss, taxCaseKey: 'DE_ZERO_EXEMPT', evidenceType: 'asset_disposal', evidenceReference: row.asset_number, memo: input.reason });
      if (residualBookValue > 0) lines.push({ id: `${row.id}-residual`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: residualBookValue, memo: input.reason });
      if (vat > 0) lines.push({ id: `${row.id}-vat`, accountNumber: taxAccount!, debitAmount: 0, creditAmount: vat, taxCaseKey: (input.taxRate === 7 ? 'DE_STD_7' : 'DE_STD_19') as any, taxRate: input.taxRate, netAmount: input.proceeds, taxAmount: vat, grossAmount: gross, memo: `USt ${input.taxRate}%` });
      const journalEntryId = await insertEntry(tx, scope, 'asset_disposal', sourceKey, input.disposalDate, `${input.proceeds > 0 ? 'Anlagenverkauf' : 'Anlagenabgang'} ${row.asset_number}`, lines, { reference: row.asset_number, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation });
      const stamp = now(); await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'disposal',$4,$5,$6,$7,$8,'asset_disposal',$9,$10,$11)`, [randomUUID(), tenant(scope), row.id, input.disposalDate, residualBookValue, input.proceeds, gainLoss, journalEntryId, sourceKey, input.overrideReason?.trim() || input.reason, stamp]);
      await q(tx, `UPDATE assets SET status=$1,disposal_date=$2,disposal_proceeds=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [input.proceeds > 0 ? 'verkauft' : 'stillgelegt', input.disposalDate, input.proceeds, stamp, tenant(scope), row.id]);
      await q(tx, `UPDATE asset_depreciation_schedule SET status='cancelled' WHERE tenant_id=$1 AND asset_id=$2 AND status='planned'`, [tenant(scope), row.id]);
      const afterRow = await assetRow(tx, scope, row.id); const afterSchedule = await assetSchedule(tx, scope, row.id); await audit(tx as PostgresTransactionClient, scope, 'asset', row.id, 'dispose', input.reason, { asset: assetSnapshot(row) }, { asset: assetSnapshot(afterRow), schedule: afterSchedule, residualBookValue, gainLoss, journalEntryId }, input.mutation);
      return { asset: mapAsset(afterRow, afterSchedule), residualBookValue, gainLoss, journalEntryId };
    });
  },
  async ensureSeedData(scope) { await inTx(db, async (tx) => { const t = tenant(scope); const stamp = now(); await q(tx, `INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2) ON CONFLICT (tenant_id) DO NOTHING`, [t, stamp]); const p = await policy(tx, t); for (const [role, accountNumber] of Object.entries(defaults[p.activeChart])) await q(tx, `INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,chart,role) DO NOTHING`, [randomUUID(), t, p.activeChart, role, accountNumber, stamp]); const accounts = await q<any>(tx, `SELECT account_number FROM ledger_accounts WHERE chart=$1 ORDER BY account_number`, [p.activeChart]); for (const account of accounts) { const first = String(account.account_number)[0]; if (['4','5','6','7','8','9'].includes(first)) await q(tx, `INSERT INTO account_mappings_hgb (id,tenant_id,chart,account_number,statement_type,position_key,position_label,balance_side,updated_at) VALUES ($1,$2,$3,$4,'guv',$5,$6,NULL,$7) ON CONFLICT (tenant_id,chart,account_number,statement_type) DO NOTHING`, [randomUUID(), t, p.activeChart, account.account_number, ['8','9'].includes(first) ? 'revenue' : 'expense', ['8','9'].includes(first) ? 'Umsatzerloese' : 'Aufwendungen', stamp]); else if (['0','1','2','3'].includes(first)) await q(tx, `INSERT INTO account_mappings_hgb (id,tenant_id,chart,account_number,statement_type,position_key,position_label,balance_side,updated_at) VALUES ($1,$2,$3,$4,'bilanz',$5,$6,$7,$8) ON CONFLICT (tenant_id,chart,account_number,statement_type) DO NOTHING`, [randomUUID(), t, p.activeChart, account.account_number, ['0','1'].includes(first) ? 'assets' : 'liabilities', ['0','1'].includes(first) ? 'Aktiva' : 'Passiva', ['0','1'].includes(first) ? 'asset' : 'liability', stamp]); } await ensurePeriod(tx, t, period(stamp.slice(0, 10))); }); },
});

type AssetDbRow = {
  id: string; tenant_id: string; asset_number: string; name: string; asset_class: string; status: string;
  activation_date: string; acquisition_cost: number | string; useful_life_years: number | null; depreciation_method: string;
  cost_center: string; location: string; receipt_linked: boolean; supplier: string | null; invoice_ref: string | null;
  asset_account_number: string; disposal_date: string | null; disposal_proceeds: number | string | null;
  acquisition_offset_account_number: string | null; source_incoming_invoice_id: string | null;
  activation_journal_entry_id: string | null; accounting_repair_required: boolean; accounting_repair_reason: string | null; created_at: string;
};

const assetRow = async (db: PostgresQueryable, scope: TenantScope, assetId: string, lock = false): Promise<AssetDbRow> => {
  const rows = await q<AssetDbRow>(db, `SELECT * FROM assets WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [tenant(scope), assetId]);
  if (!rows[0]) throw new Error('ASSET_NOT_FOUND');
  return rows[0];
};

const assetSchedule = async (db: PostgresQueryable, scope: TenantScope, assetId: string, lock = false): Promise<AssetDepreciationScheduleEntry[]> => {
  const rows = await q<any>(db, `SELECT * FROM asset_depreciation_schedule WHERE tenant_id=$1 AND asset_id=$2 ORDER BY year,id${lock ? ' FOR UPDATE' : ''}`, [tenant(scope), assetId]);
  return rows.map((row) => ({
    id: row.id, assetId: row.asset_id, year: Number(row.year), amount: round(row.amount), months: Number(row.months),
    status: row.status as AssetDepreciationScheduleEntry['status'], journalEntryId: row.journal_entry_id ?? undefined,
    sourceType: row.source_type ?? undefined, sourceKey: row.source_key ?? undefined, postedAt: row.posted_at ?? undefined,
  }));
};

const assetInputFor = (row: AssetDbRow | AssetUpsertInput) => ({
  acquisitionCost: Number('acquisition_cost' in row ? row.acquisition_cost : row.acquisitionCost),
  activationDate: 'activation_date' in row ? row.activation_date : row.activationDate,
  assetClass: 'asset_class' in row ? row.asset_class : row.assetClass,
  usefulLifeYears: ('useful_life_years' in row ? row.useful_life_years : row.usefulLifeYears) ?? undefined,
  method: ('depreciation_method' in row ? row.depreciation_method : row.depreciationMethod) as any,
});

const assetSnapshot = (row: AssetDbRow | AssetUpsertInput): Record<string, unknown> => 'asset_number' in row ? {
  id: row.id, assetNumber: row.asset_number, name: row.name, assetClass: row.asset_class, status: row.status,
  activationDate: row.activation_date, acquisitionCost: Number(row.acquisition_cost), usefulLifeYears: row.useful_life_years,
  depreciationMethod: row.depreciation_method, costCenter: row.cost_center, location: row.location, receiptLinked: Boolean(row.receipt_linked),
  supplier: row.supplier, invoiceRef: row.invoice_ref, assetAccountNumber: row.asset_account_number,
  acquisitionOffsetAccountNumber: row.acquisition_offset_account_number, sourceIncomingInvoiceId: row.source_incoming_invoice_id,
  activationJournalEntryId: row.activation_journal_entry_id, accountingRepairRequired: Boolean(row.accounting_repair_required),
  accountingRepairReason: row.accounting_repair_reason, disposalDate: row.disposal_date, disposalProceeds: row.disposal_proceeds == null ? null : Number(row.disposal_proceeds),
} : { ...row, id: row.id ?? null };

const mapAsset = (row: AssetDbRow, schedule: AssetDepreciationScheduleEntry[]): AssetItem => {
  const posted = round(schedule.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount, 0));
  const residualValue = round(Math.max(0, Number(row.acquisition_cost) - posted));
  const planned = schedule.find((entry) => entry.status === 'planned');
  const status = row.status === 'aktiv' && residualValue === 0 ? 'voll_abgeschrieben' : row.status as AssetStatus;
  return {
    id: row.id, assetNumber: row.asset_number, name: row.name, assetClass: row.asset_class, status,
    activationDate: row.activation_date, acquisitionCost: round(row.acquisition_cost), residualValue,
    annualDepreciation: Math.max(0, ...schedule.map((entry) => entry.amount)), usefulLifeYears: row.useful_life_years ?? undefined,
    depreciationMethod: row.depreciation_method as any, costCenter: row.cost_center, location: row.location,
    nextDepreciation: planned ? `${planned.year}-12-31` : '—', receiptLinked: Boolean(row.receipt_linked),
    supplier: row.supplier ?? undefined, invoiceRef: row.invoice_ref ?? undefined, assetAccountNumber: row.asset_account_number,
    acquisitionOffsetAccountNumber: row.acquisition_offset_account_number ?? undefined, sourceIncomingInvoiceId: row.source_incoming_invoice_id ?? undefined,
    activationJournalEntryId: row.activation_journal_entry_id ?? undefined, accountingRepairRequired: Boolean(row.accounting_repair_required),
    accountingRepairReason: row.accounting_repair_reason ?? undefined, disposalDate: row.disposal_date ?? undefined,
    disposalProceeds: row.disposal_proceeds == null ? undefined : round(row.disposal_proceeds),
  };
};

const getAsset = async (db: PostgresQueryable, scope: TenantScope, assetId: string, lock = false): Promise<AssetItem> => {
  const row = await assetRow(db, scope, assetId, lock);
  return mapAsset(row, await assetSchedule(db, scope, assetId, lock));
};

const accountFor = async (db: PostgresQueryable, scope: TenantScope, chart: 'SKR03' | 'SKR04', role: string): Promise<string | undefined> => (await mappings(db, tenant(scope), chart))[role];
const assertAccounts = async (db: PostgresQueryable, chart: 'SKR03' | 'SKR04', accounts: string[], code: string): Promise<void> => {
  if ((await Promise.all(accounts.map((account) => accountExists(db, chart, account)))).some((exists) => !exists)) throw new Error(code);
};
const disposalAccounts = (chart: 'SKR03' | 'SKR04') => chart === 'SKR03' ? { loss: '2310', gain: '8829' } : { loss: '6895', gain: '4849' };
const outputTaxAccount = (chart: 'SKR03' | 'SKR04', rate: 0 | 7 | 19): string => chart === 'SKR03' ? (rate === 7 ? '1771' : '1776') : (rate === 7 ? '3801' : '3806');
const movementSourceExists = async (db: PostgresQueryable, scope: TenantScope, sourceType: string, sourceKey: string): Promise<boolean> => Boolean((await q(db, `SELECT 1 FROM asset_movements WHERE tenant_id=$1 AND source_type=$2 AND source_key=$3 LIMIT 1`, [tenant(scope), sourceType, sourceKey]))[0]);

const postAssetActivation = async (db: PostgresQueryable, scope: TenantScope, input: AssetUpsertInput, id: string, reason: string, options: AssetMutationOptions, chart: 'SKR03' | 'SKR04'): Promise<{ journalEntryId: string; offset: string }> => {
  const offset = input.acquisitionOffsetAccountNumber || await accountFor(db, scope, chart, 'accounts_payable');
  if (!offset) throw new Error('ACQUISITION_OFFSET_ACCOUNT_REQUIRED');
  await assertAccounts(db, chart, [input.assetAccountNumber, offset], 'ACQUISITION_ACCOUNT_NOT_IN_CHART');
  const sourceKey = `asset_activation:${id}`;
  const journalEntryId = await insertEntry(db, scope, 'asset_activation', sourceKey, input.activationDate, `Anlagenzugang ${input.assetNumber}`, [
    { id: `${id}-asset`, accountNumber: input.assetAccountNumber, debitAmount: round(input.acquisitionCost), creditAmount: 0, costCenter: input.costCenter, memo: reason },
    { id: `${id}-offset`, accountNumber: offset, debitAmount: 0, creditAmount: round(input.acquisitionCost), costCenter: input.costCenter, memo: reason },
  ], { reference: input.assetNumber, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation });
  return { journalEntryId, offset };
};

const insertAssetSchedule = async (db: PostgresQueryable, scope: TenantScope, id: string, schedule: ReturnType<typeof buildDepreciationSchedule>): Promise<void> => {
  const t = tenant(scope);
  await q(db, `DELETE FROM asset_depreciation_schedule WHERE tenant_id=$1 AND asset_id=$2 AND status='planned'`, [t, id]);
  for (const entry of schedule) await q(db, `INSERT INTO asset_depreciation_schedule (id,tenant_id,asset_id,year,amount,months,status,journal_entry_id,source_type,source_key,posted_at) VALUES ($1,$2,$3,$4,$5,$6,'planned',NULL,NULL,NULL,NULL) ON CONFLICT (tenant_id,asset_id,year) DO NOTHING`, [randomUUID(), t, id, entry.year, entry.amount, entry.months]);
};

const postedDepreciationAmount = async (db: PostgresQueryable, scope: TenantScope, row: AssetDbRow): Promise<number> => {
  const schedule = Number((await q<any>(db, `SELECT COALESCE(SUM(amount),0) amount FROM asset_depreciation_schedule WHERE tenant_id=$1 AND asset_id=$2 AND status='posted'`, [tenant(scope), row.id]))[0]?.amount ?? 0);
  const journal = Number((await q<any>(db, `SELECT COALESCE(SUM(jl.credit_amount-jl.debit_amount),0) amount FROM asset_movements m JOIN journal_entries je ON je.tenant_id=m.tenant_id AND je.id=m.journal_entry_id JOIN journal_lines jl ON jl.tenant_id=je.tenant_id AND jl.entry_id=je.id WHERE m.tenant_id=$1 AND m.asset_id=$2 AND m.type='depreciation' AND je.status='posted' AND je.source_type='asset_depreciation' AND jl.account_number=$3`, [tenant(scope), row.id, row.asset_account_number]))[0]?.amount ?? 0);
  if (Math.round(schedule * 100) !== Math.round(journal * 100)) throw new Error('ASSET_DEPRECIATION_PROJECTION_MISMATCH');
  return round(journal);
};

const postDocument = async (db: PostgresQueryable, scope: TenantScope, type: 'outgoing_invoice'|'incoming_invoice', id: string, options: { softLockOverride?: boolean; overrideReason?: string; reservationId?: string; mutation?: AccountingMutationContext }): Promise<AccountingPostingPreview> => {
  const t = tenant(scope); const table = type === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices'; const row = (await q<any>(db, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, id]))[0]; if (!row) throw new Error(type === 'outgoing_invoice' ? 'INVOICE_NOT_FOUND' : 'INCOMING_INVOICE_NOT_FOUND'); if (row.accounting_status === 'posted') { const snapshot = parse<AccountingSnapshot | undefined>(row.accounting_snapshot_json, undefined); if (snapshot) return { sourceType: type, sourceId: id, status: 'ready', snapshot, issues: [] }; return postingPreview(db, scope, row, type); }
  // Keep terminal document state a domain conflict rather than allowing the
  // later immutable-row trigger to report an implementation-specific error.
  if (row.accounting_status === 'reversed' || row.status === 'cancelled' || (type === 'incoming_invoice' && row.status === 'draft')) throw new Error('DOCUMENT_NOT_POSTABLE');
  if (type === 'outgoing_invoice' && row.client_id) { const client = (await q<any>(db, `SELECT tenant_id FROM clients WHERE id=$1`, [row.client_id]))[0]; if (client && client.tenant_id !== t) throw new Error('CLIENT_NOT_FOUND'); }
  if (type === 'incoming_invoice') {
    const vendor = (await q<any>(db, `SELECT tenant_id FROM vendors WHERE id=$1`, [row.vendor_id]))[0];
    if (!vendor || vendor.tenant_id !== t) throw new Error('VENDOR_NOT_FOUND');
  }
  if (type === 'outgoing_invoice') { if (!options.reservationId) throw new Error('FINALIZED_RESERVATION_REQUIRED'); const reservation = (await q<any>(db, `SELECT kind,number,status,document_id FROM number_reservations WHERE tenant_id=$1 AND id=$2`, [t, options.reservationId]))[0]; if (!reservation || reservation.kind !== 'invoice' || reservation.status !== 'finalized' || reservation.document_id !== id || reservation.number !== row.number || row.status === 'draft') throw new Error('FINALIZED_RESERVATION_REQUIRED'); }
  const preview = await postingPreview(db, scope, row, type); if (preview.status !== 'ready' || !preview.snapshot) return preview; const sourceKey = `${type}:${id}`; const entryId = await insertEntry(db, scope, type, sourceKey, type === 'outgoing_invoice' ? row.date : row.invoice_date, type === 'outgoing_invoice' ? `Rechnung ${row.number}` : `Eingangsrechnung ${row.number}`, preview.snapshot.lines.map((line, index) => ({ ...line, id: randomUUID(), taxCaseKey: line.taxCaseKey as any, accountNumber: line.accountNumber, debitAmount: round(line.debitAmount), creditAmount: round(line.creditAmount), memo: line.memo })), { reference: row.number, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation }); const postedAt = now(); await q(db, `UPDATE ${table} SET accounting_status='posted',accounting_snapshot_json=$1,accounting_journal_entry_id=$2,accounting_posted_at=$3,status=CASE WHEN status='draft' THEN 'open' ELSE status END,updated_at=$3 WHERE tenant_id=$4 AND id=$5`, [JSON.stringify(preview.snapshot), entryId, postedAt, t, id]); const itemId = randomUUID(); await q(db, `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$10,'open',$11,$12,$12) ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`, [itemId, t, type === 'outgoing_invoice' ? 'debtor' : 'creditor', type === 'outgoing_invoice' ? row.client_id ?? row.client ?? id : row.vendor_id, type, id, row.number, type === 'outgoing_invoice' ? row.date : row.invoice_date, row.due_date, preview.snapshot.grossAmount, entryId, postedAt]); await audit(db as PostgresTransactionClient, scope, type, id, 'accounting_post', 'Document accounting posted', null, { entryId, sourceVersion: preview.snapshot.sourceVersion }, options.mutation); return { ...preview, snapshot: { ...preview.snapshot, capturedAt: now() } };
};

const allocatePayment = async (db: PostgresQueryable, scope: TenantScope, input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity> => {
  const t = tenant(scope);
  const stamp = now();
  const allocationEventId = requireAllocationEventId(input.allocationEventId);
  const duplicate = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR UPDATE`, [t, input.sourceType, input.sourceId]))[0];
  if (duplicate) {
    if (duplicate.party_type !== input.partyType || (input.partyId && duplicate.party_id !== input.partyId) || round(duplicate.amount) !== round(input.amount) || duplicate.payment_date !== input.paymentDate || duplicate.bank_account_number !== input.bankAccountNumber) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (Number(duplicate.residual_amount) <= .01) return rowPayment(duplicate);
    const requestedTotal = round(input.allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0));
    if (requestedTotal > Number(duplicate.residual_amount) + .01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
    if (!input.paymentId || input.paymentId !== duplicate.id) return rowPayment(duplicate);

    // Group repeated allocations before changing any row.  Otherwise two
    // allocations of 80 against a 100 item each read the original residual
    // and can leave allocation rows at 160 while the item says 80.
    const requestedByItem = new Map<string, number>();
    for (const allocation of input.allocations) {
      const amount = round(allocation.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_PAYMENT_ALLOCATION');
      requestedByItem.set(allocation.openItemId, round((requestedByItem.get(allocation.openItemId) ?? 0) + amount));
    }
    const items = new Map<string, any>();
    for (const [itemId, amount] of requestedByItem) {
      const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, itemId]))[0];
      if (!item) throw new Error('OPEN_ITEM_NOT_FOUND');
      if (item.party_type !== input.partyType || (input.partyId && item.party_id !== input.partyId)) throw new Error('PAYMENT_PARTY_MISMATCH');
      await assertOpenItemSource(db, t, item);
      const eventKey = `${allocationEventId}:${item.id}`;
      if ((await q<any>(db, `SELECT id FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 AND event_key=$3 LIMIT 1`, [t, duplicate.id, eventKey]))[0]) continue;
      if (Number(item.residual_amount) <= .01 && (await q<any>(db, `SELECT 1 FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 AND open_item_id=$3 LIMIT 1`, [t, duplicate.id, item.id]))[0]) continue;
      if (amount > Number(item.residual_amount) + .01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
      items.set(itemId, { item, amount });
    }
    for (const { item, amount } of items.values()) {
      const allocationId = randomUUID();
      const eventKey = `${allocationEventId}:${item.id}`;
      await q(db, `INSERT INTO open_item_allocations (id,tenant_id,payment_id,open_item_id,amount,created_at,event_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [allocationId, t, duplicate.id, item.id, amount, stamp, eventKey]);
      const allocated = round(Number(item.allocated_amount) + amount);
      const residual = round(Number(item.original_amount) - allocated);
      await recognizeIstVat(db, scope, item, duplicate.id, `${allocationEventId}:${item.id}`, amount, Number(item.allocated_amount), allocated, input.paymentDate);
      await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, residual, residual <= .01 ? 'paid' : 'partially_paid', stamp, t, item.id]);
      if (item.source_type === 'outgoing_invoice') await q(db, `UPDATE invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [residual <= .01 ? 'paid' : 'open', stamp, t, item.source_id]);
      if (item.source_type === 'incoming_invoice') await q(db, `UPDATE incoming_invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [residual <= .01 ? 'paid' : 'open', stamp, t, item.source_id]);
    }
    const totals = (await q<any>(db, `SELECT COALESCE(SUM(amount),0) allocated FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2`, [t, duplicate.id]))[0];
    const allocatedTotal = round(totals.allocated);
    const residualTotal = round(Number(duplicate.amount) - allocatedTotal);
    await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocatedTotal, residualTotal, residualTotal > .01 ? 'partially_allocated' : 'allocated', t, duplicate.id]);
    await audit(db as PostgresTransactionClient, scope, 'open_item_payment', duplicate.id, 'allocate', 'Payment allocation', null, { ...input, mutation: undefined }, input.mutation);
    return rowPayment((await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2`, [t, duplicate.id]))[0]);
  }

  if (!isoDate(input.paymentDate) || !Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('INVALID_PAYMENT'); const total = round(input.amount); const allocTotal = round(input.allocations.reduce((sum, a) => sum + Number(a.amount), 0)); if (allocTotal > total + .01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_PAYMENT');
  if (input.sourceType === 'bank_transaction') {
    const source = (await q<any>(db, `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, input.sourceId]))[0];
    if (!source) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    if (round(Math.abs(Number(source.amount))) !== total || source.date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (source.status === 'booked' || source.linked_invoice_id) throw new Error('PAYMENT_SOURCE_ALREADY_BOOKED');
    const expectedType = input.partyType === 'debtor' ? 'income' : 'expense';
    if (source.type !== expectedType) throw new Error('PAYMENT_SOURCE_DIRECTION_MISMATCH');
    if (!input.partyId) throw new Error('PAYMENT_PARTY_REQUIRED');
  } else if (input.sourceType === 'invoice_payment') {
    const invoiceRows = await q<any>(db, `SELECT id,client_id,payments_json FROM invoices WHERE tenant_id=$1`, [t]);
    let payment: any;
    for (const invoice of invoiceRows) {
      const payments = parse<any[]>(invoice.payments_json, []);
      const candidate = payments.find((entry) => entry?.id === input.sourceId);
      if (candidate) { payment = { ...candidate, client_id: invoice.client_id }; break; }
    }
    if (!payment) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    if (round(Math.abs(Number(payment.amount))) !== total || payment.date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (payment.client_id && input.partyId && payment.client_id !== input.partyId) throw new Error('PAYMENT_PARTY_MISMATCH');
    if (!input.partyId && !payment.client_id) throw new Error('PAYMENT_PARTY_REQUIRED');
  }
  const requestedByItem = new Map<string, number>();
  for (const allocation of input.allocations) {
    const amount = round(allocation.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_PAYMENT_ALLOCATION');
    requestedByItem.set(allocation.openItemId, round((requestedByItem.get(allocation.openItemId) ?? 0) + amount));
  }
  const items: any[] = [];
  for (const [openItemId, amount] of requestedByItem) {
    const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, openItemId]))[0];
    if (!item) throw new Error('OPEN_ITEM_NOT_FOUND');
    if (item.party_type !== input.partyType || (input.partyId && item.party_id !== input.partyId)) throw new Error('PAYMENT_PARTY_MISMATCH');
    await assertOpenItemSource(db, t, item);
    if (amount > Number(item.residual_amount) + .01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
    items.push({ item, amount });
  }
  const p = await policy(db, t);
  const m = await mappings(db, t, p.activeChart);
  if (!(await accountExists(db, p.activeChart, input.bankAccountNumber))) throw new Error(`UNKNOWN_ACCOUNT:${input.bankAccountNumber}`);
  const lines: JournalLineEntity[] = input.partyType === 'debtor'
    ? [{ id: randomUUID(), accountNumber: input.bankAccountNumber, debitAmount: total, creditAmount: 0 }, { id: randomUUID(), accountNumber: m.accounts_receivable, debitAmount: 0, creditAmount: total }]
    : [{ id: randomUUID(), accountNumber: m.accounts_payable, debitAmount: total, creditAmount: 0 }, { id: randomUUID(), accountNumber: input.bankAccountNumber, debitAmount: 0, creditAmount: total }];
  const entryId = await insertEntry(db, scope, 'payment', `payment:${input.sourceType}:${input.sourceId}`, input.paymentDate, 'Zahlung', lines, { mutation: input.mutation });
  const paymentId = input.paymentId ?? randomUUID();
  await q(db, `INSERT INTO open_item_payments (id,tenant_id,party_type,party_id,payment_date,amount,bank_account_number,method,source_type,source_id,allocated_amount,residual_amount,status,journal_entry_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [paymentId, t, input.partyType, input.partyId ?? items[0]?.item.party_id ?? null, input.paymentDate, total, input.bankAccountNumber, input.method ?? null, input.sourceType, input.sourceId, 0, total, 'open', entryId, stamp]);
  for (const allocation of items) {
    const allocationId = randomUUID();
    const beforeAllocated = Number(allocation.item.allocated_amount);
    const allocated = round(beforeAllocated + allocation.amount);
    const residual = round(Number(allocation.item.original_amount) - allocated);
    const eventKey = `${allocationEventId}:${allocation.item.id}`;
    if ((await q<any>(db, `SELECT id FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 AND event_key=$3 LIMIT 1`, [t, paymentId, eventKey]))[0]) continue;
    await q(db, `INSERT INTO open_item_allocations (id,tenant_id,payment_id,open_item_id,amount,created_at,event_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [allocationId, t, paymentId, allocation.item.id, allocation.amount, stamp, eventKey]);
    await recognizeIstVat(db, scope, allocation.item, paymentId, `${allocationEventId}:${allocation.item.id}`, allocation.amount, beforeAllocated, allocated, input.paymentDate);
    await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, residual, residual <= .01 ? 'paid' : 'partially_paid', stamp, t, allocation.item.id]);
    if (allocation.item.source_type === 'outgoing_invoice') await q(db, `UPDATE invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [residual <= .01 ? 'paid' : 'open', stamp, t, allocation.item.source_id]);
    if (allocation.item.source_type === 'incoming_invoice') await q(db, `UPDATE incoming_invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [residual <= .01 ? 'paid' : 'open', stamp, t, allocation.item.source_id]);
  }
  const allocated = round(items.reduce((sum, x) => sum + x.amount, 0));
  const residual = round(total - allocated);
  await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocated, residual, residual > .01 ? allocated ? 'partially_allocated' : 'overpaid' : 'allocated', t, paymentId]);
  if (input.sourceType === 'bank_transaction') {
    const linked = (await q<any>(db, `SELECT source_id FROM open_items oi JOIN open_item_allocations oa ON oa.open_item_id=oi.id WHERE oa.tenant_id=$1 AND oa.payment_id=$2 AND oi.source_type='outgoing_invoice' ORDER BY oa.created_at LIMIT 1`, [t, paymentId]))[0];
    await q(db, `UPDATE bank_transactions SET status='booked',linked_invoice_id=COALESCE($1,linked_invoice_id),updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [linked?.source_id ?? null, stamp, t, input.sourceId]);
  }
  await audit(db as PostgresTransactionClient, scope, 'open_item_payment', paymentId, 'allocate', 'Payment allocation', null, { ...input, mutation: undefined }, input.mutation);
  return rowPayment((await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2`, [t, paymentId]))[0]);
};
