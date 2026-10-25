import { createHash, randomUUID } from 'node:crypto';
import {
  computeUstva,
  buildDepreciationSchedule,
  calculateReport,
  computeAssetDisposal,
  DEPRECIATION_EXPENSE_ACCOUNTS,
  resolveDepreciationMethod,
  listReportMappingPositions,
  defaultReportMappings,
} from '@billme/accounting-engine';
import {
  fiscalYearForDate,
  fiscalYearRange,
} from '@billme/accounting-shared';
import type {
  AccountingAccountMapping, AccountingBackfillConfirmation, AccountingBackfillPreview, AccountingBackfillResult,
  AccountingDocumentSource, AccountingPostingPreview, AccountingSnapshot, IncomingInvoiceEntity,
  IncomingInvoiceDocumentDownload, IncomingInvoiceDocumentEntity, IncomingInvoiceDocumentReviewInput,
  IncomingInvoiceDocumentUploadInput,
  IncomingInvoiceLineEntity, OpenItemEntity, OpenItemPaymentEntity, OpenItemPaymentInput, VendorEntity,
  BookingDraftEntity, DraftExceptionCase, JournalEntryEntity, JournalLineEntity, LedgerBalance, ValidationIssue, AccountingMutationContext, DatevExportContent, DatevExportSourceSnapshot, DatevTaxEvidence, TaxCaseDefinition, TaxCaseKey,
  ReportKind, ReportingCalculationProfile, ReportingMapping, ReportResult, Bwa01Report, ManagementGuvReport, HgbGuvReport, HgbBilanzReport,
} from '@billme/accounting-shared';
import { datevDestinationCases, datevSachverhaltCases, normalizeDatevTaxEvidence, validateDatevTaxEvidence, INCOMING_INVOICE_DOCUMENT_MAX_BYTES, assertIncomingInvoiceDocumentContent, isSelfAssessedPurchase, TAX_CASE_RECEIPT_MODE } from '@billme/accounting-shared';
import type {
  TenantScope, ProAccountingAssetRepository, ProAccountingRepository, PostDraftOptions, ProDraftActionRequest, ReverseJournalEntryOptions,
  AssetDepreciationInput, AssetDepreciationResult, AssetDepreciationScheduleEntry, AssetDisposalInput, AssetDisposalResult, AssetRegister,
  AssetItem, AssetMutationOptions, AssetStatus, AssetUpsertInput,
} from '@billme/server-core';
import { businessReportingProfileSchema, localIsoDate } from '@billme/server-core';
import { AccountingPolicyError, BANK_ACCOUNT_DEFAULT, isMoneyLedgerAccount } from '@billme/accounting-shared';
import { defaultResultAccount, isProfitAndLossAccount } from '@billme/accounting-shared';
import { runInTransaction, type PostgresQueryable, type PostgresTransactionClient } from './connection.js';
import { suggestAccountForTransaction } from '@billme/finance-intelligence';
import { loadAccountSuggestionContext } from './accountSuggestions.js';
import { appendWithClient } from './audit.js';
import {
  createReportSnapshot,
  getReportSnapshot,
  hashReportSource,
  listReportSnapshots,
  type ReportSnapshotRecord,
} from './reporting.js';
import { getServerEurReport, type ServerEurReportResult } from './eurReport.js';
import { assertServerEurCashSource, assertServerEurProfile, listServerEurCashItems, type ServerEurCashItem } from './eurReport.js';
import { saveServerBankAccount, saveServerEurClassification, type ServerBankAccountRecord, type ServerEurClassificationRecord } from './proAccounting.js';
import { createPostgresAccountingSourceRunRepository, sourceEntries, type AccountingSourceRunRepository } from './accountingSourceRuns.js';
import { ACCOUNT_ROLE_DEFAULTS, accountRoleMappings, taxCaseAccount } from './taxAccounts.js';
import { DATEV_AUTOMATIC_ACCOUNTS } from './datevAutomaticAccounts.js';
import { usableAccountNumbers } from './tenantLedgerAccounts.js';
import { listAccountingPeriods, lockPeriodRow, reportingFiscalYear, reportingFiscalYearStart, setAccountingPeriodStatus, type AccountingPeriodRecord, type AccountingPeriodStatus, type AccountingPeriodStatusChange } from './accountingPeriods.js';

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const inTx = <T>(db: PostgresQueryable, work: (client: PostgresTransactionClient) => Promise<T>): Promise<T> =>
  runInTransaction(db, work, { serializable: true });
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

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

/** Canonical fiscal year calculation for double-entry posting. EÜR stays calendar-year. */
export const fiscalYearForPostingDate = (postingDate: string, fiscalYearStart = '01-01'): number =>
  fiscalYearForDate(postingDate, fiscalYearStart);

const snapshotPositions = (payload: unknown): Array<{ positionKey: string; positionLabel: string; amount: number; debitAmount: number; creditAmount: number; metadataJson: string }> => {
  if (!payload || typeof payload !== 'object') return [];
  const source = payload as { rows?: unknown[]; assets?: unknown[]; liabilities?: unknown[] };
  const rows = [
    ...(Array.isArray(source.rows) ? source.rows : []),
    ...(Array.isArray(source.assets) ? source.assets.map((row) => ({ ...(row as object), side: 'asset' })) : []),
    ...(Array.isArray(source.liabilities) ? source.liabilities.map((row) => ({ ...(row as object), side: 'liability' })) : []),
  ];
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const positionKey = String(row.positionKey ?? row.position ?? row.accountNumber ?? '').trim();
    if (!positionKey) return [];
    const amount = Number(row.amount ?? row.closingBalance ?? 0);
    const debitAmount = Number(row.debitAmount ?? row.debitTurnover ?? 0);
    const creditAmount = Number(row.creditAmount ?? row.creditTurnover ?? 0);
    return [{
      positionKey,
      positionLabel: String(row.positionLabel ?? row.label ?? row.position ?? row.accountNumber ?? positionKey),
      amount: Number.isFinite(amount) ? amount : 0,
      debitAmount: Number.isFinite(debitAmount) ? debitAmount : 0,
      creditAmount: Number.isFinite(creditAmount) ? creditAmount : 0,
      metadataJson: JSON.stringify({ accountRefs: row.accountRefs ?? row.accountNumbers ?? [], side: row.side }),
    }];
  });
};

type DatabaseReportType = 'bwa01' | 'guv' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';
type DatabaseReportFor<T extends DatabaseReportType> = T extends 'bwa01'
  ? ReportResult<Bwa01Report>
  : T extends 'hgb-guv'
    ? ReportResult<HgbGuvReport>
    : T extends 'hgb-bilanz'
      ? ReportResult<HgbBilanzReport>
      : ReportResult<ManagementGuvReport>;

const reportKindFor = (reportType: DatabaseReportType): ReportKind => reportType === 'guv' ? 'management-guv' : reportType;

const reportStatementFor = (reportType: string): ReportingMapping['statement'] | undefined => {
  switch (reportType) {
    case 'bwa01': return 'bwa01';
    case 'guv':
    case 'management-guv': return 'management-guv';
    case 'hgb-guv': return 'hgb-guv';
    case 'hgb-bilanz': return 'hgb-bilanz';
    default: return undefined;
  }
};

const reportProfile = async (db: PostgresQueryable, t: string, activeChart: 'SKR03' | 'SKR04', reportType: DatabaseReportType): Promise<ReportingCalculationProfile> => {
  const rows = await q<any>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [t]);
  if (!rows[0]) throw new Error('REPORTING_PROFILE_REQUIRED');
  const settings = parse<Record<string, unknown>>(rows[0]?.settings_json, {});
  const parsed = businessReportingProfileSchema.safeParse(settings.businessReportingProfile);
  if (!parsed.success) throw new Error('REPORTING_PROFILE_INVALID');
  const profile = parsed.data;
  if (profile.chart && profile.chart !== activeChart) throw new Error('REPORT_CHART_MISMATCH');
  const hgbReport = reportType === 'hgb-guv' || reportType === 'hgb-bilanz';
  const corporation = profile.legalForm === 'gmbh' || profile.legalForm === 'ug';
  // A GmbH/UG always balances; a sole proprietor, eK or GbR either files an EÜR or balances (§ 238 HGB / voluntarily).
  const supportedProfile = corporation ? profile.profitDetermination === 'double_entry' : true;
  if (!supportedProfile) throw new Error('REPORTING_PROFILE_REQUIRED');
  const fiscalYearStart = profile.profitDetermination === 'eur' ? '01-01' : profile.fiscalYearStart;
  // § 267 size classes apply to corporations; a balancing sole proprietor gets the short (Kleinst) layout.
  if (hgbReport && (profile.profitDetermination === 'eur' || (corporation && !profile.hgbSizeClass))) throw new Error('REPORTING_PROFILE_REQUIRED');
  const size = profile.hgbSizeClass ?? 'micro';
  return { size, fiscalYearStart, chart: activeChart, businessId: t };
};

const reportMappings = async (db: PostgresQueryable, scope: TenantScope, chart: 'SKR03' | 'SKR04', asOfDate?: string): Promise<ReportingMapping[]> => {
  const rows = await q<any>(db, `SELECT DISTINCT ON (account_number,report_type) account_number,report_type,position_key,position_label FROM report_account_mappings WHERE tenant_id=$1 AND chart=$2 AND (valid_from IS NULL OR valid_from <= COALESCE($3,CURRENT_DATE::text)) AND (valid_to IS NULL OR valid_to >= COALESCE($3,CURRENT_DATE::text)) ORDER BY account_number,report_type,valid_from DESC NULLS LAST,version DESC`, [tenant(scope), chart, asOfDate ?? null]);
  return rows.map((row): ReportingMapping | null => {
    const rawPosition = String(row.position_key);
    const explicitSide = rawPosition.match(/^(asset|liability):(.+)$/);
    const reportType = String(row.report_type);
    const statement = reportStatementFor(reportType);
    if (!statement) return null;
    const catalogSide: ReportingMapping['side'] = reportType === 'hgb-bilanz'
      ? rawPosition.startsWith('assets.') ? 'asset' : /^(equity|provisions|liabilities|deferred-income)(?:\.|$)/.test(rawPosition) ? 'liability' : undefined
      : undefined;
    const side: ReportingMapping['side'] = explicitSide?.[1] === 'asset' || explicitSide?.[1] === 'liability' ? explicitSide[1] : catalogSide;
    return {
      accountNumber: String(row.account_number),
      statement,
      position: explicitSide?.[2] ?? rawPosition,
      label: String(row.position_label ?? row.position_key),
      ...(reportType === 'hgb-bilanz' && side ? { side } : {}),
    };
  }).filter((mapping): mapping is ReportingMapping => mapping !== null);
};

const eurBalanceAccounts = async (db: PostgresQueryable, scope: TenantScope, chart: 'SKR03' | 'SKR04', reportType: string): Promise<Set<string>> => {
  if (reportType !== 'bwa01' && reportType !== 'management-guv') return new Set();
  const row = (await q<any>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1`, [tenant(scope)]))[0];
  if (parse<any>(row?.settings_json, {}).businessReportingProfile?.profitDetermination !== 'eur') return new Set();
  const roles = await mappings(db, tenant(scope), chart);
  const accounts = new Set(['accounts_receivable', 'accounts_payable', 'bank', 'asset', 'output_vat', 'output_vat_deferred', 'input_vat', 'output_vat_7', 'output_vat_deferred_7', 'input_vat_7', 'customer_advances', 'customer_advances_7'].map((role) => roles[role]));
  const taxAccounts = await q<any>(db, `SELECT account_number FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=$2 AND role IN ('output_tax','input_tax')`, [tenant(scope), chart]);
  for (const row of taxAccounts) accounts.add(String(row.account_number));
  return accounts;
};

/**
 * Reports, balances and the DATEV stack read the running journal: balances
 * carry over from all earlier entries. Year-end close (Erfolgskonten → Ergebnis)
 * and carry-forward (Saldovortrag) entries are bookkeeping of the closing
 * itself; counting them would zero the closed year's result and count the
 * opening balances twice.
 */
const RUNNING_JOURNAL = `COALESCE(je.source_type,'') NOT IN ('fiscal_close','carry_forward')`;

/**
 * Erfolgskonten open every fiscal year at 0. Opening balances are split at the start of the fiscal year of
 * `from`: before it, a booked close of an earlier year counts (it moved that year's Erfolgskonten onto the
 * result account); what an unclosed earlier year leaves on Erfolgskonten is carried on the default result account.
 * `$yearStart` is the SQL parameter of that date; lines of the opening columns are `opening_prior` / `opening_year`.
 */
const yearOpeningJournal = (yearStart: string) => `(${RUNNING_JOURNAL} OR (je.source_type='fiscal_close' AND ${yearStart}::text IS NOT NULL AND je.posting_date < ${yearStart}))`;
const yearStartOf = async (db: PostgresQueryable, t: string, from: string | undefined): Promise<string | null> => {
  if (!from) return null;
  const start = await reportingFiscalYearStart(db, t);
  return fiscalYearRange(fiscalYearForDate(from, start), start).start;
};
const foldYearOpening = async <R extends { account_number: unknown; opening_prior: unknown; opening_year: unknown }>(db: PostgresQueryable, t: string, chart: 'SKR03' | 'SKR04', rows: R[], blank: (accountNumber: string) => R): Promise<Array<R & { opening_balance: number }>> => {
  let carriedCents = 0;
  const out = rows.map((row) => {
    const prior = Math.round(Number(row.opening_prior) * 100);
    const pnl = isProfitAndLossAccount(chart, String(row.account_number));
    if (pnl) carriedCents += prior;
    return { ...row, opening_balance: ((pnl ? 0 : prior) + Math.round(Number(row.opening_year) * 100)) / 100 };
  });
  if (!carriedCents) return out;
  const settings = parse<any>((await q<any>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [t]))[0]?.settings_json, {});
  const resultAccount = defaultResultAccount(chart, settings.businessReportingProfile?.legalForm);
  const target = out.find((row) => String(row.account_number) === resultAccount) ?? (() => { const row = { ...blank(resultAccount), opening_balance: 0 }; out.push(row); return row; })();
  target.opening_balance = (Math.round(target.opening_balance * 100) + carriedCents) / 100;
  return out.sort((a, b) => String(a.account_number).localeCompare(String(b.account_number)));
};

/** DATEV Personenkonten: Debitoren from 1·10^L, Kreditoren from 7·10^L (L = Sachkontenlänge), numbered per OPOS party. */
const DATEV_PARTY_BASE = { debtor: 1, creditor: 7 } as const;
const DATEV_PARTY_CAPACITY = { debtor: 6, creditor: 3 } as const;
const datevPartyAccount = (type: 'debtor' | 'creditor', ordinal: number, length: number) => {
  if (ordinal >= DATEV_PARTY_CAPACITY[type] * 10 ** length) throw new Error(`DATEV_PARTY_RANGE_EXHAUSTED: Für ${type === 'debtor' ? 'Debitoren' : 'Kreditoren'} reicht der Nummernkreis bei Sachkontenlänge ${length} nicht.`);
  return String(DATEV_PARTY_BASE[type] * 10 ** length + ordinal);
};

/** Numbers every OPOS party that has none yet, in the order it first appeared. A number, once given, never changes. */
const assignDatevPartyAccounts = (db: PostgresQueryable, t: string) => inTx(db, async (tx) => {
  for (const type of ['debtor', 'creditor'] as const) {
    await q(tx, `INSERT INTO datev_party_accounts (tenant_id,party_type,party_id,ordinal,created_at)
      SELECT $1,$2,p.party_id,COALESCE((SELECT MAX(ordinal) FROM datev_party_accounts WHERE tenant_id=$1 AND party_type=$2),0) + ROW_NUMBER() OVER (ORDER BY p.first_at,p.party_id),$3
      FROM (SELECT party_id,MIN(created_at) first_at FROM (
        SELECT party_id,created_at FROM open_items WHERE tenant_id=$1 AND party_type=$2
        UNION ALL SELECT party_id,created_at FROM open_item_payments WHERE tenant_id=$1 AND party_type=$2) x
        WHERE COALESCE(party_id,'')<>'' GROUP BY party_id) p
      WHERE NOT EXISTS (SELECT 1 FROM datev_party_accounts d WHERE d.tenant_id=$1 AND d.party_type=$2 AND d.party_id=p.party_id)`, [t, type, now()]);
  }
});

/** The Personenkonto per entry and party type, when the entry (or the entry it reverses) belongs to exactly one party of that type. */
const datevEntryPartyAccounts = async (db: PostgresQueryable, t: string, entryIds: string[], length: number) => {
  const originals = await q<{ id: string; reversed_entry_id: string }>(db, `SELECT id,reversed_entry_id FROM journal_entries WHERE tenant_id=$1 AND reversed_entry_id = ANY($2::text[])`, [t, entryIds]);
  const ownerOf = new Map<string, string[]>(entryIds.map((id) => [id, [id]]));
  for (const original of originals) ownerOf.get(original.reversed_entry_id)?.push(original.id);
  const sources = [...new Set([...ownerOf.values()].flat())];
  const parties = await q<{ entry_id: string; party_type: 'debtor' | 'creditor'; ordinal: number }>(db, `
    SELECT x.entry_id,x.party_type,d.ordinal FROM (
      SELECT journal_entry_id entry_id,party_type,party_id FROM open_items WHERE tenant_id=$1 AND journal_entry_id = ANY($2::text[])
      UNION SELECT journal_entry_id,party_type,party_id FROM open_item_payments WHERE tenant_id=$1 AND journal_entry_id = ANY($2::text[])) x
    JOIN datev_party_accounts d ON d.tenant_id=$1 AND d.party_type=x.party_type AND d.party_id=x.party_id`, [t, sources]);
  const result = new Map<string, { debtor?: string; creditor?: string }>();
  for (const [entryId, owners] of ownerOf) {
    const found: { debtor?: string; creditor?: string } = {};
    for (const type of ['debtor', 'creditor'] as const) {
      const ordinals = [...new Set(parties.filter((party) => owners.includes(party.entry_id) && party.party_type === type).map((party) => Number(party.ordinal)))];
      if (ordinals.length === 1) found[type] = datevPartyAccount(type, ordinals[0]!, length);
    }
    if (found.debtor || found.creditor) result.set(entryId, found);
  }
  return result;
};

const calculateDatabaseReport = async <T extends DatabaseReportType>(db: PostgresQueryable, scope: TenantScope, reportType: T, args: { from?: string; to?: string; asOfDate?: string; chart?: 'SKR03' | 'SKR04' }): Promise<DatabaseReportFor<T>> => {
  const p = await policy(db, tenant(scope));
  if (args.chart && args.chart !== p.activeChart) throw new Error('REPORT_CHART_MISMATCH');
  const fromDate = args.from;
  const toDate = args.to ?? args.asOfDate;
  const reportTo = toDate ?? (reportType === 'hgb-bilanz' ? undefined : now().slice(0, 10));
  const chart = args.chart ?? p.activeChart;
  const balanceProfile = reportType === 'hgb-bilanz' ? await reportProfile(db, tenant(scope), chart, reportType) : undefined;
  const ledgerFromDate = reportType === 'hgb-bilanz' && !fromDate && reportTo && balanceProfile
    ? fiscalYearRange(fiscalYearForDate(reportTo, balanceProfile.fiscalYearStart), balanceProfile.fiscalYearStart).start
    : fromDate;
  const yearStart = await yearStartOf(db, tenant(scope), ledgerFromDate);
  const queriedBalances = await foldYearOpening(db, tenant(scope), chart, await q<any>(db, `SELECT jl.account_number,COALESCE(SUM(CASE WHEN $4::text IS NOT NULL AND je.posting_date < $4 THEN jl.debit_amount-jl.credit_amount ELSE 0 END),0) opening_prior,COALESCE(SUM(CASE WHEN $3::text IS NOT NULL AND je.posting_date < $3 AND ($4::text IS NULL OR je.posting_date >= $4) THEN jl.debit_amount-jl.credit_amount ELSE 0 END),0) opening_year,COALESCE(SUM(CASE WHEN $3::text IS NULL OR je.posting_date >= $3 THEN jl.debit_amount ELSE 0 END),0) debit_turnover,COALESCE(SUM(CASE WHEN $3::text IS NULL OR je.posting_date >= $3 THEN jl.credit_amount ELSE 0 END),0) credit_turnover FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${yearOpeningJournal('$4')} AND ($2::text IS NULL OR je.posting_date <= $2) GROUP BY jl.account_number ORDER BY jl.account_number`, [tenant(scope), reportTo ?? null, ledgerFromDate ?? null, yearStart]), (accountNumber) => ({ account_number: accountNumber, opening_prior: 0, opening_year: 0, debit_turnover: 0, credit_turnover: 0 }));
  const profile = balanceProfile ?? await reportProfile(db, tenant(scope), chart, reportType);
  const mappings = await reportMappings(db, scope, chart, reportTo);
  const excluded = await eurBalanceAccounts(db, scope, chart, reportType);
  // GuV/Bilanz/BWA positions by account range for every account the tenant has not mapped itself (never stored).
  const explicit = new Set(mappings.flatMap((mapping) => [mapping.statement].flat().map((statement) => `${mapping.accountNumber}:${statement}`)));
  const defaults = defaultReportMappings(chart, queriedBalances.map((row) => String(row.account_number)), profile.size, reportTo ?? args.asOfDate ?? now().slice(0, 10), (account, statement) => explicit.has(`${account}:${statement}`), reportType === 'bwa01' ? 'bwa01' : 'hgb-guv');
  const result = calculateReport({ kind: reportKindFor(reportType), profile, ledger: { balances: queriedBalances.filter((row) => !excluded.has(String(row.account_number))).map((row) => ({ accountNumber: String(row.account_number), openingBalance: Number(row.opening_balance), debitTurnover: Number(row.debit_turnover), creditTurnover: Number(row.credit_turnover), closingBalance: Number(row.opening_balance) + Number(row.debit_turnover) - Number(row.credit_turnover) })) }, mappings: [...mappings, ...defaults], from: ledgerFromDate, to: reportTo, asOfDate: args.asOfDate ?? reportTo }) as DatabaseReportFor<T>;
  const used = defaults.filter((mapping) => !excluded.has(mapping.accountNumber) && (reportType === 'hgb-bilanz' || reportType === 'hgb-guv' || mapping.statement === 'hgb-bilanz' || mapping.statement === 'bwa01'));
  if (!used.length) return result;
  const health = (result as { mappingHealth: { inferredAccounts: number; warnings: string[] } }).mappingHealth;
  return { ...result, mappingHealth: { ...health, inferredAccounts: used.length, warnings: [...health.warnings, `Standardzuordnung nach Kontenbereich (${chart}): ${used.map((mapping) => mapping.accountNumber).sort().join(', ')}`] } } as DatabaseReportFor<T>;
};

type ReportMappingType = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';

const validateReportMappingPosition = async (db: PostgresQueryable, scope: TenantScope, input: { chart: 'SKR03' | 'SKR04'; statementType: ReportMappingType; positionKey: string; balanceSide?: 'asset' | 'liability'; asOfDate: string }): Promise<void> => {
  const p = await policy(db, tenant(scope));
  if (input.chart !== p.activeChart) throw new Error('REPORT_CHART_MISMATCH');
  const profile = await reportProfile(db, tenant(scope), input.chart, input.statementType);
  const catalogPosition = listReportMappingPositions(input.statementType, profile.size, input.asOfDate)
    .find((entry) => entry.key === input.positionKey);
  if (!catalogPosition) throw new Error('REPORT_POSITION_INVALID');
  if (input.balanceSide && catalogPosition.side && input.balanceSide !== catalogPosition.side) throw new Error('REPORT_POSITION_INVALID');
  const result = calculateReport({
    kind: input.statementType,
    profile,
    ledger: { balances: [{ accountNumber: '__mapping_validation__', debitTurnover: 0, creditTurnover: 0, openingBalance: 0, closingBalance: 0 }] },
    mappings: [{ accountNumber: '__mapping_validation__', statement: input.statementType, position: input.positionKey, side: input.balanceSide, label: input.positionKey }],
    to: input.asOfDate,
    asOfDate: input.asOfDate,
  });
  // An unknown position is distinguishable by the validation account being
  // reported as unmapped. The canonical catalog is owned by accounting-engine.
  if (result.mappingHealth.unmappedAccounts.includes('__mapping_validation__')) throw new Error('REPORT_POSITION_INVALID');
};

export const normalizeDatevBuKey = (value: unknown): string | undefined => {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.padStart(4, '0') : undefined;
};
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
  evidenceReference: row.evidence_reference ?? undefined, datevSachverhaltLl: row.datev_sachverhalt_ll ?? undefined, costCenter: row.cost_center ?? undefined, memo: row.memo ?? undefined,
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
    lines: value.lines && issues.some((item) => item.code === 'DUPLICATE_LINE_ID') ? value.lines : lines.map((line) => ({ id: line.id, accountNumber: line.account_number, debitAmount: Number(line.debit_amount || 0), creditAmount: Number(line.credit_amount || 0), taxCode: line.tax_code ?? undefined, taxCaseKey: line.tax_case_key ?? undefined, taxRate: line.tax_rate == null ? undefined : Number(line.tax_rate), netAmount: line.net_amount == null ? undefined : Number(line.net_amount), taxAmount: line.tax_amount == null ? undefined : Number(line.tax_amount), grossAmount: line.gross_amount == null ? undefined : Number(line.gross_amount), countryCode: line.country_code ?? undefined, counterpartyVatId: line.counterparty_vat_id ?? undefined, evidenceType: line.evidence_type ?? undefined, evidenceReference: line.evidence_reference ?? undefined, datevSachverhaltLl: line.datev_sachverhalt_ll ?? undefined, costCenter: line.cost_center ?? undefined, memo: line.memo ?? undefined })),
    validationIssues: issues.map((item) => parse<ValidationIssue>(item.issue_json, { id: item.id, code: item.code, severity: item.severity, message: item.message, fieldPath: item.field_path ?? undefined, blocking: Boolean(item.blocking), source: item.source })), updatedAt: row.updated_at,
    ...(value.exceptionCase ? { exceptionCase: value.exceptionCase } : {}),
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
const ensurePeriod = async (db: PostgresQueryable, scope: TenantScope, key: string, postingDate?: string): Promise<string> => {
  const t = tenant(scope);
  const year = postingDate && isoDate(postingDate) ? await reportingFiscalYear(db, t, postingDate) : Number(key.slice(0, 4));
  const row = await lockPeriodRow(db, t, key, year);
  // The fiscal year of a month follows the reporting profile (a changed fiscal-year start). Never silently: audited, and never on a closed month.
  if (row.status !== 'closed' && postingDate && isoDate(postingDate) && row.fiscalYear !== year) {
    await q(db, `UPDATE accounting_periods SET fiscal_year=$1,updated_at=$2 WHERE tenant_id=$3 AND period=$4`, [year, now(), t, key]);
    await audit(db as PostgresTransactionClient, scope, 'accounting_period', key, 'fiscal_year_change', 'Geschäftsjahr des Monats nach geändertem Wirtschaftsjahresbeginn angepasst', { fiscalYear: row.fiscalYear }, { fiscalYear: year });
  }
  return row.status;
};
const policy = async (db: PostgresQueryable, t: string): Promise<{ activeChart: 'SKR03'|'SKR04'; vatMethod: 'soll'|'ist'; periodPolicy: 'calendar_month'; updatedAt: string; tenantId: string }> => {
  const rows = await q<any>(db, `SELECT * FROM accounting_policies WHERE tenant_id=$1`, [t]); const row = rows[0];
  return { tenantId: t, activeChart: row?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03', vatMethod: row?.vat_method === 'ist' ? 'ist' : 'soll', periodPolicy: 'calendar_month', updatedAt: row?.updated_at ?? '' };
};
const defaults = ACCOUNT_ROLE_DEFAULTS;
const mappings = accountRoleMappings;
// The tax account resolver lives in taxAccounts.ts; re-exported for the bank draft path (taxCaseAccount(db, t, chart, case, role, fallback, date)).
export { taxCaseAccount };
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
// Fail closed: without a catalogue for the chart no account exists; a deactivated tenant account does not either.
const accountExists = async (db: PostgresQueryable, chart: string, account: string, tenantId: string): Promise<boolean> => (await usableAccountNumbers(db, tenantId, chart, [account])).has(account);
/**
 * A line keyed with an automatic tax case (standard VAT above 0 %, no destination country) carries the gross amount;
 * it books the net on its own account and the tax on the case's VAT account (taxCaseAccount). Other cases return
 * undefined. `skipAccounts`: a tax account already in the entry means the user split it by hand.
 */
const automaticTaxSplit = async (db: PostgresQueryable, t: string, chart: 'SKR03'|'SKR04', line: JournalLineEntity, date: string, skipAccounts: ReadonlySet<string> = new Set()): Promise<JournalLineEntity[] | undefined> => {
  if (!line.taxCaseKey) return undefined;
  const taxCase = (await q<any>(db, `SELECT mechanism,default_rate,requires_country,active FROM tax_cases WHERE key=$1`, [line.taxCaseKey]))[0];
  const rate = Number(taxCase?.default_rate ?? 0);
  if (!taxCase || !taxCase.active || taxCase.mechanism !== 'standard_vat' || !(rate > 0) || taxCase.requires_country) return undefined;
  const debit = cents(line.debitAmount) ?? 0; const credit = cents(line.creditAmount) ?? 0;
  const debitSide = debit > 0; const gross = debitSide ? debit : credit;
  const net = Math.round(gross * 100 / (100 + rate)); const tax = gross - net;
  const m = await mappings(db, t, chart);
  // 7 % Vorsteuer/Umsatzsteuer have their own accounts (SKR03 1571/1771, SKR04 1401/3801): taxCaseAccount knows them.
  const taxAccount = debitSide
    ? await taxCaseAccount(db, t, chart, line.taxCaseKey, 'input_tax', m.input_vat!, date)
    : await taxCaseAccount(db, t, chart, line.taxCaseKey, 'output_tax', m.output_vat!, date);
  if (skipAccounts.has(taxAccount)) return undefined;
  if (!(await accountExists(db, chart, taxAccount, t))) throw new Error(`UNKNOWN_ACCOUNT:${taxAccount} (Steuerkonto) ist im Kontenrahmen ${chart} nicht vorhanden.`);
  return [
    { ...line, debitAmount: debitSide ? net / 100 : 0, creditAmount: debitSide ? 0 : net / 100, taxRate: rate, netAmount: net / 100, taxAmount: tax / 100, grossAmount: gross / 100 },
    ...(tax > 0 ? [{ id: randomUUID(), accountNumber: taxAccount, debitAmount: debitSide ? tax / 100 : 0, creditAmount: debitSide ? 0 : tax / 100, memo: `${debitSide ? 'Vorsteuer' : 'USt'} ${line.taxCaseKey}` }] : []),
  ];
};
/** The lines a bank draft posts: a gross line with a tax case is split; the bank line and lines with their own tax figures stay. */
const draftPostingLines = async (db: PostgresQueryable, t: string, chart: 'SKR03'|'SKR04', lines: JournalLineEntity[], date: string, bankAccount: string): Promise<JournalLineEntity[]> => {
  const booked = new Set(lines.map((line) => line.accountNumber));
  const out: JournalLineEntity[] = [];
  for (const line of lines) out.push(...(line.accountNumber === bankAccount || line.taxAmount != null ? undefined : await automaticTaxSplit(db, t, chart, line, date, booked)) ?? [line]);
  return out;
};
type DraftBankLine = { account_id: unknown; amount: unknown; type: string };
/** The money of a bank line moved on its bank account: the draft books exactly that amount there, on that side. */
const bankLineIssue = async (db: PostgresQueryable, t: string, draft: BookingDraftEntity, bank: DraftBankLine): Promise<ValidationIssue | undefined> => {
  const account = await bankLedgerAccount(db, t, bank.account_id);
  const amount = Math.abs(cents(bank.amount) ?? 0);
  const expected = bank.type === 'income' ? amount : -amount;
  const booked = draft.lines.filter((line) => line.accountNumber === account).reduce((sum, line) => sum + (cents(line.debitAmount) ?? 0) - (cents(line.creditAmount) ?? 0), 0);
  if (booked === expected) return undefined;
  const euro = (amount / 100).toFixed(2).replace('.', ',');
  return issue('BANK_LINE_MISMATCH', `Die Bankzeile muss ${euro} € im ${bank.type === 'income' ? 'Soll' : 'Haben'} auf dem Konto ${account} des Bankkontos buchen.`, 'lines');
};
/** The customer or vendor of an open item, for booking texts. */
const openItemPartnerName = async (db: PostgresQueryable, t: string, item: { source_type: string; source_id: string }): Promise<string | undefined> => {
  if (item.source_type === 'outgoing_invoice') return (await q<any>(db, `SELECT client FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, item.source_id]))[0]?.client || undefined;
  if (item.source_type === 'incoming_invoice') return (await q<any>(db, `SELECT v.name FROM incoming_invoices i JOIN vendors v ON v.tenant_id=i.tenant_id AND v.id=i.vendor_id WHERE i.tenant_id=$1 AND i.id=$2`, [t, item.source_id]))[0]?.name || undefined;
  return undefined;
};
/** A bank line that pays an open item of its side: the document number in the purpose, or exactly the residual of that customer/vendor (by name). */
/**
 * The tax case a partner's bank bookings on this account carried so far, when it is one and the same every time.
 * A suggested draft takes it over, so a batch posting splits Vorsteuer/USt like a hand-made one; an unknown or mixed
 * history leaves the line without a tax case and the batch skips it instead of booking the gross amount.
 */
const partnerTaxCase = async (db: PostgresQueryable, t: string, counterparty: string, accountNumber: string): Promise<TaxCaseKey | undefined> => {
  const rows = await q<{ k: string }>(db, `SELECT DISTINCT COALESCE(jl.tax_case_key,'') AS k FROM journal_entries je JOIN booking_drafts bd ON bd.id=je.source_draft_id AND bd.tenant_id=je.tenant_id JOIN bank_transactions bt ON bt.id=bd.transaction_id AND bt.tenant_id=bd.tenant_id JOIN journal_lines jl ON jl.entry_id=je.id AND jl.tenant_id=je.tenant_id WHERE je.tenant_id=$1 AND je.status='posted' AND lower(trim(bt.counterparty))=lower(trim($2)) AND jl.account_number=$3`, [t, counterparty, accountNumber]);
  return rows.length === 1 && rows[0]!.k ? rows[0]!.k as TaxCaseKey : undefined;
};
const paysOpenItem = async (db: PostgresQueryable, t: string, row: { type: string; amount: unknown; counterparty?: string | null; purpose?: string | null }): Promise<boolean> => (await q<any>(db,
  `SELECT 1 FROM open_items oi
     LEFT JOIN invoices i ON i.tenant_id=oi.tenant_id AND oi.source_type='outgoing_invoice' AND i.id=oi.source_id
     LEFT JOIN incoming_invoices ii ON ii.tenant_id=oi.tenant_id AND oi.source_type='incoming_invoice' AND ii.id=oi.source_id
     LEFT JOIN vendors v ON v.tenant_id=oi.tenant_id AND v.id=ii.vendor_id
    WHERE oi.tenant_id=$1 AND oi.party_type=$2 AND oi.status IN ('open','partially_paid') AND oi.residual_amount>0
      AND ((COALESCE(oi.document_number,'')<>'' AND position(lower(oi.document_number) in lower($3))>0)
        OR (oi.residual_amount=$4 AND lower(btrim($5)) IN (lower(oi.party_id), lower(COALESCE(i.client,'')), lower(COALESCE(v.name,''))))) LIMIT 1`,
  [t, row.type === 'income' ? 'debtor' : 'creditor', row.purpose ?? '', round(Math.abs(Number(row.amount))), row.counterparty ?? ''])).length > 0;
const validateDraft = async (db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, periodStatus: string, chart: 'SKR03'|'SKR04', bank?: DraftBankLine): Promise<ValidationIssue[]> => {
  const out: ValidationIssue[] = []; const debit = draft.lines.reduce((sum, l) => sum + (cents(l.debitAmount) ?? 0), 0); const credit = draft.lines.reduce((sum, l) => sum + (cents(l.creditAmount) ?? 0), 0);
  if (!isoDate(draft.postingDate)) out.push(issue('INVALID_POSTING_DATE', 'Buchungsdatum ist ungültig.', 'postingDate'));
  else if (draft.period !== period(draft.postingDate) || draft.fiscalYear !== await reportingFiscalYear(db, tenant(scope), draft.postingDate)) out.push(issue('POSTING_PERIOD_MISMATCH', 'Periode und Geschäftsjahr müssen zum Buchungsdatum passen.', 'period'));
  if (!isoDate(draft.documentDate ?? draft.postingDate)) out.push(issue('INVALID_DOCUMENT_DATE', 'Belegdatum ist ungültig.', 'documentDate'));
  if (debit !== credit || debit <= 0) out.push(issue('UNBALANCED_ENTRY', 'Soll und Haben sind nicht ausgeglichen.'));
  if (draft.lines.length < 2) out.push(issue('MISSING_ACCOUNT', 'Mindestens zwei Buchungszeilen sind erforderlich.'));
  const ids = new Set<string>();
  for (const [index, line] of draft.lines.entries()) {
    if (!line.accountNumber) out.push(issue('MISSING_ACCOUNT', 'Sachkonto fehlt.', `lines[${index}].accountNumber`));
    if (ids.has(line.id)) out.push(issue('DUPLICATE_LINE_ID', 'Buchungszeilen müssen eindeutige IDs haben.', `lines[${index}].id`)); ids.add(line.id);
    const d = cents(line.debitAmount); const c = cents(line.creditAmount);
    if (d === null || c === null || d < 0 || c < 0 || (d > 0) === (c > 0)) out.push(issue('INVALID_LINE_AMOUNT', 'Beträge müssen Centbeträge mit genau einer Seite sein.', `lines[${index}]`));
    if (line.accountNumber && !(await accountExists(db, chart, line.accountNumber, tenant(scope)))) out.push(issue('UNKNOWN_ACCOUNT', `Sachkonto ${line.accountNumber} ist im Kontenrahmen nicht vorhanden.`, `lines[${index}].accountNumber`));
  }
  if (bank) { const mismatch = await bankLineIssue(db, tenant(scope), draft, bank); if (mismatch) out.push(mismatch); }
  if (bank) {
    // A payment on the receivable or payable settles an open item; booked as a free draft the ledger would say paid while OPOS stays open.
    const m = await mappings(db, tenant(scope), chart);
    const control = draft.lines.find((line) => line.accountNumber === m.accounts_receivable || line.accountNumber === m.accounts_payable);
    if (control) out.push(issue('OPEN_ITEM_ACCOUNT_IN_DRAFT', `Eine Zahlung auf ${control.accountNumber === m.accounts_receivable ? 'Forderungen' : 'Verbindlichkeiten'} (${control.accountNumber}) gleicht einen offenen Posten aus. Buchen Sie sie über „In Offene Posten ausgleichen“.`, 'lines'));
  }
  if (periodStatus === 'closed') out.push(issue('POSTING_DATE_IN_CLOSED_PERIOD', 'Periode ist geschlossen.'));
  out.push(...await validateJournalLineDatevEvidence(db, draft.lines));
  return out;
};
const saveDraftTarget = async (db: PostgresQueryable, scope: TenantScope, draft: BookingDraftEntity, mutation?: AccountingMutationContext): Promise<BookingDraftEntity> => {
  const draftMutation = mutation ?? (draft as BookingDraftEntity & { mutation?: AccountingMutationContext }).mutation;
  const { mutation: _ignoredMutation, ...draftData } = draft as BookingDraftEntity & { mutation?: AccountingMutationContext };
  const existing = (await q<any>(db, `SELECT workflow_status,draft_json FROM booking_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), draft.id]))[0];
  if (existing?.workflow_status === 'posted') throw Object.assign(new Error('POSTED_DRAFT_IMMUTABLE'), { statusCode: 409 });
  // The Ausnahme belongs to the bank line, not to the Kontierung a save sends: a save without it keeps the stored one.
  const keptException = draftData.exceptionCase ?? parse<Partial<BookingDraftEntity>>(existing?.draft_json, {}).exceptionCase;
  if (keptException) draftData.exceptionCase = keptException;
  const t = tenant(scope); const transactionOwner = (await q<any>(db, `SELECT tenant_id,account_id,amount,type FROM bank_transactions WHERE id=$1`, [draft.transactionId]))[0]; if (!transactionOwner || transactionOwner.tenant_id !== t) throw new Error('BANK_TRANSACTION_NOT_FOUND: Ein Buchungsentwurf gehört zu einer Bankzeile; ohne Bankzeile ist es eine freie Buchung mit Beleg.'); const foreignDraft = (await q<any>(db, `SELECT tenant_id FROM booking_drafts WHERE id=$1 AND tenant_id<>$2`, [draft.id, t]))[0]; if (foreignDraft) throw new Error('DRAFT_NOT_FOUND'); const p = await policy(db, t); const postingDate = draft.postingDate ?? now().slice(0, 10); const normalized = { ...draftData, tenantId: t, lines: (draft.lines ?? []).map((line, i) => ({ ...line, id: line.id || `${draft.id}-${i + 1}`, debitAmount: round(line.debitAmount), creditAmount: round(line.creditAmount) })), period: draft.period || period(postingDate), fiscalYear: isoDate(postingDate) ? await reportingFiscalYear(db, t, postingDate) : draft.fiscalYear || Number((draft.period || period(postingDate)).slice(0, 4)), updatedAt: now() };
  const periodStatus = await ensurePeriod(db, scope, normalized.period, isoDate(postingDate) ? postingDate : undefined); normalized.validationIssues = await validateDraft(db, scope, normalized, periodStatus, p.activeChart, transactionOwner); normalized.workflowStatus = normalized.validationIssues.some((x) => x.blocking) ? periodStatus === 'closed' ? 'period_locked' : 'incomplete' : normalized.workflowStatus;
  await q(db, `INSERT INTO booking_drafts (id,tenant_id,transaction_id,workflow_status,draft_json,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id,workflow_status=EXCLUDED.workflow_status,draft_json=EXCLUDED.draft_json,updated_at=EXCLUDED.updated_at`, [normalized.id, t, normalized.transactionId, normalized.workflowStatus, JSON.stringify(normalized), normalized.updatedAt]);
  await q(db, `DELETE FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2`, [t, normalized.id]); await q(db, `DELETE FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [t, normalized.id]);
  for (const [index, line] of normalized.lines.entries()) { if (normalized.lines.findIndex((candidate) => candidate.id === line.id) !== index) continue; await q(db, `INSERT INTO booking_draft_lines (id,tenant_id,draft_id,line_no,account_number,debit_amount,credit_amount,tax_code,tax_case_key,tax_rate,net_amount,tax_amount,gross_amount,country_code,counterparty_vat_id,evidence_type,evidence_reference,datev_sachverhalt_ll,cost_center,memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [line.id, t, normalized.id, index + 1, line.accountNumber, line.debitAmount, line.creditAmount, line.taxCode ?? null, line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.datevSachverhaltLl ?? null, line.costCenter ?? null, line.memo ?? null]); }
  for (const item of normalized.validationIssues) await q(db, `INSERT INTO draft_validation_issues (id,tenant_id,draft_id,code,severity,message,field_path,blocking,source,issue_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [item.id, t, normalized.id, item.code, item.severity, item.message, item.fieldPath ?? null, item.blocking, item.source, JSON.stringify(item), normalized.updatedAt]);
  await audit(db as PostgresTransactionClient, scope, 'booking_draft', normalized.id, 'save', 'Booking draft changed', null, { transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus }, draftMutation);
  return normalized;
};

type DatevVatAccount = { rate: number; flow: 'income' | 'expense' };
type DatevPair = { amount: number; debit: string; credit: string; debitRate?: number; creditRate?: number; bu?: string; euLandUstId?: string; euSteuersatz?: number; sachverhaltLl?: string };
/** The VAT rate a journal line carries: its tax case (DE_STD_19/DE_STD_7), else the rate on the line. */
const datevLineRate = (taxCaseKey: unknown, rate: unknown): number | undefined => taxCaseKey === 'DE_STD_19' ? 19 : taxCaseKey === 'DE_STD_7' ? 7 : rate == null || rate === '' ? undefined : Number(rate);
/** DATEV Belegfeld 1: at most 36 characters of a-z, A-Z, 0-9 and $&%*+-/; anything else becomes a hyphen. */
const datevBelegfeld = (value: unknown): string => String(value ?? '').trim().replace(/[^\w$&%*+\-/]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
/** DATEV Buchungstext: one line of at most 60 characters; a longer text is cut, not the whole export refused. */
const datevText = (value: unknown): string => { const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); return text.length > 60 ? `${text.slice(0, 59)}…` : text; };
const DATEV_BU_KEY: Record<DatevVatAccount['flow'], Record<number, string>> = { income: { 19: '0003', 7: '0002' }, expense: { 19: '0009', 7: '0008' } };
/** BU-Schlüssel 40: Berichtigungsschlüssel 4 = Aufhebung der Automatik (DATEV Kontenrahmen, Hinweis zum Berichtigungsschlüssel 4). */
const DATEV_AUTOMATIC_OFF = '0040';
/**
 * One DATEV row per Geschäftsvorfall and rate instead of a net row plus a VAT row: DATEV computes the VAT itself from a
 * gross amount on an Automatikkonto (8400, 3400, 8736, …) or from a BU-Schlüssel on any other account, so a separate
 * row on 1776/1576 would book the tax twice. A VAT pair (due USt/VSt 19 % or 7 %, the role accounts) folds into the
 * pair of the same entry that shares its other account and carries that rate; with several such pairs the tax is
 * split by their amounts. The folded row is gross: without BU on an Automatikkonto of that rate, else with BU 3/2
 * (USt) or 9/8 (VSt) like the Lite export (a tenant's datev_bu mapping wins). Pairs that cannot fold (not-yet-due
 * VAT under Ist, § 13b and Erwerb, an Automatikkonto of another rate) stay as booked, and an Automatikkonto with a
 * rate on such a row gets BU 40 so DATEV adds no VAT of its own.
 */
const collapseDatevPairs = (pairs: DatevPair[], vat: Map<string, DatevVatAccount>, automatic: Readonly<Record<string, number>>): DatevPair[] => {
  const rows = pairs.map((pair) => ({ ...pair }));
  const dropped = new Set<number>(); const folded = new Set<number>();
  rows.forEach((tax, index) => {
    const onCredit = vat.get(tax.credit); const onDebit = vat.get(tax.debit);
    if (Boolean(onCredit) === Boolean(onDebit)) return;
    const account = (onCredit ?? onDebit)!; const side = onCredit ? 'credit' : 'debit';
    const other = side === 'credit' ? tax.debit : tax.credit;
    const candidates = rows.map((pair, at) => ({ pair, at })).filter(({ pair, at }) => at !== index && !dropped.has(at) && (side === 'credit' ? pair.debit === other && !vat.has(pair.credit) : pair.credit === other && !vat.has(pair.debit)));
    const atRate = candidates.filter(({ pair }) => (side === 'credit' ? pair.creditRate : pair.debitRate) === account.rate);
    const bases = atRate.length ? atRate : candidates.length === 1 ? candidates : [];
    if (!bases.length) return;
    const baseAccount = (pair: DatevPair) => side === 'credit' ? pair.credit : pair.debit;
    if (bases.some(({ pair }) => automatic[baseAccount(pair)] !== undefined && automatic[baseAccount(pair)] !== account.rate)) return;
    const total = bases.reduce((sum, { pair }) => sum + Math.round(pair.amount * 100), 0);
    let rest = Math.round(tax.amount * 100);
    bases.forEach(({ pair, at }, position) => {
      const share = position === bases.length - 1 ? rest : Math.round(Math.round(tax.amount * 100) * Math.round(pair.amount * 100) / total);
      rest -= share;
      pair.amount = round((Math.round(pair.amount * 100) + share) / 100);
      pair.bu = automatic[baseAccount(pair)] === account.rate ? undefined : pair.bu ?? DATEV_BU_KEY[account.flow][account.rate];
      folded.add(at);
    });
    dropped.add(index);
  });
  return rows.filter((_, at) => !dropped.has(at)).map((pair) => {
    if (pair.bu !== undefined || folded.has(rows.indexOf(pair))) return pair;
    const rate = Math.max(automatic[pair.debit] ?? 0, automatic[pair.credit] ?? 0);
    return rate > 0 ? { ...pair, bu: DATEV_AUTOMATIC_OFF } : pair;
  });
};
/**
 * § 13b and innergemeinschaftlicher Erwerb: DATEV books Vorsteuer and Umsatzsteuer itself from the BU key on the net
 * row (DATEV Kontenrahmen 2025, Fußnote 21: § 13b with Vorsteuerabzug BU 94, 7 % BU 91, the Tatbestand in Sachverhalt
 * L+L; Erwerb BU 19/18). So the self-assessed tax lines drop out and the rest of the entry is paired again; the stored
 * pairs may cross the tax lines with the expense. An entry whose self-assessed tax does not net to zero stays as booked.
 */
const SELF_ASSESSED_DATEV: Record<string, { bu: Record<number, string>; sachverhaltLl?: string }> = {
  NON_EU_SERVICE_RC: { bu: { 19: '0094', 7: '0091' }, sachverhaltLl: '1' },
  DE_RC_13B_DOMESTIC: { bu: { 19: '0094', 7: '0091' }, sachverhaltLl: '4' },
  EU_B2B_SERVICE_RC: { bu: { 19: '0094', 7: '0091' }, sachverhaltLl: '7' },
  EU_IGE_GOODS_RC: { bu: { 19: '0019', 7: '0018' } },
};
const selfAssessedDatevPairs = (lines: JournalLineEntity[], taxAccounts: Set<string>): DatevPair[] | null => {
  const tax = lines.filter((line) => taxAccounts.has(line.accountNumber));
  if (!tax.length || tax.reduce((sum, line) => sum + Math.round(Number(line.debitAmount) * 100) - Math.round(Number(line.creditAmount) * 100), 0) !== 0) return null;
  return pairLines(lines.filter((line) => !taxAccounts.has(line.accountNumber))).map((pair) => {
    const datev = SELF_ASSESSED_DATEV[pair.taxCaseKey ?? ''];
    const rate = Number(pair.debit.taxRate ?? pair.credit.taxRate);
    return { amount: pair.amount, debit: pair.debit.accountNumber, credit: pair.credit.accountNumber, bu: datev?.bu[rate], sachverhaltLl: datev?.bu[rate] ? datev.sachverhaltLl : undefined };
  });
};
const pairLines = (lines: JournalLineEntity[]): Array<{ debit: JournalLineEntity; credit: JournalLineEntity; amount: number; taxCaseKey?: string }> => {
  const debits = lines.filter((l) => Number(l.debitAmount) > 0).map((l) => ({ l, n: round(l.debitAmount) })); const credits = lines.filter((l) => Number(l.creditAmount) > 0).map((l) => ({ l, n: round(l.creditAmount) })); const out: Array<{ debit: JournalLineEntity; credit: JournalLineEntity; amount: number; taxCaseKey?: string }> = [];
  for (const debit of debits) for (const credit of credits) { if (debit.n <= 0 || credit.n <= 0) continue; const amount = round(Math.min(debit.n, credit.n)); out.push({ debit: debit.l, credit: credit.l, amount, taxCaseKey: debit.l.taxCaseKey ?? credit.l.taxCaseKey }); debit.n = round(debit.n - amount); credit.n = round(credit.n - amount); }
  return out.filter((x) => x.amount > 0);
};
const insertEntry = async (db: PostgresQueryable, scope: TenantScope, sourceType: string, sourceKey: string, postingDate: string, bookingText: string, lines: JournalLineEntity[], options: { documentDate?: string; reference?: string; sourceDraftId?: string; softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext; datevBuKeys?: Array<string | null> }): Promise<string> => {
  const t = tenant(scope); const sourceLockKey = options.sourceDraftId ? `billme:draft:${t}:${options.sourceDraftId}` : `billme:source:${t}:${sourceType}:${sourceKey}`; await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [sourceLockKey]); const existing = await q<any>(db, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND ((source_type=$2 AND source_key=$3) OR ($4::text IS NOT NULL AND source_draft_id=$4 AND status='posted'))`, [t, sourceType, sourceKey, options.sourceDraftId ?? null]); if (existing[0]) return existing[0].id;
  if (!isoDate(postingDate)) throw new Error('INVALID_POSTING_DATE'); const fiscalYear = await reportingFiscalYear(db, t, postingDate); const status = await ensurePeriod(db, scope, period(postingDate), postingDate); if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD'); if (status === 'soft_locked' && (!options.softLockOverride || !options.overrideReason?.trim())) { const granted = (await q<{ reason: string | null }>(db, `SELECT current_setting('billme.soft_lock_override', true) AS reason`))[0]?.reason?.trim(); if (!granted) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED'); options = { ...options, softLockOverride: true, overrideReason: granted }; }
  if (!lines.length) throw new Error('EMPTY_ENTRY'); const totalDebit = lines.reduce((sum, l) => sum + (cents(l.debitAmount) ?? -1), 0); const totalCredit = lines.reduce((sum, l) => sum + (cents(l.creditAmount) ?? -1), 0); if (totalDebit <= 0 || totalDebit !== totalCredit) throw new Error('UNBALANCED_ENTRY');
  for (const line of lines) { if (!line.accountNumber || (cents(line.debitAmount) ?? -1) < 0 || (cents(line.creditAmount) ?? -1) < 0 || (Number(line.debitAmount) > 0 && Number(line.creditAmount) > 0)) throw new Error(`INVALID_JOURNAL_LINE:${line.accountNumber}`); }
  await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`billme:entry-number:${t}`]); const nr = await q<any>(db, `SELECT COALESCE(MAX(entry_number),0)+1 AS n FROM journal_entries WHERE tenant_id=$1`, [t]); const entryNumber = Number(nr[0].n); const id = randomUUID(); const stamp = now();
  await q(db, `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_draft_id,source_type,source_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10,$11,$12,$13)`, [id, t, entryNumber, postingDate, options.documentDate ?? postingDate, bookingText, options.reference ?? null, period(postingDate), fiscalYear, options.sourceDraftId ?? null, sourceType, sourceKey, stamp]);
  for (const [index, line] of lines.entries()) await q(db, `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount,tax_code,tax_case_key,tax_rate,net_amount,tax_amount,gross_amount,country_code,counterparty_vat_id,evidence_type,evidence_reference,datev_sachverhalt_ll,memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [line.id || randomUUID(), t, id, index + 1, line.accountNumber, round(line.debitAmount), round(line.creditAmount), line.taxCode ?? null, line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.datevSachverhaltLl ?? null, line.memo ?? null]);
  const dbLines = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, id]); const byId = new Map(dbLines.map((line) => [line.id, line]));
  for (const [pairIndex, pair] of pairLines(lines).entries()) { const debit = byId.get(pair.debit.id); const credit = byId.get(pair.credit.id); if (debit && credit) { const mapping = options.datevBuKeys?.[pairIndex]; const configured = mapping === undefined ? (await q<any>(db, `SELECT datev_bu_key FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=COALESCE((SELECT active_chart FROM accounting_policies WHERE tenant_id=$1),'SKR03') AND tax_case_key=$2 AND role='datev_bu' AND (valid_from IS NULL OR valid_from <= $3) AND (valid_to IS NULL OR valid_to >= $3) ORDER BY (tenant_id IS NULL),valid_from DESC NULLS LAST,updated_at DESC LIMIT 1`, [t, pair.taxCaseKey ?? '', postingDate]))[0]?.datev_bu_key ?? null : mapping; await insertJournalPostingPair(db, [randomUUID(), t, id, debit.id, credit.id, pair.amount, pair.taxCaseKey ?? null, configured, stamp]); } }
  for (const line of lines.filter((l) => Number(l.taxAmount || 0) > 0 || l.evidenceType || l.evidenceReference || l.countryCode || l.counterpartyVatId || l.datevSachverhaltLl)) await q(db, `INSERT INTO vat_evidence (id,tenant_id,entry_id,line_id,tax_case_key,evidence_type,evidence_reference,country_code,counterparty_vat_id,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), t, id, line.id, line.taxCaseKey ?? 'standard_vat', line.evidenceType ?? null, line.evidenceReference ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, stamp]);
  await audit(db as PostgresTransactionClient, scope, 'pro_journal_entry', id, 'post', options.overrideReason?.trim() || 'Accounting posting', null, { sourceType, sourceKey, entryNumber, postingDate, overrideReason: options.overrideReason?.trim() }, options.overrideReason?.trim() && options.mutation ? { ...options.mutation, reason: `${options.mutation.reason}; ${options.overrideReason.trim()}` } : options.mutation); return id;
};

const readInvoice = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<any | null> => (await q<any>(db, `SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), id]))[0] ?? null;
const isNonBillingInvoice = (row: any): boolean => ['order_confirmation', 'delivery_note'].includes(String(row.document_kind ?? 'invoice'));
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
  // A service to a Drittland customer is not taxable in Germany (§3a Abs. 2): a sale, never the reverse-charge purchase case.
  if (mode === 'non_taxable_outside_scope') return 'NON_EU_SERVICE_OUTSIDE_SCOPE';
  if (category === 'K') return 'EU_IGL_GOODS_0';
  if (category === 'G') return 'NON_EU_EXPORT_0';
  if (category === 'AE') return 'DE_RC_13B_DOMESTIC';
  if (category === 'E' || category === 'O' || rate === 0) return 'DE_ZERO_EXEMPT';
  if (Math.abs(rate - 7) < .01) return 'DE_STD_7';
  if (Math.abs(rate - 19) < .01) return 'DE_STD_19';
  // 20 % (AT), 16 %, 5 %: no German tax case; posting it as DE_STD_19 would report foreign VAT as German.
  return UNSUPPORTED_TAX_RATE;
};
const UNSUPPORTED_TAX_RATE = 'TAX_RATE_UNSUPPORTED';
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
type DatevPostingEvidence = Pick<JournalLineEntity, 'countryCode' | 'counterpartyVatId' | 'evidenceType' | 'evidenceReference' | 'datevSachverhaltLl'> & { taxRate?: number };
const datevTaxCaseDefinition = async (db: PostgresQueryable, taxCaseKey: string, rate: number): Promise<{ definition?: TaxCaseDefinition; special: boolean; issues: ValidationIssue[] }> => {
  const definitionRows = await q<any>(db, `SELECT key,label,mechanism,default_rate,requires_counterparty_vat_id,requires_country,requires_evidence,active FROM tax_cases WHERE key=$1 LIMIT 1`, [taxCaseKey]);
  const definitionRow = definitionRows[0];
  const special = datevDestinationCases.has(taxCaseKey as TaxCaseKey) || datevSachverhaltCases.has(taxCaseKey as TaxCaseKey);
  if (!definitionRow && special) return { special, issues: [issue('TAX_CASE_DEFINITION_REQUIRED', `Steuerfall ${taxCaseKey} ist serverseitig nicht eingerichtet.`)] };
  const definition: TaxCaseDefinition = definitionRow ? {
    key: taxCaseKey as TaxCaseKey, label: String(definitionRow.label ?? taxCaseKey), mechanism: definitionRow.mechanism,
    defaultRate: Number(definitionRow.default_rate ?? rate), requiresCounterpartyVatId: Boolean(definitionRow.requires_counterparty_vat_id),
    requiresCountry: Boolean(definitionRow.requires_country), requiresEvidence: Boolean(definitionRow.requires_evidence), active: Boolean(definitionRow.active),
  } : { key: taxCaseKey as TaxCaseKey, label: taxCaseKey, mechanism: 'standard_vat', defaultRate: rate, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: false, active: true };
  if (!definition.active) return { special, issues: [issue('TAX_CASE_INACTIVE', `Steuerfall ${taxCaseKey} ist nicht aktiv.`)] };
  return { definition, special, issues: [] };
};
const validateDatevEvidenceForCase = async (db: PostgresQueryable, taxCaseKey: string, evidence: DatevTaxEvidence, rate: number): Promise<{ normalized: DatevTaxEvidence; special: boolean; issues: ValidationIssue[] }> => {
  const resolved = await datevTaxCaseDefinition(db, taxCaseKey, rate);
  if (!resolved.definition) return { normalized: normalizeDatevTaxEvidence(evidence), special: resolved.special, issues: resolved.issues };
  const normalized = normalizeDatevTaxEvidence(evidence);
  const validation = validateDatevTaxEvidence(resolved.definition, normalized);
  if (validation.length) return { normalized, special: resolved.special, issues: validation.map((item) => issue(item.code, item.message)) };
  return { normalized, special: resolved.special, issues: [] };
};
const validateJournalLineDatevEvidence = async (db: PostgresQueryable, lines: Array<Pick<JournalLineEntity, 'taxCaseKey' | 'taxRate' | 'countryCode' | 'counterpartyVatId' | 'evidenceType' | 'evidenceReference' | 'datevSachverhaltLl'>>): Promise<ValidationIssue[]> => {
  const issues: ValidationIssue[] = [];
  for (const line of lines) {
    if (!line.taxCaseKey) continue;
    const checked = await validateDatevEvidenceForCase(db, line.taxCaseKey, {
      buyerCountryCode: line.countryCode, buyerVatId: line.counterpartyVatId, destinationVatRate: line.taxRate,
      datevEvidenceType: line.evidenceType, datevEvidenceReference: line.evidenceReference, datevSachverhaltLl: line.datevSachverhaltLl,
    }, line.taxRate ?? 0);
    issues.push(...checked.issues);
  }
  return issues;
};
/**
 * The evidence of a purchase. Domestic and tax-free purchases (0 %, Kleinunternehmer, Versicherung) need none.
 * A self-assessed purchase (§ 13b, innergemeinschaftlicher Erwerb) needs the supplier's country, VAT ID and an
 * evidence reference as its tax case defines; the supplier bills net and the rate on the line is what the buyer owes.
 */
const incomingPostingEvidence = async (db: PostgresQueryable, entry: TaxBreakdown, row: any): Promise<{ evidence?: DatevPostingEvidence; issues: ValidationIssue[] }> => {
  const mode = TAX_CASE_RECEIPT_MODE[entry.taxCaseKey as TaxCaseKey];
  if (!mode) return { issues: [issue('INCOMING_TAX_CASE_UNSUPPORTED', `Steuerfall ${entry.taxCaseKey} gehört zu Ausgangsrechnungen; für einen Einkauf bitte Inland, steuerfrei, § 13b oder innergemeinschaftlichen Erwerb wählen.`)] };
  if (!isSelfAssessedPurchase(entry.taxCaseKey)) return { issues: [] };
  if (entry.tax > .005) return { issues: [issue('SELF_ASSESSED_VAT_BILLED', `Bei Steuerfall ${entry.taxCaseKey} schuldet der Empfänger die Steuer; die Rechnung darf keine Umsatzsteuer ausweisen. Bitte Betrag netto erfassen oder Steuerfall prüfen.`)] };
  if (!(mode === 'intra_eu_acquisition' ? [19, 7] : [19]).includes(entry.rate)) return { issues: [issue('SELF_ASSESSED_RATE_UNSUPPORTED', `Steuersatz ${entry.rate} % wird für ${entry.taxCaseKey} nicht unterstützt (§ 13b: 19 %, innergemeinschaftlicher Erwerb: 19 % oder 7 %).`)] };
  const resolved = await datevTaxCaseDefinition(db, entry.taxCaseKey, entry.rate);
  if (!resolved.definition) return { issues: resolved.issues };
  const meta = parse<{ vendorCountryCode?: string; vendorVatId?: string; evidenceType?: string; evidenceReference?: string }>(row.tax_meta_json, {});
  const evidence = normalizeDatevTaxEvidence({ buyerCountryCode: meta.vendorCountryCode, buyerVatId: meta.vendorVatId, datevEvidenceType: meta.evidenceType, datevEvidenceReference: meta.evidenceReference });
  // Destination rate and DATEV Sachverhalt L+L belong to sales (ZM/OSS), not to a purchase.
  const issues = validateDatevTaxEvidence(resolved.definition, evidence).filter((item) => item.code !== 'MISSING_DESTINATION_VAT_RATE' && item.code !== 'MISSING_DATEV_SACHVERHALT');
  if (issues.length) return { issues: issues.map((item) => issue(item.code, item.message)) };
  return { evidence: { countryCode: evidence.buyerCountryCode, counterpartyVatId: evidence.buyerVatId, evidenceType: evidence.datevEvidenceType, evidenceReference: evidence.datevEvidenceReference, taxRate: entry.rate }, issues: [] };
};
const datevPostingEvidence = async (db: PostgresQueryable, taxCaseKey: string, row: any, rate: number): Promise<{ evidence?: DatevPostingEvidence; issues: ValidationIssue[] }> => {
  const checked = await validateDatevEvidenceForCase(db, taxCaseKey, parse<DatevTaxEvidence>(row.tax_meta_json, {}), rate);
  if (checked.issues.length) return { issues: checked.issues };
  const normalized = checked.normalized;
  const destinationId = normalized.buyerVatId
    ? (/^[A-Z]{2}/.test(normalized.buyerVatId) ? normalized.buyerVatId : `${normalized.buyerCountryCode ?? ''}${normalized.buyerVatId}`)
    : normalized.buyerCountryCode;
  return {
    evidence: {
      countryCode: normalized.buyerCountryCode,
      counterpartyVatId: normalized.buyerVatId,
      evidenceType: normalized.datevEvidenceType,
      evidenceReference: normalized.datevEvidenceReference,
      datevSachverhaltLl: normalized.datevSachverhaltLl,
      taxRate: datevDestinationCases.has(taxCaseKey as TaxCaseKey) ? normalized.destinationVatRate : rate,
      ...(datevDestinationCases.has(taxCaseKey as TaxCaseKey) && destinationId ? { counterpartyVatId: destinationId } : {}),
    }, issues: [],
  };
};
/** Lines posted before 0050 hash as they did: the new column only counts once it is set. */
const versionedIncomingLine = ({ input_vat_deductible, ...line }: any) => input_vat_deductible == null ? line : { ...line, input_vat_deductible };
const sourceVersion = (row: any, lines: unknown): string => hash({ id: row.id, tenantId: row.tenant_id, number: row.number, date: row.date ?? row.invoice_date, dueDate: row.due_date, amount: row.amount ?? row.gross_amount, net: row.net_amount, tax: row.tax_amount, gross: row.gross_amount, taxMode: row.tax_mode, taxMeta: parse(row.tax_meta_json, null), taxSnapshot: parse(row.tax_snapshot_json, null), lines });
type FinalizedInvoiceReservation = { id: string; kind: string; number: string; status: string; document_id: string };
const finalizedInvoiceReservation = async (db: PostgresQueryable, t: string, row: any): Promise<FinalizedInvoiceReservation | null> =>
  (await q<FinalizedInvoiceReservation>(db, `SELECT id,kind,number,status,document_id FROM number_reservations WHERE tenant_id=$1 AND kind='invoice' AND status='finalized' AND document_id=$2 AND number=$3 LIMIT 1`, [t, row.id, row.number]))[0] ?? null;
const backfillOutgoingSourceVersion = (row: any, documentVersion: string, reservation: FinalizedInvoiceReservation | null): string =>
  hash({ documentVersion, eligibility: { status: row.status, accountingStatus: row.accounting_status, reservation: reservation && { id: reservation.id, kind: reservation.kind, number: reservation.number, status: reservation.status, documentId: reservation.document_id } } });
const incomingBackfillSourceVersion = (row: any, documentVersion: string): string =>
  hash({ documentVersion, eligibility: { status: row.status, accountingStatus: row.accounting_status } });
const BEWIRTUNG_ACCOUNTS: Record<'SKR03' | 'SKR04', [string, string]> = { SKR03: ['4650', '4654'], SKR04: ['6640', '6644'] };
const postingPreview = async (db: PostgresQueryable, scope: TenantScope, row: any, type: 'outgoing_invoice'|'incoming_invoice'): Promise<AccountingPostingPreview> => {
  if (type === 'outgoing_invoice' && isNonBillingInvoice(row)) {
    return {
      sourceType: type,
      sourceId: row.id,
      status: 'unresolved',
      reason: 'NON_BILLING_DOCUMENT',
      issues: [{ code: 'NON_BILLING_DOCUMENT', message: 'Auftragsbestätigungen und Lieferscheine werden nicht gebucht.', blocking: true }],
    };
  }
  const t = tenant(scope); const p = await policy(db, t); const m = await mappings(db, t, p.activeChart); const category = parse<any>(row.tax_snapshot_json ?? row.accounting_snapshot_json, null)?.einvoiceCategoryCode ?? parse<any>(row.tax_meta_json, null)?.einvoiceCategoryCode; const incomingLines = type === 'incoming_invoice' ? (row.__incomingLines ?? await q<any>(db, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, row.id])) : []; const tax = taxSnapshot(row, type === 'incoming_invoice', incomingLines); const id = row.id;
  if (!tax) return { sourceType: type, sourceId: id, status: 'unresolved', reason: 'AMBIGUOUS_TAX_SNAPSHOT', issues: [{ code: 'AMBIGUOUS_TAX_SNAPSHOT', message: 'Netto, Steuer und Brutto konnten nicht sicher ermittelt werden.', blocking: true }] };
  const unsupported = [...tax.breakdown.filter((entry) => entry.taxCaseKey === UNSUPPORTED_TAX_RATE).map((entry) => entry.rate), ...incomingLines.map((line: any) => Number(line.tax_rate ?? 0)).filter((rate: number) => taxCaseFor(row, rate, category) === UNSUPPORTED_TAX_RATE)];
  if (unsupported.length) return { sourceType: type, sourceId: id, status: 'unresolved', reason: UNSUPPORTED_TAX_RATE, issues: [{ code: UNSUPPORTED_TAX_RATE, message: `Steuersatz ${unsupported[0]} % ist kein deutscher Umsatzsteuersatz (0, 7 oder 19 %); bitte Steuerart oder Satz korrigieren.`, blocking: true }] };
  const evidenceByCase = new Map<string, DatevPostingEvidence>();
  for (const entry of tax.breakdown) {
    const resolved = type === 'incoming_invoice' ? await incomingPostingEvidence(db, entry, row) : await datevPostingEvidence(db, entry.taxCaseKey, row, entry.rate);
    if (resolved.issues.length) return { sourceType: type, sourceId: id, status: 'unresolved', reason: resolved.issues[0].code, issues: resolved.issues };
    if (resolved.evidence) evidenceByCase.set(entry.taxCaseKey, resolved.evidence);
  }
  const basisEvidence = (entry: TaxBreakdown): DatevPostingEvidence | undefined => evidenceByCase.get(entry.taxCaseKey);
  // A line without its own account books the vendor's default expense account, then the expense role.
  const vendorExpense = type === 'incoming_invoice' && row.vendor_id ? (await q<any>(db, `SELECT default_expense_account FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, row.vendor_id]))[0]?.default_expense_account || undefined : undefined;
  const expenseAccount: string = vendorExpense ?? m.expense;
  const lines: AccountingSnapshot['lines'] = [{ accountNumber: type === 'outgoing_invoice' ? m.accounts_receivable : (incomingLines[0]?.account_number ?? incomingLines[0]?.asset_account_number ?? expenseAccount), debitAmount: type === 'outgoing_invoice' ? tax.gross : tax.net, creditAmount: 0 }];
  // Anzahlungsrechnung (§13 Abs. 1 Nr. 1a S. 4 UStG, Mindest-Ist): the VAT is due when the money comes in, also
  // under Soll, and the net is a received advance (Erhaltene Anzahlungen) until the final invoice releases it.
  // A Storno or credit note of an advance invoice books the same accounts the other way round.
  const correctionKind = type === 'outgoing_invoice' && (row.document_kind === 'credit_note' || row.document_kind === 'cancellation_invoice');
  const chainKind = correctionKind && row.source_document_id
    ? (await q<any>(db, `SELECT document_kind FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, row.source_document_id]))[0]?.document_kind
    : row.document_kind;
  const advance = type === 'outgoing_invoice' && chainKind === 'advance_invoice';
  const vatMethod: 'soll' | 'ist' = advance ? 'ist' : p.vatMethod;
  // The invoice of a fixed-asset sale books its proceeds on the asset-sale account (the disposal books the book value).
  const assetSaleId = type === 'outgoing_invoice' && !advance ? parse<any>(row.tax_meta_json, null)?.assetSaleAssetId : undefined;
  const assetSale = Boolean(assetSaleId) && (await q<any>(db, `SELECT 1 FROM assets WHERE tenant_id=$1 AND id=$2`, [t, assetSaleId])).length > 0;
  if (type === 'outgoing_invoice') {
    for (const entry of tax.breakdown) {
      // Under Ist the VAT waits on the not-yet-due account of its rate until the money comes in.
      const outputAccount = vatMethod === 'ist'
        ? await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'output_tax_deferred', undefined, row.date)
        : await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'output_tax', m.output_vat, row.date);
      const revenueAccount = assetSale ? await assetSaleRevenueAccount(db, t, p.activeChart, assetSaleId, row) : await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, advance ? 'customer_advance' : 'revenue', undefined, row.date);
      // Ist VAT is deferred and must not appear in the initial VAT report.
      // Preserve the case only in the stable basis memo for payment-time
      // recognition; the control line itself remains unkeyed.
      const evidence = basisEvidence(entry);
      lines.push(vatMethod === 'ist'
        ? { accountNumber: revenueAccount, debitAmount: 0, creditAmount: entry.net, taxCaseKey: entry.taxCaseKey, taxRate: evidence?.taxRate, countryCode: evidence?.countryCode, counterpartyVatId: evidence?.counterpartyVatId, evidenceType: evidence?.evidenceType, evidenceReference: evidence?.evidenceReference, datevSachverhaltLl: evidence?.datevSachverhaltLl, memo: `UStBasis ${entry.taxCaseKey}` }
        : { accountNumber: revenueAccount, debitAmount: 0, creditAmount: entry.net, taxCaseKey: entry.taxCaseKey, taxRate: evidence?.taxRate ?? entry.rate, netAmount: entry.net, taxAmount: entry.tax, grossAmount: entry.gross, countryCode: evidence?.countryCode, counterpartyVatId: evidence?.counterpartyVatId, evidenceType: evidence?.evidenceType, evidenceReference: evidence?.evidenceReference, datevSachverhaltLl: evidence?.datevSachverhaltLl });
      if (entry.tax > 0) lines.push({ accountNumber: outputAccount, debitAmount: 0, creditAmount: entry.tax, memo: `USt ${entry.taxCaseKey}` });
    }
    // The final invoice (or its Storno) releases the advances of its order into revenue. Its own lines only carry
    // the rest of the order, so revenue ends at the order's net. No tax figures: the advance's VAT was reported
    // when it was paid.
    if (chainKind === 'final_invoice' && (row.document_kind === 'final_invoice' || row.document_kind === 'cancellation_invoice')) {
      const finalRow = row.document_kind === 'final_invoice' ? row : (await q<any>(db, `SELECT id,root_document_id FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, row.source_document_id]))[0];
      const advances = finalRow?.root_document_id ? await q<any>(db, `SELECT i.number,i.accounting_snapshot_json FROM invoices i WHERE i.tenant_id=$1 AND i.root_document_id=$2 AND i.document_kind='advance_invoice' AND i.accounting_status='posted' AND NOT EXISTS (SELECT 1 FROM invoices c WHERE c.tenant_id=i.tenant_id AND c.source_document_id=i.id AND c.document_kind='cancellation_invoice' AND c.status<>'draft') ORDER BY i.date,i.number`, [t, finalRow.root_document_id]) : [];
      for (const advanceRow of advances) {
        for (const basis of parse<AccountingSnapshot | undefined>(advanceRow.accounting_snapshot_json, undefined)?.lines.filter((line) => line.creditAmount > 0 && line.memo?.startsWith('UStBasis ')) ?? []) {
          const memo = `Auflösung Anzahlung ${advanceRow.number}`;
          lines.push({ accountNumber: basis.accountNumber, debitAmount: basis.creditAmount, creditAmount: 0, memo });
          lines.push({ accountNumber: await taxCaseAccount(db, t, p.activeChart, basis.memo!.slice('UStBasis '.length), 'revenue', undefined, row.date), debitAmount: 0, creditAmount: basis.creditAmount, memo });
        }
      }
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
        const taxCaseKey = entry?.taxCaseKey ?? taxCaseFor(row, rate, category); const evidence = evidenceByCase.get(taxCaseKey);
        // A self-assessed purchase carries the tax the buyer owes (net × rate), not the zero on the invoice.
        const owed = isSelfAssessedPurchase(taxCaseKey) ? round(net * rate / 100) : undefined;
        // Non-deductible VAT (§ 15 Abs. 1a UStG) is part of the expense; with taxAmount 0 it stays out of Kz 66.
        if (line.input_vat_deductible === false && !isSelfAssessedPurchase(taxCaseKey)) return { accountNumber: line.asset_account_number ?? line.account_number ?? expenseAccount, debitAmount: round(net + taxAmount), creditAmount: 0, taxCaseKey, netAmount: round(net + taxAmount), taxRate: rate, taxAmount: 0, grossAmount: round(net + taxAmount), memo: line.description, nonDeductibleTax: round(taxAmount) };
        return { accountNumber: line.asset_account_number ?? line.account_number ?? expenseAccount, debitAmount: round(net), creditAmount: 0, taxCaseKey, netAmount: round(net), taxRate: evidence?.taxRate ?? rate, taxAmount: owed ?? round(taxAmount), grossAmount: owed === undefined ? round(gross || net + taxAmount) : round(net + owed), countryCode: evidence?.countryCode, counterpartyVatId: evidence?.counterpartyVatId, evidenceType: evidence?.evidenceType, evidenceReference: evidence?.evidenceReference, datevSachverhaltLl: evidence?.datevSachverhaltLl, memo: line.description };
      })
      : tax.breakdown.map((entry) => { const evidence = basisEvidence(entry); const owed = isSelfAssessedPurchase(entry.taxCaseKey) ? round(entry.net * entry.rate / 100) : undefined; return { accountNumber: expenseAccount, debitAmount: entry.net, creditAmount: 0, taxCaseKey: entry.taxCaseKey, netAmount: entry.net, taxRate: evidence?.taxRate ?? entry.rate, taxAmount: owed ?? entry.tax, grossAmount: owed === undefined ? entry.gross : round(entry.net + owed), countryCode: evidence?.countryCode, counterpartyVatId: evidence?.counterpartyVatId, evidenceType: evidence?.evidenceType, evidenceReference: evidence?.evidenceReference, datevSachverhaltLl: evidence?.datevSachverhaltLl }; });
    // Bewirtung (§4 Abs. 5 Nr. 2 EStG): 70 % is a deductible expense, 30 % goes to "nicht abzugsfähige
    // Bewirtungskosten". The input VAT stays fully deductible; the VAT figures follow the split so the sum is unchanged.
    const [entertainment, nonDeductible] = BEWIRTUNG_ACCOUNTS[p.activeChart];
    const thirty = (value: number | undefined) => round((value ?? 0) * 0.3);
    lines.splice(0, lines.length, ...expenseLines.flatMap((line: AccountingSnapshot['lines'][number]) => {
      if (line.accountNumber !== entertainment || !line.debitAmount) return [line];
      const rest = { ...line, accountNumber: nonDeductible, debitAmount: thirty(line.debitAmount), netAmount: thirty(line.netAmount), taxAmount: thirty(line.taxAmount), grossAmount: thirty(line.grossAmount) };
      return [{ ...line, debitAmount: round(line.debitAmount - rest.debitAmount), netAmount: round((line.netAmount ?? 0) - rest.netAmount), taxAmount: round((line.taxAmount ?? 0) - rest.taxAmount), grossAmount: round((line.grossAmount ?? 0) - rest.grossAmount) }, rest];
    }));
    const nonDeductibleTax = new Map(tax.breakdown.map((entry) => [entry.taxCaseKey, round(expenseLines.filter((line: { taxCaseKey?: string; nonDeductibleTax?: number }) => line.taxCaseKey === entry.taxCaseKey).reduce((sum: number, line: { nonDeductibleTax?: number }) => sum + (line.nonDeductibleTax ?? 0), 0))]));
    for (const line of lines) delete (line as { nonDeductibleTax?: number }).nonDeductibleTax;
    for (const entry of tax.breakdown) {
      if (isSelfAssessedPurchase(entry.taxCaseKey)) {
        // § 13b / innergemeinschaftlicher Erwerb: the buyer books the USt it owes and, in the same entry, the same
        // amount as Vorsteuer (§ 15 Abs. 1 Nr. 3, 4 UStG). The supplier is owed the net amount only.
        const owed = round(lines.filter((line) => line.taxCaseKey === entry.taxCaseKey && Math.abs((line.taxRate ?? entry.rate) - entry.rate) < .01).reduce((sum, line) => sum + (line.taxAmount ?? 0), 0));
        if (owed <= 0) continue;
        lines.push({ accountNumber: await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'input_tax', undefined, row.invoice_date, entry.rate), debitAmount: owed, creditAmount: 0, memo: `Vorsteuer ${entry.taxCaseKey}` });
        lines.push({ accountNumber: await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'output_tax', undefined, row.invoice_date, entry.rate), debitAmount: 0, creditAmount: owed, memo: `USt ${entry.taxCaseKey}` });
      } else if (entry.tax > 0) {
        const deductible = round(entry.tax - nonDeductibleTax.get(entry.taxCaseKey)!);
        if (deductible > 0) lines.push({ accountNumber: await taxCaseAccount(db, t, p.activeChart, entry.taxCaseKey, 'input_tax', m.input_vat, row.invoice_date), debitAmount: deductible, creditAmount: 0, memo: `Vorsteuer ${entry.taxCaseKey}` });
      }
    }
    lines.push({ accountNumber: m.accounts_payable, debitAmount: 0, creditAmount: tax.gross });
  }
  const snapshot: AccountingSnapshot = { sourceType: type, sourceId: id, sourceVersion: sourceVersion(row, type === 'incoming_invoice' ? incomingLines.map(versionedIncomingLine) : invoiceLines(row)), chart: p.activeChart, vatMethod, netAmount: tax.net, taxAmount: tax.tax, grossAmount: tax.gross, lines, capturedAt: now() };
  const accounts = [...new Set(lines.map((line) => line.accountNumber))]; const missing: string[] = []; for (const account of accounts) if (!(await accountExists(db, p.activeChart, account, tenant(scope)))) missing.push(account); if (missing.length) return { sourceType: type, sourceId: id, status: 'unresolved', reason: 'UNKNOWN_ACCOUNT', snapshot, issues: [{ code: 'UNKNOWN_ACCOUNT', message: `Konten fehlen: ${missing.join(', ')}`, blocking: true }] };
  return { sourceType: type, sourceId: id, status: 'ready', snapshot, issues: [] };
};
const rowVendor = (row: any): VendorEntity => ({ id: row.id, tenantId: row.tenant_id, vendorNumber: row.vendor_number ?? undefined, name: row.name, email: row.email ?? undefined, address: row.address ?? undefined, vatId: row.vat_id ?? undefined, iban: row.iban ?? undefined, defaultExpenseAccount: row.default_expense_account ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const rowIncoming = (row: any, lines: any[]): IncomingInvoiceEntity => ({ id: row.id, tenantId: row.tenant_id, vendorId: row.vendor_id, number: row.number, invoiceDate: row.invoice_date, dueDate: row.due_date, servicePeriod: row.service_period ?? undefined, netAmount: Number(row.net_amount), taxAmount: Number(row.tax_amount), grossAmount: Number(row.gross_amount), status: row.status, taxRate: Number(row.tax_rate), taxCaseKey: row.tax_case_key ?? undefined, ...(row.tax_meta_json ? { taxMeta: parse(row.tax_meta_json, undefined) } : {}), notes: row.notes ?? undefined, lines: lines.map((l) => ({ id: l.id, incomingInvoiceId: l.incoming_invoice_id, position: Number(l.position), description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), netAmount: Number(l.net_amount), taxRate: Number(l.tax_rate), taxAmount: Number(l.tax_amount), grossAmount: Number(l.gross_amount), accountNumber: l.account_number ?? undefined, assetAccountNumber: l.asset_account_number ?? undefined, ...(l.input_vat_deductible === false ? { inputVatDeductible: false } : {}) })), accountingStatus: row.accounting_status, accountingSnapshot: parse(row.accounting_snapshot_json, undefined), createdAt: row.created_at, updatedAt: row.updated_at });
const rowIncomingInvoiceDocument = (row: any): IncomingInvoiceDocumentEntity => ({
  id: row.id,
  tenantId: row.tenant_id,
  incomingInvoiceId: row.incoming_invoice_id,
  originalFilename: row.original_filename,
  mimeType: row.mime_type,
  byteLength: Number(row.byte_length),
  sha256: row.sha256,
  reviewStatus: row.review_status,
  journalEntryId: row.accounting_journal_entry_id ?? row.journal_entry_id ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const incomingInvoiceDocumentContent = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  throw new Error('INCOMING_INVOICE_DOCUMENT_CONTENT_UNAVAILABLE');
};
const assertIncomingInvoiceDocumentInput = (input: IncomingInvoiceDocumentUploadInput): void => {
  if (!input.originalFilename.trim() || /[\\/\u0000-\u001f\u007f]/.test(input.originalFilename)) throw new Error('INCOMING_INVOICE_DOCUMENT_FILENAME_INVALID');
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType)) throw new Error('INCOMING_INVOICE_DOCUMENT_MIME_UNSUPPORTED');
  if (!input.content.byteLength || input.content.byteLength > INCOMING_INVOICE_DOCUMENT_MAX_BYTES) throw new Error('INCOMING_INVOICE_DOCUMENT_SIZE_INVALID');
  assertIncomingInvoiceDocumentContent(input.mimeType, input.content);
};
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
const rowOpenItem = (row: any): OpenItemEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id, sourceType: row.source_type, sourceId: row.source_id, documentNumber: row.document_number, documentDate: row.document_date, dueDate: row.due_date, originalAmount: Number(row.original_amount), allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
const rowPayment = (row: any): OpenItemPaymentEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, refund: row.refund === true || undefined, creditedPaymentId: row.credited_payment_id ?? undefined });
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

const reverseEntryInTransaction = async (db: PostgresQueryable, scope: TenantScope, entryId: string, reason: string, options: ReverseJournalEntryOptions & { allowDocumentSource?: boolean; allowPaymentSource?: boolean; allowAssetSource?: boolean } = {}): Promise<{ ok: true; reversalEntryId: string }> => {
  const t = tenant(scope); const entry = (await q<any>(db, `SELECT * FROM journal_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, entryId]))[0]; if (!entry) throw new Error('Journal entry not found'); if (!reason.trim()) throw new Error('Reversal reason is required'); if (!options.allowDocumentSource && (entry.source_type === 'outgoing_invoice' || entry.source_type === 'incoming_invoice')) throw new Error('DOCUMENT_REVERSAL_REQUIRED: reverseDocumentAccounting must be used for document-owned entries'); if (!options.allowAssetSource && (entry.source_type === 'asset_activation' || entry.source_type === 'asset_depreciation' || entry.source_type === 'asset_disposal')) throw new Error('ASSET_REVERSAL_REQUIRED: use the asset-specific correction flow'); if (!options.allowPaymentSource && (entry.source_type === 'payment' || entry.source_type === 'payment_vat' || entry.source_type === 'skonto')) throw new Error('PAYMENT_REVERSAL_REQUIRED: Zahlungen werden über den Zahlungsstorno im OPOS storniert'); if (['fiscal_close', 'carry_forward', 'provision', 'accrual', 'inventory_closing', 'fx_valuation', 'loan_schedule', 'payroll_batch', 'correction'].includes(entry.source_type) || (entry.source_type === 'standalone_source' && /^(correction|settlement):/.test(String(entry.source_key ?? '')))) throw new Error('AGGREGATE_REVERSAL_BLOCKED: use the source-specific correction flow'); if (entry.status === 'reversed' || entry.reversed_entry_id || entry.source_type === 'reversal') throw new Error('Journal entry cannot be reversed again');
  const postingDate = options.postingDate ?? now().slice(0, 10); if (!isoDate(postingDate)) throw new Error('Invalid reversal posting date'); const lines = await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, entryId]); if (!lines.length) throw new Error('Journal entry has no lines');
  const originalPairs = await q<any>(db, `SELECT jp.amount,jp.tax_case_key,jp.datev_bu_key,dl.account_number AS debit_account,cl.account_number AS credit_account FROM journal_posting_pairs jp JOIN journal_lines dl ON dl.id=jp.debit_line_id AND dl.tenant_id=jp.tenant_id JOIN journal_lines cl ON cl.id=jp.credit_line_id AND cl.tenant_id=jp.tenant_id WHERE jp.tenant_id=$1 AND jp.entry_id=$2`, [t, entryId]);
  const reversalLines = lines.map((line) => ({ ...mapLine(line), id: randomUUID(), debitAmount: Number(line.credit_amount), creditAmount: Number(line.debit_amount), netAmount: line.net_amount == null ? undefined : -Number(line.net_amount), taxAmount: line.tax_amount == null ? undefined : -Number(line.tax_amount), grossAmount: line.gross_amount == null ? undefined : -Number(line.gross_amount) }));
  const originalBu = new Map(originalPairs.map((pair) => [`${pair.amount}|${pair.tax_case_key ?? ''}|${pair.credit_account}|${pair.debit_account}`, pair.datev_bu_key ?? null]));
  const datevBuKeys = pairLines(reversalLines).map((pair) => originalBu.get(`${pair.amount}|${pair.taxCaseKey ?? ''}|${pair.debit.accountNumber}|${pair.credit.accountNumber}`) ?? null);
  const reversalEntryId = await insertEntry(db, scope, 'reversal', `reversal:${entryId}`, postingDate, `Storno ${entry.entry_number}: ${reason.trim()}`, reversalLines, { documentDate: entry.document_date, reference: entry.reference ?? undefined, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation, datevBuKeys });
  await q(db, `UPDATE journal_entries SET status='reversed',reversed_entry_id=$1 WHERE tenant_id=$2 AND id=$3`, [reversalEntryId, t, entryId]);
  // A reversed bank booking is no longer "Gebucht" in the booking workspace, whichever screen started the Storno, and
  // its bank line is open again: "Neu kontieren" books it once more (migration 0066 keeps one live entry per draft).
  if (entry.source_type === 'booking_draft' && entry.source_draft_id) {
    await q(db, `UPDATE booking_drafts SET workflow_status='reversed',updated_at=$1 WHERE tenant_id=$2 AND id=$3 AND workflow_status='posted'`, [now(), t, entry.source_draft_id]);
    await q(db, `UPDATE bank_transactions SET status='pending',updated_at=$1 WHERE tenant_id=$2 AND linked_invoice_id IS NULL AND id=(SELECT transaction_id FROM booking_drafts WHERE tenant_id=$2 AND id=$3)`, [now(), t, entry.source_draft_id]);
  }
  await audit(db as PostgresTransactionClient, scope, 'pro_journal_entry', entryId, 'reverse', reason.trim(), { status: 'posted' }, { status: 'reversed', reversalEntryId, postingDate }, options.mutation); return { ok: true, reversalEntryId };
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
  const source = (await q<any>(db, `SELECT accounting_snapshot_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), item.source_id]))[0];
  const snapshot = parse<AccountingSnapshot | undefined>(source?.accounting_snapshot_json, undefined);
  // The invoice's own snapshot says whether its VAT waits for the money (Ist, or an advance invoice under Soll).
  if (!snapshot || snapshot.vatMethod !== 'ist' || snapshot.grossAmount <= 0) return;
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
    // A refund or Rücklastschrift takes back what a payment recognised: the VAT is not yet due again.
    if (Math.abs(delta) < .005) continue;
    const grossShare = round((Math.sign(allocationAmount) * Math.min(Math.abs(allocationAmount), snapshot.grossAmount) * basisGross) / snapshot.grossAmount);
    const netShare = round(grossShare - delta);
    const deferred = control?.accountNumber ?? m.output_vat_deferred;
    const output = await taxCaseAccount(db, tenant(scope), p.activeChart, taxCaseKey, 'output_tax', m.output_vat, paymentDate);
    if (delta > 0) {
      payableLines.push({ id: randomUUID(), accountNumber: deferred, debitAmount: delta, creditAmount: 0, taxCaseKey, netAmount: netShare, taxAmount: delta, grossAmount: grossShare });
      payableLines.push({ id: randomUUID(), accountNumber: output, debitAmount: 0, creditAmount: delta });
    } else {
      payableLines.push({ id: randomUUID(), accountNumber: output, debitAmount: -delta, creditAmount: 0, taxCaseKey, netAmount: netShare, taxAmount: delta, grossAmount: grossShare });
      payableLines.push({ id: randomUUID(), accountNumber: deferred, debitAmount: 0, creditAmount: -delta });
    }
  }
  if (payableLines.length) await insertEntry(db, scope, 'payment_vat', `payment-vat:${paymentId}:${allocationId}`, paymentDate, 'USt Vereinnahmung', payableLines, {});
};

/** A Beleg archived on a bank line (immutable, migration 0065). */
export interface BankTransactionDocument {
  id: string;
  tenantId: string;
  bankTransactionId: string;
  originalFilename: string;
  mimeType: IncomingInvoiceDocumentUploadInput['mimeType'];
  byteLength: number;
  sha256: string;
  createdAt: string;
}
const rowBankTransactionDocument = (row: any): BankTransactionDocument => ({ id: row.id, tenantId: row.tenant_id, bankTransactionId: row.bank_transaction_id, originalFilename: row.original_filename, mimeType: row.mime_type, byteLength: Number(row.byte_length), sha256: row.sha256, createdAt: row.created_at });

export type ProAccountingReportRepository = Omit<ProAccountingRepository, 'getGuvReport' | 'getBilanzReport'> & ProAccountingAssetRepository & AccountingSourceRunRepository & {
  listAccountingPeriods(scope: TenantScope, year: number): Promise<AccountingPeriodRecord[]>;
  listOpenItemPayments(scope: TenantScope): Promise<OpenItemPaymentEntity[]>;
  updateDraftExceptionCase(scope: TenantScope, input: { transactionId: string; patch: Partial<DraftExceptionCase>; mutation: AccountingMutationContext }): Promise<BookingDraftEntity>;
  listBankTransactionDocuments(scope: TenantScope, transactionId: string): Promise<BankTransactionDocument[]>;
  uploadBankTransactionDocument(scope: TenantScope, input: { transactionId: string; originalFilename: string; mimeType: IncomingInvoiceDocumentUploadInput['mimeType']; content: Uint8Array; mutation: AccountingMutationContext }): Promise<BankTransactionDocument>;
  downloadBankTransactionDocument(scope: TenantScope, documentId: string): Promise<{ document: BankTransactionDocument; content: Uint8Array }>;
  reverseOpenItemPayment(scope: TenantScope, input: { paymentId: string; reason: string; postingDate?: string; mutation?: AccountingMutationContext }): Promise<OpenItemPaymentReversal>;
  reallocateOpenItemPayment(scope: TenantScope, input: { paymentId: string; reason: string; partyId: string; allocations: Array<{ openItemId: string; amount: number }>; allocationEventId: string; mutation?: AccountingMutationContext }): Promise<{ reversal: OpenItemPaymentReversal; payment: OpenItemPaymentEntity }>;
  setAccountingPeriodStatus(scope: TenantScope, input: { period: string; status: AccountingPeriodStatus; mutation: AccountingMutationContext }): Promise<AccountingPeriodStatusChange>;
  postManualJournalEntry(scope: TenantScope, input: ManualJournalEntryInput): Promise<JournalEntryEntity>;
  getBankLedgerReconciliation(scope: TenantScope): Promise<BankLedgerReconciliationRow[]>;
  getBwa01Report(scope: TenantScope, args?: { from?: string; to?: string; chart?: 'SKR03' | 'SKR04'; profile?: string }): Promise<ReportResult<Bwa01Report>>;
  getGuvReport(scope: TenantScope, args?: { from?: string; to?: string; chart?: 'SKR03' | 'SKR04'; profile?: 'guv' | 'management-guv' | 'hgb-guv' }): Promise<ReportResult<ManagementGuvReport | HgbGuvReport>>;
  getBilanzReport(scope: TenantScope, args?: { asOfDate?: string; chart?: 'SKR03' | 'SKR04' }): Promise<ReportResult<HgbBilanzReport>>;
  getReportingReport(scope: TenantScope, args: { kind: ReportKind; from?: string; to?: string; asOfDate?: string }): Promise<ReportResult<object>>;
  getEurReport(scope: TenantScope, args?: { from?: string; to?: string; asOfDate?: string; chart?: 'SKR03' | 'SKR04'; product?: 'lite' | 'pro' }): Promise<ServerEurReportResult>;
  listEurCashItems(scope: TenantScope, args?: { from?: string; to?: string; product?: 'lite' | 'pro' }): Promise<ServerEurCashItem[]>;
  upsertEurClassification(scope: TenantScope, input: Omit<ServerEurClassificationRecord, 'id' | 'tenantId' | 'updatedAt'> & { product?: 'lite' | 'pro'; mutation?: AccountingMutationContext }): Promise<ServerEurClassificationRecord>;
  /** All documents of the tenant when `invoiceId` is omitted (Belege inbox). */
  listIncomingInvoiceDocuments(scope: TenantScope, invoiceId?: string): Promise<IncomingInvoiceDocumentEntity[]>;
  uploadIncomingInvoiceDocument(scope: TenantScope, input: IncomingInvoiceDocumentUploadInput): Promise<IncomingInvoiceDocumentEntity>;
  downloadIncomingInvoiceDocument(scope: TenantScope, documentId: string): Promise<IncomingInvoiceDocumentDownload>;
  reviewIncomingInvoiceDocument(scope: TenantScope, input: IncomingInvoiceDocumentReviewInput): Promise<IncomingInvoiceDocumentEntity>;
  listReportSnapshots(scope: TenantScope, reportType?: string): Promise<ReportSnapshotRecord[]>;
  getReportSnapshot(scope: TenantScope, id: string): Promise<ReportSnapshotRecord>;
  saveReportSnapshot(scope: TenantScope, input: { reportType: string; args: unknown; payload: unknown; mutation?: AccountingMutationContext }): Promise<ReportSnapshotRecord>;
  getAccountMappingHealth(scope: TenantScope, chart?: 'SKR03' | 'SKR04', reportType?: ReportMappingType, asOfDate?: string): Promise<{ chart: string; reportType?: string; unmapped: Array<{ accountNumber: string; statementType: string }> }>;
  listReportMappingPositions(scope: TenantScope, reportType: ReportMappingType, asOfDate: string): Promise<ReturnType<typeof listReportMappingPositions>>;
  upsertAccountMappingOverride(scope: TenantScope, input: { chart: 'SKR03' | 'SKR04'; asOfDate: string; accountNumber: string; statementType: ReportMappingType; positionKey: string; positionLabel: string; balanceSide?: 'asset' | 'liability'; mutation?: AccountingMutationContext }): Promise<unknown>;
};

/** The Stammdaten behind the Personenkonten (DATEV Debitoren/Kreditoren); numbers every party that has none yet. */
export const listDatevPartyRows = async (db: PostgresQueryable, scope: TenantScope, accountLength: number) => {
  const t = tenant(scope);
  await assignDatevPartyAccounts(db, t);
  const rows = await q<any>(db, `SELECT d.party_type,d.party_id,d.ordinal,c.company,c.contact_person,c.email c_email,c.address c_address,c.tax_profile_json,v.name v_name,v.email v_email,v.address v_address,v.vat_id
    FROM datev_party_accounts d
    LEFT JOIN clients c ON d.party_type='debtor' AND c.tenant_id=d.tenant_id AND c.id=d.party_id
    LEFT JOIN vendors v ON d.party_type='creditor' AND v.tenant_id=d.tenant_id AND v.id=d.party_id
    WHERE d.tenant_id=$1 ORDER BY d.party_type,d.ordinal`, [t]);
  // Addresses are free text; only "Straße\nPLZ Ort" is split into the DATEV fields.
  const address = (text: unknown) => {
    const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const place = lines.at(-1)?.match(/^(\d{4,5})\s+(.+)$/);
    return place && lines.length >= 2 ? { street: lines[0], postalCode: place[1], city: place[2] } : {};
  };
  return rows.map((row) => {
    const konto = datevPartyAccount(row.party_type, Number(row.ordinal), accountLength);
    if (row.party_type === 'creditor') return { konto, name: String(row.v_name ?? row.party_id), addresseeType: 2 as const, vatId: row.vat_id ?? undefined, email: row.v_email ?? undefined, ...address(row.v_address) };
    if (row.company == null) return { konto, name: String(row.party_id), addresseeType: 0 as const };
    const profile: { type?: string; countryCode?: string; vatId?: string } = (() => { try { return JSON.parse(row.tax_profile_json ?? 'null') ?? {}; } catch { return {}; } })();
    return { konto, name: String(row.company || row.contact_person || row.party_id), addresseeType: profile.type === 'consumer' ? 1 as const : 2 as const, vatId: profile.vatId, country: profile.countryCode, email: row.c_email ?? undefined, ...address(row.c_address) };
  });
};

export const createPostgresProAccountingRepository = (db: PostgresQueryable): ProAccountingReportRepository => ({
  ...createPostgresAccountingSourceRunRepository(db),
  listAccountingPeriods: (scope, year) => listAccountingPeriods(db, scope, year),
  async listBankTransactionDocuments(scope, transactionId) {
    return (await q<any>(db, `SELECT id,tenant_id,bank_transaction_id,original_filename,mime_type,byte_length,sha256,created_at FROM bank_transaction_documents WHERE tenant_id=$1 AND bank_transaction_id=$2 ORDER BY created_at,id`, [tenant(scope), transactionId])).map(rowBankTransactionDocument);
  },
  async uploadBankTransactionDocument(scope, input) {
    if (!input.mutation.reason?.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    assertIncomingInvoiceDocumentInput({ incomingInvoiceId: input.transactionId, originalFilename: input.originalFilename, mimeType: input.mimeType, content: input.content });
    return inTx(db, async (tx) => {
      const t = tenant(scope);
      if (!(await q<any>(tx, `SELECT id FROM bank_transactions WHERE tenant_id=$1 AND id=$2`, [t, input.transactionId]))[0]) throw Object.assign(new Error('BANK_TRANSACTION_NOT_FOUND: Diese Bankzeile gibt es nicht.'), { statusCode: 404 });
      const content = Buffer.from(input.content);
      const sha256 = createHash('sha256').update(content).digest('hex');
      // The same file again on the same line is the archived Beleg, not a second one.
      const inserted = await q<any>(tx, `INSERT INTO bank_transaction_documents (id,tenant_id,bank_transaction_id,original_filename,mime_type,byte_length,sha256,content_bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,bank_transaction_id,sha256) DO NOTHING RETURNING id`, [randomUUID(), t, input.transactionId, input.originalFilename.trim(), input.mimeType, content.byteLength, sha256, content, now()]);
      const saved = rowBankTransactionDocument((await q<any>(tx, `SELECT * FROM bank_transaction_documents WHERE tenant_id=$1 AND bank_transaction_id=$2 AND sha256=$3`, [t, input.transactionId, sha256]))[0]);
      if (inserted[0]) await audit(tx as PostgresTransactionClient, scope, 'bank_transaction_document', saved.id, 'upload', input.mutation.reason.trim(), null, saved, input.mutation);
      return saved;
    });
  },
  async downloadBankTransactionDocument(scope, documentId) {
    const row = (await q<any>(db, `SELECT * FROM bank_transaction_documents WHERE tenant_id=$1 AND id=$2`, [tenant(scope), documentId]))[0];
    if (!row) throw Object.assign(new Error('BANK_TRANSACTION_DOCUMENT_NOT_FOUND: Diesen Beleg gibt es nicht.'), { statusCode: 404 });
    const content = incomingInvoiceDocumentContent(row.content_bytes);
    if (content.byteLength !== Number(row.byte_length) || createHash('sha256').update(content).digest('hex') !== row.sha256) throw new Error('INCOMING_INVOICE_DOCUMENT_HASH_MISMATCH');
    return { document: rowBankTransactionDocument(row), content };
  },
  async updateDraftExceptionCase(scope, input) {
    if (!input.mutation.reason?.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    // An untouched line gets its draft first, as opening it in the editor would.
    await this.getDraftByTransactionId(scope, input.transactionId);
    return inTx(db, async (tx) => {
    const t = tenant(scope);
    const row = (await q<any>(tx, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND transaction_id=$2 FOR UPDATE`, [t, input.transactionId]))[0];
    if (!row) throw Object.assign(new Error('BANK_TRANSACTION_NOT_FOUND: Zu dieser Bankzeile gibt es keinen Buchungsentwurf.'), { statusCode: 404 });
    const value = parse<Partial<BookingDraftEntity>>(row.draft_json, {});
    const before = value.exceptionCase ?? null;
    const merged: DraftExceptionCase = { state: 'open', ...(before ?? {}) };
    for (const [key, next] of Object.entries(input.patch) as Array<[keyof DraftExceptionCase, string | undefined]>) { if (next === undefined) continue; if (next === '' && key !== 'state') delete merged[key]; else (merged as unknown as Record<string, string>)[key] = next; }
    const updatedAt = now();
    await q(tx, `UPDATE booking_drafts SET draft_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify({ ...value, exceptionCase: merged, updatedAt }), updatedAt, t, row.id]);
    await audit(tx as PostgresTransactionClient, scope, 'booking_draft', row.id, 'exception_update', input.mutation.reason.trim(), before, merged, input.mutation);
    return (await getDraft(tx, scope, input.transactionId))!;
  }); },
  async listOpenItemPayments(scope) {
    // What each payment settled (invoice numbers, customer or vendor) for the OPOS list; a Storno keeps its history.
    const rows = await q<any>(db, `SELECT p.*,
        (SELECT string_agg(DISTINCT oi.document_number, ', ') FROM open_item_allocations a JOIN open_items oi ON oi.tenant_id=a.tenant_id AND oi.id=a.open_item_id
          WHERE a.tenant_id=p.tenant_id AND a.payment_id=p.id AND a.amount>0 AND COALESCE(oi.document_number,'')<>'') AS document_numbers,
        COALESCE((SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(i.client),''), v.name), ', ') FROM open_item_allocations a JOIN open_items oi ON oi.tenant_id=a.tenant_id AND oi.id=a.open_item_id
            LEFT JOIN invoices i ON i.tenant_id=oi.tenant_id AND oi.source_type='outgoing_invoice' AND i.id=oi.source_id
            LEFT JOIN incoming_invoices ii ON ii.tenant_id=oi.tenant_id AND oi.source_type='incoming_invoice' AND ii.id=oi.source_id
            LEFT JOIN vendors v ON v.tenant_id=oi.tenant_id AND v.id=ii.vendor_id
          WHERE a.tenant_id=p.tenant_id AND a.payment_id=p.id AND a.amount>0),
          (SELECT NULLIF(btrim(bt.counterparty),'') FROM bank_transactions bt WHERE p.source_type='bank_transaction' AND bt.tenant_id=p.tenant_id AND bt.id=p.source_id)) AS party_name
      FROM open_item_payments p WHERE p.tenant_id=$1 ORDER BY p.payment_date DESC,p.created_at DESC,p.id`, [tenant(scope)]);
    return rows.map((row) => ({ ...rowPayment(row), ...(row.document_numbers ? { documentNumbers: row.document_numbers } : {}), ...(row.party_name ? { partyName: row.party_name } : {}) }));
  },
  reverseOpenItemPayment: (scope, input) => inTx(db, (tx) => reverseOpenItemPaymentInTransaction(tx, scope, input)),
  // Umbuchung: Zahlungsstorno and the new allocation of the same money in one transaction, under one reason.
  reallocateOpenItemPayment: (scope, input) => inTx(db, async (tx) => {
    const original = (await q<any>(tx, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), input.paymentId]))[0];
    if (!original) throw new Error('OPEN_ITEM_PAYMENT_NOT_FOUND');
    // A payment recorded on an invoice moves as a whole to another issued invoice: it leaves the list of the
    // first invoice and joins the list of the second, booked there. A split or a refund is reversed and recorded anew.
    const listedOn = original.source_type === 'invoice_payment' ? await invoicePaymentListing(tx, tenant(scope), original, input.allocations) : undefined;
    const reversal = await reverseOpenItemPaymentInTransaction(tx, scope, { paymentId: input.paymentId, reason: input.reason, mutation: input.mutation });
    if (listedOn) await q(tx, `UPDATE invoices SET payments_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify([...parse<any[]>(listedOn.target.payments_json, []), listedOn.entry]), now(), tenant(scope), listedOn.target.id]);
    const payment = await allocatePayment(tx, scope, {
      sourceType: original.source_type, sourceId: original.source_id, partyType: original.party_type, partyId: input.partyId,
      paymentDate: original.payment_date, amount: Number(original.amount), bankAccountNumber: original.bank_account_number, method: original.method ?? undefined,
      allocations: input.allocations, allocationEventId: input.allocationEventId, mutation: input.mutation, reason: input.reason,
      bookingText: `Zahlung (Umbuchung): ${input.reason.trim()}`,
    });
    return { reversal, payment };
  }),
  setAccountingPeriodStatus: (scope, input) => setAccountingPeriodStatus(db, scope, input),
  postManualJournalEntry: (scope, input) => inTx(db, (tx) => postManualJournalEntryInTransaction(tx, scope, input)),
  async getBankLedgerReconciliation(scope) {
    const t = tenant(scope);
    const lines = await q<any>(db, `SELECT account_id, COUNT(*) FILTER (WHERE booked)::int booked_count, COALESCE(SUM(signed) FILTER (WHERE booked),0) booked_total, COUNT(*) FILTER (WHERE NOT booked)::int pending_count, COALESCE(SUM(signed) FILTER (WHERE NOT booked),0) pending_total
      FROM (SELECT account_id, (status='booked' OR linked_invoice_id IS NOT NULL) booked, CASE WHEN type='income' THEN ABS(amount) ELSE -ABS(amount) END signed FROM bank_transactions WHERE tenant_id=$1) b GROUP BY account_id ORDER BY account_id`, [t]);
    const rows = new Map<string, BankLedgerReconciliationRow>();
    for (const line of lines) {
      const ledgerAccountNumber = await bankLedgerAccount(db, t, line.account_id);
      const row = rows.get(ledgerAccountNumber) ?? { ledgerAccountNumber, bankAccountIds: [], bookedBankTotal: 0, pendingCount: 0, pendingTotal: 0, ledgerBalance: 0, difference: 0 };
      if (line.account_id) row.bankAccountIds.push(String(line.account_id));
      row.bookedBankTotal = round(row.bookedBankTotal + Number(line.booked_total));
      row.pendingCount += Number(line.pending_count);
      row.pendingTotal = round(row.pendingTotal + Number(line.pending_total));
      rows.set(ledgerAccountNumber, row);
    }
    if (!rows.size) return [];
    const balances = await q<any>(db, `SELECT jl.account_number, COALESCE(SUM(jl.debit_amount-jl.credit_amount),0) balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND jl.account_number = ANY($2::text[]) GROUP BY jl.account_number`, [t, [...rows.keys()]]);
    for (const balance of balances) { const row = rows.get(String(balance.account_number)); if (row) row.ledgerBalance = round(balance.balance); }
    return [...rows.values()].map((row) => ({ ...row, difference: round(row.ledgerBalance - row.bookedBankTotal) })).sort((a, b) => a.ledgerAccountNumber.localeCompare(b.ledgerAccountNumber));
  },
  async listBankTransactions(scope) {
    const [rows, suggestionContext] = await Promise.all([
      q<any>(db, `SELECT b.*, (SELECT count(*) FROM bank_transaction_documents d WHERE d.tenant_id=b.tenant_id AND d.bank_transaction_id=b.id) AS receipt_document_count FROM bank_transactions b WHERE b.tenant_id=$1 ORDER BY b.date DESC,b.id`, [tenant(scope)]),
      loadAccountSuggestionContext(db, scope),
    ]);
    return rows.map((r) => {
      const type: 'income' | 'expense' = r.type === 'income' ? 'income' : 'expense';
      // Same layers as the desktop SQLite repository: rule, remembered counterparty, Bayes, keyword, fallback.
      const suggestion = suggestAccountForTransaction(suggestionContext, { flowType: type, counterparty: r.counterparty ?? '', purpose: r.purpose ?? '' });
      return {
        id: r.id, tenantId: r.tenant_id, accountId: r.account_id, date: r.date, amount: Number(r.amount), type,
        counterparty: r.counterparty, purpose: r.purpose, status: r.status === 'booked' ? 'booked' : 'pending', linkedInvoiceId: r.linked_invoice_id ?? undefined,
        ...(Number(r.receipt_document_count) > 0 ? { receiptDocumentCount: Number(r.receipt_document_count) } : {}),
        suggestedAccountNumber: suggestion.accountNumber, suggestionReason: suggestion.reason, suggestionLayer: suggestion.layer, suggestionConfidence: suggestion.confidence,
      };
    });
  },
  async getDraftByTransactionId(scope, transactionId) { return inTx(db, async (tx) => { const existing = await getDraft(tx, scope, transactionId); /* A draft nobody has saved yet (imported/suggested) follows the current rules and open items; a person's draft stays. */ if (existing && !['imported', 'suggested'].includes(existing.workflowStatus)) return existing; const row = (await q<any>(tx, `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND id=$2`, [tenant(scope), transactionId]))[0]; if (!row) return existing; const p = await policy(tx, tenant(scope)); const m = await mappings(tx, tenant(scope), p.activeChart); const bankAccount = await bankLedgerAccount(tx, tenant(scope), row.account_id); const amount = round(Math.abs(row.amount)); const suggestion = row.status === 'booked' ? {} : suggestAccountForTransaction(await loadAccountSuggestionContext(tx, scope), { flowType: row.type === 'income' ? 'income' : 'expense', counterparty: row.counterparty ?? '', purpose: row.purpose ?? '' }); const suggested = suggestion.layer && suggestion.layer !== 'fallback' ? suggestion.accountNumber : undefined; const settles = row.status !== 'booked' && await paysOpenItem(tx, tenant(scope), row); const rememberedTax = suggested && !settles && String(row.counterparty ?? '').trim() ? await partnerTaxCase(tx, tenant(scope), row.counterparty, suggested) : undefined; if (existing) { const counter = existing.lines.findIndex((line) => line.accountNumber !== bankAccount); const target = settles ? (row.type === 'income' ? m.accounts_receivable : m.accounts_payable) : suggested; if (row.status === 'booked' || existing.lines.length !== 2 || counter < 0 || !target || existing.lines[counter]!.accountNumber === target) return existing; return saveDraftTarget(tx, scope, { ...existing, workflowStatus: 'suggested', lines: existing.lines.map((line, index) => index === counter ? (({ taxCaseKey: _previousTax, ...rest }) => ({ ...rest, accountNumber: target, ...(target === suggested && rememberedTax ? { taxCaseKey: rememberedTax } : {}) }))(line) : line), updatedAt: now() }); } const draft: BookingDraftEntity = { id: `draft-${row.id}`, tenantId: tenant(scope), transactionId: row.id, workflowStatus: row.status === 'booked' ? 'posted' : suggested ? 'suggested' : 'imported', postingDate: row.date, documentDate: row.date, bookingText: row.purpose || (row.type === 'income' ? 'Einnahme' : 'Ausgabe'), /* The Beleg is the person's to name; the internal transaction id is no Belegnummer. */ reference: undefined, period: period(row.date), fiscalYear: await reportingFiscalYear(tx, tenant(scope), row.date), lines: [{ id: `draft-${row.id}-1`, accountNumber: row.type === 'income' ? bankAccount : settles ? m.accounts_payable : suggested ?? m.expense, debitAmount: amount, creditAmount: 0, ...(row.type !== 'income' && rememberedTax ? { taxCaseKey: rememberedTax } : {}) }, { id: `draft-${row.id}-2`, accountNumber: row.type === 'income' ? settles ? m.accounts_receivable : suggested ?? m.revenue : bankAccount, debitAmount: 0, creditAmount: amount, ...(row.type === 'income' && rememberedTax ? { taxCaseKey: rememberedTax } : {}) }], validationIssues: [], updatedAt: now() }; if (row.status !== 'booked') return saveDraftTarget(tx, scope, draft); const postedSourceDraft = (await q<any>(tx, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND source_draft_id=$2 AND status='posted' LIMIT 1`, [tenant(scope), draft.id]))[0]; return postedSourceDraft ? draft : { ...draft, isVirtualProjection: true }; }); },
  async saveDraft(scope, draft) { return inTx(db, (tx) => saveDraftTarget(tx, scope, draft, draft.mutation)); },
  async dispatchDraftAction(scope, args) { return inTx(db, async (tx) => { const draft = await getDraft(tx, scope, args.transactionId); if (!draft) throw new Error('Draft not found'); const transitions: Record<string, string[]> = { imported: ['suggested','incomplete','pending_approval'], suggested: ['suggested','incomplete','pending_approval'], incomplete: ['suggested','incomplete','pending_approval'], ready_for_review: ['pending_approval'], pending_approval: ['approved','incomplete'], approved: ['approved'], posted: ['reversed'], reversed: ['corrected'], corrected: ['suggested','incomplete','pending_approval'], period_locked: ['incomplete','suggested'], integration_error: ['incomplete','suggested'] }; const targets: Record<string, string> = { save_draft: 'suggested', submit_for_review: 'pending_approval', approve: 'approved', reject: 'incomplete', post: 'approved', reverse: 'reversed', create_correction: 'corrected', request_receipt: 'incomplete' }; const target = targets[args.action]; if (!transitions[draft.workflowStatus]?.includes(target)) throw new Error(`Invalid workflow transition: ${draft.workflowStatus} -> ${target}`); return saveDraftTarget(tx, scope, { ...draft, workflowStatus: target as BookingDraftEntity['workflowStatus'], validationIssues: args.action === 'reject' && args.rejectReason ? [{ id: randomUUID(), code: 'MANUAL_REVIEW_REJECTED', severity: 'warning', message: args.rejectReason, blocking: false, source: 'user' }] : draft.validationIssues }, args.mutation); }); },
  async validateTaxCompliance(scope, args) { const draft = args.draftId ? (await q<any>(db, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND id=$2`, [tenant(scope), args.draftId]))[0] : args.transactionId ? await getDraft(db, scope, args.transactionId) : null; if (!draft) throw new Error('Draft not found'); if ('draft_json' in draft) { const lines = await q<any>(db, `SELECT * FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2 ORDER BY line_no`, [tenant(scope), draft.id]); const issues = await q<any>(db, `SELECT * FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [tenant(scope), draft.id]); const parsed = draftFromRows(draft, lines, issues, scope); const saved = await inTx(db, (tx) => saveDraftTarget(tx, scope, parsed, args.mutation)); return { ok: !saved.validationIssues.some((x) => x.blocking), issues: saved.validationIssues }; } return { ok: !(draft as BookingDraftEntity).validationIssues.some((x) => x.blocking), issues: (draft as BookingDraftEntity).validationIssues }; },
  async postDraft(scope, draftId, options: PostDraftOptions = {}) { return inTx(db, async (tx) => { const t = tenant(scope); /* Booked again after a Storno: its own key per round, so the replay below finds this round's entry and the old one stays. */ const earlier = Number((await q<any>(tx, `SELECT count(*) AS n FROM journal_entries WHERE tenant_id=$1 AND source_draft_id=$2 AND status='reversed'`, [t, draftId]))[0]?.n ?? 0); const sourceKey = options.idempotencyKey?.trim() || (earlier ? `booking-draft:${draftId}:${earlier + 1}` : `booking-draft:${draftId}`); /* A replay returns the live entry; a reversed one is never handed back as a fresh posting. */ const existing = await q<any>(tx, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND source_type='booking_draft' AND source_key=$2 AND status='posted'`, [t, sourceKey]); if (existing[0]) return { entry: (await loadEntry(tx, scope, existing[0].id))!, issues: [] }; const rows = await q<any>(tx, `SELECT * FROM booking_drafts WHERE tenant_id=$1 AND id=$2`, [t, draftId]); if (!rows[0]) throw new Error('Draft not found'); const lines = await q<any>(tx, `SELECT * FROM booking_draft_lines WHERE tenant_id=$1 AND draft_id=$2 ORDER BY line_no`, [t, draftId]); const savedIssues = await q<any>(tx, `SELECT * FROM draft_validation_issues WHERE tenant_id=$1 AND draft_id=$2`, [t, draftId]); const draft = draftFromRows(rows[0], lines, savedIssues, scope); const bankLine = (await q<any>(tx, `SELECT status,linked_invoice_id,account_id,amount,type FROM bank_transactions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, draft.transactionId]))[0]; if (!bankLine) throw new Error('BANK_TRANSACTION_NOT_FOUND: Ein Buchungsentwurf ohne Bankzeile wird nicht gebucht; das ist eine freie Buchung mit Beleg.'); if (bankLine.status === 'booked' || bankLine.linked_invoice_id) throw new Error('PAYMENT_SOURCE_ALREADY_BOOKED'); const postingDate = options.postingDate ?? draft.postingDate; const p = await policy(tx, t); const fiscalYear = postingDate && isoDate(postingDate) ? await reportingFiscalYear(tx, t, postingDate) : draft.fiscalYear; const periodStatus = postingDate && isoDate(postingDate) ? await ensurePeriod(tx, scope, period(postingDate), postingDate) : 'open'; const issues = await validateDraft(tx, scope, { ...draft, postingDate, period: postingDate ? period(postingDate) : draft.period, fiscalYear }, periodStatus, p.activeChart, bankLine); if (rows[0].workflow_status !== 'approved') issues.push(issue('DRAFT_NOT_APPROVED', 'Nur freigegebene Entwürfe dürfen gebucht werden.')); if (periodStatus === 'soft_locked' && (!options.softLockOverride || !options.overrideReason?.trim())) issues.push(issue('SOFT_LOCK_OVERRIDE_REQUIRED', 'Vorläufig gesperrte Periode benötigt Freigabe und Begründung.')); if (issues.some((x) => x.blocking)) return { entry: { id: '', tenantId: t, entryNumber: 0, postingDate: postingDate ?? '', bookingText: draft.bookingText, period: draft.period, fiscalYear, status: 'posted', createdAt: now(), lines: [] }, issues }; const normalized = { ...draft, postingDate: postingDate!, period: period(postingDate!), fiscalYear }; const postingLines = await draftPostingLines(tx, t, p.activeChart, normalized.lines, postingDate!, await bankLedgerAccount(tx, t, bankLine.account_id)); /* The reversed round still owns the draft's line ids. */ const roundIds = earlier ? postingLines.map((line) => ({ ...line, id: `${line.id || randomUUID()}-r${earlier + 1}` })) : postingLines; /* A Beleg archived on the bank line is the evidence of every posting line that names none. */ const belege = await q<any>(tx, `SELECT original_filename FROM bank_transaction_documents WHERE tenant_id=$1 AND bank_transaction_id=$2 ORDER BY created_at,id`, [t, draft.transactionId]); const beleg = belege.length ? `${belege[0].original_filename}${belege.length > 1 ? ` (+${belege.length - 1})` : ''}` : undefined; const roundLines = beleg ? roundIds.map((line) => line.evidenceReference ? line : { ...line, evidenceType: 'bank_document', evidenceReference: beleg }) : roundIds; const entryId = await insertEntry(tx, scope, 'booking_draft', sourceKey, postingDate!, normalized.bookingText, roundLines, { documentDate: normalized.documentDate, reference: normalized.reference, sourceDraftId: normalized.id, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation }); await q(tx, `UPDATE booking_drafts SET workflow_status='posted',draft_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify({ ...normalized, workflowStatus: 'posted' }), now(), t, draftId]); await q(tx, `UPDATE bank_transactions SET status='booked',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), t, draft.transactionId]); return { entry: (await loadEntry(tx, scope, entryId))!, issues: [] }; }); },
  async reverseJournalEntry(scope, entryId, reason, options: ReverseJournalEntryOptions = {}) { return inTx(db, (tx) => reverseEntryInTransaction(tx, scope, entryId, reason, options)); },
  async listJournalEntries(scope, args = {}) { const t = tenant(scope); const values: unknown[] = [t]; const where = ['tenant_id=$1']; if (args.from) { values.push(args.from); where.push(`posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); where.push(`posting_date <= $${values.length}`); } if (args.accountNumbers?.length) { values.push(args.accountNumbers); where.push(`id IN (SELECT entry_id FROM journal_lines WHERE tenant_id=$1 AND account_number = ANY($${values.length}))`); } if (args.sourceDraftId) { values.push(args.sourceDraftId); where.push(`source_draft_id = $${values.length}`); } values.push(Math.max(1, Math.min(5000, args.limit ?? 500)), Math.max(0, args.offset ?? 0)); const rows = await q<any>(db, `SELECT * FROM journal_entries WHERE ${where.join(' AND ')} ORDER BY posting_date DESC,entry_number DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values); return Promise.all(rows.map((r) => loadEntry(db, scope, r.id))).then((items) => items.filter(Boolean) as JournalEntryEntity[]); },
  async getJournalEntryById(scope, entryId) { return loadEntry(db, scope, entryId); },
  async getLedgerBalances(scope, args = {}) {
    const t = tenant(scope);
    const asOf = args.to ?? args.asOfDate;
    const from = args.fromDate ?? args.from ?? (asOf ? `${asOf.slice(0, 4)}-01-01` : undefined);
    const yearStart = await yearStartOf(db, t, from);
    const chart = (await policy(db, t)).activeChart;
    const rows = await q<any>(db, `SELECT jl.account_number,COALESCE(SUM(CASE WHEN $4::text IS NOT NULL AND je.posting_date < $4 THEN jl.debit_amount-jl.credit_amount ELSE 0 END),0) opening_prior,COALESCE(SUM(CASE WHEN $3::text IS NOT NULL AND je.posting_date < $3 AND ($4::text IS NULL OR je.posting_date >= $4) THEN jl.debit_amount-jl.credit_amount ELSE 0 END),0) opening_year,COALESCE(SUM(CASE WHEN $3::text IS NULL OR je.posting_date >= $3 THEN jl.debit_amount ELSE 0 END),0) debit,COALESCE(SUM(CASE WHEN $3::text IS NULL OR je.posting_date >= $3 THEN jl.credit_amount ELSE 0 END),0) credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${yearOpeningJournal('$4')} AND ($2::text IS NULL OR je.posting_date <= $2) GROUP BY jl.account_number ORDER BY jl.account_number`, [t, asOf ?? null, from ?? null, yearStart]);
    const folded = await foldYearOpening(db, t, chart, rows, (accountNumber) => ({ account_number: accountNumber, opening_prior: 0, opening_year: 0, debit: 0, credit: 0 }));
    return folded.map((r) => ({ accountNumber: String(r.account_number), openingBalance: round(r.opening_balance), debitTurnover: round(r.debit), creditTurnover: round(r.credit), closingBalance: round(r.opening_balance + Number(r.debit) - Number(r.credit)) } as LedgerBalance));
  },
  async getSusaReport(scope, args = {}) {
    const requestedChart = (args as typeof args & { chart?: 'SKR03' | 'SKR04' }).chart;
    if (requestedChart) {
      const p = await policy(db, tenant(scope));
      if (requestedChart !== p.activeChart) throw new Error('REPORT_CHART_MISMATCH');
    }
    const fromDate = args.fromDate ?? args.from;
    const asOfDate = args.to ?? args.asOfDate;
    const balances = await this.getLedgerBalances(scope, { ...args, fromDate, asOfDate });
    const chart = requestedChart ?? (await policy(db, tenant(scope))).activeChart;
    const names = new Map((await q<any>(db, `SELECT n.account_number,COALESCE(t.name,g.name) AS name FROM unnest($3::text[]) AS n(account_number) LEFT JOIN tenant_ledger_accounts t ON t.tenant_id=$1 AND t.chart=$2 AND t.account_number=n.account_number LEFT JOIN ledger_accounts g ON g.chart=$2 AND g.account_number=n.account_number`, [tenant(scope), chart, balances.map((row) => row.accountNumber)])).map((row) => [String(row.account_number), row.name == null ? undefined : String(row.name)]));
    const rows = balances.map((row) => ({ ...row, accountName: names.get(row.accountNumber) }));
    return { from: fromDate, to: asOfDate, chart: requestedChart, asOfDate: asOfDate ?? now().slice(0, 10), rows, totals: { debit: round(rows.reduce((s, r) => s + r.debitTurnover, 0)), credit: round(rows.reduce((s, r) => s + r.creditTurnover, 0)), balance: round(rows.reduce((s, r) => s + r.closingBalance, 0)) } };
  },
  async getBwa01Report(scope, args = {}) {
    return calculateDatabaseReport(db, scope, 'bwa01', args);
  },
  async getGuvReport(scope, args: { from?: string; to?: string; chart?: 'SKR03' | 'SKR04'; profile?: 'guv' | 'management-guv' | 'hgb-guv' } = {}) {
    return calculateDatabaseReport(db, scope, args.profile ?? 'guv', args);
  },
  async getBilanzReport(scope, args = {}) {
    return calculateDatabaseReport(db, scope, 'hgb-bilanz', args);
  },
  async getEurReport(scope, args = {}) {
    if (args.chart) throw new Error('EUR_CHART_NOT_APPLICABLE');
    if (args.asOfDate && args.asOfDate !== '2025-12-31') throw new Error('EUR_RANGE_2025_REQUIRED');
    return getServerEurReport(db, scope, args);
  },
  async listEurCashItems(scope, args = {}) {
    return listServerEurCashItems(db, scope, args);
  },
  async upsertEurClassification(scope, input) {
    const mutationReason = input.mutation?.reason?.trim();
    if (!mutationReason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    const sourceType = input.sourceType === 'transaction' || input.sourceType === 'invoice' ? input.sourceType : undefined;
    if (!sourceType) throw new Error('EUR_SOURCE_TYPE_INVALID');
    return inTx(db, async (tx) => {
      await assertServerEurProfile(tx, scope, {});
      const source = await assertServerEurCashSource(tx, scope, sourceType, input.sourceId, input.product ?? 'pro');
      if (input.taxYear !== 2025) throw new Error('EUR_RANGE_2025_REQUIRED');
      if (input.eurLineId) {
        const line = (await q<any>(tx, `SELECT kind FROM eur_lines WHERE id=$1 AND tax_year=2025 LIMIT 1`, [input.eurLineId]))[0];
        if (!line) throw new Error('EUR_LINE_NOT_FOUND');
        if (line.kind === 'computed') throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
        if (!input.excluded && (line.kind === 'income' || line.kind === 'expense') && line.kind !== source.flowType) throw new Error('EUR_LINE_FLOW_MISMATCH');
      }
      const existing = (await q<any>(tx, `SELECT * FROM eur_classifications WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND tax_year=$4 LIMIT 1`, [tenant(scope), sourceType, input.sourceId, input.taxYear]))[0];
      const record: ServerEurClassificationRecord = {
        id: String(existing?.id ?? randomUUID()), tenantId: tenant(scope), sourceType, sourceId: input.sourceId, taxYear: 2025,
        eurLineId: input.excluded ? undefined : input.eurLineId, excluded: input.excluded === true, vatMode: input.vatMode ?? 'none', vatRate: input.vatRate, note: input.note, updatedAt: now(),
      };
      await saveServerEurClassification(tx, record);
      await audit(tx as PostgresTransactionClient, scope, 'eur_classification', `${record.sourceType}:${record.sourceId}:2025`, existing ? 'update' : 'create', mutationReason, existing ?? null, record, input.mutation);
      return record;
    });
  },
  async getReportingReport(scope, args) {
    const kind = args.kind.replaceAll('_', '-');
    if (kind === 'bwa01') return calculateDatabaseReport(db, scope, 'bwa01', args);
    if (kind === 'management-guv') return calculateDatabaseReport(db, scope, 'management-guv', args);
    if (kind === 'hgb-guv') return calculateDatabaseReport(db, scope, 'hgb-guv', args);
    if (kind === 'hgb-bilanz') return calculateDatabaseReport(db, scope, 'hgb-bilanz', args);
    throw new Error(`REPORT_KIND_UNAVAILABLE:${args.kind}`);
  },
  async listReportSnapshots(scope, reportType) { return listReportSnapshots(db, scope, reportType); },
  async getReportSnapshot(scope, id) { const snapshot = await getReportSnapshot(db, scope, id); if (!snapshot) throw new Error('REPORT_SNAPSHOT_NOT_FOUND'); return snapshot; },
  async saveReportSnapshot(scope, input) {
    return inTx(db, async (tx) => {
      const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>;
      const payload = input.payload && typeof input.payload === 'object' ? input.payload as Record<string, unknown> : {};
      const health = payload.mappingHealth && typeof payload.mappingHealth === 'object' ? payload.mappingHealth as Record<string, unknown> : undefined;
      const blocked = input.reportType !== 'susa' && (health?.blocking === true || payload.blocking === true || payload.complete === false || (input.reportType.includes('eur') && Array.isArray(payload.unmatchedCashEntries) && payload.unmatchedCashEntries.length > 0));
      if (blocked) throw new Error('REPORT_SNAPSHOT_BLOCKED_INCOMPLETE_MAPPING');
      const argsJson = canonicalJson(args);
      const payloadJson = canonicalJson(input.payload);
      const positions = snapshotPositions(input.payload);
      const sourceHash = hashReportSource(canonicalize({ reportType: input.reportType, args, payload: input.payload, mappingRefs: positions.map((position) => ({ positionKey: position.positionKey, metadataJson: position.metadataJson })) }));
      const snapshot = await createReportSnapshot(tx, scope, { reportType: input.reportType, argsJson, payloadJson, sourceHash, fromDate: typeof args.from === 'string' ? args.from : undefined, toDate: typeof args.to === 'string' ? args.to : undefined, asOfDate: typeof args.asOfDate === 'string' ? args.asOfDate : undefined, positions });
      await audit(tx as PostgresTransactionClient, scope, 'report_snapshot', snapshot.id, 'create', input.mutation?.reason ?? 'Report snapshot created', null, { reportType: input.reportType, args, sourceHash }, input.mutation);
      return snapshot;
    });
  },
  async getAccountMappingHealth(scope, chart, reportType, asOfDate) {
    const p = await policy(db, tenant(scope));
    const activeChart = chart ?? p.activeChart;
    if (chart && chart !== p.activeChart) throw new Error('REPORT_CHART_MISMATCH');
    const requested = reportType ?? 'management-guv';
    // Reports are currently catalogued for 2025. Keep the fallback explicit so
    // omitted legacy callers never drift with wall-clock time.
    const effectiveAsOfDate = asOfDate ?? '2025-12-31';
    const rows = await q<any>(db, `SELECT DISTINCT jl.account_number,$3::text AS statement_type FROM journal_lines jl LEFT JOIN report_account_mappings relevant ON relevant.tenant_id=jl.tenant_id AND relevant.chart=$2 AND relevant.account_number=jl.account_number AND relevant.report_type = ANY($4::text[]) AND (relevant.valid_from IS NULL OR relevant.valid_from::date <= $5::date) AND (relevant.valid_to IS NULL OR relevant.valid_to::date >= $5::date) LEFT JOIN report_account_mappings current_mapping ON current_mapping.tenant_id=jl.tenant_id AND current_mapping.chart=$2 AND current_mapping.account_number=jl.account_number AND current_mapping.report_type=$3 AND (current_mapping.valid_from IS NULL OR current_mapping.valid_from::date <= $5::date) AND (current_mapping.valid_to IS NULL OR current_mapping.valid_to::date >= $5::date) WHERE jl.tenant_id=$1 AND (relevant.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM report_account_mappings any_mapping WHERE any_mapping.tenant_id=jl.tenant_id AND any_mapping.chart=$2 AND any_mapping.account_number=jl.account_number AND (any_mapping.valid_from IS NULL OR any_mapping.valid_from::date <= $5::date) AND (any_mapping.valid_to IS NULL OR any_mapping.valid_to::date >= $5::date))) AND current_mapping.id IS NULL ORDER BY jl.account_number`, [tenant(scope), activeChart, requested, requested === 'hgb-bilanz' ? ['hgb-bilanz'] : ['bwa01', 'management-guv', 'hgb-guv'], effectiveAsOfDate]);
    const excluded = await eurBalanceAccounts(db, scope, activeChart, requested);
    // An account covered by the range default is not unmapped: a balance-sheet default (or a GuV/BWA default for the
    // HGB families and the BWA) settles it; the management GuV still needs its own mapping for P&L accounts.
    const size = await reportProfile(db, tenant(scope), activeChart, requested).then((profile) => profile.size, () => 'small' as const);
    const covered = new Set(defaultReportMappings(activeChart, rows.map((row) => String(row.account_number)), size, effectiveAsOfDate, () => false, requested === 'bwa01' ? 'bwa01' : 'hgb-guv')
      .filter((mapping) => mapping.statement === 'hgb-bilanz' || mapping.statement === 'bwa01' || requested === 'hgb-guv' || requested === 'hgb-bilanz').map((mapping) => mapping.accountNumber));
    return { chart: activeChart, reportType: requested, unmapped: rows.filter((row) => !excluded.has(String(row.account_number)) && !covered.has(String(row.account_number))).map((r) => ({ accountNumber: String(r.account_number), statementType: String(r.statement_type) })) };
  },
  async listReportMappingPositions(scope, reportType, asOfDate) {
    const p = await policy(db, tenant(scope));
    const profile = await reportProfile(db, tenant(scope), p.activeChart, reportType);
    return listReportMappingPositions(reportType, profile.size, asOfDate);
  },
  async upsertAccountMappingOverride(scope, input) {
    return inTx(db, async (tx) => {
      const t = tenant(scope);
      const accountNumber = input.accountNumber.trim();
      const positionKey = input.positionKey.trim();
      const positionLabel = input.positionLabel.trim();
      if (!accountNumber || !positionKey || !positionLabel) throw new Error('REPORT_MAPPING_REQUIRED');
      await validateReportMappingPosition(tx, scope, input);
      const stamp = now();
      const reportType = input.statementType;
      const existing = (await q<any>(tx, `SELECT id,version FROM report_account_mappings WHERE tenant_id=$1 AND report_type=$2 AND chart=$3 AND account_number=$4 AND valid_from=$5 LIMIT 1`, [t, reportType, input.chart, accountNumber, input.asOfDate]))[0] as { id?: string; version?: number } | undefined;
      const version = Number(existing?.version ?? (await q<any>(tx, `SELECT COALESCE(MAX(version),0)+1 AS version FROM report_account_mappings WHERE tenant_id=$1 AND report_type=$2 AND chart=$3 AND account_number=$4`, [t, reportType, input.chart, accountNumber]))[0]?.version ?? 1);
      const storedPosition = input.balanceSide ? `${input.balanceSide}:${positionKey}` : positionKey;
      const id = existing?.id ?? `report-override:${t}:${input.chart}:${accountNumber}:${reportType}:${input.asOfDate}`;
      const sourceHash = hash({ reportType, chart: input.chart, accountNumber, positionKey: storedPosition, positionLabel, validFrom: input.asOfDate });
      await q(tx, `INSERT INTO report_account_mappings (id,tenant_id,report_type,chart,account_number,position_key,position_label,valid_from,valid_to,version,source,source_hash,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,'tenant_override',$10,$11,$12) ON CONFLICT (id) DO UPDATE SET position_key=EXCLUDED.position_key,position_label=EXCLUDED.position_label,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,version=EXCLUDED.version,source=EXCLUDED.source,source_hash=EXCLUDED.source_hash,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at`, [id, t, reportType, input.chart, accountNumber, storedPosition, positionLabel, input.asOfDate, version, sourceHash, input.mutation?.actor?.displayName ?? null, stamp]);
      await audit(tx as PostgresTransactionClient, scope, 'report_account_mapping', `${input.chart}:${reportType}:${accountNumber}`, 'override', input.mutation?.reason ?? 'Report mapping override', null, input, input.mutation);
      const row = (await q<any>(tx, `SELECT id,tenant_id,report_type,chart,account_number,position_key,position_label,valid_from,valid_to,version,source,source_hash,created_by,created_at FROM report_account_mappings WHERE tenant_id=$1 AND id=$2`, [t, id]))[0];
      return { id: row.id, tenantId: row.tenant_id, reportType: row.report_type, chart: row.chart, accountNumber: row.account_number, positionKey: row.position_key, positionLabel: row.position_label, validFrom: row.valid_from ?? undefined, version: Number(row.version), source: row.source, sourceHash: row.source_hash, createdBy: row.created_by ?? undefined, createdAt: row.created_at };
    });
  },
  async listDatevExports(scope) { return (await q<any>(db, `SELECT * FROM datev_exports WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenant(scope)])).map((r) => { const metadata = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(r.meta_json, {}); return { id: r.id, filePath: r.file_path, recordCount: Number(r.record_count), fromDate: r.from_date ?? undefined, toDate: r.to_date ?? undefined, createdAt: r.created_at, contentSha256: metadata.contentSha256, encoding: metadata.encoding, headerVersion: metadata.headerVersion, formatVersion: metadata.formatVersion, chart: metadata.chart, sourceSnapshotHash: metadata.sourceSnapshot ? createHash('sha256').update(JSON.stringify(metadata.sourceSnapshot)).digest('hex') : undefined }; }); },
  async getDatevExportContent(scope, exportId): Promise<DatevExportContent> { const row = (await q<any>(db, `SELECT * FROM datev_exports WHERE tenant_id=$1 AND id=$2`, [tenant(scope), exportId]))[0]; if (!row) throw new Error('DATEV_EXPORT_NOT_FOUND'); if (!row.content_bytes) throw new Error('DATEV_EXPORT_CONTENT_UNAVAILABLE'); const content = new Uint8Array(row.content_bytes); const contentSha256 = createHash('sha256').update(content).digest('hex'); const metadata = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(row.meta_json, {}); if (metadata.contentSha256 && metadata.contentSha256 !== contentSha256) throw new Error('DATEV_EXPORT_HASH_MISMATCH'); return { id: row.id, filePath: row.file_path, recordCount: Number(row.record_count), fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined, createdAt: row.created_at, contentSha256, content, encoding: metadata.encoding, headerVersion: metadata.headerVersion, formatVersion: metadata.formatVersion, chart: metadata.chart, sourceSnapshotHash: metadata.sourceSnapshot ? createHash('sha256').update(JSON.stringify(metadata.sourceSnapshot)).digest('hex') : undefined }; },
  async insertDatevExport(scope, args) { return inTx(db, async (tx) => { const existing = (await q<any>(tx, `SELECT * FROM datev_exports WHERE tenant_id=$1 AND file_path=$2`, [tenant(scope), args.filePath]))[0]; if (existing) { const existingMeta = parse<{ contentSha256?: string; encoding?: 'cp1252' | 'utf8-bom'; headerVersion?: number; formatVersion?: number; chart?: 'SKR03' | 'SKR04'; sourceSnapshot?: DatevExportSourceSnapshot }>(existing.meta_json, {}); return { id: existing.id, filePath: existing.file_path, recordCount: Number(existing.record_count), fromDate: existing.from_date ?? undefined, toDate: existing.to_date ?? undefined, createdAt: existing.created_at, contentSha256: existingMeta.contentSha256, encoding: existingMeta.encoding, headerVersion: existingMeta.headerVersion, formatVersion: existingMeta.formatVersion, chart: existingMeta.chart }; } const id = randomUUID(); const createdAt = now(); if (!args.content) throw new Error('DATEV_EXPORT_CONTENT_REQUIRED'); const content = Buffer.from(args.content); const contentSha256 = createHash('sha256').update(content).digest('hex'); if (args.contentSha256 && args.contentSha256 !== contentSha256) throw new Error('DATEV_EXPORT_HASH_MISMATCH'); const metadata = { immutable: true, contentSha256, encoding: args.encoding, headerVersion: args.headerVersion, formatVersion: args.formatVersion, chart: args.chart, sourceSnapshot: args.sourceSnapshot }; await q(tx, `INSERT INTO datev_exports (id,tenant_id,file_path,record_count,from_date,to_date,created_at,meta_json,content_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, tenant(scope), args.filePath, args.recordCount, args.fromDate ?? null, args.toDate ?? null, createdAt, JSON.stringify(metadata), content]); await audit(tx as PostgresTransactionClient, scope, 'pro_datev_export', id, 'export', 'DATEV export recorded', null, { ...args, content: undefined, contentSha256, mutation: undefined }, args.mutation); return { id, filePath: args.filePath, recordCount: args.recordCount, fromDate: args.fromDate, toDate: args.toDate, createdAt, contentSha256, encoding: args.encoding, headerVersion: args.headerVersion, formatVersion: args.formatVersion, chart: args.chart }; }); },
  async getAccountingHealth(scope) { const t = tenant(scope); const [draft, posted, reversed, unbalanced, last] = await Promise.all([q<any>(db, `SELECT COUNT(*)::int c FROM booking_drafts WHERE tenant_id=$1`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND status='posted'`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND status='reversed'`, [t]), q<any>(db, `SELECT COUNT(*)::int c FROM draft_validation_issues WHERE tenant_id=$1 AND code='UNBALANCED_ENTRY' AND blocking=true`, [t]), q<any>(db, `SELECT created_at FROM datev_exports WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [t])]); const today = localIsoDate(new Date()); const unmapped = (await this.getAccountMappingHealth(scope, undefined, 'hgb-bilanz', today)).unmapped; const currentYear = await reportingFiscalYear(db, t, today); const missingDepreciation = (await q<any>(db, `SELECT a.id,a.asset_number,s.year FROM asset_depreciation_schedule s JOIN assets a ON a.tenant_id=s.tenant_id AND a.id=s.asset_id WHERE s.tenant_id=$1 AND s.status='planned' AND s.year < $2 AND a.status='aktiv' AND a.activation_journal_entry_id IS NOT NULL AND a.disposal_date IS NULL ORDER BY a.asset_number,s.year`, [t, currentYear])).map((row) => ({ assetId: String(row.id), assetNumber: String(row.asset_number), year: Number(row.year) })); return { draftCount: Number(draft[0]?.c || 0), postedCount: Number(posted[0]?.c || 0), reversedCount: Number(reversed[0]?.c || 0), unbalancedDraftCount: Number(unbalanced[0]?.c || 0), unmappedAccountCount: unmapped.length, lastDatevExportAt: last[0]?.created_at, missingDepreciation }; },
  async getVatSummary(scope, args = {}) { const values: unknown[] = [tenant(scope)]; const date: string[] = []; if (args.from) { values.push(args.from); date.push(`je.posting_date >= $${values.length}`); } if (args.to) { values.push(args.to); date.push(`je.posting_date <= $${values.length}`); } const rows = await q<any>(db, `SELECT jl.tax_case_key,SUM(jl.net_amount) net,SUM(jl.tax_amount) tax,SUM(COALESCE(jl.gross_amount,CASE WHEN jl.debit_amount>0 THEN jl.debit_amount ELSE jl.credit_amount END)) gross,COUNT(*)::int line_count FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND jl.tax_case_key IS NOT NULL AND je.status IN ('posted','reversed')${date.length ? ` AND ${date.join(' AND ')}` : ''} GROUP BY jl.tax_case_key ORDER BY jl.tax_case_key`, values); // The same Kennzahlen as the prepared UStVA, live and without locking the period.
    const kennzahlen = computeUstva({ from: args.from ?? '0000-01-01', to: args.to ?? '9999-12-31', entries: await sourceEntries(db, scope) });
    return { from: args.from, to: args.to, rows: rows.map((r) => ({ taxCaseKey: r.tax_case_key, netAmount: round(r.net), taxAmount: round(r.tax), grossAmount: round(r.gross), lineCount: Number(r.line_count) })), kennzahlen }; },
  async buildDatevRows(scope, args = {}) {
    const t = tenant(scope); const values: unknown[] = [t]; const date: string[] = [];
    if (args.from) { values.push(args.from); date.push(`posting_date >= $${values.length}`); }
    if (args.to) { values.push(args.to); date.push(`posting_date <= $${values.length}`); }
    if (args.openingBalances) {
      // EB-Werte: every carried balance against 9000 (Saldenvorträge Sachkonten in SKR03 and SKR04).
      const lines = await q<any>(db, `SELECT je.posting_date,je.entry_number,je.reference,jl.account_number,jl.debit_amount,jl.credit_amount FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND je.source_type='carry_forward' AND jl.account_number<>'9000'${date.map((condition) => ` AND je.${condition}`).join('')} ORDER BY je.posting_date,je.entry_number,jl.line_no`, values);
      return lines.filter((line) => round(Number(line.debit_amount) - Number(line.credit_amount)) !== 0).map((line) => {
        const balance = round(Number(line.debit_amount) - Number(line.credit_amount));
        return { date: line.posting_date, belegfeld1: datevBelegfeld(line.reference) || String(line.entry_number), buchungstext: 'Saldovortrag', konto: line.account_number, gegenkonto: '9000', sollHabenKennzeichen: balance > 0 ? 'S' as const : 'H' as const, umsatz: Math.abs(balance) };
      });
    }
    const entries = await q<any>(db, `SELECT * FROM journal_entries je WHERE tenant_id=$1 AND status IN ('posted','reversed') AND ${RUNNING_JOURNAL}${date.length ? ` AND ${date.join(' AND ')}` : ''} ORDER BY posting_date,entry_number`, values);
    const chart = (await policy(db, t)).activeChart;
    const roles = await accountRoleMappings(db, t, chart);
    const vat = new Map<string, DatevVatAccount>([[roles.output_vat!, { rate: 19, flow: 'income' }], [roles.output_vat_7!, { rate: 7, flow: 'income' }], [roles.input_vat!, { rate: 19, flow: 'expense' }], [roles.input_vat_7!, { rate: 7, flow: 'expense' }]]);
    // Personenkonten only in a real export (it knows the Sachkontenlänge); the preview keeps the Sammelkonten.
    if (args.personAccountLength) await assignDatevPartyAccounts(db, t);
    const personAccounts = args.personAccountLength ? await datevEntryPartyAccounts(db, t, entries.map((entry) => String(entry.id)), args.personAccountLength) : new Map<string, { debtor?: string; creditor?: string }>();
    const personal = (entryId: string, account: string) => {
      const own = personAccounts.get(entryId);
      return account === roles.accounts_receivable && own?.debtor ? own.debtor : account === roles.accounts_payable && own?.creditor ? own.creditor : account;
    };
    const selfAssessedTax = new Set([roles.input_vat_rc_13b, roles.output_vat_rc_13b, roles.input_vat_ige, roles.output_vat_ige, roles.input_vat_ige_7, roles.output_vat_ige_7].filter((account): account is string => Boolean(account)));
    const result: any[] = [];
    for (const entry of entries) {
      const persisted = await q<any>(db, `SELECT jp.amount,jp.tax_case_key,jp.datev_bu_key,dl.account_number konto,cl.account_number gegenkonto,
        dl.tax_case_key debit_case,cl.tax_case_key credit_case,dl.tax_rate debit_rate,cl.tax_rate credit_rate,
        COALESCE(dl.country_code,cl.country_code) country_code,
        COALESCE(dl.counterparty_vat_id,cl.counterparty_vat_id) counterparty_vat_id,
        COALESCE(dl.tax_rate,cl.tax_rate) tax_rate,
        COALESCE(dl.datev_sachverhalt_ll,cl.datev_sachverhalt_ll) datev_sachverhalt_ll
        FROM journal_posting_pairs jp
        JOIN journal_lines dl ON dl.id=jp.debit_line_id AND dl.tenant_id=jp.tenant_id
        JOIN journal_lines cl ON cl.id=jp.credit_line_id AND cl.tenant_id=jp.tenant_id
        WHERE jp.tenant_id=$1 AND jp.entry_id=$2 ORDER BY dl.line_no,cl.line_no,jp.id`, [t, entry.id]);
      const pairs: DatevPair[] = persisted.length ? persisted.map((pair) => ({ amount: Number(pair.amount), debit: pair.konto, credit: pair.gegenkonto, debitRate: datevLineRate(pair.debit_case, pair.debit_rate), creditRate: datevLineRate(pair.credit_case, pair.credit_rate), bu: normalizeDatevBuKey(pair.datev_bu_key), euLandUstId: datevDestinationCases.has(pair.tax_case_key as TaxCaseKey) ? pair.counterparty_vat_id ?? pair.country_code : undefined, euSteuersatz: pair.tax_rate == null ? undefined : Number(pair.tax_rate), sachverhaltLl: pair.datev_sachverhalt_ll ?? undefined })) : pairLines((await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, entry.id])).map(mapLine)).map((pair) => ({ amount: pair.amount, debit: pair.debit.accountNumber, credit: pair.credit.accountNumber, debitRate: datevLineRate(pair.debit.taxCaseKey, pair.debit.taxRate), creditRate: datevLineRate(pair.credit.taxCaseKey, pair.credit.taxRate), bu: undefined, euLandUstId: datevDestinationCases.has(pair.taxCaseKey as TaxCaseKey) ? pair.debit.counterpartyVatId ?? pair.credit.counterpartyVatId ?? pair.debit.countryCode ?? pair.credit.countryCode : undefined, euSteuersatz: pair.debit.taxRate ?? pair.credit.taxRate, sachverhaltLl: pair.debit.datevSachverhaltLl ?? pair.credit.datevSachverhaltLl }));
      const selfAssessed = pairs.some((pair) => selfAssessedTax.has(pair.debit) || selfAssessedTax.has(pair.credit))
        ? selfAssessedDatevPairs((await q<any>(db, `SELECT * FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [t, entry.id])).map(mapLine), selfAssessedTax)
        : null;
      if (selfAssessed) pairs.splice(0, pairs.length, ...selfAssessed);
      const belegfeld1 = datevBelegfeld(entry.reference) || String(entry.entry_number);
      const documentDate = entry.document_date && isoDate(entry.document_date) && (args.from && args.to ? entry.document_date >= args.from && entry.document_date <= args.to : entry.document_date.slice(0, 7) === entry.posting_date.slice(0, 7)) ? entry.document_date : entry.posting_date;
      for (const pair of collapseDatevPairs(pairs, vat, DATEV_AUTOMATIC_ACCOUNTS[chart])) result.push({ date: documentDate, belegfeld1, buchungstext: datevText(entry.booking_text), konto: personal(entry.id, pair.debit), gegenkonto: personal(entry.id, pair.credit), sollHabenKennzeichen: 'S', buSchluessel: pair.bu ?? undefined, euLandUstId: pair.euLandUstId, euSteuersatz: pair.euLandUstId === undefined ? undefined : pair.euSteuersatz, sachverhaltLl: pair.sachverhaltLl, umsatz: round(pair.amount) });
    }
    return result;
  },
  async getAccountingPolicy(scope) { return policy(db, tenant(scope)); },
  async setAccountingPolicy(scope, input) { return inTx(db, (tx) => writeAccountingPolicy(tx, scope, input)); },
  async listAccountingAccountMappings(scope, chart) { const rows = await q<any>(db, `SELECT * FROM accounting_account_mappings WHERE tenant_id=$1${chart ? ' AND chart=$2' : ''} ORDER BY chart,role`, chart ? [tenant(scope), chart] : [tenant(scope)]); return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, chart: r.chart, role: r.role, accountNumber: r.account_number, updatedAt: r.updated_at })); },
  async saveTenantLedgerAccount(scope, input) { return inTx(db, async (tx) => {
    const t = tenant(scope); const number = input.accountNumber.trim(); const stamp = now();
    if (!/^\d{4,8}$/.test(number)) throw new Error('INVALID_ACCOUNT_NUMBER: Kontonummern haben 4 bis 8 Ziffern.');
    const catalogue = (await q<any>(tx, `SELECT name FROM ledger_accounts WHERE chart=$1 AND account_number=$2`, [input.chart, number]))[0];
    const before = (await q<any>(tx, `SELECT * FROM tenant_ledger_accounts WHERE tenant_id=$1 AND chart=$2 AND account_number=$3 FOR UPDATE`, [t, input.chart, number]))[0];
    // A catalogue account keeps its DATEV name; only an own account is named by the tenant (DATEV Kontenbeschriftung: 40 characters).
    const name = catalogue ? String(catalogue.name) : (input.name ?? before?.name ?? '').trim();
    if (!catalogue && (!name || name.length > 40)) throw new Error('INVALID_ACCOUNT_NAME: Ein eigenes Konto braucht eine Bezeichnung mit höchstens 40 Zeichen.');
    if (!input.active) {
      const roles = Object.values(await accountRoleMappings(tx, t, input.chart));
      const taxCases = await q<any>(tx, `SELECT 1 FROM tax_case_account_mappings WHERE tenant_id=$1 AND chart=$2 AND account_number=$3 LIMIT 1`, [t, input.chart, number]);
      if (roles.includes(number) || taxCases.length) throw new Error(`ACCOUNT_IN_USE: Konto ${number} ist als Standardkonto zugeordnet und kann nicht deaktiviert werden.`);
    }
    await q(tx, `INSERT INTO tenant_ledger_accounts (tenant_id,chart,account_number,name,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (tenant_id,chart,account_number) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,updated_at=EXCLUDED.updated_at`, [t, input.chart, number, name, input.active, stamp]);
    const after = { chart: input.chart, accountNumber: number, name, active: input.active };
    await audit(tx as PostgresTransactionClient, scope, 'ledger_account', `${input.chart}:${number}`, before ? 'update' : 'create', input.active ? 'Konto aktiv' : 'Konto deaktiviert', before ? { name: before.name, active: before.active } : null, after, input.mutation);
    return { id: catalogue ? `${input.chart}:${number}` : `tenant:${input.chart}:${number}`, chart: input.chart, accountNumber: number, name, source: catalogue ? 'server-catalog' : 'tenant', active: input.active, createdAt: before?.created_at ?? stamp, updatedAt: stamp };
  }); },
  async upsertAccountingAccountMapping(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); if (!(await accountExists(tx, input.chart, input.accountNumber.trim(), t))) throw new Error(`UNKNOWN_ACCOUNT:${input.accountNumber.trim()}`); const id = input.id ?? randomUUID(); const stamp = now(); await q(tx, `INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,chart,role) DO UPDATE SET account_number=EXCLUDED.account_number,updated_at=EXCLUDED.updated_at`, [id, t, input.chart, input.role, input.accountNumber.trim(), stamp]); await audit(tx as PostgresTransactionClient, scope, 'accounting_mapping', id, 'update', 'Accounting mapping changed', null, { chart: input.chart, role: input.role, accountNumber: input.accountNumber }, input.mutation); const row = (await q<any>(tx, `SELECT * FROM accounting_account_mappings WHERE tenant_id=$1 AND chart=$2 AND role=$3`, [t, input.chart, input.role]))[0]; return { id: row.id, tenantId: row.tenant_id, chart: row.chart, role: row.role, accountNumber: row.account_number, updatedAt: row.updated_at }; }); },
  async listVendors(scope) { return (await q<any>(db, `SELECT * FROM vendors WHERE tenant_id=$1 ORDER BY name,id`, [tenant(scope)])).map(rowVendor); },
  async upsertVendor(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const id = input.id || randomUUID(); const stamp = now(); const existing = (await q<any>(tx, `SELECT * FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, id]))[0]; /* A new vendor under a name that exists (trimmed, any case) is that vendor, not a duplicate. */ if (!existing) { const same = (await q<any>(tx, `SELECT * FROM vendors WHERE tenant_id=$1 AND lower(btrim(name))=lower(btrim($2)) ORDER BY created_at LIMIT 1`, [t, input.name]))[0]; if (same) { /* Never drop what the new entry says differently: refuse it and name the field, the person opens the existing vendor. */ const norm = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toUpperCase(); const differs = [['IBAN', input.iban, same.iban], ['USt-IdNr.', input.vatId, same.vat_id], ['Standard-Aufwandskonto', input.defaultExpenseAccount, same.default_expense_account]].filter(([, given, stored]) => norm(given) && norm(given) !== norm(stored)).map(([label]) => label); if (differs.length) throw new Error(`VENDOR_EXISTS: Der Lieferant „${String(same.name).trim()}“ existiert bereits, abweichend: ${differs.join(', ')}. Wähle ihn als Kreditor und ändere die Angaben dort, gespeichert wurde nichts.`); return rowVendor(same); } } const foreign = (await q<any>(tx, `SELECT tenant_id FROM vendors WHERE id=$1 AND tenant_id<>$2`, [id, t]))[0]; if (foreign) throw new Error('VENDOR_NOT_FOUND'); if (existing && (await q<any>(tx, `SELECT accounting_status FROM incoming_invoices WHERE tenant_id=$1 AND vendor_id=$2 AND accounting_status='posted' LIMIT 1`, [t, id]))[0]) throw new Error('VENDOR_HAS_POSTED_DOCUMENTS'); await q(tx, `INSERT INTO vendors (id,tenant_id,vendor_number,name,email,address,vat_id,iban,default_expense_account,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT (id) DO UPDATE SET vendor_number=EXCLUDED.vendor_number,name=EXCLUDED.name,email=EXCLUDED.email,address=EXCLUDED.address,vat_id=EXCLUDED.vat_id,iban=EXCLUDED.iban,default_expense_account=EXCLUDED.default_expense_account,updated_at=EXCLUDED.updated_at`, [id, t, input.vendorNumber ?? null, input.name, input.email ?? null, input.address ?? null, input.vatId ?? null, input.iban ?? null, input.defaultExpenseAccount ?? null, stamp]); await audit(tx as PostgresTransactionClient, scope, 'vendor', id, 'upsert', 'Vendor changed', existing ?? null, { ...input, mutation: undefined }, input.mutation); return rowVendor((await q<any>(tx, `SELECT * FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, id]))[0]); }); },
  async listIncomingInvoices(scope) { const rows = await q<any>(db, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 ORDER BY invoice_date DESC,number`, [tenant(scope)]); return Promise.all(rows.map(async (r) => rowIncoming(r, await q(db, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [tenant(scope), r.id])))); },
  async listIncomingInvoiceDocuments(scope, invoiceId) {
    const rows = await q<any>(db, `SELECT d.*, i.accounting_journal_entry_id FROM incoming_invoice_documents d JOIN incoming_invoices i ON i.id=d.incoming_invoice_id AND i.tenant_id=d.tenant_id WHERE d.tenant_id=$1${invoiceId ? ' AND d.incoming_invoice_id=$2' : ''} ORDER BY d.created_at,d.id`, invoiceId ? [tenant(scope), invoiceId] : [tenant(scope)]);
    return rows.map(rowIncomingInvoiceDocument);
  },
  async uploadIncomingInvoiceDocument(scope, input) {
    assertIncomingInvoiceDocumentInput(input);
    return inTx(db, async (tx) => {
      const t = tenant(scope);
      const invoice = (await q<any>(tx, `SELECT id FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.incomingInvoiceId]))[0];
      if (!invoice) throw new Error('INCOMING_INVOICE_NOT_FOUND');
      const content = Buffer.from(input.content);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const duplicate = (await q<any>(tx, `SELECT id FROM incoming_invoice_documents WHERE tenant_id=$1 AND sha256=$2`, [t, sha256]))[0];
      if (duplicate) throw new Error('INCOMING_INVOICE_DOCUMENT_DUPLICATE: Diese Datei ist im Mandanten bereits archiviert.');
      const id = input.id?.trim() || randomUUID();
      const stamp = now();
      try {
        await q(tx, `INSERT INTO incoming_invoice_documents (id,tenant_id,incoming_invoice_id,original_filename,mime_type,byte_length,sha256,content_bytes,review_status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9)`, [id, t, input.incomingInvoiceId, input.originalFilename.trim(), input.mimeType, content.byteLength, sha256, content, stamp]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error('INCOMING_INVOICE_DOCUMENT_DUPLICATE: Diese Datei ist im Mandanten bereits archiviert.');
        throw error;
      }
      const saved = (await q<any>(tx, `SELECT d.*, i.accounting_journal_entry_id FROM incoming_invoice_documents d JOIN incoming_invoices i ON i.id=d.incoming_invoice_id AND i.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.id=$2`, [t, id]))[0];
      if (!saved) throw new Error('INCOMING_INVOICE_DOCUMENT_NOT_FOUND');
      const metadata = rowIncomingInvoiceDocument(saved);
      await audit(tx as PostgresTransactionClient, scope, 'incoming_invoice_document', id, 'upload', input.mutation?.reason ?? 'Incoming invoice document uploaded', null, { ...metadata, mutation: undefined }, input.mutation);
      return metadata;
    });
  },
  async downloadIncomingInvoiceDocument(scope, documentId) {
    const row = (await q<any>(db, `SELECT d.*, i.accounting_journal_entry_id FROM incoming_invoice_documents d JOIN incoming_invoices i ON i.id=d.incoming_invoice_id AND i.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.id=$2`, [tenant(scope), documentId]))[0];
    if (!row) throw new Error('INCOMING_INVOICE_DOCUMENT_NOT_FOUND');
    const content = incomingInvoiceDocumentContent(row.content_bytes);
    if (content.byteLength !== Number(row.byte_length) || createHash('sha256').update(content).digest('hex') !== row.sha256) throw new Error('INCOMING_INVOICE_DOCUMENT_HASH_MISMATCH');
    return { document: rowIncomingInvoiceDocument(row), content };
  },
  async reviewIncomingInvoiceDocument(scope, input) {
    return inTx(db, async (tx) => {
      const t = tenant(scope);
      const existing = (await q<any>(tx, `SELECT d.*, i.accounting_journal_entry_id FROM incoming_invoice_documents d JOIN incoming_invoices i ON i.id=d.incoming_invoice_id AND i.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE`, [t, input.documentId]))[0];
      if (!existing) throw new Error('INCOMING_INVOICE_DOCUMENT_NOT_FOUND');
      const stamp = now();
      await q(tx, `UPDATE incoming_invoice_documents SET review_status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [input.reviewStatus, stamp, t, input.documentId]);
      const updated = (await q<any>(tx, `SELECT d.*, i.accounting_journal_entry_id FROM incoming_invoice_documents d JOIN incoming_invoices i ON i.id=d.incoming_invoice_id AND i.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.id=$2`, [t, input.documentId]))[0];
      if (!updated) throw new Error('INCOMING_INVOICE_DOCUMENT_NOT_FOUND');
      const before = rowIncomingInvoiceDocument(existing);
      const after = rowIncomingInvoiceDocument(updated);
      await audit(tx as PostgresTransactionClient, scope, 'incoming_invoice_document', input.documentId, 'review', input.mutation?.reason ?? 'Incoming invoice document reviewed', before, after, input.mutation);
      return after;
    });
  },
  async upsertIncomingInvoice(scope, input) { return inTx(db, async (tx) => { const t = tenant(scope); const existing = (await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.id]))[0]; const foreign = (await q<any>(tx, `SELECT tenant_id FROM incoming_invoices WHERE id=$1 AND tenant_id<>$2`, [input.id, t]))[0]; if (foreign) throw new Error('INCOMING_INVOICE_NOT_FOUND'); if (existing?.accounting_status === 'posted' || existing?.accounting_status === 'reversed') { const oldLines = await q(tx, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, input.id]); return rowIncoming(existing, oldLines); } const vendor = (await q<any>(tx, `SELECT id FROM vendors WHERE tenant_id=$1 AND id=$2`, [t, input.vendorId]))[0]; if (!vendor) throw new Error('VENDOR_NOT_FOUND'); if (input.status !== 'draft') { /* Released for posting only with accounts the chart knows; a draft may hold an unfinished one. */ const chart = (await policy(tx, t)).activeChart; const accounts = [...new Set(input.lines.map((line) => line.accountNumber ?? line.assetAccountNumber).filter((account): account is string => Boolean(account)))]; const usable = await usableAccountNumbers(tx, t, chart, accounts); const unknown = accounts.find((account) => !usable.has(account)); if (unknown) throw Object.assign(new Error(`Das Konto ${unknown} ist nicht im Kontenrahmen ${chart} vorhanden oder deaktiviert. Wählen Sie ein vorhandenes Konto; bis dahin bleibt der Beleg ein Entwurf.`), { statusCode: 422 }); } const stamp = now(); await q(tx, `INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,service_period,net_amount,tax_amount,gross_amount,status,tax_rate,tax_case_key,notes,accounting_status,accounting_snapshot_json,accounting_journal_entry_id,created_at,updated_at,tax_meta_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'unposted',NULL,NULL,$15,$16,$17) ON CONFLICT (id) DO UPDATE SET tax_meta_json=EXCLUDED.tax_meta_json, vendor_id=EXCLUDED.vendor_id,number=EXCLUDED.number,invoice_date=EXCLUDED.invoice_date,due_date=EXCLUDED.due_date,service_period=EXCLUDED.service_period,net_amount=EXCLUDED.net_amount,tax_amount=EXCLUDED.tax_amount,gross_amount=EXCLUDED.gross_amount,status=EXCLUDED.status,tax_rate=EXCLUDED.tax_rate,tax_case_key=EXCLUDED.tax_case_key,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at`, [input.id, t, input.vendorId, input.number, input.invoiceDate, input.dueDate, input.servicePeriod ?? null, input.netAmount, input.taxAmount, input.grossAmount, input.status, input.taxRate, input.taxCaseKey ?? null, input.notes ?? null, input.createdAt || stamp, stamp, input.taxMeta && Object.values(input.taxMeta).some((value) => value !== undefined) ? JSON.stringify(input.taxMeta) : null]); await q(tx, `DELETE FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2`, [t, input.id]); for (const line of input.lines) await q(tx, `INSERT INTO incoming_invoice_lines (id,tenant_id,incoming_invoice_id,position,description,quantity,unit_price,net_amount,tax_rate,tax_amount,gross_amount,account_number,asset_account_number,input_vat_deductible) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [line.id, t, input.id, line.position, line.description, line.quantity, line.unitPrice, line.netAmount, line.taxRate, line.taxAmount, line.grossAmount, line.accountNumber ?? null, line.assetAccountNumber ?? null, line.inputVatDeductible === false ? false : null]); await audit(tx as PostgresTransactionClient, scope, 'incoming_invoice', input.id, 'upsert', 'Incoming invoice changed', existing ?? null, { ...input, accountingStatus: undefined, accountingSnapshot: undefined, mutation: undefined }, input.mutation); return rowIncoming((await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [t, input.id]))[0], await q(tx, `SELECT * FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2 ORDER BY position`, [t, input.id])); }); },
  async previewOutgoingInvoice(scope, invoiceId) { const row = await readInvoice(db, scope, invoiceId); if (!row) throw new Error('INVOICE_NOT_FOUND'); return postingPreview(db, scope, row, 'outgoing_invoice'); },
  async postOutgoingInvoice(scope, invoiceId, options = {}) { return inTx(db, (tx) => postDocument(tx, scope, 'outgoing_invoice', invoiceId, options)); },
  async previewIncomingInvoice(scope, invoiceId) { const row = (await q<any>(db, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), invoiceId]))[0]; if (!row) throw new Error('INCOMING_INVOICE_NOT_FOUND'); return postingPreview(db, scope, row, 'incoming_invoice'); },
  async postIncomingInvoice(scope, invoiceId, options = {}) { return inTx(db, (tx) => postDocument(tx, scope, 'incoming_invoice', invoiceId, options)); },
  async listOpenItems(scope) {
    const items = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 ORDER BY due_date,id`, [tenant(scope)])).map(rowOpenItem);
    // The unallocated rest of a payment is the partner's credit (Guthaben): listed as a negative open item
    // with the partner, refundable or allocated later. It is a view of the payment, not a second record.
    const credits = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND status <> 'reversed' AND refund = FALSE AND residual_amount > 0.01 AND party_id IS NOT NULL ORDER BY payment_date,id`, [tenant(scope)])).map((row): OpenItemEntity => ({
      id: `${PAYMENT_CREDIT_PREFIX}${row.id}`, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id, sourceType: 'payment', sourceId: row.id,
      documentNumber: `Guthaben aus Zahlung vom ${row.payment_date}`, documentDate: row.payment_date, dueDate: row.payment_date,
      originalAmount: -Number(row.residual_amount), allocatedAmount: 0, residualAmount: -Number(row.residual_amount), status: 'open', journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, updatedAt: row.created_at,
    }));
    return [...items, ...credits].sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id));
  },
  async allocateOpenItemPayment(scope, input) { requireAllocationEventId(input.allocationEventId); return inTx(db, (tx) => allocatePayment(tx, scope, input)); },
  async allocateRemainingOpenItemPayment(scope, paymentId, allocations, allocationEventId, mutation) { const eventId = requireAllocationEventId(allocationEventId); return inTx(db, async (tx) => { const row = (await q<any>(tx, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), paymentId]))[0]; if (!row) throw new Error('PAYMENT_NOT_FOUND'); return allocatePayment(tx, scope, { paymentId, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocations, allocationEventId: eventId, reason: mutation?.reason ?? 'Allocate remaining open item payment', mutation }); }); },
  async reverseDocumentAccounting(scope, input) { return inTx(db, async (tx) => { const table = input.documentType === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices'; const row = (await q<any>(tx, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenant(scope), input.documentId]))[0]; if (!row || row.accounting_status !== 'posted' || !row.accounting_journal_entry_id) throw new Error('DOCUMENT_NOT_POSTED'); if ((await q<any>(tx, `SELECT id FROM assets WHERE tenant_id=$1 AND (activation_journal_entry_id=$2 OR source_incoming_invoice_id=$3) LIMIT 1`, [tenant(scope), row.accounting_journal_entry_id, input.documentId]))[0]) throw new Error('ASSET_CORRECTION_REQUIRED: correct linked asset before reversing its source document'); const item = (await q<any>(tx, `SELECT * FROM open_items WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR UPDATE`, [tenant(scope), input.documentType, input.documentId]))[0]; if (item && Number((await q<any>(tx, `SELECT COUNT(*)::int c FROM open_item_allocations a JOIN open_item_payments p ON p.tenant_id=a.tenant_id AND p.id=a.payment_id WHERE a.tenant_id=$1 AND a.open_item_id=$2 AND p.status <> 'reversed'`, [tenant(scope), item.id]))[0]?.c)) throw new Error('DOCUMENT_HAS_ALLOCATIONS'); const reversal = await reverseEntryInTransaction(tx, scope, row.accounting_journal_entry_id, input.reason, { postingDate: input.postingDate, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation, allowDocumentSource: true }); if (item) await q(tx, `UPDATE open_items SET status='unresolved',allocated_amount=original_amount,residual_amount=0,updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), tenant(scope), item.id]); await q(tx, `UPDATE ${table} SET accounting_status='reversed',status='cancelled',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now(), tenant(scope), input.documentId]); return reversal; }); },
  async previewAccountingBackfill(scope) { return inTx(db, async (tx) => { const candidates: AccountingBackfillPreview['candidates'] = []; const config = await backfillConfig(tx, tenant(scope)); const outgoing = await q<any>(tx, `SELECT i.* FROM invoices i JOIN number_reservations nr ON nr.tenant_id=i.tenant_id AND nr.kind='invoice' AND nr.status='finalized' AND nr.document_id=i.id AND nr.number=i.number WHERE i.tenant_id=$1 AND COALESCE(i.document_kind,'invoice') NOT IN ('order_confirmation','delivery_note') AND COALESCE(i.accounting_status,'unposted') NOT IN ('posted','reversed') AND i.status NOT IN ('draft','cancelled') ORDER BY i.id`, [tenant(scope)]); for (const row of outgoing) { const reservation = await finalizedInvoiceReservation(tx, tenant(scope), row); const preview = await postingPreview(tx, scope, row, 'outgoing_invoice'); const documentVersion = preview.snapshot?.sourceVersion ?? hash(row); candidates.push({ sourceType: 'outgoing_invoice', sourceId: row.id, status: preview.status, reason: preview.reason, sourceVersion: backfillOutgoingSourceVersion(row, documentVersion, reservation), snapshot: preview.snapshot ? { ...preview.snapshot, capturedAt: '' } : undefined }); } const incoming = await q<any>(tx, `SELECT * FROM incoming_invoices WHERE tenant_id=$1 AND accounting_status NOT IN ('posted','reversed') AND status NOT IN ('draft','cancelled') ORDER BY id`, [tenant(scope)]); for (const row of incoming) { const preview = await postingPreview(tx, scope, row, 'incoming_invoice'); const documentVersion = preview.snapshot?.sourceVersion ?? hash(row); candidates.push({ sourceType: 'incoming_invoice', sourceId: row.id, status: preview.status, reason: preview.reason, sourceVersion: incomingBackfillSourceVersion(row, documentVersion), snapshot: preview.snapshot ? { ...preview.snapshot, capturedAt: '' } : undefined }); } const legacy = await q<any>(tx, `SELECT id,date,amount,type,counterparty,purpose FROM transactions WHERE tenant_id=$1 ORDER BY id`, [tenant(scope)]); for (const row of legacy) candidates.push({ sourceType: 'legacy_transaction', sourceId: row.id, status: 'unresolved', reason: 'Legacy transaction requires explicit review.', sourceVersion: hash(row), snapshot: row }); const confirmationHash = hash({ tenantId: tenant(scope), config, candidates }); const runId = randomUUID(); await q(tx, `INSERT INTO accounting_backfill_runs (id,tenant_id,status,candidates_json,confirmation_hash,created_at,config_json) VALUES ($1,$2,'preview',$3,$4,$5,$6)`, [runId, tenant(scope), JSON.stringify(candidates), confirmationHash, now(), JSON.stringify(config)]); await audit(tx as PostgresTransactionClient, scope, 'accounting_backfill', runId, 'preview', 'dry-run accounting backfill', null, { confirmationHash }); return { runId, status: 'preview', candidates, readyCount: candidates.filter((x) => x.status === 'ready').length, unresolvedCount: candidates.filter((x) => x.status === 'unresolved').length, confirmationHash }; }); },
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
      // AfA years are Wirtschaftsjahre of the tenant (a GmbH with a fiscal year from April depreciates per April–March).
      const schedule = buildDepreciationSchedule({ ...assetInputFor(input), method, fiscalYearStart: await reportingFiscalYearStart(tx, t) });
      const oldSchedule = existing ? await assetSchedule(tx, scope, id) : [];
      const financiallyOwned = Boolean(existing?.activation_journal_entry_id) || oldSchedule.some((entry) => entry.status === 'posted') || Boolean((await q<any>(tx, `SELECT 1 FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 LIMIT 1`, [t, id]))[0]);
      if (existing && financiallyOwned) {
        if (input.status !== existing.status) throw new Error('ACCOUNTING_ASSET_STATUS_IMMUTABLE');
        const financialChanged = input.assetNumber !== existing.asset_number || input.assetClass !== existing.asset_class || input.activationDate !== existing.activation_date || round(input.acquisitionCost) !== round(existing.acquisition_cost) || (input.usefulLifeYears ?? null) !== existing.useful_life_years || method !== existing.depreciation_method || input.assetAccountNumber !== existing.asset_account_number || (input.acquisitionOffsetAccountNumber !== undefined && input.acquisitionOffsetAccountNumber !== existing.acquisition_offset_account_number) || (input.sourceIncomingInvoiceId !== undefined && input.sourceIncomingInvoiceId !== existing.source_incoming_invoice_id);
        if (financialChanged) throw new Error('ACCOUNTING_ASSET_FIELDS_IMMUTABLE');
      }
      if (input.status === 'aktiv' && !existing?.activation_journal_entry_id) {
        if (!isoDate(input.activationDate)) throw new Error('INVALID_ACTIVATION_DATE');
        const periodStatus = await ensurePeriod(tx, scope, period(input.activationDate), input.activationDate);
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
      const sourceKey = await depreciationSourceKey(tx, scope, row.id, input.year);
      if (entry.status === 'posted' && entry.journalEntryId) return { asset: mapAsset(row, schedule), scheduleEntry: entry, journalEntryId: entry.journalEntryId };
      if (entry.status === 'cancelled') throw new Error('DEPRECIATION_SCHEDULE_CANCELLED');
      if (row.accounting_repair_required) throw new Error('ASSET_ACTIVATION_REPAIR_REQUIRED');
      if (row.status === 'entwurf' || !row.activation_journal_entry_id) throw new Error('ASSET_NOT_ACTIVE');
      if (!isoDate(input.postingDate)) throw new Error('INVALID_POSTING_DATE');
      // The AfA of a Wirtschaftsjahr is booked inside that Wirtschaftsjahr, not in the year before or after.
      if (await reportingFiscalYear(tx, tenant(scope), input.postingDate) !== input.year) throw new Error(`INVALID_DEPRECIATION_POSTING_DATE: Die AfA ${input.year} muss im Wirtschaftsjahr ${input.year} gebucht werden.`);
      // The schedule year is the whole, month-exact AfA of the Wirtschaftsjahr; booked earlier it would claim months that have not passed.
      const yearEnd = fiscalYearRange(input.year, await reportingFiscalYearStart(tx, tenant(scope))).end;
      if (input.postingDate < yearEnd) throw new Error(`INVALID_DEPRECIATION_POSTING_DATE: Die AfA ${input.year} wird zum Ende des Wirtschaftsjahres (${yearEnd.split('-').reverse().join('.')}) gebucht, monatsgenau bis dahin. Ein Verkauf oder Abgang im Jahr bucht die anteilige AfA selbst.`);
      const status = await ensurePeriod(tx, scope, period(input.postingDate), input.postingDate);
      if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD');
      if (status === 'soft_locked' && (!input.softLockOverride || !input.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
      const chart = (await policy(tx, tenant(scope))).activeChart; const expense = DEPRECIATION_EXPENSE_ACCOUNTS[chart]; await assertAccounts(tx, chart, [expense, row.asset_account_number], 'DEPRECIATION_ACCOUNT_NOT_IN_CHART', tenant(scope));
      const journalEntryId = await insertEntry(tx, scope, 'asset_depreciation', sourceKey, input.postingDate, `AfA ${row.asset_number} ${input.year}`, [
        { id: `${row.id}-expense-${input.year}${keyRound(sourceKey)}`, accountNumber: expense, debitAmount: entry.amount, creditAmount: 0, evidenceType: 'asset_depreciation', evidenceReference: row.invoice_ref ?? row.asset_number, costCenter: row.cost_center || undefined, memo: input.reason },
        { id: `${row.id}-asset-${input.year}${keyRound(sourceKey)}`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: entry.amount, costCenter: row.cost_center || undefined, memo: input.reason },
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
      const row = await assetRow(tx, scope, input.assetId, true); const sourceKey = await disposalSourceKey(tx, scope, row.id);
      const existing = (await q<any>(tx, `SELECT journal_entry_id,amount,gain_loss,proceeds FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 AND source_type='asset_disposal' AND source_key=$3 LIMIT 1`, [tenant(scope), row.id, sourceKey]))[0];
      if (existing) {
        // A retry returns the recorded disposal. A sale invoice other than the one the asset was sold with is a second sale.
        if (input.saleInvoiceId && (Math.abs(Number(existing.proceeds ?? 0) - input.proceeds) > 0.005 || await otherAssetSaleInvoice(tx, scope, row.id, input.saleInvoiceId))) throw new Error(`ASSET_ALREADY_DISPOSED: Die Anlage ${row.asset_number} ist bereits ausgebucht. Ein zweiter Verkauf ist nicht möglich; zum Rückgängigmachen den Verkaufsentwurf löschen oder die Verkaufsrechnung stornieren.`);
        return { asset: await getAsset(tx, scope, row.id), residualBookValue: round(existing.amount), gainLoss: round(existing.gain_loss ?? Number(existing.proceeds) - Number(existing.amount)), journalEntryId: existing.journal_entry_id ?? '' };
      }
      if (!isoDate(input.disposalDate)) throw new Error('INVALID_DISPOSAL_DATE');
      const status = await ensurePeriod(tx, scope, period(input.disposalDate), input.disposalDate); if (status === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD'); if (status === 'soft_locked' && (!input.softLockOverride || !input.overrideReason?.trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
      if (row.depreciation_method === 'pool') throw new Error('POOL_INDIVIDUAL_DISPOSAL_NOT_SUPPORTED');
      if (row.accounting_repair_required) throw new Error('ASSET_ACTIVATION_REPAIR_REQUIRED'); if (row.status === 'entwurf' || !row.activation_journal_entry_id) throw new Error('ASSET_NOT_ACTIVE'); if (row.disposal_date) throw new Error(`ASSET_ALREADY_DISPOSED: Die Anlage ${row.asset_number} ist bereits ausgebucht.`);
      // A sale to a customer: its outgoing invoice books proceeds, VAT and the open item, so the disposal only takes the book value off.
      const saleInvoice = input.saleInvoiceId ? (await q<any>(tx, `SELECT id,status,items_json,tax_meta_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), input.saleInvoiceId]))[0] : undefined;
      if (input.saleInvoiceId) {
        if (!saleInvoice || parse<any>(saleInvoice.tax_meta_json, null)?.assetSaleAssetId !== row.id || saleInvoice.status === 'cancelled') throw new Error('ASSET_SALE_INVOICE_MISMATCH: Die Rechnung gehört nicht zum Verkauf dieser Anlage.');
        const invoiceNet = round(parse<any[]>(saleInvoice.items_json, []).filter((item) => (item.kind ?? 'item') === 'item').reduce((sum, item) => sum + Number(item.total ?? 0), 0));
        if (input.proceeds <= 0 || Math.abs(invoiceNet - input.proceeds) > 0.005) throw new Error(`ASSET_SALE_INVOICE_MISMATCH: Der Erlös muss dem Nettobetrag der Rechnung entsprechen (${invoiceNet.toFixed(2).replace('.', ',')} €).`);
      }
      if (input.proceeds > 0 && input.taxRate === undefined && !saleInvoice) throw new Error('TAX_RATE_REQUIRED_FOR_PROCEEDS');
      const fiscalYearStart = await reportingFiscalYearStart(tx, tenant(scope));
      const disposal = computeAssetDisposal({ ...assetInputFor(row), fiscalYearStart, disposalDate: input.disposalDate, proceeds: input.proceeds });
      const chart = (await policy(tx, tenant(scope))).activeChart; const accounts = disposalAccounts(chart);
      // A disposal during the year first books the AfA of that Wirtschaftsjahr up to the disposal month (§ 7 Abs. 1 Satz 4 EStG);
      // every earlier year must already be posted, otherwise the book value is not known.
      const disposalYear = await reportingFiscalYear(tx, tenant(scope), input.disposalDate);
      const schedule = await assetSchedule(tx, scope, row.id, true);
      const posted = await postedDepreciationAmount(tx, scope, row);
      const partial = round(disposal.depreciationToDate - posted);
      const yearEntry = schedule.find((entry) => entry.year === disposalYear && entry.status === 'planned');
      if (schedule.some((entry) => entry.year < disposalYear && entry.status === 'planned') || partial < -0.01 || (partial > 0.005 && !yearEntry)) throw new Error('ASSET_DISPOSAL_PROJECTION_MISMATCH');
      if (partial > 0.005 && yearEntry) {
        const expense = DEPRECIATION_EXPENSE_ACCOUNTS[chart]; await assertAccounts(tx, chart, [expense, row.asset_account_number], 'DEPRECIATION_ACCOUNT_NOT_IN_CHART', tenant(scope));
        const depreciationKey = await depreciationSourceKey(tx, scope, row.id, disposalYear);
        const depreciationEntryId = await insertEntry(tx, scope, 'asset_depreciation', depreciationKey, input.disposalDate, `AfA ${row.asset_number} ${disposalYear} bis Abgang`, [
          { id: `${row.id}-expense-${disposalYear}${keyRound(depreciationKey)}`, accountNumber: expense, debitAmount: partial, creditAmount: 0, evidenceType: 'asset_depreciation', evidenceReference: row.invoice_ref ?? row.asset_number, costCenter: row.cost_center || undefined, memo: input.reason },
          { id: `${row.id}-asset-${disposalYear}${keyRound(depreciationKey)}`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: partial, costCenter: row.cost_center || undefined, memo: input.reason },
        ], { reference: row.asset_number, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation });
        const months = Math.max(1, Math.min(yearEntry.months, Math.round(yearEntry.months * partial / yearEntry.amount)));
        await q(tx, `UPDATE asset_depreciation_schedule SET amount=$1,months=$2,status='posted',journal_entry_id=$3,source_type='asset_depreciation',source_key=$4,posted_at=$5 WHERE tenant_id=$6 AND id=$7 AND status='planned'`, [partial, months, depreciationEntryId, depreciationKey, now(), tenant(scope), yearEntry.id]);
        await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'depreciation',$4,$5,NULL,NULL,$6,'asset_depreciation',$7,$8,$9)`, [randomUUID(), tenant(scope), row.id, input.disposalDate, partial, depreciationEntryId, depreciationKey, input.overrideReason?.trim() || input.reason, now()]);
      }
      const residualBookValue = round(Math.max(0, Number(row.acquisition_cost) - posted - Math.max(0, partial)));
      if (Math.abs(disposal.residualBookValue - residualBookValue) > 0.01) throw new Error('ASSET_DISPOSAL_PROJECTION_MISMATCH'); if (saleInvoice) {
        // Bruttomethode: the invoice put the proceeds on the asset-sale account; the book value goes to the Restbuchwert account.
        const residualAccount = input.proceeds - residualBookValue >= 0 ? accounts.residualOnGain : accounts.loss;
        await assertAccounts(tx, chart, [row.asset_account_number, residualAccount], 'DISPOSAL_ACCOUNT_NOT_IN_CHART', tenant(scope));
        const gainLoss = round(input.proceeds - residualBookValue);
        const lines: JournalLineEntity[] = residualBookValue > 0 ? [
          { id: `${row.id}${keyRound(sourceKey)}-residual-expense`, accountNumber: residualAccount, debitAmount: residualBookValue, creditAmount: 0, evidenceType: 'asset_disposal', evidenceReference: row.asset_number, memo: input.reason },
          { id: `${row.id}${keyRound(sourceKey)}-residual`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: residualBookValue, memo: input.reason },
        ] : [];
        const journalEntryId = lines.length ? await insertEntry(tx, scope, 'asset_disposal', sourceKey, input.disposalDate, `Anlagenverkauf ${row.asset_number}`, lines, { reference: row.asset_number, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation }) : null;
        const stamp = now(); await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'disposal',$4,$5,$6,$7,$8,'asset_disposal',$9,$10,$11)`, [randomUUID(), tenant(scope), row.id, input.disposalDate, residualBookValue, input.proceeds, gainLoss, journalEntryId, sourceKey, input.overrideReason?.trim() || input.reason, stamp]);
        await q(tx, `UPDATE assets SET status='verkauft',disposal_date=$1,disposal_proceeds=$2,updated_at=$3 WHERE tenant_id=$4 AND id=$5`, [input.disposalDate, input.proceeds, stamp, tenant(scope), row.id]);
        await q(tx, `UPDATE asset_depreciation_schedule SET status='cancelled' WHERE tenant_id=$1 AND asset_id=$2 AND status='planned'`, [tenant(scope), row.id]);
        const afterRow = await assetRow(tx, scope, row.id); const afterSchedule = await assetSchedule(tx, scope, row.id); await audit(tx as PostgresTransactionClient, scope, 'asset', row.id, 'dispose', input.reason, { asset: assetSnapshot(row) }, { asset: assetSnapshot(afterRow), schedule: afterSchedule, residualBookValue, gainLoss, journalEntryId, saleInvoiceId: saleInvoice.id }, input.mutation);
        return { asset: mapAsset(afterRow, afterSchedule), residualBookValue, gainLoss, journalEntryId: journalEntryId ?? '' };
      }
      const proceedsAccount = input.proceedsAccountNumber || await accountFor(tx, scope, chart, 'bank'); if (input.proceeds > 0 && !proceedsAccount) throw new Error('PROCEEDS_ACCOUNT_REQUIRED');
      const taxAccount = input.taxRate && input.taxRate > 0 ? await taxCaseAccount(tx, tenant(scope), chart, input.taxRate === 7 ? 'DE_STD_7' : 'DE_STD_19', 'output_tax', outputTaxAccount(chart, input.taxRate), input.disposalDate) : undefined; await assertAccounts(tx, chart, [row.asset_account_number, accounts.loss, accounts.gain, ...(input.proceeds > 0 && proceedsAccount ? [proceedsAccount] : []), ...(taxAccount ? [taxAccount] : [])], 'DISPOSAL_ACCOUNT_NOT_IN_CHART', tenant(scope));
      const gainLoss = round(input.proceeds - residualBookValue); const gross = round(input.proceeds * (1 + (input.taxRate ?? 0) / 100)); const vat = round(gross - input.proceeds); const lines: JournalLineEntity[] = [];
      if (input.proceeds > 0) lines.push({ id: `${row.id}${keyRound(sourceKey)}-proceeds`, accountNumber: proceedsAccount!, debitAmount: gross, creditAmount: 0, memo: input.reason });
      // The VAT follows the proceeds, so the posting pairs (and DATEV) put the tax on the sale, never on a book loss.
      if (vat > 0) lines.push({ id: `${row.id}${keyRound(sourceKey)}-vat`, accountNumber: taxAccount!, debitAmount: 0, creditAmount: vat, taxCaseKey: (input.taxRate === 7 ? 'DE_STD_7' : 'DE_STD_19') as any, taxRate: input.taxRate, netAmount: input.proceeds, taxAmount: vat, grossAmount: gross, memo: `USt ${input.taxRate}%` });
      if (gainLoss < 0) lines.push({ id: `${row.id}${keyRound(sourceKey)}-loss`, accountNumber: accounts.loss, debitAmount: -gainLoss, creditAmount: 0, memo: input.reason });
      if (gainLoss > 0) lines.push({ id: `${row.id}${keyRound(sourceKey)}-gain`, accountNumber: accounts.gain, debitAmount: 0, creditAmount: gainLoss, taxCaseKey: 'DE_ZERO_EXEMPT', evidenceType: 'asset_disposal', evidenceReference: row.asset_number, memo: input.reason });
      if (residualBookValue > 0) lines.push({ id: `${row.id}${keyRound(sourceKey)}-residual`, accountNumber: row.asset_account_number, debitAmount: 0, creditAmount: residualBookValue, memo: input.reason });
      const journalEntryId = await insertEntry(tx, scope, 'asset_disposal', sourceKey, input.disposalDate, `${input.proceeds > 0 ? 'Anlagenverkauf' : 'Anlagenabgang'} ${row.asset_number}`, lines, { reference: row.asset_number, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation });
      const stamp = now(); await q(tx, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'disposal',$4,$5,$6,$7,$8,'asset_disposal',$9,$10,$11)`, [randomUUID(), tenant(scope), row.id, input.disposalDate, residualBookValue, input.proceeds, gainLoss, journalEntryId, sourceKey, input.overrideReason?.trim() || input.reason, stamp]);
      await q(tx, `UPDATE assets SET status=$1,disposal_date=$2,disposal_proceeds=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [input.proceeds > 0 ? 'verkauft' : 'stillgelegt', input.disposalDate, input.proceeds, stamp, tenant(scope), row.id]);
      await q(tx, `UPDATE asset_depreciation_schedule SET status='cancelled' WHERE tenant_id=$1 AND asset_id=$2 AND status='planned'`, [tenant(scope), row.id]);
      const afterRow = await assetRow(tx, scope, row.id); const afterSchedule = await assetSchedule(tx, scope, row.id); await audit(tx as PostgresTransactionClient, scope, 'asset', row.id, 'dispose', input.reason, { asset: assetSnapshot(row) }, { asset: assetSnapshot(afterRow), schedule: afterSchedule, residualBookValue, gainLoss, journalEntryId }, input.mutation);
      return { asset: mapAsset(afterRow, afterSchedule), residualBookValue, gainLoss, journalEntryId };
    });
  },
  async getAssetRegister(scope, year): Promise<AssetRegister> {
    const t = tenant(scope);
    const { start: from, end: to } = fiscalYearRange(year, await reportingFiscalYearStart(db, t));
    // Book values from the asset movements: activation adds the cost, AfA and the disposal (at residual book value) take it off.
    const rows = await q<any>(db, `SELECT a.id,a.asset_number,a.name,a.asset_account_number,
        COALESCE(SUM(CASE WHEN m.movement_date < $2 THEN CASE WHEN m.type='activation' THEN m.amount ELSE -m.amount END ELSE 0 END),0) AS opening,
        COALESCE(SUM(CASE WHEN m.movement_date >= $2 AND m.type='activation' THEN m.amount ELSE 0 END),0) AS additions,
        COALESCE(SUM(CASE WHEN m.movement_date >= $2 AND m.type='disposal' THEN m.amount ELSE 0 END),0) AS disposals,
        COALESCE(SUM(CASE WHEN m.movement_date >= $2 AND m.type='depreciation' THEN m.amount ELSE 0 END),0) AS depreciation
      FROM assets a JOIN asset_movements m ON m.tenant_id=a.tenant_id AND m.asset_id=a.id
      WHERE a.tenant_id=$1 AND m.movement_date <= $3 AND m.type IN ('activation','depreciation','disposal')
      GROUP BY a.id,a.asset_number,a.name,a.asset_account_number ORDER BY a.asset_account_number,a.asset_number,a.id`, [t, from, to]);
    const register = rows.map((row) => {
      const [opening, additions, disposals, depreciation] = [row.opening, row.additions, row.disposals, row.depreciation].map((value) => round(Number(value)));
      return { assetId: String(row.id), assetNumber: String(row.asset_number), name: String(row.name ?? ''), accountNumber: String(row.asset_account_number ?? ''), opening, additions, disposals, depreciation, closing: round(opening + additions - disposals - depreciation) + 0 };
    }).filter((row) => row.opening !== 0 || row.additions !== 0 || row.disposals !== 0 || row.depreciation !== 0);
    const sum = (key: 'opening' | 'additions' | 'disposals' | 'depreciation' | 'closing') => round(register.reduce((total, row) => total + row[key], 0));
    return { year, from, to, rows: register, totals: { opening: sum('opening'), additions: sum('additions'), disposals: sum('disposals'), depreciation: sum('depreciation'), closing: sum('closing') } };
  },
  async ensureSeedData(scope) { await inTx(db, async (tx) => { const t = tenant(scope); const stamp = now(); await q(tx, `INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2) ON CONFLICT (tenant_id) DO NOTHING`, [t, stamp]); const p = await policy(tx, t); for (const [role, accountNumber] of Object.entries(defaults[p.activeChart])) await q(tx, `INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,chart,role) DO NOTHING`, [randomUUID(), t, p.activeChart, role, accountNumber, stamp]); // HGB report mappings are explicit tenant data; never infer them from account-number digits.
 await ensurePeriod(tx, scope, period(stamp.slice(0, 10)), stamp.slice(0, 10)); }); },
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
    nextDepreciation: planned ? `${planned.year}-12-31` : '–', receiptLinked: Boolean(row.receipt_linked),
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
const assertAccounts = async (db: PostgresQueryable, chart: 'SKR03' | 'SKR04', accounts: string[], code: string, tenantId: string): Promise<void> => {
  if ((await Promise.all(accounts.map((account) => accountExists(db, chart, account, tenantId)))).some((exists) => !exists)) throw new Error(code);
};
// Proceeds of a sale through an invoice: "bei Buchgewinn" or "bei Buchverlust" (SKR04 4849/6889). The SKR03 catalogue in
// the repo has no Sachanlagen account "bei Buchverlust" (8800 is missing, 8801 is a DATEV automatic account at 19 % that
// would book the VAT a second time), so SKR03 keeps 8829 for both; gain or loss still shows on 2315/2310.
const disposalAccounts = (chart: 'SKR03' | 'SKR04') => chart === 'SKR03' ? { loss: '2310', gain: '8829', lossProceeds: '8829', residualOnGain: '2315' } : { loss: '6895', gain: '4849', lossProceeds: '6889', residualOnGain: '4855' };

/** Keys of a disposal and of an AfA year get a round suffix after a reversal, so booking them again does not collide. */
const disposalSourceKey = async (db: PostgresQueryable, scope: TenantScope, assetId: string): Promise<string> => {
  const reversed = Number((await q<any>(db, `SELECT count(*) AS n FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 AND source_type='asset_disposal_reversal'`, [tenant(scope), assetId]))[0]?.n ?? 0);
  return reversed ? `asset_disposal:${assetId}:r${reversed + 1}` : `asset_disposal:${assetId}`;
};
/** Line ids of a later round carry its suffix (journal line ids are unique). */
const keyRound = (sourceKey: string): string => { const round = sourceKey.match(/:(r\d+)$/)?.[1]; return round ? `-${round}` : ''; };
const depreciationSourceKey = async (db: PostgresQueryable, scope: TenantScope, assetId: string, year: number): Promise<string> => {
  const base = `asset_depreciation:${assetId}:${year}`;
  const reversed = Number((await q<any>(db, `SELECT count(*) AS n FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_depreciation' AND status='reversed' AND (source_key=$2 OR source_key LIKE $3)`, [tenant(scope), base, `${base}:r%`]))[0]?.n ?? 0);
  return reversed ? `${base}:r${reversed + 1}` : base;
};
const assetSaleInvoices = async (db: PostgresQueryable, scope: TenantScope, assetId: string): Promise<Array<{ id: string; status: string; number: string }>> =>
  (await q<any>(db, `SELECT id,status,number,tax_meta_json FROM invoices WHERE tenant_id=$1 AND tax_meta_json LIKE $2 AND COALESCE(document_kind,'invoice') NOT IN ('credit_note','cancellation_invoice')`, [tenant(scope), `%${assetId}%`]))
    .filter((row) => parse<any>(row.tax_meta_json, null)?.assetSaleAssetId === assetId);
const otherAssetSaleInvoice = async (db: PostgresQueryable, scope: TenantScope, assetId: string, invoiceId: string): Promise<boolean> =>
  (await assetSaleInvoices(db, scope, assetId)).some((row) => row.id !== invoiceId && row.status !== 'cancelled');

/** The revenue account of a sale invoice follows the disposal; a Storno or credit note takes the account of its original. */
const assetSaleRevenueAccount = async (db: PostgresQueryable, t: string, chart: 'SKR03' | 'SKR04', assetId: string, row: any): Promise<string> => {
  const accounts = disposalAccounts(chart);
  if (row.source_document_id && (row.document_kind === 'credit_note' || row.document_kind === 'cancellation_invoice')) {
    const original = parse<AccountingSnapshot | undefined>((await q<any>(db, `SELECT accounting_snapshot_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, row.source_document_id]))[0]?.accounting_snapshot_json, undefined);
    const account = original?.lines.find((line) => line.creditAmount > 0 && line.taxCaseKey && (line.accountNumber === accounts.gain || line.accountNumber === accounts.lossProceeds))?.accountNumber;
    if (account) return account;
  }
  const disposal = (await q<any>(db, `SELECT gain_loss FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 AND type='disposal' AND source_type='asset_disposal' ORDER BY created_at DESC LIMIT 1`, [t, assetId]))[0];
  return disposal && Number(disposal.gain_loss) < 0 ? accounts.lossProceeds : accounts.gain;
};
const outputTaxAccount = (chart: 'SKR03' | 'SKR04', rate: 0 | 7 | 19): string => chart === 'SKR03' ? (rate === 7 ? '1771' : '1776') : (rate === 7 ? '3801' : '3806');
const movementSourceExists = async (db: PostgresQueryable, scope: TenantScope, sourceType: string, sourceKey: string): Promise<boolean> => Boolean((await q(db, `SELECT 1 FROM asset_movements WHERE tenant_id=$1 AND source_type=$2 AND source_key=$3 LIMIT 1`, [tenant(scope), sourceType, sourceKey]))[0]);

const postAssetActivation = async (db: PostgresQueryable, scope: TenantScope, input: AssetUpsertInput, id: string, reason: string, options: AssetMutationOptions, chart: 'SKR03' | 'SKR04'): Promise<{ journalEntryId: string; offset: string }> => {
  const offset = input.acquisitionOffsetAccountNumber || await accountFor(db, scope, chart, 'accounts_payable');
  if (!offset) throw new Error('ACQUISITION_OFFSET_ACCOUNT_REQUIRED');
  await assertAccounts(db, chart, [input.assetAccountNumber, offset], 'ACQUISITION_ACCOUNT_NOT_IN_CHART', tenant(scope));
  const sourceKey = `asset_activation:${id}`;
  const journalEntryId = await insertEntry(db, scope, 'asset_activation', sourceKey, input.activationDate, `Anlagenzugang ${input.assetNumber}`, [
    { id: `${id}-asset`, accountNumber: input.assetAccountNumber, debitAmount: round(input.acquisitionCost), creditAmount: 0, costCenter: input.costCenter || undefined, memo: reason },
    { id: `${id}-offset`, accountNumber: offset, debitAmount: 0, creditAmount: round(input.acquisitionCost), costCenter: input.costCenter || undefined, memo: reason },
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
  const t = tenant(scope);
  const table = type === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices';
  const row = (await q<any>(db, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, id]))[0];
  if (!row) throw new Error(type === 'outgoing_invoice' ? 'INVOICE_NOT_FOUND' : 'INCOMING_INVOICE_NOT_FOUND');
  if (type === 'outgoing_invoice' && isNonBillingInvoice(row)) throw new Error('NON_BILLING_DOCUMENT');
  // Posting is idempotent.  In particular, a retry after the document and its
  // open item were committed must not create a second correction allocation.
  if (row.accounting_status === 'posted') {
    const snapshot = parse<AccountingSnapshot | undefined>(row.accounting_snapshot_json, undefined);
    if (snapshot) return { sourceType: type, sourceId: id, status: 'ready', snapshot, issues: [] };
    return postingPreview(db, scope, row, type);
  }
  // Keep terminal document state a domain conflict rather than allowing the
  // later immutable-row trigger to report an implementation-specific error.
  if (row.accounting_status === 'reversed' || row.status === 'cancelled' || (type === 'incoming_invoice' && row.status === 'draft')) throw new Error('DOCUMENT_NOT_POSTABLE');
  if (type === 'outgoing_invoice' && row.client_id) {
    const client = (await q<any>(db, `SELECT tenant_id FROM clients WHERE id=$1`, [row.client_id]))[0];
    if (client && client.tenant_id !== t) throw new Error('CLIENT_NOT_FOUND');
  }
  if (type === 'incoming_invoice') {
    const vendor = (await q<any>(db, `SELECT tenant_id FROM vendors WHERE id=$1`, [row.vendor_id]))[0];
    if (!vendor || vendor.tenant_id !== t) throw new Error('VENDOR_NOT_FOUND');
  }
  if (type === 'outgoing_invoice') {
    if (!options.reservationId) throw new Error('FINALIZED_RESERVATION_REQUIRED');
    const reservation = (await q<any>(db, `SELECT kind,number,status,document_id FROM number_reservations WHERE tenant_id=$1 AND id=$2`, [t, options.reservationId]))[0];
    if (!reservation || reservation.kind !== 'invoice' || reservation.status !== 'finalized' || reservation.document_id !== id || reservation.number !== row.number || row.status === 'draft') throw new Error('FINALIZED_RESERVATION_REQUIRED');
  }

  const preview = await postingPreview(db, scope, row, type);
  if (preview.status !== 'ready' || !preview.snapshot) return preview;
  const correction = type === 'outgoing_invoice'
    && (row.document_kind === 'credit_note' || row.document_kind === 'cancellation_invoice');
  // Credit and cancellation documents carry the same tax/accounting snapshot
  // as an invoice, but their journal is the exact inverse of that snapshot,
  // tax figures included (as in a journal reversal): UStVA, ZM and OSS read them.
  const negate = (value: number | undefined) => (value == null ? value : -Math.abs(value));
  const accountingSnapshot: AccountingSnapshot = correction
    ? { ...preview.snapshot, lines: preview.snapshot.lines.map((line) => ({ ...line, debitAmount: line.creditAmount, creditAmount: line.debitAmount, netAmount: negate(line.netAmount), taxAmount: negate(line.taxAmount), grossAmount: negate(line.grossAmount) })) }
    : preview.snapshot;
  const sourceKey = correction ? `outgoing-correction:${id}` : `${type === 'incoming_invoice' ? 'incoming-invoice' : 'outgoing-invoice'}:${id}`;
  // A correction names the invoice it corrects, so the journal leads back to the original.
  const original = correction && row.source_document_id ? (await q<any>(db, `SELECT number FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, row.source_document_id]))[0]?.number : undefined;
  const bookingText = type === 'outgoing_invoice'
    ? `${row.document_kind === 'credit_note' ? 'Gutschrift' : row.document_kind === 'cancellation_invoice' ? 'Stornorechnung' : 'Rechnung'} ${row.number}${original ? ` zu ${original}` : ''}`
    : `Eingangsrechnung ${row.number}`;
  const entryId = await insertEntry(db, scope, type, sourceKey, type === 'outgoing_invoice' ? row.date : row.invoice_date, bookingText, accountingSnapshot.lines.map((line) => ({
    ...line,
    id: randomUUID(),
    taxCaseKey: line.taxCaseKey as any,
    accountNumber: line.accountNumber,
    debitAmount: round(line.debitAmount),
    creditAmount: round(line.creditAmount),
    memo: line.memo,
  })), { reference: row.number, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason, mutation: options.mutation });
  const postedAt = now();
  const postedSnapshot = { ...accountingSnapshot, capturedAt: postedAt };
  await q(db, `UPDATE ${table} SET accounting_status='posted',accounting_snapshot_json=$1,accounting_journal_entry_id=$2,accounting_posted_at=$3,status=CASE WHEN status='draft' THEN 'open' ELSE status END,updated_at=$3 WHERE tenant_id=$4 AND id=$5`, [JSON.stringify(postedSnapshot), entryId, postedAt, t, id]);

  if (correction && row.source_document_id) {
    // A correction settles the original receivable.  Lock and update that
    // item in the same transaction as the inverse journal entry, bounded by
    // the remaining amount so repeated/parallel corrections cannot overdraw.
    const original = (await q<any>(db, `SELECT id,party_id,original_amount,allocated_amount,residual_amount FROM open_items WHERE tenant_id=$1 AND source_type='outgoing_invoice' AND source_id=$2 FOR UPDATE`, [t, row.source_document_id]))[0];
    if (original) {
      const allocation = round(Math.min(Math.max(0, Number(original.residual_amount)), Math.abs(accountingSnapshot.grossAmount)));
      const allocated = round(Number(original.allocated_amount) + allocation);
      const residual = round(Math.max(0, Number(original.original_amount) - allocated));
      await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, residual, residual <= .01 ? 'paid' : allocated > .01 ? 'partially_paid' : 'open', postedAt, t, original.id]);
      // What the correction takes back beyond the open rest was already paid: the customer is owed it.
      // It stays a credit item (negative residual) of this customer until it is refunded or offset.
      const owed = round(Math.abs(accountingSnapshot.grossAmount) - allocation);
      if (owed > .01) await q(db, `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,'debtor',$3,'outgoing_invoice',$4,$5,$6,$6,$7,0,$7,'open',$8,$9,$9) ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`, [randomUUID(), t, original.party_id, id, row.number, row.date, -owed, entryId, postedAt]);
    }
  } else {
    const itemId = randomUUID();
    await q(db, `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$10,'open',$11,$12,$12) ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`, [itemId, t, type === 'outgoing_invoice' ? 'debtor' : 'creditor', type === 'outgoing_invoice' ? row.client_id ?? row.client ?? id : row.vendor_id, type, id, row.number, type === 'outgoing_invoice' ? row.date : row.invoice_date, row.due_date, accountingSnapshot.grossAmount, entryId, postedAt]);
  }
  await audit(db as PostgresTransactionClient, scope, type === 'outgoing_invoice' ? 'invoice' : type, id, 'accounting_post', 'Document accounting posted', null, { entryId, sourceVersion: accountingSnapshot.sourceVersion, correctionOf: correction ? row.source_document_id ?? undefined : undefined }, options.mutation);
  return { ...preview, snapshot: postedSnapshot };
};

/**
 * Mahngebühr (§288 Abs. 4/5 BGB): damages, not a taxable supply. In Pro it is a receivable of the customer from
 * the moment the reminder went out, booked against sonstige Erträge without a tax case and kept as an open item of
 * its own, so OPOS shows it and a payment can settle it. The issued invoice and its open item stay untouched.
 * Only for an invoice that is in the journal and a reminder date in an open month; idempotent per invoice and level.
 */
const postDunningClaimInTransaction = async (db: PostgresQueryable, scope: TenantScope, kind: 'dunning_fee' | 'dunning_interest', input: { invoiceId: string; level: number; amount: number; date: string; mutation?: AccountingMutationContext }): Promise<void> => {
  if (scope.product !== 'pro' || !(input.amount > 0)) return;
  const t = tenant(scope);
  const invoice = (await q<any>(db, `SELECT id,number,accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, input.invoiceId]))[0];
  const item = (await q<any>(db, `SELECT party_id FROM open_items WHERE tenant_id=$1 AND source_type='outgoing_invoice' AND source_id=$2`, [t, input.invoiceId]))[0];
  if (!invoice || invoice.accounting_status !== 'posted' || !item) return;
  // A reminder dated in a soft-locked or closed month is booked on the first day of the next open month: refusing it
  // would undo the record that the reminder went out, and fee and interest carry no VAT, so no submitted UStVA changes.
  // The reminder date stays the document date and is named in the text.
  let postingDate = input.date;
  let status = await ensurePeriod(db, scope, period(postingDate), postingDate);
  for (let step = 0; status !== 'open' && step < 36; step += 1) {
    const [year, month] = postingDate.split('-').map(Number);
    postingDate = `${month === 12 ? year! + 1 : year}-${String(month === 12 ? 1 : month! + 1).padStart(2, '0')}-01`;
    status = await ensurePeriod(db, scope, period(postingDate), postingDate);
  }
  if (status !== 'open') return;
  const p = await policy(db, t); const m = await mappings(db, t, p.activeChart);
  const amount = round(input.amount); const sourceId = `${invoice.id}:${input.level}`;
  const moved = postingDate === input.date ? '' : ` (Mahnung vom ${input.date.slice(8, 10)}.${input.date.slice(5, 7)}.${input.date.slice(0, 4)})`;
  const entryId = await insertEntry(db, scope, kind, `${kind === 'dunning_fee' ? 'dunning-fee' : 'dunning-interest'}:${sourceId}`, postingDate, `${kind === 'dunning_fee' ? 'Mahngebühr' : 'Verzugszinsen'} ${invoice.number} Stufe ${input.level}${moved}`, [
    { id: randomUUID(), accountNumber: m.accounts_receivable, debitAmount: amount, creditAmount: 0 },
    { id: randomUUID(), accountNumber: kind === 'dunning_fee' ? m.dunning_fees : m.late_interest, debitAmount: 0, creditAmount: amount },
  ], { documentDate: input.date, reference: invoice.number, mutation: input.mutation });
  const stamp = now();
  await q(db, `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,'debtor',$3,$10,$4,$5,$6,$6,$7,0,$7,'open',$8,$9,$9) ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`, [randomUUID(), t, item.party_id, sourceId, invoice.number, input.date, amount, entryId, stamp, kind]);
};

export const postDunningFeeInTransaction = (db: PostgresQueryable, scope: TenantScope, input: { invoiceId: string; level: number; fee: number; date: string; mutation?: AccountingMutationContext }): Promise<void> =>
  postDunningClaimInTransaction(db, scope, 'dunning_fee', { ...input, amount: input.fee });

export const postDunningInterestInTransaction = (db: PostgresQueryable, scope: TenantScope, input: { invoiceId: string; level: number; interest: number; date: string; mutation?: AccountingMutationContext }): Promise<void> =>
  postDunningClaimInTransaction(db, scope, 'dunning_interest', { ...input, amount: input.interest });

const SKONTO_PAYMENT_ID = 'skonto:';
const standingSkonto = async (db: PostgresQueryable, t: string, invoiceId: string): Promise<any> =>
  (await q<any>(db, `SELECT * FROM journal_entries WHERE tenant_id=$1 AND source_type='skonto' AND source_key LIKE $2 AND status='posted' ORDER BY entry_number DESC LIMIT 1`, [t, `skonto:${invoiceId}:%`]))[0];
const projectSkonto = async (db: PostgresQueryable, t: string, invoiceId: string, skonto: { date: string; amount: number } | null, stamp: string): Promise<void> => {
  const row = (await q<any>(db, `SELECT payments_json FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, invoiceId]))[0];
  if (!row) return;
  const id = `${SKONTO_PAYMENT_ID}${invoiceId}`;
  const kept = parse<any[]>(row.payments_json, []).filter((entry) => entry?.id !== id);
  await q(db, `UPDATE invoices SET payments_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(skonto ? [...kept, { id, date: skonto.date, amount: skonto.amount, method: 'Skonto' }] : kept), stamp, t, invoiceId]);
};

/**
 * Skonto in Pro, derived from the money like in Lite: received within the Skonto days and covering the open
 * amount less the Skonto, the rest is booked as gewährte Skonti (Erlösschmälerung) with its VAT (§17 UStG) and
 * the open item is settled. Under Ist the VAT part comes off the not-yet-due account, because the payment only
 * recognised the VAT of the money received. The invoice lists it as a payment "Skonto" (no money).
 */
const settleSkontoInTransaction = async (db: PostgresQueryable, scope: TenantScope, itemId: string, paymentDate: string, paymentId: string, mutation?: AccountingMutationContext): Promise<void> => {
  const t = tenant(scope);
  const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, itemId]))[0];
  if (!item || item.source_type !== 'outgoing_invoice' || Number(item.original_amount) <= 0) return;
  const invoice = (await q<any>(db, `SELECT id,number,date,status,skonto_json,accounting_snapshot_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, item.source_id]))[0];
  const terms = parse<{ percent?: number; days?: number } | null>(invoice?.skonto_json, null);
  if (!invoice || !terms?.percent || !terms.days || invoice.status === 'cancelled' || await standingSkonto(db, t, invoice.id)) return;
  const residual = Math.round(Number(item.residual_amount) * 100);
  if (residual <= 0) return;
  // Money on the item (payments less refunds and their reversals); the rest of the allocation is credit notes.
  const paid = Math.round(Number((await q<any>(db, `SELECT COALESCE(SUM(amount),0) AS paid FROM open_item_allocations WHERE tenant_id=$1 AND open_item_id=$2`, [t, item.id]))[0]?.paid ?? 0) * 100);
  const open = Math.round(Number(item.original_amount) * 100) - (Math.round(Number(item.allocated_amount) * 100) - paid);
  const deadline = new Date(Date.parse(`${String(invoice.date).slice(0, 10)}T00:00:00Z`) + terms.days * 86_400_000).toISOString().slice(0, 10);
  if (paymentDate > deadline || paid < Math.round(open * (1 - terms.percent / 100)) || paid >= open || residual !== open - paid) return;
  const snapshot = parse<AccountingSnapshot | undefined>(invoice.accounting_snapshot_json, undefined);
  const bases = (snapshot?.lines ?? []).filter((line) => line.creditAmount > 0 && line.taxCaseKey);
  if (!snapshot || !bases.length) return;
  const ist = snapshot.vatMethod === 'ist';
  const p = await policy(db, t);
  const m = await mappings(db, t, p.activeChart);
  const parts = bases.map((line) => {
    const control = snapshot.lines.find((candidate) => candidate.creditAmount > 0 && candidate.memo === `USt ${line.taxCaseKey}`);
    const tax = Math.round(Number(control?.creditAmount ?? 0) * 100);
    return { key: String(line.taxCaseKey), rate: line.taxRate, tax, gross: Math.round(line.creditAmount * 100) + tax, deferred: control?.accountNumber };
  });
  const total = parts.reduce((sum, part) => sum + part.gross, 0);
  if (total <= 0) return;
  const lines: JournalLineEntity[] = [];
  let left = residual;
  for (const [index, part] of parts.entries()) {
    const share = index === parts.length - 1 ? left : Math.round(residual * part.gross / total);
    left -= share;
    if (share <= 0) continue;
    const tax = part.gross ? Math.round(share * part.tax / part.gross) : 0;
    const net = share - tax;
    const discount = await taxCaseAccount(db, t, p.activeChart, part.key, 'cash_discount', undefined, paymentDate);
    // Under Ist this VAT was never reported (only the money received was): no VAT figures on the line.
    lines.push({ id: randomUUID(), accountNumber: discount, debitAmount: net / 100, creditAmount: 0, ...(ist ? {} : { taxCaseKey: part.key as TaxCaseKey, taxRate: part.rate, netAmount: -net / 100, taxAmount: -tax / 100, grossAmount: -share / 100 }), memo: `Skonto ${part.key}` });
    if (tax > 0) lines.push({ id: randomUUID(), accountNumber: ist ? part.deferred ?? await taxCaseAccount(db, t, p.activeChart, part.key, 'output_tax_deferred', undefined, paymentDate) : await taxCaseAccount(db, t, p.activeChart, part.key, 'output_tax', m.output_vat, paymentDate), debitAmount: tax / 100, creditAmount: 0, memo: `USt Skonto ${part.key}` });
  }
  lines.push({ id: randomUUID(), accountNumber: m.accounts_receivable, debitAmount: 0, creditAmount: residual / 100 });
  await insertEntry(db, scope, 'skonto', `skonto:${invoice.id}:${paymentId}`, paymentDate, `Skonto ${invoice.number}`, lines, { reference: invoice.number, mutation });
  const stamp = now();
  await q(db, `UPDATE open_items SET allocated_amount=original_amount,residual_amount=0,status='paid',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [stamp, t, item.id]);
  await q(db, `UPDATE invoices SET status='paid',updated_at=$1 WHERE tenant_id=$2 AND id=$3 AND accounting_status='posted' AND status <> 'cancelled'`, [stamp, t, invoice.id]);
  await projectSkonto(db, t, invoice.id, { date: paymentDate, amount: residual / 100 }, stamp);
};

/** No money, no Skonto: reversing a payment of the invoice reverses its Skonto and reopens that amount. */
const reverseSkontoInTransaction = async (db: PostgresQueryable, scope: TenantScope, itemId: string, reason: string, postingDate: string, mutation?: AccountingMutationContext): Promise<string | undefined> => {
  const t = tenant(scope);
  const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, itemId]))[0];
  if (!item || item.source_type !== 'outgoing_invoice') return undefined;
  const entry = await standingSkonto(db, t, item.source_id);
  if (!entry) return undefined;
  const amount = round((await q<any>(db, `SELECT COALESCE(SUM(credit_amount),0) AS amount FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 AND credit_amount > 0`, [t, entry.id]))[0]?.amount);
  const { reversalEntryId } = await reverseEntryInTransaction(db, scope, entry.id, reason, { postingDate: postingDate < entry.posting_date ? entry.posting_date : postingDate, mutation, allowPaymentSource: true });
  const allocated = round(Number(item.allocated_amount) - amount);
  const next = itemStatus(item, allocated);
  const stamp = now();
  await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, next.residual, next.status, stamp, t, item.id]);
  await q(db, `UPDATE invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted' AND status <> 'cancelled'`, [next.status === 'paid' ? 'paid' : 'open', stamp, t, item.source_id]);
  await projectSkonto(db, t, item.source_id, null, stamp);
  return reversalEntryId;
};

const allocatePayment = async (db: PostgresQueryable, scope: TenantScope, input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity> => {
  const t = tenant(scope);
  const stamp = now();
  const allocationEventId = requireAllocationEventId(input.allocationEventId);
  // A reversed payment is history; its source can be allocated anew (Umbuchung).
  const duplicate = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND status <> 'reversed' FOR UPDATE`, [t, input.sourceType, input.sourceId]))[0];
  if (duplicate) {
    if (duplicate.party_type !== input.partyType || (input.partyId && duplicate.party_id !== input.partyId) || round(duplicate.amount) !== round(input.amount) || duplicate.payment_date !== input.paymentDate || duplicate.bank_account_number !== input.bankAccountNumber) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if ((await q(db, `SELECT 1 FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 AND event_key = ANY($3::text[]) LIMIT 1`, [t, duplicate.id, input.allocations.map((allocation) => `${allocationEventId}:${allocation.openItemId}`)]))[0]) return rowPayment(duplicate);
    if (Number(duplicate.residual_amount) <= .01) return rowPayment(duplicate);
    const requestedTotal = round(input.allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0));
    if (requestedTotal > Number(duplicate.residual_amount) + .01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
    if (!input.paymentId || input.paymentId !== duplicate.id) return rowPayment(duplicate);
    if (duplicate.refund) throw new Error('PAYMENT_REFUND_REMAINING_UNSUPPORTED: Der Rest einer Erstattung wird nicht nachträglich zugeordnet.');

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
      if (item.source_type === 'outgoing_invoice') await projectInvoicePayment(db, t, duplicate, item.source_id, amount, stamp);
      if (!duplicate.refund) await settleSkontoInTransaction(db, scope, item.id, input.paymentDate, duplicate.id, input.mutation);
    }
    const totals = (await q<any>(db, `SELECT COALESCE(SUM(amount),0) allocated FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2`, [t, duplicate.id]))[0];
    const allocatedTotal = round(totals.allocated);
    const residualTotal = round(Number(duplicate.amount) - allocatedTotal);
    await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocatedTotal, residualTotal, residualTotal > .01 ? 'partially_allocated' : 'allocated', t, duplicate.id]);
    await audit(db as PostgresTransactionClient, scope, 'open_item_payment', duplicate.id, 'allocate', 'Payment allocation', null, { ...input, mutation: undefined }, input.mutation);
    return rowPayment((await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2`, [t, duplicate.id]))[0]);
  }

  if (!isoDate(input.paymentDate) || !Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('INVALID_PAYMENT'); const total = round(input.amount); const allocTotal = round(input.allocations.reduce((sum, a) => sum + Number(a.amount), 0)); if (allocTotal > total + .01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_PAYMENT');
  // A refund moves money the other way: to a customer (Rückzahlung, Rücklastschrift) or from a supplier.
  // It books Forderungen an Bank (Bank an Verbindlichkeiten) and takes back what was paid on an item, or
  // pays out a credit (negative open item, or the surplus of an earlier payment).
  let refund = input.refund === true;
  if (input.sourceType === 'bank_transaction') {
    const source = (await q<any>(db, `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, input.sourceId]))[0];
    if (!source) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    if (round(Math.abs(Number(source.amount))) !== total || source.date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (source.status === 'booked' || source.linked_invoice_id) throw new Error('PAYMENT_SOURCE_ALREADY_BOOKED');
    const expectedType = input.partyType === 'debtor' ? 'income' : 'expense';
    if (input.refund === false && source.type !== expectedType) throw new Error('PAYMENT_SOURCE_DIRECTION_MISMATCH');
    refund = source.type !== expectedType;
    if (!input.partyId) throw new Error('PAYMENT_PARTY_REQUIRED');
    // The money moved on this bank account, so the entry books its ledger account and no other.
    if (input.bankAccountNumber !== await bankLedgerAccount(db, t, source.account_id)) throw new Error('PAYMENT_BANK_ACCOUNT_MISMATCH');
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
    refund = Number(payment.amount) < 0;
  }
  const requestedByItem = new Map<string, number>();
  for (const allocation of input.allocations) {
    const amount = round(allocation.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_PAYMENT_ALLOCATION');
    requestedByItem.set(allocation.openItemId, round((requestedByItem.get(allocation.openItemId) ?? 0) + amount));
  }
  const items: any[] = [];
  let credited: { payment: any; amount: number } | undefined;
  for (const [openItemId, amount] of requestedByItem) {
    if (openItemId.startsWith(PAYMENT_CREDIT_PREFIX)) {
      // The surplus of an earlier payment is the partner's credit; only a refund pays it out.
      const creditPayment = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 AND status <> 'reversed' FOR UPDATE`, [t, openItemId.slice(PAYMENT_CREDIT_PREFIX.length)]))[0];
      if (!creditPayment) throw new Error('OPEN_ITEM_NOT_FOUND');
      if (creditPayment.party_type !== input.partyType || (input.partyId && creditPayment.party_id !== input.partyId)) throw new Error('PAYMENT_PARTY_MISMATCH');
      if (!refund || credited || amount > Number(creditPayment.residual_amount) + .01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
      credited = { payment: creditPayment, amount };
      continue;
    }
    const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, openItemId]))[0];
    if (!item) throw new Error('OPEN_ITEM_NOT_FOUND');
    if (item.party_type !== input.partyType || (input.partyId && item.party_id !== input.partyId)) throw new Error('PAYMENT_PARTY_MISMATCH');
    await assertOpenItemSource(db, t, item);
    // A payment settles what is open; a refund takes back at most what was paid, or pays out a credit item.
    const limit = !refund ? Number(item.residual_amount) : Number(item.original_amount) < 0 ? -Number(item.residual_amount) : Number(item.allocated_amount);
    if (amount > limit + .01) throw new Error(refund ? 'OPEN_ITEM_REFUND_EXCEEDS_PAID' : 'OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
    items.push({ item, amount: refund ? -amount : amount });
  }
  const p = await policy(db, t);
  const m = await mappings(db, t, p.activeChart);
  if (!(await accountExists(db, p.activeChart, input.bankAccountNumber, tenant(scope)))) throw new Error(`UNKNOWN_ACCOUNT:${input.bankAccountNumber}`);
  const moneyIn = (input.partyType === 'debtor') !== refund;
  const party = input.partyType === 'debtor' ? m.accounts_receivable : m.accounts_payable;
  const lines: JournalLineEntity[] = moneyIn
    ? [{ id: randomUUID(), accountNumber: input.bankAccountNumber, debitAmount: total, creditAmount: 0 }, { id: randomUUID(), accountNumber: party, debitAmount: 0, creditAmount: total }]
    : [{ id: randomUUID(), accountNumber: party, debitAmount: total, creditAmount: 0 }, { id: randomUUID(), accountNumber: input.bankAccountNumber, debitAmount: 0, creditAmount: total }];
  const paymentId = input.paymentId ?? randomUUID();
  // The first booking of a source keeps its historic key; a source booked again after a Zahlungsstorno gets its own.
  const rebooked = (await q<any>(db, `SELECT 1 FROM open_item_payments WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND status='reversed' LIMIT 1`, [t, input.sourceType, input.sourceId]))[0];
  // The journal and DATEV Belegfeld 1 name what the payment settles: the document number(s) and the partner.
  const numbers = [...new Set(items.map((allocation) => String(allocation.item.document_number ?? '')).filter(Boolean))];
  const partner = items[0] ? await openItemPartnerName(db, t, items[0].item) : undefined;
  const defaultText = [refund ? 'Erstattung' : 'Zahlung', numbers.join(', '), partner].filter(Boolean).join(' ');
  const entryId = await insertEntry(db, scope, 'payment', `payment:${input.sourceType}:${input.sourceId}${rebooked ? `:${paymentId}` : ''}`, input.paymentDate, input.bookingText?.trim() || defaultText, lines, { reference: numbers[0], mutation: input.mutation });
  await q(db, `INSERT INTO open_item_payments (id,tenant_id,party_type,party_id,payment_date,amount,bank_account_number,method,source_type,source_id,allocated_amount,residual_amount,status,journal_entry_id,created_at,refund,credited_payment_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [paymentId, t, input.partyType, input.partyId ?? items[0]?.item.party_id ?? credited?.payment.party_id ?? null, input.paymentDate, total, input.bankAccountNumber, input.method ?? null, input.sourceType, input.sourceId, 0, total, 'open', entryId, stamp, refund, credited?.payment.id ?? null]);
  for (const allocation of items) {
    const allocationId = randomUUID();
    const beforeAllocated = Number(allocation.item.allocated_amount);
    const allocated = round(beforeAllocated + allocation.amount);
    const next = itemStatus(allocation.item, allocated);
    const eventKey = `${allocationEventId}:${allocation.item.id}`;
    if ((await q<any>(db, `SELECT id FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 AND event_key=$3 LIMIT 1`, [t, paymentId, eventKey]))[0]) continue;
    await q(db, `INSERT INTO open_item_allocations (id,tenant_id,payment_id,open_item_id,amount,created_at,event_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [allocationId, t, paymentId, allocation.item.id, allocation.amount, stamp, eventKey]);
    await recognizeIstVat(db, scope, allocation.item, paymentId, `${allocationEventId}:${allocation.item.id}`, allocation.amount, beforeAllocated, allocated, input.paymentDate);
    await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, next.residual, next.status, stamp, t, allocation.item.id]);
    const documentStatus = next.status === 'paid' ? 'paid' : 'open';
    if (allocation.item.source_type === 'outgoing_invoice') await q(db, `UPDATE invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted' AND status <> 'cancelled'`, [documentStatus, stamp, t, allocation.item.source_id]);
    if (allocation.item.source_type === 'incoming_invoice') await q(db, `UPDATE incoming_invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [documentStatus, stamp, t, allocation.item.source_id]);
    if (allocation.item.source_type === 'outgoing_invoice') await projectInvoicePayment(db, t, { id: paymentId, source_type: input.sourceType, source_id: input.sourceId, payment_date: input.paymentDate, method: input.method ?? (refund ? 'Erstattung' : undefined) }, allocation.item.source_id, allocation.amount, stamp);
    if (!refund) await settleSkontoInTransaction(db, scope, allocation.item.id, input.paymentDate, paymentId, input.mutation);
  }
  if (credited) {
    const allocatedCredit = round(Number(credited.payment.allocated_amount) + credited.amount);
    const residualCredit = round(Number(credited.payment.amount) - allocatedCredit);
    await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocatedCredit, residualCredit, residualCredit > .01 ? 'partially_allocated' : 'allocated', t, credited.payment.id]);
  }
  const allocated = round(items.reduce((sum, x) => sum + Math.abs(x.amount), 0) + (credited?.amount ?? 0));
  const residual = round(total - allocated);
  await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocated, residual, residual > .01 ? allocated ? 'partially_allocated' : 'overpaid' : 'allocated', t, paymentId]);
  if (input.sourceType === 'bank_transaction') {
    const linked = (await q<any>(db, `SELECT source_id FROM open_items oi JOIN open_item_allocations oa ON oa.open_item_id=oi.id WHERE oa.tenant_id=$1 AND oa.payment_id=$2 AND oi.source_type='outgoing_invoice' ORDER BY oa.created_at LIMIT 1`, [t, paymentId]))[0];
    await q(db, `UPDATE bank_transactions SET status='booked',linked_invoice_id=COALESCE($1,linked_invoice_id),updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [linked?.source_id ?? null, stamp, t, input.sourceId]);
    // The imported row behind the bank line shows the same link in the bank list.
    if (linked?.source_id) await q(db, `UPDATE transactions SET linked_invoice_id=$1 WHERE tenant_id=$2 AND id=(SELECT source_transaction_id FROM bank_transactions WHERE tenant_id=$2 AND id=$3) AND (linked_invoice_id IS NULL OR linked_invoice_id='')`, [linked.source_id, t, input.sourceId]);
  }
  await audit(db as PostgresTransactionClient, scope, 'open_item_payment', paymentId, 'allocate', 'Payment allocation', null, { ...input, mutation: undefined }, input.mutation);
  return rowPayment((await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2`, [t, paymentId]))[0]);
};

/** The ledger account of a bank account: its own SKR account, or the bank role of the chart. */
const bankLedgerAccount = async (db: PostgresQueryable, t: string, accountId: unknown): Promise<string> => {
  const own = accountId ? (await q<any>(db, `SELECT default_skr_account_number FROM accounts WHERE tenant_id=$1 AND id=$2`, [t, accountId]))[0]?.default_skr_account_number : undefined;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const p = await policy(db, t);
  return (await mappings(db, t, p.activeChart)).bank!;
};

/**
 * Saves a Pro bank account. Its ledger account must be a money account of the active chart (Kasse/Bank); a blank one
 * takes the bank role. When it changes, the drafts of its bank lines that are not posted yet move to the new account.
 */
export const saveProServerBankAccount = async (db: PostgresQueryable, scope: TenantScope, record: ServerBankAccountRecord): Promise<ServerBankAccountRecord> => inTx(db, async (tx) => {
  const t = tenant(scope);
  const p = await policy(tx, t);
  const requested = record.defaultSkrAccountNumber?.trim();
  const ledgerAccount = requested || (await mappings(tx, t, p.activeChart)).bank!;
  const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 422 });
  if (!isMoneyLedgerAccount(p.activeChart, ledgerAccount)) throw refuse(`Das Konto ${ledgerAccount} ist kein Geld- oder Bankkonto im ${p.activeChart}. Wählen Sie ein Bank- oder Kassenkonto, zum Beispiel ${BANK_ACCOUNT_DEFAULT[p.activeChart]}.`);
  if (!(await accountExists(tx, p.activeChart, ledgerAccount, t))) throw refuse(`Das Konto ${ledgerAccount} ist im Kontenrahmen ${p.activeChart} nicht vorhanden oder deaktiviert.`);
  const exists = (await q<any>(tx, `SELECT 1 FROM accounts WHERE tenant_id=$1 AND id=$2`, [t, record.id]))[0];
  const previous = exists ? await bankLedgerAccount(tx, t, record.id) : undefined;
  const saved = await saveServerBankAccount(tx, { ...record, defaultSkrAccountNumber: ledgerAccount });
  if (previous && previous !== ledgerAccount) {
    const drafts = await q<any>(tx, `SELECT bd.transaction_id FROM booking_drafts bd JOIN bank_transactions bt ON bt.tenant_id=bd.tenant_id AND bt.id=bd.transaction_id WHERE bd.tenant_id=$1 AND bt.account_id=$2 AND bd.workflow_status<>'posted' ORDER BY bd.id`, [t, record.id]);
    for (const row of drafts) {
      const draft = await getDraft(tx, scope, row.transaction_id);
      if (!draft || !draft.lines.some((line) => line.accountNumber === previous)) continue;
      await saveDraftTarget(tx, scope, { ...draft, lines: draft.lines.map((line) => (line.accountNumber === previous ? { ...line, accountNumber: ledgerAccount } : line)) });
    }
  }
  return saved;
});

const writeAccountingPolicy = async (tx: PostgresQueryable, scope: TenantScope, input: { activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; mutation?: AccountingMutationContext }) => { const t = tenant(scope); const before = await policy(tx, t); if (input.activeChart !== before.activeChart && (await q<any>(tx, `SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND status='posted' LIMIT 1`, [t]))[0]) throw new AccountingPolicyError('ACCOUNTING_CHART_LOCKED', 'Der Kontenrahmen kann nach einer gebuchten Journalbuchung nicht mehr geändert werden.'); const stamp = now(); await q(tx, `INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,$2,$3,'calendar_month',$4) ON CONFLICT (tenant_id) DO UPDATE SET active_chart=EXCLUDED.active_chart,vat_method=EXCLUDED.vat_method,updated_at=EXCLUDED.updated_at`, [t, input.activeChart, input.vatMethod, stamp]); await audit(tx as PostgresTransactionClient, scope, 'accounting_policy', t, 'update', 'Accounting policy changed', before, { activeChart: input.activeChart, vatMethod: input.vatMethod }, input.mutation); return policy(tx, t); };
/**
 * The Pro settings own the user's choice of chart and Soll/Ist; the posting policy follows a changed choice in the
 * same transaction as the settings save. A chart switch after the first posting is refused (ACCOUNTING_CHART_LOCKED).
 */
export const applyProSettingsToAccountingPolicy = async (tx: PostgresQueryable, scope: TenantScope, change: { activeChart?: 'SKR03' | 'SKR04'; vatMethod?: 'soll' | 'ist' }, mutation?: AccountingMutationContext): Promise<void> => {
  if (!change.activeChart && !change.vatMethod) return;
  const before = await policy(tx, tenant(scope));
  const next = { activeChart: change.activeChart ?? before.activeChart, vatMethod: change.vatMethod ?? before.vatMethod };
  if (next.activeChart === before.activeChart && next.vatMethod === before.vatMethod) return;
  await writeAccountingPolicy(tx, scope, { ...next, mutation });
};

/** The id under which an OPOS payment shows on the invoice (payments_json). */
const invoicePaymentEntryId = async (db: PostgresQueryable, t: string, payment: { id: string; source_type: string; source_id: string }): Promise<string> => {
  if (payment.source_type === 'invoice_payment') return String(payment.source_id);
  if (payment.source_type === 'bank_transaction') {
    const legacy = (await q<any>(db, `SELECT source_transaction_id FROM bank_transactions WHERE tenant_id=$1 AND id=$2`, [t, payment.source_id]))[0]?.source_transaction_id;
    if (legacy) return `transaction-payment:${legacy}`;
  }
  return `open-item-payment:${payment.id}`;
};

/**
 * Pro has one payment truth: the OPOS allocation and its journal entry. The invoice keeps the payments it
 * shows (payments_json) in step, in the same transaction. A payment recorded on the invoice itself is
 * already listed there, so only bank and OPOS payments are projected.
 */
const projectInvoicePayment = async (db: PostgresQueryable, t: string, payment: { id: string; source_type: string; source_id: string; payment_date: string; method?: string | null }, invoiceId: string, delta: number, stamp: string): Promise<void> => {
  if (payment.source_type === 'invoice_payment' || Math.abs(delta) < .005) return;
  const row = (await q<any>(db, `SELECT payments_json FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, invoiceId]))[0];
  if (!row) return;
  const id = await invoicePaymentEntryId(db, t, payment);
  const payments = parse<any[]>(row.payments_json, []);
  const index = payments.findIndex((entry) => entry?.id === id);
  const amount = round((index >= 0 ? Number(payments[index].amount) : 0) + delta);
  const entry = { ...(index >= 0 ? payments[index] : {}), id, date: payment.payment_date, amount, method: (index >= 0 ? payments[index].method : undefined) ?? payment.method ?? 'Überweisung' };
  const next = index >= 0 ? payments.map((candidate, at) => at === index ? entry : candidate) : [...payments, entry];
  await q(db, `UPDATE invoices SET payments_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(next.filter((candidate) => Math.abs(Number(candidate.amount)) >= .005)), stamp, t, invoiceId]);
};

const PAYMENT_CREDIT_PREFIX = 'payment-credit:';
const itemStatus = (item: { original_amount: unknown }, allocated: number): { residual: number; status: string } => {
  const residual = round(Number(item.original_amount) - allocated);
  return { residual, status: Math.abs(residual) <= .01 ? 'paid' : Math.abs(allocated) > .01 ? 'partially_paid' : 'open' };
};

export interface OpenItemPaymentReversal {
  paymentId: string;
  reversalEntryIds: string[];
  reopenedItemIds: string[];
}

/**
 * Zahlungsstorno: the payment entry and every Ist-VAT recognition of the payment get their mirror entry,
 * each allocation is taken back by a counter-allocation (rows are never deleted), open items and invoice
 * status follow, the invoice no longer lists the payment, and a bank line is open again for a new
 * allocation. The reversal is dated like the payment unless a date is given; a closed month refuses it.
 */
/**
 * A person confirmed a posting into a vorläufig gesperrten month (with a written reason) for a whole command whose
 * postings run deep in the repository (invoice payment, its Zahlungsstorno, Skonto, Ist-VAT): every entry of this
 * transaction passes the soft lock and carries the reason in its audit. A closed month stays closed.
 */
export const allowSoftLockedPostingsInTransaction = async (db: PostgresQueryable, reason: string): Promise<void> => {
  if (!reason.trim()) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
  await q(db, `SELECT set_config('billme.soft_lock_override', $1, true)`, [reason.trim()]);
};
/**
 * Takes a sale through an invoice back when its draft is deleted or the issued invoice is stornoed: the book value and
 * the AfA up to the sale are reversed on the given date (Gegenbuchung, the originals stay in the journal), the asset is
 * on the books again and its AfA plan planned. Nothing happens for an invoice that sells no asset, for an asset that is
 * not disposed, or while another live sale invoice of the asset keeps the sale (the replacement of a revision).
 */
export const reverseAssetSaleInTransaction = async (db: PostgresQueryable, scope: TenantScope, input: { invoiceId: string; reason: string; postingDate: string; softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext }): Promise<void> => {
  if (scope.product !== 'pro') return;
  const t = tenant(scope);
  const assetId = parse<any>((await q<any>(db, `SELECT tax_meta_json FROM invoices WHERE tenant_id=$1 AND id=$2`, [t, input.invoiceId]))[0]?.tax_meta_json, null)?.assetSaleAssetId;
  if (!assetId) return;
  const row = (await q<AssetDbRow>(db, `SELECT * FROM assets WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, assetId]))[0];
  if (!row?.disposal_date || await otherAssetSaleInvoice(db, scope, assetId, input.invoiceId)) return;
  const disposalKey = await disposalSourceKey(db, scope, assetId);
  const disposal = (await q<any>(db, `SELECT * FROM asset_movements WHERE tenant_id=$1 AND asset_id=$2 AND type='disposal' AND source_type='asset_disposal' AND source_key=$3`, [t, assetId, disposalKey]))[0];
  if (!disposal) return;
  const reason = input.reason.trim() || 'Anlagenverkauf rückgängig';
  const options = { postingDate: input.postingDate, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation, allowAssetSource: true };
  const stamp = now();
  const reversals: string[] = [];
  const disposalReversal = disposal.journal_entry_id ? (await reverseEntryInTransaction(db, scope, disposal.journal_entry_id, reason, options)).reversalEntryId : null;
  if (disposalReversal) reversals.push(disposalReversal);
  // Counter-movements of the same type keep the Anlagenspiegel right: the disposal and the AfA of the sale net to zero.
  await q(db, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'disposal',$4,$5,NULL,$6,$7,'asset_disposal_reversal',$8,$9,$10)`, [randomUUID(), t, assetId, input.postingDate, -Number(disposal.amount), disposal.gain_loss == null ? null : -Number(disposal.gain_loss), disposalReversal, `${disposalKey}:reversal`, reason, stamp]);
  // The AfA the disposal booked up to the sale month; the year is depreciated in full again at its end.
  const partial = (await q<any>(db, `SELECT m.journal_entry_id,m.amount,m.source_key FROM asset_movements m JOIN journal_entries je ON je.tenant_id=m.tenant_id AND je.id=m.journal_entry_id WHERE m.tenant_id=$1 AND m.asset_id=$2 AND m.type='depreciation' AND m.source_type='asset_depreciation' AND m.movement_date=$3 AND je.status='posted' AND je.booking_text LIKE '% bis Abgang'`, [t, assetId, disposal.movement_date]))[0];
  if (partial) {
    const { reversalEntryId } = await reverseEntryInTransaction(db, scope, partial.journal_entry_id, reason, options);
    reversals.push(reversalEntryId);
    await q(db, `INSERT INTO asset_movements (id,tenant_id,asset_id,type,movement_date,amount,proceeds,gain_loss,journal_entry_id,source_type,source_key,reason,created_at) VALUES ($1,$2,$3,'depreciation',$4,$5,NULL,NULL,$6,'asset_depreciation_reversal',$7,$8,$9)`, [randomUUID(), t, assetId, input.postingDate, -Number(partial.amount), reversalEntryId, `${partial.source_key}:reversal`, reason, stamp]);
  }
  const plan = buildDepreciationSchedule({ ...assetInputFor(row), method: resolveDepreciationMethod(assetInputFor(row)), fiscalYearStart: await reportingFiscalYearStart(db, t) });
  for (const entry of await assetSchedule(db, scope, assetId)) {
    if (entry.status !== 'cancelled' && !(partial && entry.journalEntryId === partial.journal_entry_id)) continue;
    const planned = plan.find((candidate) => candidate.year === entry.year);
    await q(db, `UPDATE asset_depreciation_schedule SET status='planned',amount=$1,months=$2,journal_entry_id=NULL,source_type=NULL,source_key=NULL,posted_at=NULL WHERE tenant_id=$3 AND id=$4`, [planned?.amount ?? entry.amount, planned?.months ?? entry.months, t, entry.id]);
  }
  const schedule = await assetSchedule(db, scope, assetId);
  const status = schedule.length > 0 && schedule.every((entry) => entry.status === 'posted') ? 'voll_abgeschrieben' : 'aktiv';
  await q(db, `UPDATE assets SET status=$1,disposal_date=NULL,disposal_proceeds=NULL,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [status, stamp, t, assetId]);
  const after = await assetRow(db, scope, assetId);
  await audit(db as PostgresTransactionClient, scope, 'asset', assetId, 'disposal_reversed', reason, { asset: assetSnapshot(row) }, { asset: assetSnapshot(after), schedule, invoiceId: input.invoiceId, reversalEntryIds: reversals }, input.mutation);
};

export const reverseOpenItemPaymentInTransaction = async (db: PostgresQueryable, scope: TenantScope, input: { paymentId: string; reason: string; postingDate?: string; mutation?: AccountingMutationContext }): Promise<OpenItemPaymentReversal> => {
  const t = tenant(scope);
  const reason = input.reason?.trim();
  if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
  const payment = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, input.paymentId]))[0];
  if (!payment) throw new Error('OPEN_ITEM_PAYMENT_NOT_FOUND');
  if (payment.status === 'reversed') throw new Error('ALREADY_REVERSED: Die Zahlung ist bereits storniert.');
  const postingDate = input.postingDate ?? payment.payment_date;
  if (!isoDate(postingDate)) throw new Error('INVALID_PAYMENT_REVERSAL_DATE');
  // A refund that paid out the surplus of this payment has to be reversed first.
  if ((await q<any>(db, `SELECT 1 FROM open_item_payments WHERE tenant_id=$1 AND credited_payment_id=$2 AND status <> 'reversed' LIMIT 1`, [t, payment.id]))[0]) throw new Error('ALREADY_REFUNDED: Ein Teil dieser Zahlung wurde erstattet; bitte zuerst die Erstattung stornieren.');
  const stamp = now();
  const reversalEntryIds: string[] = [];
  for (const row of await q<any>(db, `SELECT DISTINCT open_item_id FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2`, [t, payment.id])) {
    const skontoReversal = await reverseSkontoInTransaction(db, scope, row.open_item_id, reason, postingDate, input.mutation);
    if (skontoReversal) reversalEntryIds.push(skontoReversal);
  }
  const entries = await q<any>(db, `SELECT id FROM journal_entries WHERE tenant_id=$1 AND status='posted' AND ((source_type='payment' AND id=$2) OR (source_type='payment_vat' AND source_key LIKE $3)) ORDER BY entry_number`, [t, payment.journal_entry_id, `payment-vat:${payment.id}:%`]);
  for (const entry of entries) {
    reversalEntryIds.push((await reverseEntryInTransaction(db, scope, entry.id, reason, { postingDate, mutation: input.mutation, allowPaymentSource: true })).reversalEntryId);
  }
  const allocations = await q<any>(db, `SELECT open_item_id, SUM(amount) AS amount FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2 GROUP BY open_item_id ORDER BY open_item_id`, [t, payment.id]);
  const reopenedItemIds: string[] = [];
  for (const allocation of allocations) {
    const amount = round(allocation.amount);
    if (Math.abs(amount) < .005) continue;
    const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, allocation.open_item_id]))[0];
    if (!item) continue;
    await q(db, `INSERT INTO open_item_allocations (id,tenant_id,payment_id,open_item_id,amount,created_at,event_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), t, payment.id, item.id, -amount, stamp, `reversal:${item.id}`]);
    const allocated = round(Number(item.allocated_amount) - amount);
    // Paid back already (Rücklastschrift, Erstattung): that refund is reversed first, never the item below zero.
    if (Number(item.original_amount) > 0 && allocated < -.01) throw new Error('ALREADY_REFUNDED: Diese Zahlung wurde schon erstattet; bitte zuerst die Erstattung stornieren.');
    const next = itemStatus(item, allocated);
    await q(db, `UPDATE open_items SET allocated_amount=$1,residual_amount=$2,status=$3,updated_at=$4 WHERE tenant_id=$5 AND id=$6`, [allocated, next.residual, next.status, stamp, t, item.id]);
    const documentStatus = next.status === 'paid' ? 'paid' : 'open';
    if (item.source_type === 'outgoing_invoice') {
      await q(db, `UPDATE invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted' AND status <> 'cancelled'`, [documentStatus, stamp, t, item.source_id]);
      const id = await invoicePaymentEntryId(db, t, payment);
      const invoice = (await q<any>(db, `SELECT payments_json FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, item.source_id]))[0];
      if (invoice) {
        const payments = parse<any[]>(invoice.payments_json, []);
        const shown = payments.find((entry) => entry?.id === id);
        const left = round(Number(shown?.amount ?? 0) - amount);
        const kept = payments.flatMap((entry) => entry?.id !== id ? [entry] : Math.abs(left) >= .005 && payment.source_type !== 'invoice_payment' ? [{ ...entry, amount: left }] : []);
        await q(db, `UPDATE invoices SET payments_json=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(kept), stamp, t, item.source_id]);
      }
    }
    if (item.source_type === 'incoming_invoice') await q(db, `UPDATE incoming_invoices SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND accounting_status='posted'`, [documentStatus, stamp, t, item.source_id]);
    reopenedItemIds.push(item.id);
  }
  await q(db, `UPDATE open_item_payments SET status='reversed' WHERE tenant_id=$1 AND id=$2`, [t, payment.id]);
  if (payment.credited_payment_id) {
    // The credit this refund paid out is open again on the earlier payment.
    const credit = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, payment.credited_payment_id]))[0];
    const creditItems = round(Number(payment.allocated_amount) - Math.abs(round((allocations as any[]).reduce((sum, row) => sum + Number(row.amount), 0))));
    if (credit && creditItems > .005) {
      const allocatedCredit = round(Number(credit.allocated_amount) - creditItems);
      const residualCredit = round(Number(credit.amount) - allocatedCredit);
      await q(db, `UPDATE open_item_payments SET allocated_amount=$1,residual_amount=$2,status=$3 WHERE tenant_id=$4 AND id=$5`, [allocatedCredit, residualCredit, residualCredit > .01 ? allocatedCredit > .01 ? 'partially_allocated' : 'overpaid' : 'allocated', t, credit.id]);
    }
  }
  if (payment.source_type === 'bank_transaction') {
    const bank = (await q<any>(db, `SELECT source_transaction_id FROM bank_transactions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, payment.source_id]))[0];
    await q(db, `UPDATE bank_transactions SET status='pending',linked_invoice_id=NULL,updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [stamp, t, payment.source_id]);
    if (bank?.source_transaction_id) await q(db, `UPDATE transactions SET linked_invoice_id=NULL WHERE tenant_id=$1 AND id=$2`, [t, bank.source_transaction_id]);
  }
  const after = { status: 'reversed', reversalEntryIds, reopenedItemIds, postingDate };
  await audit(db as PostgresTransactionClient, scope, 'open_item_payment', payment.id, 'reverse', reason, rowPayment(payment), after, input.mutation);
  return { paymentId: payment.id, reversalEntryIds, reopenedItemIds };
};

/** The active OPOS payment behind a source (an invoice payment id, a bank line id), if it was booked. */
export const findActiveOpenItemPayment = async (db: PostgresQueryable, scope: TenantScope, sourceType: 'invoice_payment' | 'bank_transaction' | 'manual', sourceId: string): Promise<OpenItemPaymentEntity | undefined> => {
  const row = (await q<any>(db, `SELECT * FROM open_item_payments WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND status <> 'reversed'`, [tenant(scope), sourceType, sourceId]))[0];
  return row ? rowPayment(row) : undefined;
};

/** The credit a Storno or Gutschrift of a paid invoice left for the customer, while it is not paid out. */
const correctionCreditOf = async (db: PostgresQueryable, t: string, invoiceId: string): Promise<any> =>
  (await q<any>(db, `SELECT oi.* FROM open_items oi JOIN invoices c ON c.tenant_id=oi.tenant_id AND c.id=oi.source_id WHERE oi.tenant_id=$1 AND oi.source_type='outgoing_invoice' AND c.source_document_id=$2 AND oi.residual_amount < 0 ORDER BY oi.created_at LIMIT 1 FOR UPDATE OF oi`, [t, invoiceId]))[0];

const debtorItemOfInvoice = async (db: PostgresQueryable, t: string, invoiceId: string): Promise<any> => {
  const item = (await q<any>(db, `SELECT * FROM open_items WHERE tenant_id=$1 AND source_type='outgoing_invoice' AND source_id=$2 FOR UPDATE`, [t, invoiceId]))[0];
  // An issued Pro invoice is posted with its open item; one without has not reached the books.
  if (!item) throw new Error('DOCUMENT_NOT_POSTED: Die Rechnung ist nicht gebucht; eine Zahlung lässt sich erst nach der Buchung erfassen.');
  return item;
};

/**
 * A payment recorded on a Pro invoice (Zahlung erfassen) is a booking: Bank, or Kasse for a cash payment,
 * against the receivable, allocated to the open item of the invoice, Ist-VAT recognised like any OPOS
 * payment. The payment must already be listed on the invoice (payments_json).
 */
export const bookInvoicePaymentInTransaction = async (db: PostgresQueryable, scope: TenantScope, input: { invoiceId: string; payment: { id: string; date: string; amount: number; method?: string }; mutation: AccountingMutationContext }): Promise<OpenItemPaymentEntity> => {
  const t = tenant(scope);
  const item = await debtorItemOfInvoice(db, t, input.invoiceId);
  const signed = round(input.payment.amount);
  const amount = Math.abs(signed);
  if (!(amount > 0)) throw new Error('INVALID_PAYMENT');
  // A negative payment is a refund: it pays out the credit a correction left (Storno/Gutschrift of a paid
  // invoice) or takes back what was paid on the invoice, never more.
  const credit = signed < 0 ? await correctionCreditOf(db, t, input.invoiceId) : undefined;
  const target = credit ?? item;
  if (signed > 0 && amount > round(item.residual_amount) + .01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL: Die Zahlung ist höher als der offene Betrag.');
  if (signed < 0 && amount > (credit ? -round(credit.residual_amount) : round(item.allocated_amount)) + .01) throw new Error('OPEN_ITEM_REFUND_EXCEEDS_PAID: Erstattet werden kann höchstens, was bezahlt wurde.');
  const p = await policy(db, t);
  const m = await mappings(db, t, p.activeChart);
  const cash = /^(bar|cash|kasse)/i.test(String(input.payment.method ?? '').trim());
  return allocatePayment(db, scope, {
    sourceType: 'invoice_payment', sourceId: input.payment.id, partyType: 'debtor', partyId: item.party_id,
    paymentDate: input.payment.date, amount, bankAccountNumber: cash ? m.cash! : m.bank!, method: input.payment.method,
    allocations: [{ openItemId: target.id, amount }], allocationEventId: `invoice-payment:${input.payment.id}`, mutation: input.mutation, reason: input.mutation.reason,
  });
};

/**
 * Bank-Link in Pro (Rechnung zuordnen): the bank line is booked through OPOS on the ledger account of its
 * bank account. What exceeds the open amount stays on the payment as the customer's credit.
 */
export const bookBankLinkInTransaction = async (db: PostgresQueryable, scope: TenantScope, input: { legacyTransactionId: string; invoiceId: string; appliedAmount?: number; mutation: AccountingMutationContext }): Promise<OpenItemPaymentEntity> => {
  const t = tenant(scope);
  const bank = (await q<any>(db, `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND source_transaction_id=$2 FOR UPDATE`, [t, input.legacyTransactionId]))[0];
  if (!bank) throw new Error('PAYMENT_ALLOCATION_INVALID');
  const item = await debtorItemOfInvoice(db, t, input.invoiceId);
  const cash = round(Math.abs(Number(bank.amount)));
  // An outgoing line is a refund (Rückzahlung, Rücklastschrift): it pays out the credit a correction left,
  // or takes back what was paid on the invoice and reopens it.
  const refund = bank.type === 'expense';
  const credit = refund ? await correctionCreditOf(db, t, input.invoiceId) : undefined;
  const target = credit ?? item;
  const room = !refund ? round(item.residual_amount) : credit ? -round(credit.residual_amount) : round(item.allocated_amount);
  const applied = input.appliedAmount === undefined ? round(Math.min(cash, room)) : round(input.appliedAmount);
  if (!(applied > 0) || applied > cash + .005 || applied > room + .005) throw new Error('PAYMENT_ALLOCATION_INVALID');
  return allocatePayment(db, scope, {
    sourceType: 'bank_transaction', sourceId: bank.id, partyType: 'debtor', partyId: item.party_id,
    paymentDate: bank.date, amount: cash, bankAccountNumber: await bankLedgerAccount(db, t, bank.account_id), method: 'Überweisung',
    allocations: [{ openItemId: target.id, amount: applied }], allocationEventId: `bank-link:${bank.id}`, mutation: input.mutation, reason: input.mutation.reason,
  });
};

/** Where a payment recorded on an invoice is listed, and the issued invoice it may move to as a whole. */
const invoicePaymentListing = async (db: PostgresQueryable, t: string, original: any, allocations: Array<{ openItemId: string; amount: number }>): Promise<{ entry: any; target: any }> => {
  const unsupported = () => new Error('PAYMENT_REALLOCATION_UNSUPPORTED: Eine auf der Rechnung erfasste Zahlung lässt sich nur ganz auf eine andere gestellte Rechnung umbuchen; sonst dort stornieren und neu erfassen.');
  const only = allocations.length === 1 ? allocations[0]! : undefined;
  if (original.refund || !only || round(only.amount) !== round(original.amount)) throw unsupported();
  const item = (await q<any>(db, `SELECT source_type,source_id FROM open_items WHERE tenant_id=$1 AND id=$2`, [t, only.openItemId]))[0];
  const target = item?.source_type === 'outgoing_invoice' ? (await q<any>(db, `SELECT id,status,accounting_status,payments_json FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [t, item.source_id]))[0] : undefined;
  if (!target || target.accounting_status !== 'posted' || target.status === 'cancelled' || target.status === 'draft') throw unsupported();
  let entry: any;
  for (const row of await q<any>(db, `SELECT payments_json FROM invoices WHERE tenant_id=$1 AND payments_json LIKE $2`, [t, `%${original.source_id}%`])) {
    entry = parse<any[]>(row.payments_json, []).find((candidate) => candidate?.id === original.source_id) ?? entry;
  }
  if (!entry) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
  return { entry, target };
};

export interface ManualJournalEntryLine { accountNumber: string; debitAmount: number; creditAmount: number; taxCaseKey?: string; memo?: string }
export interface ManualJournalEntryInput {
  documentDate: string;
  /** Defaults to the Belegdatum. */
  postingDate?: string;
  /** Belegnummer (DATEV Belegfeld 1): the free entry is only posted with its Beleg. */
  reference: string;
  bookingText: string;
  lines: ManualJournalEntryLine[];
  idempotencyKey: string;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
  /** Another flow (e.g. Geldtransit) posts under its own source identity; default `manual`. */
  sourceType?: string;
  sourceKey?: string;
}
export interface BankLedgerReconciliationRow {
  ledgerAccountNumber: string;
  bankAccountIds: string[];
  /** Imported bank lines that are booked (draft posted or allocated), signed. */
  bookedBankTotal: number;
  pendingCount: number;
  pendingTotal: number;
  /** Saldo of the ledger account (Soll − Haben), every posted entry. */
  ledgerBalance: number;
  /** Ledger minus booked bank lines: entries on the bank account without a bank line, or the other way round. */
  difference: number;
}

/**
 * Freie Buchung (Buchungssatz / Memorialbuchung): Belegdatum, Belegnummer, Buchungstext and at least two
 * lines from the chart, Soll = Haben. A line with a Steuerschlüssel (19 % or 7 % Inland) is a gross amount:
 * it is split into the net line, which carries the tax basis, and the Vorsteuer (Soll) or Umsatzsteuer (Haben)
 * line. The period locks apply as for every posting; the same idempotency key returns the same entry.
 */
export const postManualJournalEntryInTransaction = async (db: PostgresQueryable, scope: TenantScope, input: ManualJournalEntryInput): Promise<JournalEntryEntity> => {
  const t = tenant(scope);
  const reference = input.reference?.trim();
  if (!reference) throw new Error('MISSING_REFERENCE: Ohne Beleg keine Buchung: die Belegnummer fehlt.');
  const bookingText = input.bookingText?.trim();
  if (!bookingText) throw new Error('MISSING_BOOKING_TEXT: Der Buchungstext fehlt.');
  if (bookingText.length > 60) throw new Error('INVALID_BOOKING_TEXT: Der Buchungstext hat höchstens 60 Zeichen (DATEV).');
  if (!isoDate(input.documentDate)) throw new Error('INVALID_DOCUMENT_DATE: Das Belegdatum ist ungültig.');
  const postingDate = input.postingDate ?? input.documentDate;
  if (!isoDate(postingDate)) throw new Error('INVALID_POSTING_DATE');
  const key = input.idempotencyKey?.trim();
  if (!key && !input.sourceKey) throw new Error('MISSING_IDEMPOTENCY_KEY');
  if (!Array.isArray(input.lines) || input.lines.length < 2) throw new Error('UNBALANCED_ENTRY: Eine Buchung hat mindestens zwei Zeilen.');
  const p = await policy(db, t);
  const lines: JournalLineEntity[] = [];
  for (const [index, line] of input.lines.entries()) {
    const accountNumber = String(line.accountNumber ?? '').trim();
    const debit = cents(line.debitAmount ?? 0); const credit = cents(line.creditAmount ?? 0);
    if (debit === null || credit === null || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) throw new Error(`INVALID_LINE_AMOUNT: Zeile ${index + 1} braucht einen Centbetrag im Soll oder im Haben.`);
    if (!accountNumber || !(await accountExists(db, p.activeChart, accountNumber, tenant(scope)))) throw new Error(`UNKNOWN_ACCOUNT:${accountNumber} ist im Kontenrahmen ${p.activeChart} nicht vorhanden.`);
    if (!line.taxCaseKey) {
      lines.push({ id: randomUUID(), accountNumber, debitAmount: debit / 100, creditAmount: credit / 100, memo: line.memo });
      continue;
    }
    const split = await automaticTaxSplit(db, t, p.activeChart, { id: randomUUID(), accountNumber, debitAmount: debit / 100, creditAmount: credit / 100, taxCaseKey: line.taxCaseKey as TaxCaseKey, memo: line.memo }, postingDate);
    if (!split) throw new Error(`TAX_CASE_NOT_AUTOMATIC: Steuerschlüssel ${line.taxCaseKey} lässt sich in der freien Buchung nicht automatisch aufteilen; Steuerzeile bitte als eigene Zeile buchen.`);
    lines.push(...split);
  }
  const entryId = await insertEntry(db, scope, input.sourceType ?? 'manual', input.sourceKey ?? `manual-entry:${key}`, postingDate, bookingText, lines, {
    documentDate: input.documentDate, reference, softLockOverride: input.softLockOverride, overrideReason: input.overrideReason, mutation: input.mutation,
  });
  return (await loadEntry(db, scope, entryId))!;
};
