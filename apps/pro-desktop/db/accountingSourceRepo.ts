import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  buildCarryForward,
  buildFiscalClose,
  buildFxValuation,
  buildInventoryClosingValuation,
  buildProvisionCommand,
  buildJournalCommand,
  planAccrualSchedule,
  planLoanSchedule,
  validatePayrollBatch,
  validateShareholderFlow,
  calculateBadDebtWriteOff,
  calculateInvoiceSettlement,
  calculateSkontoVatApportionment,
  createLinkedCorrection,
  validateUstg17AdjustmentFacts,
} from '@billme/accounting-engine';
import type {
  AccountingSourceFact,
  BadDebtWriteOffInput,
  ClosingDomainError,
  ImmutableOriginalDocument,
  InvoiceSettlementInput,
  JournalCommand,
  LinkedCorrectionInput,
  SkontoVatApportionmentInput,
  Ustg17AdjustmentFactsInput,
} from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { AccountingPolicyError } from '@billme/accounting-shared';
import { appendAuditLog } from './audit';
import { getTenantId } from '../tenantScope';

export type AccountingSourceRunStatus = 'posted' | 'rejected' | 'noop';

export interface AccountingSourceRunEntity {
  id: string;
  tenantId: string;
  sourceType: AccountingSourceFact['sourceType'];
  sourceId: string;
  sourceRevision: string;
  idempotencyKey: string;
  fact: AccountingSourceFact;
  result: unknown;
  status: AccountingSourceRunStatus;
  journalEntryId?: string;
  createdAt: string;
}

export interface PostAccountingSourceOptions {
  chart?: 'SKR03' | 'SKR04';
  softLockOverride?: boolean;
  overrideReason?: string;
  reason?: string;
  /** Extra immutable provenance for correction/settlement actions. */
  provenance?: unknown;
}

export interface AccountingSourcePostResult {
  status: 'posted' | 'rejected' | 'duplicate' | 'noop';
  sourceRun?: AccountingSourceRunEntity;
  command?: JournalCommand;
  errors: ClosingDomainError[];
  idempotencyKey: string;
}

export type AccountingCommandKind =
  | 'standalone'
  | 'correction'
  | 'credit'
  | 'skonto'
  | 'bad_debt'
  | 'ustg17'
  | 'advance_settlement'
  | 'fiscal_close'
  | 'carry_forward'
  | 'provision'
  | 'accrual'
  | 'inventory_closing'
  | 'fx_valuation'
  | 'loan_schedule'
  | 'payroll_batch'
  | 'shareholder_flow';

export interface PostAccountingCommandInput {
  kind: AccountingCommandKind;
  source: AccountingSourceFact;
  /** Domain facts are validated before the immutable source is posted. */
  domainFacts?: unknown;
}

const now = (): string => new Date().toISOString();
const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const amount = (value: number): number => cents(value) / 100;
const keyFor = (fact: Pick<AccountingSourceFact, 'sourceType' | 'sourceId' | 'sourceRevision'>): string =>
  `${fact.sourceType}:${fact.sourceId}:${fact.sourceRevision}`;
const sourceRunId = (tenantId: string, key: string): string =>
  `accounting-source:${tenantId}:${crypto.createHash('sha256').update(key).digest('hex')}`;

const stableJson = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
};

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

const error = (code: ClosingDomainError['code'], message: string, field?: string): ClosingDomainError => ({
  code,
  message,
  field,
  blocking: true,
});

const rowToEntity = (row: SourceRunRow): AccountingSourceRunEntity => ({
  id: row.id,
  tenantId: row.tenant_id,
  sourceType: row.source_type as AccountingSourceFact['sourceType'],
  sourceId: row.source_id,
  sourceRevision: row.source_revision,
  idempotencyKey: row.idempotency_key,
  fact: parseJson<AccountingSourceFact>(row.fact_json, {
    sourceType: row.source_type as AccountingSourceFact['sourceType'],
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    effectiveDate: row.effective_date,
    postingDate: row.posting_date,
    period: row.period,
    fiscalYear: row.fiscal_year,
    currency: row.currency,
    bookingText: row.booking_text,
    lines: [],
  }),
  result: parseJson(row.result_json, null),
  status: row.status as AccountingSourceRunStatus,
  journalEntryId: row.journal_entry_id ?? undefined,
  createdAt: row.created_at,
});

type SourceRunRow = {
  id: string;
  tenant_id: string;
  source_type: string;
  source_id: string;
  source_revision: string;
  idempotency_key: string;
  fact_json: string;
  result_json: string;
  status: string;
  journal_entry_id: string | null;
  effective_date: string;
  posting_date: string;
  period: string;
  fiscal_year: number;
  currency: string;
  booking_text: string;
  created_at: string;
};

const loadRun = (db: Database.Database, tenantId: string, key: string): SourceRunRow | undefined =>
  db.prepare('SELECT * FROM accounting_source_runs WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, key) as SourceRunRow | undefined;

const activeChart = (db: Database.Database, tenantId: string, requested?: 'SKR03' | 'SKR04'): 'SKR03' | 'SKR04' => {
  const row = db.prepare('SELECT active_chart FROM accounting_policies WHERE tenant_id = ?').get(tenantId) as { active_chart?: string } | undefined;
  const authoritative = row?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';
  if (requested && requested !== authoritative) {
    throw new AccountingPolicyError(
      'ACCOUNTING_CHART_MISMATCH',
      `Source verwendet ${requested}, der maßgebliche Kontenrahmen ist ${authoritative}.`,
    );
  }
  return authoritative;
};

const accountExists = (db: Database.Database, chart: 'SKR03' | 'SKR04', accountNumber: string): boolean =>
  Boolean(db.prepare('SELECT 1 FROM ledger_accounts WHERE chart = ? AND account_number = ?').get(chart, accountNumber));

const persistRejected = (
  db: Database.Database,
  tenantId: string,
  fact: AccountingSourceFact,
  result: unknown,
  options: PostAccountingSourceOptions,
): AccountingSourceRunEntity => {
  const key = keyFor(fact);
  const id = sourceRunId(tenantId, key);
  const createdAt = now();
  const runFact = { ...fact, provenance: options.provenance };
  db.prepare(`INSERT INTO accounting_source_runs
    (id, tenant_id, source_type, source_id, source_revision, idempotency_key, fact_json, result_json, status,
     journal_entry_id, effective_date, posting_date, period, fiscal_year, currency, booking_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, tenantId, fact.sourceType, fact.sourceId, fact.sourceRevision, key, stableJson(runFact), stableJson(result),
    fact.effectiveDate, fact.postingDate, fact.period, fact.fiscalYear, fact.currency, fact.bookingText, createdAt,
  );
  appendAuditLog(db, {
    entityType: 'accounting_source_run', entityId: id, action: 'reject', reason: options.reason ?? 'Accounting source rejected',
    before: null, after: result, actor: 'pro',
  });
  return rowToEntity(db.prepare('SELECT * FROM accounting_source_runs WHERE id = ?').get(id) as SourceRunRow);
};

const persistNoop = (
  db: Database.Database,
  tenantId: string,
  fact: AccountingSourceFact,
  result: unknown,
  options: PostAccountingSourceOptions,
): AccountingSourceRunEntity => {
  const key = keyFor(fact);
  const id = sourceRunId(tenantId, key);
  const createdAt = now();
  const runFact = { ...fact, provenance: options.provenance };
  db.prepare(`INSERT INTO accounting_source_runs
    (id, tenant_id, source_type, source_id, source_revision, idempotency_key, fact_json, result_json, status,
     journal_entry_id, effective_date, posting_date, period, fiscal_year, currency, booking_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'noop', NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, tenantId, fact.sourceType, fact.sourceId, fact.sourceRevision, key, stableJson(runFact), stableJson(result),
    fact.effectiveDate, fact.postingDate, fact.period, fact.fiscalYear, fact.currency, fact.bookingText, createdAt,
  );
  appendAuditLog(db, {
    entityType: 'accounting_source_run', entityId: id, action: 'noop', reason: options.reason!,
    before: null, after: result, actor: 'pro',
  });
  return rowToEntity(db.prepare('SELECT * FROM accounting_source_runs WHERE id = ?').get(id) as SourceRunRow);
};

const existingResult = (
  db: Database.Database,
  tenantId: string,
  fact: AccountingSourceFact,
  options: PostAccountingSourceOptions,
): AccountingSourcePostResult | undefined => {
  const idempotencyKey = keyFor(fact);
  const existing = loadRun(db, tenantId, idempotencyKey);
  if (!existing) return undefined;
  const sameFact = stableJson(parseJson(existing.fact_json, null)) === stableJson({ ...fact, provenance: options.provenance });
  if (!sameFact) return { status: 'rejected', sourceRun: rowToEntity(existing), errors: [error('DUPLICATE_SOURCE_REVISION', 'Source revision already exists with different facts.')], idempotencyKey };
  return { status: 'duplicate', sourceRun: rowToEntity(existing), errors: [], idempotencyKey };
};

const postJournal = (
  db: Database.Database,
  tenantId: string,
  fact: AccountingSourceFact,
  command: JournalCommand,
  chart: 'SKR03' | 'SKR04',
): { id: string; entry: JournalCommand['entry'] } => {
  const entryId = command.commandId;
  const sourceKey = keyFor(fact);
  const entryNumber = Number((db.prepare('SELECT COALESCE(MAX(entry_number), 0) AS n FROM journal_entries WHERE tenant_id = ?').get(tenantId) as { n: number }).n) + 1;
  const createdAt = now();
  db.prepare(`INSERT INTO journal_entries
    (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status,
     source_draft_id, source_type, source_key, reversed_entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`).run(
    entryId, tenantId, entryNumber, fact.postingDate, fact.effectiveDate, fact.bookingText, fact.reference ?? sourceKey,
    fact.period, fact.fiscalYear, fact.sourceType, sourceKey, createdAt,
  );
  const insertLine = db.prepare(`INSERT INTO journal_lines
    (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key,
     tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id, evidence_type,
     evidence_reference, datev_sachverhalt_ll, cost_center, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`);
  for (const [index, line] of command.entry.lines.entries()) {
    insertLine.run(
      line.id, tenantId, entryId, index + 1, line.accountNumber, amount(line.debitAmount), amount(line.creditAmount), line.memo ?? null,
    );
  }
  const debits = command.entry.lines.filter((line) => cents(line.debitAmount) > 0);
  const credits = command.entry.lines.filter((line) => cents(line.creditAmount) > 0);
  const insertPair = db.prepare(`INSERT INTO journal_posting_pairs
    (id, tenant_id, entry_id, debit_line_id, credit_line_id, amount, tax_case_key, datev_bu_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`);
  let creditIndex = 0;
  let creditRemaining = credits[0] ? cents(credits[0].creditAmount) : 0;
  for (const debit of debits) {
    let debitRemaining = cents(debit.debitAmount);
    while (debitRemaining > 0 && creditIndex < credits.length) {
      if (creditRemaining <= 0) {
        creditIndex += 1;
        creditRemaining = credits[creditIndex] ? cents(credits[creditIndex].creditAmount) : 0;
        continue;
      }
      const paired = Math.min(debitRemaining, creditRemaining);
      insertPair.run(crypto.randomUUID(), tenantId, entryId, debit.id, credits[creditIndex]!.id, paired / 100, createdAt);
      debitRemaining -= paired;
      creditRemaining -= paired;
    }
  }
  return {
    id: entryId,
    entry: {
      ...command.entry,
      id: entryId,
      sourceKey,
      lines: command.entry.lines.map((line) => ({ ...line, debitAmount: amount(line.debitAmount), creditAmount: amount(line.creditAmount) })),
    },
  };
};

const validatePersistence = (
  db: Database.Database,
  tenantId: string,
  fact: AccountingSourceFact,
  chart: 'SKR03' | 'SKR04',
  options: PostAccountingSourceOptions,
): ClosingDomainError[] => {
  const errors: ClosingDomainError[] = [];
  if (fact.lines.every((line) => cents(line.debitAmount) === 0 && cents(line.creditAmount) === 0)) {
    errors.push(error('INVALID_AMOUNT', 'Journal entry must contain a non-zero amount.', 'lines'));
  }
  for (const [index, line] of fact.lines.entries()) {
    if (!accountExists(db, chart, line.accountNumber)) errors.push(error('INVALID_ACCOUNT', `Account ${line.accountNumber} is not available in ${chart}.`, `lines.${index}.accountNumber`));
  }
  const periodStatus = (db.prepare('SELECT status FROM accounting_periods WHERE tenant_id = ? AND period = ?').get(tenantId, fact.period) as { status?: string } | undefined)?.status ?? 'open';
  const periodRow = db.prepare('SELECT fiscal_year FROM accounting_periods WHERE tenant_id = ? AND period = ?').get(tenantId, fact.period) as { fiscal_year?: number } | undefined;
  if (periodRow && Number(periodRow.fiscal_year) !== fact.fiscalYear) errors.push(error('PERIOD_MISMATCH', 'Fiscal year does not match the accounting period.', 'fiscalYear'));
  if (periodStatus === 'closed') errors.push(error('PERIOD_MISMATCH', 'Posting period is closed.', 'period'));
  if (periodStatus === 'soft_locked' && !(options.softLockOverride && options.overrideReason?.trim())) errors.push(error('PERIOD_MISMATCH', 'Soft-locked period requires an override reason.', 'period'));
  return errors;
};

const ensureAccountingPeriod = (db: Database.Database, tenantId: string, fact: AccountingSourceFact): void => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fact.period) || fact.period !== fact.postingDate.slice(0, 7)) return;
  const exists = db.prepare('SELECT 1 FROM accounting_periods WHERE tenant_id = ? AND period = ?').get(tenantId, fact.period);
  if (exists) return;
  const year = Number(fact.period.slice(0, 4));
  const month = Number(fact.period.slice(5, 7));
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(crypto.randomUUID(), tenantId, fact.period, fact.fiscalYear, `${fact.period}-01`, end, now(), now());
};

/** Post one immutable source revision through the shared closing-domain boundary. */
const postAccountingSourceInTransaction = (
  db: Database.Database,
  fact: AccountingSourceFact,
  scope: TenantScope,
  options: PostAccountingSourceOptions = {},
): AccountingSourcePostResult => {
  const reason = options.reason?.trim();
  if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED: a reason is required for source posting');
  const tenantId = getTenantId(scope);
  const chart = activeChart(db, tenantId, options.chart);
  const idempotencyKey = keyFor(fact);
  const existing = existingResult(db, tenantId, fact, options);
  if (existing) return existing;

  const domain = buildJournalCommand(fact);
  if (domain.status === 'ready') ensureAccountingPeriod(db, tenantId, fact);
  const persistenceErrors = validatePersistence(db, tenantId, fact, chart, options);
  const errors = [...domain.errors, ...persistenceErrors];
  if (errors.length || domain.status === 'rejected' || !domain.value) {
    const result = { status: 'rejected', errors };
    const sourceRun = persistRejected(db, tenantId, fact, result, options);
    return { status: 'rejected', sourceRun, errors, idempotencyKey };
  }

  const command = domain.value;
  const posted = postJournal(db, tenantId, fact, command, chart);
  const createdAt = now();
  const id = sourceRunId(tenantId, idempotencyKey);
  const runFact = { ...fact, provenance: options.provenance };
  const result = { command: posted.entry, chart, status: 'posted' };
  db.prepare(`INSERT INTO accounting_source_runs
    (id, tenant_id, source_type, source_id, source_revision, idempotency_key, fact_json, result_json, status,
     journal_entry_id, effective_date, posting_date, period, fiscal_year, currency, booking_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, tenantId, fact.sourceType, fact.sourceId, fact.sourceRevision, idempotencyKey, stableJson(runFact), stableJson(result),
    posted.id, fact.effectiveDate, fact.postingDate, fact.period, fact.fiscalYear, fact.currency, fact.bookingText, createdAt,
  );
  appendAuditLog(db, {
    entityType: 'accounting_source_run', entityId: id, action: 'post', reason: options.reason ?? 'Accounting source posted',
    before: null, after: { ...result, sourceType: fact.sourceType, sourceId: fact.sourceId, sourceRevision: fact.sourceRevision }, actor: 'pro',
  });
  const sourceRun = { run: rowToEntity(db.prepare('SELECT * FROM accounting_source_runs WHERE id = ?').get(id) as SourceRunRow), entry: posted.entry };
  return { status: 'posted', sourceRun: sourceRun.run, command: { ...command, entry: sourceRun.entry }, errors: [], idempotencyKey };
};

export const postAccountingSource = (
  db: Database.Database,
  fact: AccountingSourceFact,
  scope: TenantScope,
  options: PostAccountingSourceOptions = {},
): AccountingSourcePostResult => db.transaction(() => postAccountingSourceInTransaction(db, fact, scope, options))();

export const listAccountingSourceRuns = (db: Database.Database, scope: TenantScope): AccountingSourceRunEntity[] => {
  const tenantId = getTenantId(scope);
  return (db.prepare('SELECT * FROM accounting_source_runs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC').all(tenantId) as SourceRunRow[]).map(rowToEntity);
};

export const getAccountingSourceRun = (db: Database.Database, id: string, scope: TenantScope): AccountingSourceRunEntity | null => {
  const row = db.prepare('SELECT * FROM accounting_source_runs WHERE tenant_id = ? AND id = ?').get(getTenantId(scope), id) as SourceRunRow | undefined;
  return row ? rowToEntity(row) : null;
};

type DomainBuild = { status: string; errors?: ClosingDomainError[]; value?: any };
type GeneratedCommands = { result: unknown; commands: JournalCommand[]; status: 'ready' | 'noop' | 'rejected'; errors: ClosingDomainError[] };

const generatedCommands = (kind: AccountingCommandKind, facts: Record<string, unknown>): GeneratedCommands | undefined => {
  let built: DomainBuild;
  switch (kind) {
    case 'fiscal_close': built = buildFiscalClose(facts as any); break;
    case 'carry_forward': built = buildCarryForward(facts as any); break;
    case 'provision': built = buildProvisionCommand(facts as any); break;
    case 'accrual': built = planAccrualSchedule(facts as any); break;
    case 'inventory_closing': built = buildInventoryClosingValuation(facts as any); break;
    case 'fx_valuation': built = buildFxValuation(facts as any); break;
    case 'loan_schedule': built = planLoanSchedule(facts as any); break;
    case 'payroll_batch': {
      const result = validatePayrollBatch(facts as any);
      return { result, commands: [], status: result.status === 'valid' ? 'noop' : 'rejected', errors: result.errors };
    }
    case 'shareholder_flow': {
      const result = validateShareholderFlow(facts as any);
      return { result, commands: [], status: result.conflicts.length ? 'rejected' : 'noop', errors: result.conflicts };
    }
    default: return undefined;
  }
  if (built.status === 'rejected' || built.status === 'invalid') return { result: built, commands: [], status: 'rejected', errors: built.errors ?? [] };
  const value = built.value ?? {};
  const commands = [value.command, ...(value.commands ?? [])].filter(Boolean) as JournalCommand[];
  return { result: value, commands, status: built.status === 'noop' || !commands.length ? 'noop' : 'ready', errors: built.errors ?? [] };
};

const factFromCommand = (command: JournalCommand): AccountingSourceFact => ({
  sourceType: command.source.sourceType as AccountingSourceFact['sourceType'],
  sourceId: command.source.sourceId,
  sourceRevision: command.source.sourceRevision,
  effectiveDate: command.effectiveDate,
  postingDate: command.entry.postingDate,
  period: command.entry.period,
  fiscalYear: command.entry.fiscalYear,
  currency: command.currency,
  bookingText: command.entry.bookingText,
  reference: command.entry.reference,
  lines: command.entry.lines.map((line) => ({
    accountNumber: line.accountNumber,
    debitAmount: line.debitAmount,
    creditAmount: line.creditAmount,
    memo: line.memo,
  })),
});

const correctionMappings = (db: Database.Database, tenantId: string, chart: 'SKR03' | 'SKR04'): Record<string, string> => {
  const defaults = chart === 'SKR04'
    ? { accounts_receivable: '1200', accounts_payable: '3300', revenue: '4400', expense: '6300', output_vat: '3806', input_vat: '1406' }
    : { accounts_receivable: '1400', accounts_payable: '1600', revenue: '8400', expense: '4900', output_vat: '1776', input_vat: '1576' };
  for (const row of db.prepare('SELECT role, account_number FROM accounting_account_mappings WHERE tenant_id = ? AND chart = ?').all(tenantId, chart) as Array<{ role: string; account_number: string }>) {
    if (row.role in defaults) defaults[row.role as keyof typeof defaults] = row.account_number;
  }
  return defaults;
};

const correctionLines = (db: Database.Database, tenantId: string, chart: 'SKR03' | 'SKR04', document: ReturnType<typeof createLinkedCorrection>['document'], documentType: 'outgoing_invoice' | 'incoming_invoice'): AccountingSourceFact['lines'] => {
  const mappings = correctionMappings(db, tenantId, chart);
  return document.deltas.flatMap((delta) => {
    const taxCaseKey = delta.rate === 19 ? 'DE_STD_19' : delta.rate === 7 ? 'DE_STD_7' : 'DE_ZERO_EXEMPT';
    const amount = (value: number): number => Math.abs(value);
    return documentType === 'incoming_invoice'
      ? [
          { accountNumber: mappings.expense, debitAmount: 0, creditAmount: amount(delta.netAmount), memo: `Linked correction ${taxCaseKey}` },
          ...(delta.taxAmount ? [{ accountNumber: mappings.input_vat, debitAmount: 0, creditAmount: amount(delta.taxAmount), memo: `Linked correction VAT ${taxCaseKey}` }] : []),
          { accountNumber: mappings.accounts_payable, debitAmount: amount(delta.grossAmount), creditAmount: 0, memo: 'Linked correction payable' },
        ]
      : [
          { accountNumber: mappings.revenue, debitAmount: amount(delta.netAmount), creditAmount: 0, memo: `Linked correction ${taxCaseKey}` },
          ...(delta.taxAmount ? [{ accountNumber: mappings.output_vat, debitAmount: amount(delta.taxAmount), creditAmount: 0, memo: `Linked correction VAT ${taxCaseKey}` }] : []),
          { accountNumber: mappings.accounts_receivable, debitAmount: 0, creditAmount: amount(delta.grossAmount), memo: 'Linked correction receivable' },
        ];
  });
};

const correctionBreakdown = (row: any, snapshot: any, lines: any[]): Array<{ rate: number; netAmount: number; taxAmount: number; grossAmount: number }> => {
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

const resolveCorrectionOriginal = (db: Database.Database, tenantId: string, requested: ImmutableOriginalDocument, documentType: 'outgoing_invoice' | 'incoming_invoice'): ImmutableOriginalDocument => {
  const table = documentType === 'incoming_invoice' ? 'incoming_invoices' : 'invoices';
  const dateColumn = documentType === 'incoming_invoice' ? 'invoice_date' : 'date';
  const row = documentType === 'incoming_invoice'
    ? db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND id = ?`).get(tenantId, requested.documentId) as any
    : db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(requested.documentId) as any;
  if (!row) throw new Error('ORIGINAL_DOCUMENT_NOT_FOUND');
  const journal = row.accounting_status === 'posted' && row.accounting_journal_entry_id
    ? db.prepare(`SELECT status, source_type, source_key FROM journal_entries WHERE tenant_id = ? AND id = ?`).get(tenantId, row.accounting_journal_entry_id) as { status?: string; source_type?: string; source_key?: string } | undefined
    : undefined;
  const sourceKey = documentType === 'incoming_invoice' ? `incoming-invoice:${row.id}` : `outgoing-invoice:${row.id}`;
  if (row.accounting_status !== 'posted'
    || !row.accounting_journal_entry_id
    || journal?.status !== 'posted'
    || journal.source_type !== documentType
    || journal.source_key !== sourceKey) throw new Error('DOCUMENT_NOT_POSTED');
  if (row.number !== requested.documentNumber || row[dateColumn] !== requested.taxEffectiveDate) throw new Error('ORIGINAL_CHANGED');
  const lines = documentType === 'incoming_invoice'
    ? db.prepare('SELECT * FROM incoming_invoice_lines WHERE tenant_id = ? AND incoming_invoice_id = ? ORDER BY position').all(tenantId, row.id) as any[]
    : [];
  const accountingSnapshot = parseJson<any>(row.accounting_snapshot_json, undefined);
  const taxSnapshot = parseJson<any>(row.tax_snapshot_json, undefined);
  const snapshot = taxSnapshot ?? accountingSnapshot;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('ORIGINAL_SNAPSHOT_REQUIRED');
  const authoritativeLines = lines.length ? lines : (Array.isArray(accountingSnapshot?.lines) ? accountingSnapshot.lines : []);
  const canonicalHash = crypto.createHash('sha256').update(stableJson(snapshot)).digest('hex');
  const revision = String(accountingSnapshot?.sourceVersion ?? snapshot.sourceVersion ?? canonicalHash);
  const proofs = new Set([canonicalHash, revision, crypto.createHash('sha256').update(stableJson({ snapshot, lines: authoritativeLines })).digest('hex'), crypto.createHash('sha256').update(stableJson({ accountingSnapshot, taxSnapshot, lines: authoritativeLines })).digest('hex')]);
  if (!proofs.has(requested.snapshotHash) || (requested.currentSnapshotHash !== undefined && requested.currentSnapshotHash !== requested.snapshotHash)) throw new Error('ORIGINAL_CHANGED');
  if (requested.revision !== revision && requested.revision !== canonicalHash) throw new Error('ORIGINAL_CHANGED');
  const breakdown = correctionBreakdown(row, snapshot, authoritativeLines);
  if (!breakdown.length || breakdown.some((entry) => !Object.values(entry).every(Number.isFinite))) throw new Error('ORIGINAL_SNAPSHOT_REQUIRED');
  return { documentId: row.id, documentNumber: row.number, revision, snapshotHash: canonicalHash, currentSnapshotHash: canonicalHash, taxEffectiveDate: row[dateColumn], taxBreakdown: breakdown };
};

/** Validate a settlement/correction domain payload, then post its supplied lines atomically. */
export const postAccountingCommand = (
  db: Database.Database,
  input: PostAccountingCommandInput,
  scope: TenantScope,
  options: PostAccountingSourceOptions = {},
): AccountingSourcePostResult => {
  const reason = options.reason?.trim();
  if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED: a reason is required for command posting');
  const facts = input.domainFacts as Record<string, any> | undefined;
  if (input.kind === 'correction' && facts) {
    const tenantId = getTenantId(scope);
    const documentType = facts.documentType === 'incoming_invoice' ? 'incoming_invoice' : 'outgoing_invoice';
    const original = resolveCorrectionOriginal(db, tenantId, facts.original as ImmutableOriginalDocument, documentType);
    const linked = createLinkedCorrection({ ...facts, original } as unknown as LinkedCorrectionInput);
    const chart = activeChart(db, tenantId, options.chart);
    const correctionSource: AccountingSourceFact = {
      ...input.source,
      sourceType: 'standalone_source',
      sourceId: linked.document.id,
      sourceRevision: linked.document.originalRevision,
      effectiveDate: linked.document.correctionDate,
      postingDate: linked.document.correctionDate,
      period: linked.document.correctionDate.slice(0, 7),
      fiscalYear: Number(linked.document.correctionDate.slice(0, 4)),
      lines: correctionLines(db, tenantId, chart, linked.document, documentType),
    };
    return postAccountingSource(db, correctionSource, scope, { ...options, provenance: { commandKind: input.kind, domainFacts: { ...facts, original }, ...((options.provenance as Record<string, unknown> | undefined) ?? {}) } });
  }
  if (input.kind === 'skonto' && facts) calculateSkontoVatApportionment(facts as unknown as SkontoVatApportionmentInput);
  if (input.kind === 'bad_debt' && facts) calculateBadDebtWriteOff(facts as unknown as BadDebtWriteOffInput);
  if (input.kind === 'ustg17' && facts) validateUstg17AdjustmentFacts(facts as unknown as Ustg17AdjustmentFactsInput);
  if (input.kind === 'advance_settlement' && facts) calculateInvoiceSettlement(facts as unknown as InvoiceSettlementInput);
  const generated = facts ? generatedCommands(input.kind, facts) : undefined;
  const provenance = { commandKind: input.kind, domainFacts: input.domainFacts, ...((options.provenance as Record<string, unknown> | undefined) ?? {}) };
  if (!generated) return postAccountingSource(db, input.source, scope, { ...options, provenance });
  const tenantId = getTenantId(scope);
  const generatedOptions = { ...options, provenance };
  if (generated.status === 'rejected') {
    const existing = existingResult(db, tenantId, input.source, generatedOptions);
    if (existing) return existing;
    const sourceRun = db.transaction(() => persistRejected(db, tenantId, input.source, { status: 'rejected', errors: generated.errors, result: generated.result }, generatedOptions))();
    return { status: 'rejected', sourceRun, errors: generated.errors, idempotencyKey: keyFor(input.source) };
  }
  if (generated.status === 'noop') {
    const existing = existingResult(db, tenantId, input.source, generatedOptions);
    if (existing) return existing;
    const sourceRun = db.transaction(() => persistNoop(db, tenantId, input.source, { status: 'noop', result: generated.result }, generatedOptions))();
    return { status: 'noop', sourceRun, errors: [], idempotencyKey: keyFor(input.source) };
  }
  let result: AccountingSourcePostResult | undefined;
  result = db.transaction(() => {
    for (const command of generated.commands) result = postAccountingSourceInTransaction(db, factFromCommand(command), scope, generatedOptions);
    return result!;
  })();
  return result!;
};

export type { BadDebtWriteOffInput, ImmutableOriginalDocument, InvoiceSettlementInput, LinkedCorrectionInput, SkontoVatApportionmentInput, Ustg17AdjustmentFactsInput };
