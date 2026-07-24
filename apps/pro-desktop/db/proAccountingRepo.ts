import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { TenantScope } from '@billme/server-core';
import { appendAuditLog } from './audit';
import { listAccountSuggestionRules } from './accountSuggestionRulesRepo';
import {
  buildAccountSuggestionContext,
  suggestAccountForTransaction,
  type AccountSuggestionLayer,
} from '../services/accountSuggestionPipeline';
import { seedAccountKeywords } from '../services/accountKeywordSeed';
import { getTenantId } from '../tenantScope';
import {
  ensureTaxCaseSeedData,
  getTaxCaseByKey,
  normalizeTaxCaseKey,
  resolveTaxAccountsForCase,
  resolveDatevBuKeyForTaxCase,
  type TaxCaseDefinition,
  type TaxCaseKey,
} from './taxCasesRepo';

export type AccountingPeriodStatus = 'open' | 'soft_locked' | 'closed';
export type JournalEntryStatus = 'posted' | 'reversed';

export interface ProBankTransaction {
  id: string;
  tenantId: string;
  accountId: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  status: 'pending' | 'booked';
  linkedInvoiceId?: string;
  suggestedAccountNumber?: string;
  suggestionReason?: string;
  suggestionLayer?: AccountSuggestionLayer;
  suggestionConfidence?: number;
}

export interface BookingDraftLineEntity {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface DraftValidationIssue {
  id: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fieldPath?: string;
  blocking: boolean;
  source: 'system' | 'user' | 'rule';
}

export interface BookingDraftEntity {
  id: string;
  tenantId: string;
  transactionId: string;
  workflowStatus:
    | 'imported'
    | 'suggested'
    | 'incomplete'
    | 'ready_for_review'
    | 'pending_approval'
    | 'approved'
    | 'posted'
    | 'reversed'
    | 'corrected'
    | 'period_locked'
    | 'integration_error';
  postingDate?: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  lines: BookingDraftLineEntity[];
  validationIssues: DraftValidationIssue[];
  updatedAt: string;
}

export interface JournalLineEntity {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface JournalEntryEntity {
  id: string;
  tenantId: string;
  entryNumber: number;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: JournalEntryStatus;
  sourceDraftId?: string;
  reversedEntryId?: string;
  createdAt: string;
  lines: JournalLineEntity[];
}

export interface LedgerBalanceRow {
  accountNumber: string;
  openingBalance: number;
  debitTurnover: number;
  creditTurnover: number;
  closingBalance: number;
}

export interface DatevExportResult {
  id: string;
  filePath: string;
  recordCount: number;
  fromDate?: string;
  toDate?: string;
  createdAt: string;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const safeJsonParse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const isOpenOrSoftLocked = (status: string): boolean => status === 'open' || status === 'soft_locked';

const toLegacyTaxCode = (taxCaseKey?: TaxCaseKey): string | undefined => {
  if (!taxCaseKey) return undefined;
  if (taxCaseKey === 'DE_STD_19') return 'USt19';
  if (taxCaseKey === 'DE_STD_7') return 'USt7';
  return taxCaseKey;
};

const inferGrossAmountFromLine = (line: BookingDraftLineEntity): number => {
  const explicit = Number(line.grossAmount ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);
  const debit = Number(line.debitAmount || 0);
  const credit = Number(line.creditAmount || 0);
  const amount = Math.max(debit, credit);
  return round2(amount > 0 ? amount : 0);
};

const enrichTaxFields = (
  line: BookingDraftLineEntity,
  taxCase?: TaxCaseDefinition,
): BookingDraftLineEntity => {
  if (!taxCase) {
    return {
      ...line,
      taxRate: line.taxRate !== undefined ? Number(line.taxRate || 0) : undefined,
      netAmount: line.netAmount !== undefined ? round2(Number(line.netAmount || 0)) : undefined,
      taxAmount: line.taxAmount !== undefined ? round2(Number(line.taxAmount || 0)) : undefined,
      grossAmount: line.grossAmount !== undefined ? round2(Number(line.grossAmount || 0)) : undefined,
    };
  }

  const rate = line.taxRate !== undefined ? Number(line.taxRate || 0) : Number(taxCase.defaultRate || 0);
  const gross = inferGrossAmountFromLine(line);

  if (taxCase.mechanism === 'standard_vat' && rate > 0) {
    const net = round2(gross / (1 + rate / 100));
    const tax = round2(gross - net);
    return {
      ...line,
      taxRate: rate,
      grossAmount: gross,
      netAmount: net,
      taxAmount: tax,
    };
  }

  if (taxCase.mechanism === 'reverse_charge' && rate > 0) {
    const net = line.netAmount !== undefined ? round2(Number(line.netAmount || 0)) : gross;
    const tax = line.taxAmount !== undefined ? round2(Number(line.taxAmount || 0)) : round2(net * (rate / 100));
    return {
      ...line,
      taxRate: rate,
      grossAmount: line.grossAmount !== undefined ? round2(Number(line.grossAmount || 0)) : net,
      netAmount: net,
      taxAmount: tax,
    };
  }

  return {
    ...line,
    taxRate: 0,
    grossAmount: gross,
    netAmount: gross,
    taxAmount: 0,
  };
};

const normalizeDraftLine = (line: BookingDraftLineEntity, idx: number): BookingDraftLineEntity => ({
  id: line.id || `${idx + 1}`,
  accountNumber: String(line.accountNumber || '').trim(),
  debitAmount: Number(line.debitAmount || 0),
  creditAmount: Number(line.creditAmount || 0),
  taxCode: line.taxCode || undefined,
  taxCaseKey: normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode),
  taxRate: line.taxRate !== undefined ? Number(line.taxRate || 0) : undefined,
  netAmount: line.netAmount !== undefined ? round2(Number(line.netAmount || 0)) : undefined,
  taxAmount: line.taxAmount !== undefined ? round2(Number(line.taxAmount || 0)) : undefined,
  grossAmount: line.grossAmount !== undefined ? round2(Number(line.grossAmount || 0)) : undefined,
  countryCode: line.countryCode ? String(line.countryCode).trim().toUpperCase() : undefined,
  counterpartyVatId: line.counterpartyVatId ? String(line.counterpartyVatId).trim().toUpperCase() : undefined,
  evidenceType: line.evidenceType ? String(line.evidenceType).trim() : undefined,
  evidenceReference: line.evidenceReference ? String(line.evidenceReference).trim() : undefined,
  costCenter: line.costCenter || undefined,
  memo: line.memo || undefined,
});

const ensurePeriodExists = (db: Database.Database, period: string, fiscalYear: number, tenantId: string): void => {
  const existing = db
    .prepare('SELECT id FROM accounting_periods WHERE tenant_id = ? AND period = ?')
    .get(tenantId, period) as { id: string } | undefined;
  if (existing) return;

  const startsAt = `${period}-01`;
  const [yearStr, monthStr] = period.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const endDate = new Date(Date.UTC(year, month, 0));
  const endsAt = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `,
  ).run(randomUUID(), tenantId, period, fiscalYear, startsAt, endsAt, now, now);
};

const loadPeriodStatus = (db: Database.Database, period: string, tenantId: string): AccountingPeriodStatus => {
  const row = db
    .prepare('SELECT status FROM accounting_periods WHERE tenant_id = ? AND period = ?')
    .get(tenantId, period) as { status: AccountingPeriodStatus } | undefined;
  return row?.status ?? 'open';
};

const defaultDraftFromBankTx = (
  tx: ProBankTransaction,
  suggestedAccountNumber?: string,
  bankLedgerAccountNumber?: string,
): BookingDraftEntity => {
  const absAmount = round2(Math.abs(tx.amount));
  const draftId = `draft-${tx.id}`;
  const period = (tx.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const fiscalYear = Number(period.slice(0, 4));
  const suggested = suggestedAccountNumber?.trim();
  const expenseAccount = suggested || '6000';
  const incomeAccount = suggested || '8400';
  const bankAccount = bankLedgerAccountNumber?.trim() || '1200';

  return {
    id: draftId,
    tenantId: tx.tenantId,
    transactionId: tx.id,
    workflowStatus: tx.status === 'booked' ? 'posted' : 'imported',
    postingDate: tx.date,
    documentDate: tx.date,
    bookingText: tx.purpose || (tx.type === 'income' ? 'Einnahme' : 'Ausgabe'),
    reference: tx.id,
    period,
    fiscalYear,
    lines: [
      {
        id: `${draftId}-1`,
        accountNumber: tx.type === 'income' ? bankAccount : expenseAccount,
        debitAmount: absAmount,
        creditAmount: 0,
      },
      {
        id: `${draftId}-2`,
        accountNumber: tx.type === 'income' ? incomeAccount : bankAccount,
        debitAmount: 0,
        creditAmount: absAmount,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };
};

const parseDraftRow = (
  row: { draft_json: string; updated_at: string },
  tenantId: string,
): BookingDraftEntity => {
  const draft = safeJsonParse<BookingDraftEntity>(row.draft_json, {
    id: '',
    tenantId,
    transactionId: '',
    workflowStatus: 'imported',
    bookingText: '',
    period: new Date().toISOString().slice(0, 7),
    fiscalYear: new Date().getFullYear(),
    lines: [],
    validationIssues: [],
    updatedAt: row.updated_at,
  });

  return {
    ...draft,
    lines: (draft.lines ?? []).map(normalizeDraftLine),
    validationIssues: draft.validationIssues ?? [],
    updatedAt: row.updated_at,
  };
};

const getNextEntryNumber = (db: Database.Database, tenantId: string): number => {
  const row = db
    .prepare('SELECT COALESCE(MAX(entry_number), 0) as n FROM journal_entries WHERE tenant_id = ?')
    .get(tenantId) as { n: number };
  return Number(row.n || 0) + 1;
};

const saveDraftLinesAndIssues = (db: Database.Database, draft: BookingDraftEntity): void => {
  db.prepare('DELETE FROM booking_draft_lines WHERE draft_id = ?').run(draft.id);
  db.prepare('DELETE FROM draft_validation_issues WHERE draft_id = ?').run(draft.id);

  const insertLine = db.prepare(
    `
      INSERT INTO booking_draft_lines
        (
          id, tenant_id, draft_id, line_no, account_number, debit_amount, credit_amount, tax_code,
          tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id,
          evidence_type, evidence_reference, cost_center, memo
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  draft.lines.forEach((line, idx) => {
    insertLine.run(
      line.id || randomUUID(),
      draft.tenantId,
      draft.id,
      idx + 1,
      line.accountNumber,
      round2(line.debitAmount),
      round2(line.creditAmount),
      line.taxCode ?? null,
      line.taxCaseKey ?? null,
      line.taxRate ?? null,
      line.netAmount ?? null,
      line.taxAmount ?? null,
      line.grossAmount ?? null,
      line.countryCode ?? null,
      line.counterpartyVatId ?? null,
      line.evidenceType ?? null,
      line.evidenceReference ?? null,
      line.costCenter ?? null,
      line.memo ?? null,
    );
  });

  const insertIssue = db.prepare(
    `
      INSERT INTO draft_validation_issues
        (id, tenant_id, draft_id, code, severity, message, field_path, blocking, source, issue_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  const now = new Date().toISOString();
  for (const issue of draft.validationIssues) {
    insertIssue.run(
      issue.id || randomUUID(),
      draft.tenantId,
      draft.id,
      issue.code,
      issue.severity,
      issue.message,
      issue.fieldPath ?? null,
      issue.blocking ? 1 : 0,
      issue.source,
      JSON.stringify(issue),
      now,
    );
  }
};

const validateDraft = (
  db: Database.Database,
  draft: BookingDraftEntity,
  periodStatus: AccountingPeriodStatus,
  chart: 'SKR03' | 'SKR04',
): DraftValidationIssue[] => {
  const issues: DraftValidationIssue[] = [];
  const debit = round2(draft.lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
  const credit = round2(draft.lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0));

  if (Math.abs(debit - credit) > 0.01) {
    issues.push({
      id: randomUUID(),
      code: 'UNBALANCED_ENTRY',
      severity: 'error',
      message: 'Soll/Haben sind nicht ausgeglichen.',
      blocking: true,
      source: 'system',
    });
  }

  if (!draft.lines.length) {
    issues.push({
      id: randomUUID(),
      code: 'MISSING_ACCOUNT',
      severity: 'error',
      message: 'Mindestens zwei Buchungszeilen sind erforderlich.',
      blocking: true,
      source: 'system',
    });
  }

  draft.lines.forEach((line, idx) => {
    const amount = Math.max(Number(line.debitAmount || 0), Number(line.creditAmount || 0));
    if (amount <= 0) return;

    const taxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
    const isPnl = line.accountNumber.startsWith('4') || line.accountNumber.startsWith('8');
    if (isPnl && !taxCaseKey) {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_TAX_CASE',
        severity: 'error',
        message: 'Steuerfall fehlt für Erlös-/Aufwandskonto.',
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
      return;
    }

    if (!taxCaseKey) return;

    const taxCase = getTaxCaseByKey(db, taxCaseKey);
    if (!taxCase || !taxCase.active) {
      issues.push({
        id: randomUUID(),
        code: 'INVALID_TAX_CASE',
        severity: 'error',
        message: `Unbekannter oder inaktiver Steuerfall: ${taxCaseKey}.`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
      return;
    }

    if (taxCase.requiresCounterpartyVatId && !line.counterpartyVatId) {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_COUNTERPARTY_VAT_ID',
        severity: 'error',
        message: 'USt-IdNr. des Gegenübers ist für diesen Steuerfall Pflicht.',
        fieldPath: `lines[${idx}].counterpartyVatId`,
        blocking: true,
        source: 'system',
      });
    }

    if (taxCase.requiresCountry && !line.countryCode) {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_COUNTRY_CODE',
        severity: 'error',
        message: 'Ländercode ist für diesen Steuerfall Pflicht.',
        fieldPath: `lines[${idx}].countryCode`,
        blocking: true,
        source: 'system',
      });
    }

    if (taxCase.requiresEvidence && (!line.evidenceType || !line.evidenceReference)) {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_TAX_EVIDENCE',
        severity: 'error',
        message: 'Steuernachweis (Typ und Referenz) ist für diesen Steuerfall Pflicht.',
        fieldPath: `lines[${idx}].evidenceReference`,
        blocking: true,
        source: 'system',
      });
    }

    const mapping = resolveTaxAccountsForCase(db, chart, taxCaseKey);
    if (taxCase.mechanism === 'reverse_charge' && (!mapping.inputTaxAccount || !mapping.outputTaxAccount)) {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_TAX_MAPPING',
        severity: 'error',
        message: `Steuerkonten-Mapping fehlt für Steuerfall ${taxCaseKey} (${chart}).`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
    }
    if (!mapping.datevBuKey && taxCase.mechanism !== 'exempt' && taxCase.mechanism !== 'zero_rate') {
      issues.push({
        id: randomUUID(),
        code: 'MISSING_DATEV_BU_KEY',
        severity: 'error',
        message: `DATEV BU-Schlüssel fehlt für Steuerfall ${taxCaseKey} (${chart}).`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
    }
  });

  if (periodStatus === 'closed') {
    issues.push({
      id: randomUUID(),
      code: 'POSTING_DATE_IN_CLOSED_PERIOD',
      severity: 'error',
      message: 'Periode ist geschlossen.',
      blocking: true,
      source: 'system',
    });
  }

  return issues;
};

const toBankTransaction = (row: {
  id: string;
  tenant_id: string;
  account_id: string;
  date: string;
  amount: number;
  type: string;
  counterparty: string;
  purpose: string;
  status: string;
  linked_invoice_id: string | null;
}): ProBankTransaction => ({
  id: row.id,
  tenantId: row.tenant_id,
  accountId: row.account_id,
  date: row.date,
  amount: Number(row.amount || 0),
  type: row.type === 'income' ? 'income' : 'expense',
  counterparty: row.counterparty,
  purpose: row.purpose,
  status: row.status === 'booked' ? 'booked' : 'pending',
  linkedInvoiceId: row.linked_invoice_id ?? undefined,
});

const getActiveChart = (db: Database.Database): 'SKR03' | 'SKR04' => {
  const rows = db
    .prepare(
      `
      SELECT chart, COUNT(*) as c
      FROM ledger_accounts
      GROUP BY chart
      `,
    )
    .all() as Array<{ chart: string; c: number }>;
  const byChart = rows.reduce(
    (acc, row) => {
      if (row.chart === 'SKR03') acc.SKR03 = row.c;
      if (row.chart === 'SKR04') acc.SKR04 = row.c;
      return acc;
    },
    { SKR03: 0, SKR04: 0 },
  );
  return byChart.SKR03 >= byChart.SKR04 ? 'SKR03' : 'SKR04';
};

const resolveFallbackBankLedgerAccount = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
): string => {
  const preferred = chart === 'SKR04' ? '1800' : '1200';
  const preferredRow = db
    .prepare(
      `
      SELECT account_number
      FROM ledger_accounts
      WHERE chart = ? AND account_number = ?
      LIMIT 1
      `,
    )
    .get(chart, preferred) as { account_number: string } | undefined;
  if (preferredRow?.account_number) return preferredRow.account_number;

  const chartRow = db
    .prepare(
      `
      SELECT account_number
      FROM ledger_accounts
      WHERE chart = ?
      ORDER BY account_number
      LIMIT 1
      `,
    )
    .get(chart) as { account_number: string } | undefined;
  if (chartRow?.account_number) return chartRow.account_number;

  const anyRow = db
    .prepare(
      `
      SELECT account_number
      FROM ledger_accounts
      ORDER BY chart, account_number
      LIMIT 1
      `,
    )
    .get() as { account_number: string } | undefined;
  if (anyRow?.account_number) return anyRow.account_number;

  return preferred;
};

const resolveBankLedgerAccountForTransaction = (
  db: Database.Database,
  tx: ProBankTransaction,
): string => {
  const activeChart = getActiveChart(db);
  const row = db
    .prepare(
      `
      SELECT default_skr_account_number
      FROM accounts
      WHERE id = ?
      LIMIT 1
      `,
    )
    .get(tx.accountId) as { default_skr_account_number: string | null } | undefined;

  const candidate = String(row?.default_skr_account_number ?? '').trim();
  if (!candidate) {
    return resolveFallbackBankLedgerAccount(db, activeChart);
  }

  const exists = db
    .prepare('SELECT 1 FROM ledger_accounts WHERE account_number = ? LIMIT 1')
    .get(candidate) as { 1: 1 } | undefined;

  return exists ? candidate : resolveFallbackBankLedgerAccount(db, activeChart);
};

const buildSuggestionsByTransaction = (
  db: Database.Database,
  items: ProBankTransaction[],
  scope: TenantScope,
): Map<string, ReturnType<typeof suggestAccountForTransaction>> => {
  if (items.length === 0) return new Map();
  const tenantId = getTenantId(scope);
  const chart = getActiveChart(db);
  const rules = listAccountSuggestionRules(db, { chart, activeOnly: true }, scope);
  const ctx = buildAccountSuggestionContext(db, { chart, rules, tenantId });
  const out = new Map<string, ReturnType<typeof suggestAccountForTransaction>>();
  for (const item of items) {
    out.set(
      item.id,
      suggestAccountForTransaction(ctx, {
        flowType: item.type,
        counterparty: item.counterparty,
        purpose: item.purpose,
      }),
    );
  }
  return out;
};

export const listBankTransactions = (db: Database.Database, scope: TenantScope): ProBankTransaction[] => {
  const tenantId = getTenantId(scope);
  const rows = db
    .prepare(
      `
      SELECT id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, linked_invoice_id
      FROM bank_transactions
      WHERE tenant_id = ?
      ORDER BY date DESC, id ASC
    `,
    )
    .all(tenantId) as Array<{
    id: string;
    tenant_id: string;
    account_id: string;
    date: string;
    amount: number;
    type: string;
    counterparty: string;
    purpose: string;
    status: string;
    linked_invoice_id: string | null;
  }>;

  const items = rows.map(toBankTransaction);
  const suggestionsByTx = buildSuggestionsByTransaction(db, items, scope);

  return items.map((item) => {
    const suggestion = suggestionsByTx.get(item.id);
    return {
      ...item,
      suggestedAccountNumber: suggestion?.accountNumber,
      suggestionReason: suggestion?.reason,
      suggestionLayer: suggestion?.layer,
      suggestionConfidence: suggestion?.confidence,
    };
  });
};

export const getDraftByTransactionId = (
  db: Database.Database,
  transactionId: string,
  scope: TenantScope,
): BookingDraftEntity | null => {
  const tenantId = getTenantId(scope);
  const row = db
    .prepare(
      `
        SELECT draft_json, updated_at
        FROM booking_drafts
        WHERE tenant_id = ? AND transaction_id = ?
      `,
    )
    .get(tenantId, transactionId) as { draft_json: string; updated_at: string } | undefined;

  if (row) {
    return parseDraftRow(row, tenantId);
  }

  const txRow = db
    .prepare(
      `
      SELECT id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, linked_invoice_id
      FROM bank_transactions
      WHERE tenant_id = ? AND id = ?
    `,
    )
    .get(tenantId, transactionId) as
    | {
        id: string;
        tenant_id: string;
        account_id: string;
        date: string;
        amount: number;
        type: string;
        counterparty: string;
        purpose: string;
        status: string;
        linked_invoice_id: string | null;
      }
    | undefined;

  if (!txRow) return null;

  const tx = toBankTransaction(txRow);
  const suggestion = buildSuggestionsByTransaction(db, [tx], scope).get(tx.id);
  const bankLedgerAccount = resolveBankLedgerAccountForTransaction(db, tx);
  const draft = defaultDraftFromBankTx(tx, suggestion?.accountNumber, bankLedgerAccount);
  return saveDraft(db, draft, scope);
};

export const saveDraft = (
  db: Database.Database,
  draft: BookingDraftEntity,
  scope: TenantScope,
): BookingDraftEntity => {
  const tenantId = getTenantId(scope);
  const now = new Date().toISOString();
  const chart = getActiveChart(db);
  const normalized: BookingDraftEntity = {
    ...draft,
    tenantId,
    lines: (draft.lines ?? []).map(normalizeDraftLine).map((line) => {
      const taxCase = getTaxCaseByKey(db, line.taxCaseKey ?? line.taxCode);
      const enriched = enrichTaxFields(
        {
          ...line,
          taxCaseKey: line.taxCaseKey ?? normalizeTaxCaseKey(line.taxCode),
          taxCode: toLegacyTaxCode(line.taxCaseKey ?? normalizeTaxCaseKey(line.taxCode)) ?? line.taxCode,
        },
        taxCase,
      );
      return enriched;
    }),
    validationIssues: draft.validationIssues ?? [],
    period: draft.period || (draft.postingDate || now.slice(0, 10)).slice(0, 7),
    fiscalYear: draft.fiscalYear || Number((draft.period || now.slice(0, 7)).slice(0, 4)),
    updatedAt: now,
  };

  ensurePeriodExists(db, normalized.period, normalized.fiscalYear, tenantId);
  const periodStatus = loadPeriodStatus(db, normalized.period, tenantId);
  normalized.validationIssues = validateDraft(db, normalized, periodStatus, chart);
  normalized.workflowStatus = normalized.validationIssues.some((issue) => issue.blocking)
    ? periodStatus === 'closed'
      ? 'period_locked'
      : 'incomplete'
    : normalized.workflowStatus;

  db.prepare(
    `
      INSERT INTO booking_drafts (id, tenant_id, transaction_id, workflow_status, draft_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        transaction_id = excluded.transaction_id,
        workflow_status = excluded.workflow_status,
        draft_json = excluded.draft_json,
        updated_at = excluded.updated_at
    `,
  ).run(
    normalized.id,
    tenantId,
    normalized.transactionId,
    normalized.workflowStatus,
    JSON.stringify(normalized),
    now,
  );

  saveDraftLinesAndIssues(db, normalized);
  return normalized;
};

export const dispatchDraftAction = (
  db: Database.Database,
  args: {
    transactionId: string;
    action: 'save_draft' | 'submit_for_review' | 'approve' | 'reject' | 'post' | 'reverse' | 'create_correction' | 'request_receipt';
    rejectReason?: string;
  },
  scope: TenantScope,
): BookingDraftEntity => {
  const tenantId = getTenantId(scope);
  const draft = getDraftByTransactionId(db, args.transactionId, scope);
  if (!draft) {
    throw new Error('Draft not found');
  }

  const next = { ...draft };
  switch (args.action) {
    case 'save_draft':
      next.workflowStatus = 'suggested';
      break;
    case 'submit_for_review':
      next.workflowStatus = 'pending_approval';
      break;
    case 'approve':
      next.workflowStatus = 'approved';
      break;
    case 'reject':
      next.workflowStatus = 'incomplete';
      if (args.rejectReason) {
        next.validationIssues = [
          {
            id: randomUUID(),
            code: 'MANUAL_REVIEW_REJECTED',
            severity: 'warning',
            message: args.rejectReason,
            blocking: false,
            source: 'user',
          },
        ];
      }
      break;
    case 'post':
      next.workflowStatus = 'approved';
      break;
    case 'reverse':
      next.workflowStatus = 'reversed';
      break;
    case 'create_correction':
      next.workflowStatus = 'corrected';
      break;
    case 'request_receipt':
      next.workflowStatus = 'incomplete';
      break;
  }

  return saveDraft(db, next, scope);
};

export const validateTaxCompliance = (
  db: Database.Database,
  args: { draftId?: string; transactionId?: string },
  scope: TenantScope,
): { ok: boolean; issues: DraftValidationIssue[] } => {
  const tenantId = getTenantId(scope);
  let draft: BookingDraftEntity | null = null;
  if (args.draftId) {
    const row = db
      .prepare('SELECT draft_json FROM booking_drafts WHERE tenant_id = ? AND id = ?')
      .get(tenantId, args.draftId) as { draft_json: string } | undefined;
    if (!row) throw new Error('Draft not found');
    draft = safeJsonParse<BookingDraftEntity>(row.draft_json, null as never);
  } else if (args.transactionId) {
    draft = getDraftByTransactionId(db, args.transactionId, scope);
  } else {
    throw new Error('draftId or transactionId is required');
  }

  if (!draft) throw new Error('Draft not found');
  const normalized = saveDraft(db, draft, scope);
  const blocking = normalized.validationIssues.some((issue) => issue.blocking);
  return { ok: !blocking, issues: normalized.validationIssues };
};

interface PostingPairSeed {
  debitLineId: string;
  creditLineId: string;
  amount: number;
  taxCaseKey?: TaxCaseKey;
  datevBuKey?: string;
}

const buildPostingPairs = (lines: JournalLineEntity[]): PostingPairSeed[] => {
  type RemainingLine = JournalLineEntity & { remaining: number };
  const debits: RemainingLine[] = lines
    .filter((line) => Number(line.debitAmount || 0) > 0)
    .map((line) => ({ ...line, remaining: round2(Number(line.debitAmount || 0)) }));
  const credits: RemainingLine[] = lines
    .filter((line) => Number(line.creditAmount || 0) > 0)
    .map((line) => ({ ...line, remaining: round2(Number(line.creditAmount || 0)) }));

  const pairs: PostingPairSeed[] = [];
  for (const debit of debits) {
    let cursor = 0;
    while (debit.remaining > 0.0001 && cursor < credits.length) {
      const credit = credits[cursor]!;
      if (credit.remaining <= 0.0001) {
        cursor += 1;
        continue;
      }
      const amount = round2(Math.min(debit.remaining, credit.remaining));
      if (amount <= 0) break;
      const taxCase = normalizeTaxCaseKey(debit.taxCaseKey ?? credit.taxCaseKey ?? debit.taxCode ?? credit.taxCode);
      pairs.push({
        debitLineId: debit.id,
        creditLineId: credit.id,
        amount,
        taxCaseKey: taxCase,
      });
      debit.remaining = round2(debit.remaining - amount);
      credit.remaining = round2(credit.remaining - amount);
    }
  }

  return pairs.filter((pair) => pair.amount > 0);
};

export const postDraft = (
  db: Database.Database,
  draftId: string,
  options: { postingDate?: string } = {},
  scope: TenantScope,
): { entry: JournalEntryEntity; issues: DraftValidationIssue[] } => {
  const tenantId = getTenantId(scope);
  const row = db
    .prepare('SELECT draft_json FROM booking_drafts WHERE tenant_id = ? AND id = ?')
    .get(tenantId, draftId) as { draft_json: string } | undefined;

  if (!row) {
    throw new Error('Draft not found');
  }

  const draft = safeJsonParse<BookingDraftEntity>(row.draft_json, null as never);
  const postingDate = options.postingDate || draft.postingDate || new Date().toISOString().slice(0, 10);
  const period = postingDate.slice(0, 7);
  const fiscalYear = Number(period.slice(0, 4));

  ensurePeriodExists(db, period, fiscalYear, tenantId);
  const periodStatus = loadPeriodStatus(db, period, tenantId);
  const validated = saveDraft(db, {
    ...draft,
    postingDate,
    period,
    fiscalYear,
    workflowStatus: 'approved',
  }, scope);

  const blockingIssues = validated.validationIssues.filter((issue) => issue.blocking);
  if (!isOpenOrSoftLocked(periodStatus) || blockingIssues.length > 0) {
    return {
      entry: {
        id: '',
        tenantId,
        entryNumber: 0,
        postingDate,
        bookingText: validated.bookingText,
        period,
        fiscalYear,
        status: 'posted',
        createdAt: new Date().toISOString(),
        lines: [],
      },
      issues: validated.validationIssues,
    };
  }

  const entryNumber = getNextEntryNumber(db, tenantId);
  const entryId = randomUUID();
  const createdAt = new Date().toISOString();
  const chart = getActiveChart(db);

  const postingLines: JournalLineEntity[] = [];
  validated.lines.forEach((line, idx) => {
    const taxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
    const baseLine: JournalLineEntity = {
      ...line,
      id: line.id || randomUUID(),
      taxCaseKey,
      taxCode: toLegacyTaxCode(taxCaseKey) ?? line.taxCode,
    };
    postingLines.push(baseLine);

    const taxCase = getTaxCaseByKey(db, taxCaseKey);
    if (!taxCase || taxCase.mechanism !== 'reverse_charge') return;
    const taxAmount = round2(Number(line.taxAmount || 0));
    if (taxAmount <= 0) return;
    const taxAccounts = resolveTaxAccountsForCase(db, chart, taxCaseKey);
    if (!taxAccounts.inputTaxAccount || !taxAccounts.outputTaxAccount) return;

    postingLines.push({
      id: randomUUID(),
      accountNumber: taxAccounts.inputTaxAccount,
      debitAmount: taxAmount,
      creditAmount: 0,
      taxCode: toLegacyTaxCode(taxCaseKey),
      taxCaseKey,
      taxRate: Number(line.taxRate || taxCase.defaultRate || 0),
      netAmount: line.netAmount,
      taxAmount,
      grossAmount: line.grossAmount,
      countryCode: line.countryCode,
      counterpartyVatId: line.counterpartyVatId,
      evidenceType: line.evidenceType,
      evidenceReference: line.evidenceReference,
      memo: `RC Vorsteuer ${taxCaseKey}`,
    });
    postingLines.push({
      id: randomUUID(),
      accountNumber: taxAccounts.outputTaxAccount,
      debitAmount: 0,
      creditAmount: taxAmount,
      taxCode: toLegacyTaxCode(taxCaseKey),
      taxCaseKey,
      taxRate: Number(line.taxRate || taxCase.defaultRate || 0),
      netAmount: line.netAmount,
      taxAmount,
      grossAmount: line.grossAmount,
      countryCode: line.countryCode,
      counterpartyVatId: line.counterpartyVatId,
      evidenceType: line.evidenceType,
      evidenceReference: line.evidenceReference,
      memo: `RC Umsatzsteuer ${taxCaseKey}`,
    });
  });

  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO journal_entries
        (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, reversed_entry_id, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, NULL, ?)
      `,
    ).run(
      entryId,
      tenantId,
      entryNumber,
      postingDate,
      validated.documentDate ?? null,
      validated.bookingText,
      validated.reference ?? null,
      period,
      fiscalYear,
      validated.id,
      createdAt,
    );

    const insertLine = db.prepare(
      `
      INSERT INTO journal_lines
        (
          id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code,
          tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id,
          evidence_type, evidence_reference, cost_center, memo
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    postingLines.forEach((line, idx) => {
      insertLine.run(
        line.id,
        tenantId,
        entryId,
        idx + 1,
        line.accountNumber,
        round2(line.debitAmount),
        round2(line.creditAmount),
        line.taxCode ?? null,
        line.taxCaseKey ?? null,
        line.taxRate ?? null,
        line.netAmount ?? null,
        line.taxAmount ?? null,
        line.grossAmount ?? null,
        line.countryCode ?? null,
        line.counterpartyVatId ?? null,
        line.evidenceType ?? null,
        line.evidenceReference ?? null,
        line.costCenter ?? null,
        line.memo ?? null,
      );
    });

    const insertEvidence = db.prepare(
      `
      INSERT INTO vat_evidence
        (id, tenant_id, draft_id, entry_id, line_id, tax_case_key, evidence_type, evidence_reference, country_code, counterparty_vat_id, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    for (const line of postingLines) {
      const taxCase = getTaxCaseByKey(db, line.taxCaseKey ?? line.taxCode);
      if (!taxCase) continue;
      const hasEvidence = Boolean(line.evidenceType || line.evidenceReference || line.countryCode || line.counterpartyVatId);
      if (!taxCase.requiresEvidence && !hasEvidence) continue;
      insertEvidence.run(
        randomUUID(),
        tenantId,
        validated.id,
        entryId,
        line.id,
        taxCase.key,
        line.evidenceType ?? null,
        line.evidenceReference ?? null,
        line.countryCode ?? null,
        line.counterpartyVatId ?? null,
        createdAt,
      );
    }

    const insertPair = db.prepare(
      `
      INSERT INTO journal_posting_pairs
        (id, tenant_id, entry_id, debit_line_id, credit_line_id, amount, tax_case_key, datev_bu_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    for (const pair of buildPostingPairs(postingLines)) {
      const datevBuKey = resolveDatevBuKeyForTaxCase(db, chart, pair.taxCaseKey);
      insertPair.run(
        randomUUID(),
        tenantId,
        entryId,
        pair.debitLineId,
        pair.creditLineId,
        round2(pair.amount),
        pair.taxCaseKey ?? null,
        datevBuKey ?? null,
        createdAt,
      );
    }

    db.prepare('UPDATE booking_drafts SET workflow_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(
      'posted',
      createdAt,
      validated.id,
      tenantId,
    );

    db.prepare('UPDATE bank_transactions SET status = ? WHERE id = ? AND tenant_id = ?').run(
      'booked',
      validated.transactionId,
      tenantId,
    );

    appendAuditLog(db, {
      entityType: 'pro_journal_entry',
      entityId: entryId,
      action: 'post',
      reason: 'Draft posted',
      before: null,
      after: {
        entryNumber,
        postingDate,
        period,
        fiscalYear,
        sourceDraftId: validated.id,
      },
      actor: 'pro',
    });
  });

  tx();

  return {
    entry: {
      id: entryId,
      tenantId,
      entryNumber,
      postingDate,
      documentDate: validated.documentDate,
      bookingText: validated.bookingText,
      reference: validated.reference,
      period,
      fiscalYear,
      status: 'posted',
      sourceDraftId: validated.id,
      createdAt,
      lines: postingLines,
    },
    issues: validated.validationIssues,
  };
};

export const reverseJournalEntry = (
  db: Database.Database,
  entryId: string,
  reason: string,
  scope: TenantScope,
): { ok: true; reversalEntryId: string } => {
  const tenantId = getTenantId(scope);
  const entry = db
    .prepare(
      `
      SELECT id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status
      FROM journal_entries
      WHERE tenant_id = ? AND id = ?
    `,
    )
    .get(tenantId, entryId) as
    | {
        id: string;
        entry_number: number;
        posting_date: string;
        document_date: string | null;
        booking_text: string;
        reference: string | null;
        period: string;
        fiscal_year: number;
        status: string;
      }
    | undefined;

  if (!entry) {
    throw new Error('Journal entry not found');
  }
  if (entry.status === 'reversed') {
    throw new Error('Journal entry already reversed');
  }

  const lines = db
    .prepare(
      `
      SELECT
        id,
        account_number,
        debit_amount,
        credit_amount,
        tax_code,
        tax_case_key,
        tax_rate,
        net_amount,
        tax_amount,
        gross_amount,
        country_code,
        counterparty_vat_id,
        evidence_type,
        evidence_reference,
        cost_center,
        memo
      FROM journal_lines
      WHERE tenant_id = ? AND entry_id = ?
      ORDER BY line_no ASC
    `,
    )
    .all(tenantId, entryId) as Array<{
    id: string;
    account_number: string;
    debit_amount: number;
    credit_amount: number;
    tax_code: string | null;
    tax_case_key: TaxCaseKey | null;
    tax_rate: number | null;
    net_amount: number | null;
    tax_amount: number | null;
    gross_amount: number | null;
    country_code: string | null;
    counterparty_vat_id: string | null;
    evidence_type: string | null;
    evidence_reference: string | null;
    cost_center: string | null;
    memo: string | null;
  }>;

  const reversalEntryId = randomUUID();
  const reversalNumber = getNextEntryNumber(db, tenantId);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO journal_entries
        (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, reversed_entry_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?)
      `,
    ).run(
      reversalEntryId,
      tenantId,
      reversalNumber,
      now.slice(0, 10),
      entry.document_date,
      `Storno ${entry.entry_number}: ${entry.booking_text}`,
      reason,
      entry.period,
      entry.fiscal_year,
      entryId,
      now,
    );

    const insertLine = db.prepare(
      `
      INSERT INTO journal_lines
        (
          id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code,
          tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id,
          evidence_type, evidence_reference, cost_center, memo
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    lines.forEach((line, idx) => {
      insertLine.run(
        randomUUID(),
        tenantId,
        reversalEntryId,
        idx + 1,
        line.account_number,
        round2(Number(line.credit_amount || 0)),
        round2(Number(line.debit_amount || 0)),
        line.tax_code,
        line.tax_case_key,
        line.tax_rate,
        line.net_amount,
        line.tax_amount,
        line.gross_amount,
        line.country_code,
        line.counterparty_vat_id,
        line.evidence_type,
        line.evidence_reference,
        line.cost_center,
        line.memo,
      );
    });

    const reversalLines = db
      .prepare(
        `
        SELECT
          id, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount,
          country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo
        FROM journal_lines
        WHERE tenant_id = ? AND entry_id = ?
        ORDER BY line_no ASC
        `,
      )
      .all(tenantId, reversalEntryId) as Array<{
      id: string;
      account_number: string;
      debit_amount: number;
      credit_amount: number;
      tax_code: string | null;
      tax_case_key: TaxCaseKey | null;
      tax_rate: number | null;
      net_amount: number | null;
      tax_amount: number | null;
      gross_amount: number | null;
      country_code: string | null;
      counterparty_vat_id: string | null;
      evidence_type: string | null;
      evidence_reference: string | null;
      cost_center: string | null;
      memo: string | null;
    }>;
    const chart = getActiveChart(db);
    const insertPair = db.prepare(
      `
      INSERT INTO journal_posting_pairs
        (id, tenant_id, entry_id, debit_line_id, credit_line_id, amount, tax_case_key, datev_bu_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const pairLines: JournalLineEntity[] = reversalLines.map((line) => ({
      id: line.id,
      accountNumber: line.account_number,
      debitAmount: Number(line.debit_amount || 0),
      creditAmount: Number(line.credit_amount || 0),
      taxCode: line.tax_code ?? undefined,
      taxCaseKey: line.tax_case_key ?? undefined,
      taxRate: line.tax_rate ?? undefined,
      netAmount: line.net_amount ?? undefined,
      taxAmount: line.tax_amount ?? undefined,
      grossAmount: line.gross_amount ?? undefined,
      countryCode: line.country_code ?? undefined,
      counterpartyVatId: line.counterparty_vat_id ?? undefined,
      evidenceType: line.evidence_type ?? undefined,
      evidenceReference: line.evidence_reference ?? undefined,
      costCenter: line.cost_center ?? undefined,
      memo: line.memo ?? undefined,
    }));
    for (const pair of buildPostingPairs(pairLines)) {
      const datevBuKey = resolveDatevBuKeyForTaxCase(db, chart, pair.taxCaseKey);
      insertPair.run(
        randomUUID(),
        tenantId,
        reversalEntryId,
        pair.debitLineId,
        pair.creditLineId,
        round2(pair.amount),
        pair.taxCaseKey ?? null,
        datevBuKey ?? null,
        now,
      );
    }

    db.prepare('UPDATE journal_entries SET status = ?, reversed_entry_id = ? WHERE tenant_id = ? AND id = ?').run(
      'reversed',
      reversalEntryId,
      tenantId,
      entryId,
    );

    appendAuditLog(db, {
      entityType: 'pro_journal_entry',
      entityId: entryId,
      action: 'reverse',
      reason,
      before: {
        status: 'posted',
      },
      after: {
        status: 'reversed',
        reversalEntryId,
      },
      actor: 'pro',
    });
    appendAuditLog(db, {
      entityType: 'pro_journal_entry',
      entityId: reversalEntryId,
      action: 'post_reversal',
      reason,
      before: null,
      after: {
        reversesEntryId: entryId,
        entryNumber: reversalNumber,
      },
      actor: 'pro',
    });
  });

  tx();
  return { ok: true, reversalEntryId };
};

export const listJournalEntries = (
  db: Database.Database,
  args: { from?: string; to?: string; accountNumbers?: string[]; limit?: number; offset?: number } = {},
  scope: TenantScope,
): JournalEntryEntity[] => {
  const tenantId = getTenantId(scope);
  const where: string[] = ['je.tenant_id = @tenantId'];
  const params: Record<string, unknown> = { tenantId };

  if (args.from) {
    where.push('je.posting_date >= @from');
    params.from = args.from;
  }
  if (args.to) {
    where.push('je.posting_date <= @to');
    params.to = args.to;
  }
  if (args.accountNumbers?.length) {
    const placeholders = args.accountNumbers.map((accountNumber, index) => {
      const key = `accountNumber${index}`;
      params[key] = accountNumber;
      return `@${key}`;
    });
    where.push(
      `EXISTS (
        SELECT 1
        FROM journal_lines filtered_line
        WHERE filtered_line.tenant_id = je.tenant_id
          AND filtered_line.entry_id = je.id
          AND filtered_line.account_number IN (${placeholders.join(', ')})
      )`,
    );
  }

  params.limit = Math.max(1, Math.min(5000, Math.floor(args.limit ?? 500)));
  params.offset = Math.max(0, Math.floor(args.offset ?? 0));

  const rows = db
    .prepare(
      `
      SELECT id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, reversed_entry_id, created_at
      FROM journal_entries je
      WHERE ${where.join(' AND ')}
      ORDER BY posting_date DESC, entry_number DESC
      LIMIT @limit OFFSET @offset
    `,
    )
    .all(params) as Array<{
    id: string;
    tenant_id: string;
    entry_number: number;
    posting_date: string;
    document_date: string | null;
    booking_text: string;
    reference: string | null;
    period: string;
    fiscal_year: number;
    status: string;
    source_draft_id: string | null;
    reversed_entry_id: string | null;
    created_at: string;
  }>;

  const getLines = db.prepare(
    `
      SELECT
        id,
        account_number,
        debit_amount,
        credit_amount,
        tax_code,
        tax_case_key,
        tax_rate,
        net_amount,
        tax_amount,
        gross_amount,
        country_code,
        counterparty_vat_id,
        evidence_type,
        evidence_reference,
        cost_center,
        memo
      FROM journal_lines
      WHERE tenant_id = ? AND entry_id = ?
      ORDER BY line_no ASC
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    entryNumber: row.entry_number,
    postingDate: row.posting_date,
    documentDate: row.document_date ?? undefined,
    bookingText: row.booking_text,
    reference: row.reference ?? undefined,
    period: row.period,
    fiscalYear: row.fiscal_year,
    status: row.status === 'reversed' ? 'reversed' : 'posted',
    sourceDraftId: row.source_draft_id ?? undefined,
    reversedEntryId: row.reversed_entry_id ?? undefined,
    createdAt: row.created_at,
    lines: (getLines.all(tenantId, row.id) as Array<{
      id: string;
      account_number: string;
      debit_amount: number;
      credit_amount: number;
      tax_code: string | null;
      tax_case_key: TaxCaseKey | null;
      tax_rate: number | null;
      net_amount: number | null;
      tax_amount: number | null;
      gross_amount: number | null;
      country_code: string | null;
      counterparty_vat_id: string | null;
      evidence_type: string | null;
      evidence_reference: string | null;
      cost_center: string | null;
      memo: string | null;
    }>).map((line) => ({
      id: line.id,
      accountNumber: line.account_number,
      debitAmount: Number(line.debit_amount || 0),
      creditAmount: Number(line.credit_amount || 0),
      taxCode: line.tax_code ?? undefined,
      taxCaseKey: line.tax_case_key ?? undefined,
      taxRate: line.tax_rate ?? undefined,
      netAmount: line.net_amount ?? undefined,
      taxAmount: line.tax_amount ?? undefined,
      grossAmount: line.gross_amount ?? undefined,
      countryCode: line.country_code ?? undefined,
      counterpartyVatId: line.counterparty_vat_id ?? undefined,
      evidenceType: line.evidence_type ?? undefined,
      evidenceReference: line.evidence_reference ?? undefined,
      costCenter: line.cost_center ?? undefined,
      memo: line.memo ?? undefined,
    })),
  }));
};

export const getLedgerBalances = (
  db: Database.Database,
  args: { asOfDate?: string } = {},
  scope: TenantScope,
): LedgerBalanceRow[] => {
  const tenantId = getTenantId(scope);
  const rows = db
    .prepare(
      `
      SELECT jl.account_number,
             SUM(jl.debit_amount) as debit_turnover,
             SUM(jl.credit_amount) as credit_turnover
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.tenant_id = ?
        AND je.tenant_id = ?
        AND je.status = 'posted'
        AND (? IS NULL OR je.posting_date <= ?)
      GROUP BY jl.account_number
      ORDER BY jl.account_number ASC
    `,
    )
    .all(tenantId, tenantId, args.asOfDate ?? null, args.asOfDate ?? null) as Array<{
    account_number: string;
    debit_turnover: number;
    credit_turnover: number;
  }>;

  return rows.map((row) => {
    const debit = Number(row.debit_turnover || 0);
    const credit = Number(row.credit_turnover || 0);
    return {
      accountNumber: row.account_number,
      openingBalance: 0,
      debitTurnover: round2(debit),
      creditTurnover: round2(credit),
      closingBalance: round2(debit - credit),
    };
  });
};

export const getSusaReport = (
  db: Database.Database,
  args: { asOfDate?: string } = {},
  scope: TenantScope,
): {
  asOfDate: string;
  rows: LedgerBalanceRow[];
  totals: { debit: number; credit: number; balance: number };
} => {
  const tenantId = getTenantId(scope);
  const rows = getLedgerBalances(db, args, scope);
  const totals = rows.reduce(
    (acc, row) => {
      acc.debit += row.debitTurnover;
      acc.credit += row.creditTurnover;
      acc.balance += row.closingBalance;
      return acc;
    },
    { debit: 0, credit: 0, balance: 0 },
  );

  return {
    asOfDate: args.asOfDate ?? new Date().toISOString().slice(0, 10),
    rows,
    totals: {
      debit: round2(totals.debit),
      credit: round2(totals.credit),
      balance: round2(totals.balance),
    },
  };
};

const ensureDefaultMappings = (db: Database.Database, tenantId: string): void => {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM account_mappings_hgb WHERE tenant_id = ?')
    .get(tenantId) as { c: number };
  if (row.c > 0) return;

  const accounts = db
    .prepare('SELECT chart, account_number FROM ledger_accounts ORDER BY chart, account_number')
    .all() as Array<{ chart: string; account_number: string }>;
  if (!accounts.length) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `
      INSERT INTO account_mappings_hgb
        (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, chart, account_number, statement_type) DO UPDATE SET
        position_key = excluded.position_key,
        position_label = excluded.position_label,
        balance_side = excluded.balance_side,
        updated_at = excluded.updated_at
    `,
  );

  for (const account of accounts) {
    const first = account.account_number[0] ?? '';
    if (['8', '9'].includes(first)) {
      insert.run(
        randomUUID(),
        tenantId,
        account.chart,
        account.account_number,
        'guv',
        'revenue',
        'Umsatzerloese',
        null,
        now,
      );
    } else if (['4', '5', '6', '7'].includes(first)) {
      insert.run(
        randomUUID(),
        tenantId,
        account.chart,
        account.account_number,
        'guv',
        'expense',
        'Aufwendungen',
        null,
        now,
      );
    }

    if (['0', '1'].includes(first)) {
      insert.run(
        randomUUID(),
        tenantId,
        account.chart,
        account.account_number,
        'bilanz',
        'assets',
        'Aktiva',
        'asset',
        now,
      );
    } else if (['2', '3'].includes(first)) {
      insert.run(
        randomUUID(),
        tenantId,
        account.chart,
        account.account_number,
        'bilanz',
        'liabilities',
        'Passiva',
        'liability',
        now,
      );
    }
  }
};

export const getGuvReport = (
  db: Database.Database,
  args: { from?: string; to?: string } = {},
  scope: TenantScope,
): {
  from?: string;
  to?: string;
  rows: Array<{ positionKey: string; positionLabel: string; amount: number }>;
  netResult: number;
} => {
  const tenantId = getTenantId(scope);
  ensureDefaultMappings(db, tenantId);

  const rows = db
    .prepare(
      `
      SELECT map.position_key, map.position_label,
             SUM(jl.credit_amount - jl.debit_amount) as amount
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      INNER JOIN account_mappings_hgb map
              ON map.tenant_id = jl.tenant_id
             AND map.account_number = jl.account_number
             AND map.statement_type = 'guv'
      WHERE jl.tenant_id = @tenantId
        AND je.tenant_id = @tenantId
        AND je.status = 'posted'
        AND (@from IS NULL OR je.posting_date >= @from)
        AND (@to IS NULL OR je.posting_date <= @to)
      GROUP BY map.position_key, map.position_label
      ORDER BY map.position_key ASC
    `,
    )
    .all({ tenantId, from: args.from ?? null, to: args.to ?? null }) as Array<{
    position_key: string;
    position_label: string;
    amount: number;
  }>;

  const mapped = rows.map((row) => ({
    positionKey: row.position_key,
    positionLabel: row.position_label,
    amount: round2(Number(row.amount || 0)),
  }));

  const revenue = mapped
    .filter((row) => row.positionKey === 'revenue')
    .reduce((sum, row) => sum + row.amount, 0);
  const expense = mapped
    .filter((row) => row.positionKey === 'expense')
    .reduce((sum, row) => sum + Math.abs(row.amount), 0);

  return {
    from: args.from,
    to: args.to,
    rows: mapped,
    netResult: round2(revenue - expense),
  };
};

export const getBilanzReport = (
  db: Database.Database,
  args: { asOfDate?: string } = {},
  scope: TenantScope,
): {
  asOfDate: string;
  assets: Array<{ accountNumber: string; amount: number }>;
  liabilities: Array<{ accountNumber: string; amount: number }>;
  totals: { assets: number; liabilities: number; delta: number };
} => {
  const tenantId = getTenantId(scope);
  ensureDefaultMappings(db, tenantId);

  const rows = db
    .prepare(
      `
      SELECT map.balance_side, jl.account_number,
             SUM(jl.debit_amount - jl.credit_amount) as amount
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      INNER JOIN account_mappings_hgb map
              ON map.tenant_id = jl.tenant_id
             AND map.account_number = jl.account_number
             AND map.statement_type = 'bilanz'
      WHERE jl.tenant_id = @tenantId
        AND je.tenant_id = @tenantId
        AND je.status = 'posted'
        AND (@asOfDate IS NULL OR je.posting_date <= @asOfDate)
      GROUP BY map.balance_side, jl.account_number
      ORDER BY jl.account_number ASC
    `,
    )
    .all({ tenantId, asOfDate: args.asOfDate ?? null }) as Array<{
    balance_side: 'asset' | 'liability' | null;
    account_number: string;
    amount: number;
  }>;

  const assets = rows
    .filter((row) => row.balance_side === 'asset')
    .map((row) => ({ accountNumber: row.account_number, amount: round2(Number(row.amount || 0)) }));
  const liabilities = rows
    .filter((row) => row.balance_side === 'liability')
    .map((row) => ({ accountNumber: row.account_number, amount: round2(Math.abs(Number(row.amount || 0))) }));

  const totalAssets = round2(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((sum, row) => sum + row.amount, 0));

  return {
    asOfDate: args.asOfDate ?? new Date().toISOString().slice(0, 10),
    assets,
    liabilities,
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      delta: round2(totalAssets - totalLiabilities),
    },
  };
};

export const listDatevExports = (db: Database.Database, scope: TenantScope): DatevExportResult[] => {
  const tenantId = getTenantId(scope);
  const rows = db
    .prepare(
      `
      SELECT id, file_path, record_count, from_date, to_date, created_at
      FROM datev_exports
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `,
    )
    .all(tenantId) as Array<{
    id: string;
    file_path: string;
    record_count: number;
    from_date: string | null;
    to_date: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    recordCount: row.record_count,
    fromDate: row.from_date ?? undefined,
    toDate: row.to_date ?? undefined,
    createdAt: row.created_at,
  }));
};

export const insertDatevExport = (
  db: Database.Database,
  args: { filePath: string; recordCount: number; fromDate?: string; toDate?: string },
  scope: TenantScope,
): DatevExportResult => {
  const tenantId = getTenantId(scope);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO datev_exports (id, tenant_id, file_path, record_count, from_date, to_date, created_at, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(id, tenantId, args.filePath, args.recordCount, args.fromDate ?? null, args.toDate ?? null, createdAt, '{}');

  appendAuditLog(db, {
    entityType: 'pro_datev_export',
    entityId: id,
    action: 'export',
    reason: 'DATEV Buchungsstapel generated',
    before: null,
    after: {
      filePath: args.filePath,
      recordCount: args.recordCount,
      fromDate: args.fromDate ?? null,
      toDate: args.toDate ?? null,
    },
    actor: 'pro',
  });

  return {
    id,
    filePath: args.filePath,
    recordCount: args.recordCount,
    fromDate: args.fromDate,
    toDate: args.toDate,
    createdAt,
  };
};

export const getAccountingHealth = (
  db: Database.Database,
  scope: TenantScope,
): {
  draftCount: number;
  postedCount: number;
  reversedCount: number;
  unbalancedDraftCount: number;
  unmappedAccountCount: number;
  lastDatevExportAt?: string;
} => {
  const tenantId = getTenantId(scope);
  const draftCount = (db
    .prepare('SELECT COUNT(*) as c FROM booking_drafts WHERE tenant_id = ?')
    .get(tenantId) as { c: number }).c;
  const postedCount = (db
    .prepare("SELECT COUNT(*) as c FROM journal_entries WHERE tenant_id = ? AND status = 'posted'")
    .get(tenantId) as { c: number }).c;
  const reversedCount = (db
    .prepare("SELECT COUNT(*) as c FROM journal_entries WHERE tenant_id = ? AND status = 'reversed'")
    .get(tenantId) as { c: number }).c;
  const unbalancedDraftCount = (db
    .prepare("SELECT COUNT(*) as c FROM draft_validation_issues WHERE tenant_id = ? AND code = 'UNBALANCED_ENTRY'")
    .get(tenantId) as { c: number }).c;
  const unmappedAccountCount = (db
    .prepare(
      `
        SELECT COUNT(DISTINCT jl.account_number) as c
        FROM journal_lines jl
        LEFT JOIN account_mappings_hgb map
          ON map.tenant_id = jl.tenant_id
         AND map.account_number = jl.account_number
        WHERE jl.tenant_id = ?
          AND map.account_number IS NULL
      `,
    )
    .get(tenantId) as { c: number }).c;
  const lastDatevExport = db
    .prepare('SELECT created_at FROM datev_exports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId) as { created_at: string } | undefined;

  return {
    draftCount,
    postedCount,
    reversedCount,
    unbalancedDraftCount,
    unmappedAccountCount,
    lastDatevExportAt: lastDatevExport?.created_at,
  };
};

export const getVatSummary = (
  db: Database.Database,
  args: { from?: string; to?: string } = {},
  scope: TenantScope,
): {
  from?: string;
  to?: string;
  rows: Array<{
    taxCaseKey: TaxCaseKey;
    netAmount: number;
    taxAmount: number;
    grossAmount: number;
    lineCount: number;
  }>;
} => {
  const tenantId = getTenantId(scope);
  const rows = db
    .prepare(
      `
      SELECT
        jl.tax_case_key,
        SUM(COALESCE(jl.net_amount, 0)) AS net_amount,
        SUM(COALESCE(jl.tax_amount, 0)) AS tax_amount,
        SUM(COALESCE(jl.gross_amount, CASE WHEN jl.debit_amount > 0 THEN jl.debit_amount ELSE jl.credit_amount END)) AS gross_amount,
        COUNT(*) AS line_count
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.tenant_id = @tenantId
        AND je.tenant_id = @tenantId
        AND je.status = 'posted'
        AND jl.tax_case_key IS NOT NULL
        AND (@from IS NULL OR je.posting_date >= @from)
        AND (@to IS NULL OR je.posting_date <= @to)
      GROUP BY jl.tax_case_key
      ORDER BY jl.tax_case_key ASC
      `,
    )
    .all({
      tenantId,
      from: args.from ?? null,
      to: args.to ?? null,
    }) as Array<{
    tax_case_key: TaxCaseKey;
    net_amount: number;
    tax_amount: number;
    gross_amount: number;
    line_count: number;
  }>;

  return {
    from: args.from,
    to: args.to,
    rows: rows.map((row) => ({
      taxCaseKey: row.tax_case_key,
      netAmount: round2(Number(row.net_amount || 0)),
      taxAmount: round2(Number(row.tax_amount || 0)),
      grossAmount: round2(Number(row.gross_amount || 0)),
      lineCount: Number(row.line_count || 0),
    })),
  };
};

export const buildDatevRows = (
  db: Database.Database,
  args: { from?: string; to?: string } = {},
  scope: TenantScope,
): Array<{
  date: string;
  belegfeld1: string;
  buchungstext: string;
  konto: string;
  gegenkonto: string;
  sollHabenKennzeichen: 'S' | 'H';
  buSchluessel?: string;
  umsatz: number;
}> => {
  const tenantId = getTenantId(scope);
  const params = {
    tenantId,
    from: args.from ?? null,
    to: args.to ?? null,
  };
  const pairedRows = db
    .prepare(
      `
      SELECT
        je.posting_date,
        je.entry_number,
        je.booking_text,
        debit.account_number AS debit_account,
        credit.account_number AS credit_account,
        jpp.amount,
        jpp.datev_bu_key
      FROM journal_posting_pairs jpp
      INNER JOIN journal_entries je ON je.id = jpp.entry_id AND je.tenant_id = jpp.tenant_id
      INNER JOIN journal_lines debit ON debit.id = jpp.debit_line_id AND debit.entry_id = je.id
      INNER JOIN journal_lines credit ON credit.id = jpp.credit_line_id AND credit.entry_id = je.id
      WHERE jpp.tenant_id = @tenantId
        AND je.status = 'posted'
        AND (@from IS NULL OR je.posting_date >= @from)
        AND (@to IS NULL OR je.posting_date <= @to)
      ORDER BY je.posting_date ASC, je.entry_number ASC, jpp.id ASC
      `,
    )
    .all(params) as Array<{
    posting_date: string;
    entry_number: number;
    booking_text: string;
    debit_account: string;
    credit_account: string;
    amount: number;
    datev_bu_key: string | null;
  }>;

  if (pairedRows.length > 0) {
    return pairedRows.map((row) => ({
      date: row.posting_date,
      belegfeld1: String(row.entry_number),
      buchungstext: row.booking_text,
      konto: row.debit_account,
      gegenkonto: row.credit_account,
      sollHabenKennzeichen: 'S' as const,
      buSchluessel: row.datev_bu_key ?? undefined,
      umsatz: round2(Number(row.amount || 0)),
    }));
  }

  // Fallback for legacy entries without persisted posting pairs.
  return listJournalEntries(db, { from: args.from, to: args.to, limit: 100_000, offset: 0 }, scope)
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => {
      const debitLines = entry.lines.filter((line) => Number(line.debitAmount || 0) > 0);
      const creditLines = entry.lines.filter((line) => Number(line.creditAmount || 0) > 0);
      return debitLines.map((debitLine) => ({
        date: entry.postingDate,
        belegfeld1: String(entry.entryNumber),
        buchungstext: entry.bookingText,
        konto: debitLine.accountNumber,
        gegenkonto: creditLines[0]?.accountNumber ?? '',
        sollHabenKennzeichen: 'S' as const,
        buSchluessel: resolveDatevBuKeyForTaxCase(db, getActiveChart(db), debitLine.taxCaseKey ?? debitLine.taxCode),
        umsatz: round2(debitLine.debitAmount),
      }));
    });
};

export const ensureProAccountingSeedData = (db: Database.Database, scope: TenantScope): void => {
  const tenantId = getTenantId(scope);
  ensureTaxCaseSeedData(db);
  const now = new Date();
  const thisPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const prevPeriod = `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`;

  ensurePeriodExists(db, prevPeriod, Number(prevPeriod.slice(0, 4)), tenantId);
  ensurePeriodExists(db, thisPeriod, now.getFullYear(), tenantId);

  const bankCount = (db
    .prepare('SELECT COUNT(*) as c FROM bank_transactions WHERE tenant_id = ?')
    .get(tenantId) as { c: number }).c;

  if (bankCount === 0) {
    db.prepare(
      `
      INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at)
      SELECT
        t.id,
        ?,
        t.account_id,
        t.date,
        t.amount,
        CASE WHEN t.amount >= 0 THEN 'income' ELSE 'expense' END,
        t.counterparty,
        t.purpose,
        t.linked_invoice_id,
        t.status,
        t.id,
        COALESCE(t.date || 'T00:00:00.000Z', datetime('now')),
        datetime('now')
      FROM transactions t
      `,
    ).run(tenantId);
  }

  seedAccountKeywords(db, scope);
  ensureDefaultMappings(db, tenantId);
};
