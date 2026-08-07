import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, max, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
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
  const drizzle = createDrizzle(db);
  const existing = drizzle.select({ id: schema.accountingPeriods.id }).from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.tenantId, tenantId), eq(schema.accountingPeriods.period, period))).get();
  if (existing) return;

  const startsAt = `${period}-01`;
  const [yearStr, monthStr] = period.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const endDate = new Date(Date.UTC(year, month, 0));
  const endsAt = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  const now = new Date().toISOString();

  drizzle.insert(schema.accountingPeriods).values({ id: randomUUID(), tenantId, period, fiscalYear, status: 'open', startsAt, endsAt, createdAt: now, updatedAt: now }).run();
};

const loadPeriodStatus = (db: Database.Database, period: string, tenantId: string): AccountingPeriodStatus => {
  const row = createDrizzle(db).select({ status: schema.accountingPeriods.status }).from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.tenantId, tenantId), eq(schema.accountingPeriods.period, period))).get() as { status: AccountingPeriodStatus } | undefined;
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
  const row = createDrizzle(db).select({ n: max(schema.journalEntries.entryNumber) }).from(schema.journalEntries)
    .where(eq(schema.journalEntries.tenantId, tenantId)).get();
  return Number(row?.n || 0) + 1;
};

const saveDraftLinesAndIssues = (db: Database.Database, draft: BookingDraftEntity): void => {
  const drizzle = createDrizzle(db);
  drizzle.delete(schema.bookingDraftLines).where(eq(schema.bookingDraftLines.draftId, draft.id)).run();
  drizzle.delete(schema.draftValidationIssues).where(eq(schema.draftValidationIssues.draftId, draft.id)).run();

  draft.lines.forEach((line, idx) => {
    drizzle.insert(schema.bookingDraftLines).values({ id: line.id || randomUUID(), tenantId: draft.tenantId, draftId: draft.id, lineNo: idx + 1, accountNumber: line.accountNumber, debitAmount: round2(line.debitAmount), creditAmount: round2(line.creditAmount), taxCode: line.taxCode ?? null, taxCaseKey: line.taxCaseKey ?? null, taxRate: line.taxRate ?? null, netAmount: line.netAmount ?? null, taxAmount: line.taxAmount ?? null, grossAmount: line.grossAmount ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, costCenter: line.costCenter ?? null, memo: line.memo ?? null }).run();
  });

  const now = new Date().toISOString();
  for (const issue of draft.validationIssues) {
    drizzle.insert(schema.draftValidationIssues).values({ id: issue.id || randomUUID(), tenantId: draft.tenantId, draftId: draft.id, code: issue.code, severity: issue.severity, message: issue.message, fieldPath: issue.fieldPath ?? null, blocking: issue.blocking ? 1 : 0, source: issue.source, issueJson: JSON.stringify(issue), createdAt: now }).run();
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
  const rows = createDrizzle(db).select({ chart: schema.ledgerAccounts.chart, c: count() })
    .from(schema.ledgerAccounts).groupBy(schema.ledgerAccounts.chart).all() as Array<{ chart: string; c: number }>;
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
  const drizzle = createDrizzle(db);
  const preferredRow = drizzle.select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .where(and(eq(schema.ledgerAccounts.chart, chart), eq(schema.ledgerAccounts.accountNumber, preferred))).limit(1).get();
  if (preferredRow?.account_number) return preferredRow.account_number;

  const chartRow = drizzle.select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.chart, chart)).orderBy(asc(schema.ledgerAccounts.accountNumber)).limit(1).get();
  if (chartRow?.account_number) return chartRow.account_number;

  const anyRow = drizzle.select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).limit(1).get();
  if (anyRow?.account_number) return anyRow.account_number;

  return preferred;
};

const resolveBankLedgerAccountForTransaction = (
  db: Database.Database,
  tx: ProBankTransaction,
): string => {
  const activeChart = getActiveChart(db);
  const row = createDrizzle(db).select({ default_skr_account_number: schema.accounts.defaultSkrAccountNumber }).from(schema.accounts)
    .where(eq(schema.accounts.id, tx.accountId)).limit(1).get() as { default_skr_account_number: string | null } | undefined;

  const candidate = String(row?.default_skr_account_number ?? '').trim();
  if (!candidate) {
    return resolveFallbackBankLedgerAccount(db, activeChart);
  }

  const exists = createDrizzle(db).select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.accountNumber, candidate)).limit(1).get();

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
  const rows = createDrizzle(db).select({
    id: schema.bankTransactions.id,
    tenant_id: schema.bankTransactions.tenantId,
    account_id: schema.bankTransactions.accountId,
    date: schema.bankTransactions.date,
    amount: schema.bankTransactions.amount,
    type: schema.bankTransactions.type,
    counterparty: schema.bankTransactions.counterparty,
    purpose: schema.bankTransactions.purpose,
    status: schema.bankTransactions.status,
    linked_invoice_id: schema.bankTransactions.linkedInvoiceId,
  }).from(schema.bankTransactions).where(eq(schema.bankTransactions.tenantId, tenantId))
    .orderBy(desc(schema.bankTransactions.date), asc(schema.bankTransactions.id)).all() as Array<{
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
  const row = createDrizzle(db).select({ draft_json: schema.bookingDrafts.draftJson, updated_at: schema.bookingDrafts.updatedAt })
    .from(schema.bookingDrafts).where(and(eq(schema.bookingDrafts.tenantId, tenantId), eq(schema.bookingDrafts.transactionId, transactionId))).get() as { draft_json: string; updated_at: string } | undefined;

  if (row) {
    return parseDraftRow(row, tenantId);
  }

  const txRow = createDrizzle(db).select({
    id: schema.bankTransactions.id,
    tenant_id: schema.bankTransactions.tenantId,
    account_id: schema.bankTransactions.accountId,
    date: schema.bankTransactions.date,
    amount: schema.bankTransactions.amount,
    type: schema.bankTransactions.type,
    counterparty: schema.bankTransactions.counterparty,
    purpose: schema.bankTransactions.purpose,
    status: schema.bankTransactions.status,
    linked_invoice_id: schema.bankTransactions.linkedInvoiceId,
  }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.tenantId, tenantId), eq(schema.bankTransactions.id, transactionId))).get() as
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

  createDrizzle(db).insert(schema.bookingDrafts).values({ id: normalized.id, tenantId, transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus, draftJson: JSON.stringify(normalized), updatedAt: now })
    .onConflictDoUpdate({ target: schema.bookingDrafts.id, set: { transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus, draftJson: JSON.stringify(normalized), updatedAt: now } }).run();

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
    const row = createDrizzle(db).select({ draft_json: schema.bookingDrafts.draftJson }).from(schema.bookingDrafts)
      .where(and(eq(schema.bookingDrafts.tenantId, tenantId), eq(schema.bookingDrafts.id, args.draftId))).get() as { draft_json: string } | undefined;
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
  const row = createDrizzle(db).select({ draft_json: schema.bookingDrafts.draftJson }).from(schema.bookingDrafts)
    .where(and(eq(schema.bookingDrafts.tenantId, tenantId), eq(schema.bookingDrafts.id, draftId))).get() as { draft_json: string } | undefined;

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
    const drizzle = createDrizzle(db);
    drizzle.insert(schema.journalEntries).values({ id: entryId, tenantId, entryNumber, postingDate, documentDate: validated.documentDate ?? null, bookingText: validated.bookingText, reference: validated.reference ?? null, period, fiscalYear, status: 'posted', sourceDraftId: validated.id, reversedEntryId: null, createdAt }).run();

    postingLines.forEach((line, idx) => {
      drizzle.insert(schema.journalLines).values({ id: line.id, tenantId, entryId, lineNo: idx + 1, accountNumber: line.accountNumber, debitAmount: round2(line.debitAmount), creditAmount: round2(line.creditAmount), taxCode: line.taxCode ?? null, taxCaseKey: line.taxCaseKey ?? null, taxRate: line.taxRate ?? null, netAmount: line.netAmount ?? null, taxAmount: line.taxAmount ?? null, grossAmount: line.grossAmount ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, costCenter: line.costCenter ?? null, memo: line.memo ?? null }).run();
    });

    for (const line of postingLines) {
      const taxCase = getTaxCaseByKey(db, line.taxCaseKey ?? line.taxCode);
      if (!taxCase) continue;
      const hasEvidence = Boolean(line.evidenceType || line.evidenceReference || line.countryCode || line.counterpartyVatId);
      if (!taxCase.requiresEvidence && !hasEvidence) continue;
      drizzle.insert(schema.vatEvidence).values({ id: randomUUID(), tenantId, draftId: validated.id, entryId, lineId: line.id, taxCaseKey: taxCase.key, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, capturedAt: createdAt }).run();
    }

    for (const pair of buildPostingPairs(postingLines)) {
      const datevBuKey = resolveDatevBuKeyForTaxCase(db, chart, pair.taxCaseKey);
      drizzle.insert(schema.journalPostingPairs).values({ id: randomUUID(), tenantId, entryId, debitLineId: pair.debitLineId, creditLineId: pair.creditLineId, amount: round2(pair.amount), taxCaseKey: pair.taxCaseKey ?? null, datevBuKey: datevBuKey ?? null, createdAt }).run();
    }

    drizzle.update(schema.bookingDrafts).set({ workflowStatus: 'posted', updatedAt: createdAt }).where(and(eq(schema.bookingDrafts.id, validated.id), eq(schema.bookingDrafts.tenantId, tenantId))).run();
    drizzle.update(schema.bankTransactions).set({ status: 'booked', updatedAt: createdAt }).where(and(eq(schema.bankTransactions.id, validated.transactionId), eq(schema.bankTransactions.tenantId, tenantId))).run();

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
  const drizzle = createDrizzle(db);
  const entry = drizzle.select({
    id: schema.journalEntries.id, entry_number: schema.journalEntries.entryNumber,
    posting_date: schema.journalEntries.postingDate, document_date: schema.journalEntries.documentDate,
    booking_text: schema.journalEntries.bookingText, reference: schema.journalEntries.reference,
    period: schema.journalEntries.period, fiscal_year: schema.journalEntries.fiscalYear,
    status: schema.journalEntries.status,
  }).from(schema.journalEntries).where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.id, entryId))).get() as
    | { id: string; entry_number: number; posting_date: string; document_date: string | null; booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string }
    | undefined;

  if (!entry) {
    throw new Error('Journal entry not found');
  }
  if (entry.status === 'reversed') {
    throw new Error('Journal entry already reversed');
  }

  const lineSelect = {
    id: schema.journalLines.id, account_number: schema.journalLines.accountNumber,
    debit_amount: schema.journalLines.debitAmount, credit_amount: schema.journalLines.creditAmount,
    tax_code: schema.journalLines.taxCode, tax_case_key: schema.journalLines.taxCaseKey,
    tax_rate: schema.journalLines.taxRate, net_amount: schema.journalLines.netAmount,
    tax_amount: schema.journalLines.taxAmount, gross_amount: schema.journalLines.grossAmount,
    country_code: schema.journalLines.countryCode, counterparty_vat_id: schema.journalLines.counterpartyVatId,
    evidence_type: schema.journalLines.evidenceType, evidence_reference: schema.journalLines.evidenceReference,
    cost_center: schema.journalLines.costCenter, memo: schema.journalLines.memo,
  };
  const lines = drizzle.select(lineSelect).from(schema.journalLines)
    .where(and(eq(schema.journalLines.tenantId, tenantId), eq(schema.journalLines.entryId, entryId)))
    .orderBy(asc(schema.journalLines.lineNo)).all() as Array<{
      id: string; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null;
      tax_case_key: TaxCaseKey | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null;
      gross_amount: number | null; country_code: string | null; counterparty_vat_id: string | null;
      evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null;
    }>;

  const reversalEntryId = randomUUID();
  const reversalNumber = getNextEntryNumber(db, tenantId);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const txDrizzle = createDrizzle(db);
    txDrizzle.insert(schema.journalEntries).values({ id: reversalEntryId, tenantId, entryNumber: reversalNumber,
      postingDate: now.slice(0, 10), documentDate: entry.document_date, bookingText: `Storno ${entry.entry_number}: ${entry.booking_text}`,
      reference: reason, period: entry.period, fiscalYear: entry.fiscal_year, status: 'posted', sourceDraftId: null,
      reversedEntryId: entryId, createdAt: now }).run();

    lines.forEach((line, idx) => {
      txDrizzle.insert(schema.journalLines).values({ id: randomUUID(), tenantId, entryId: reversalEntryId, lineNo: idx + 1,
        accountNumber: line.account_number, debitAmount: round2(Number(line.credit_amount || 0)), creditAmount: round2(Number(line.debit_amount || 0)),
        taxCode: line.tax_code, taxCaseKey: line.tax_case_key, taxRate: line.tax_rate, netAmount: line.net_amount,
        taxAmount: line.tax_amount, grossAmount: line.gross_amount, countryCode: line.country_code,
        counterpartyVatId: line.counterparty_vat_id, evidenceType: line.evidence_type, evidenceReference: line.evidence_reference,
        costCenter: line.cost_center, memo: line.memo }).run();
    });

    const reversalLines = txDrizzle.select(lineSelect).from(schema.journalLines)
      .where(and(eq(schema.journalLines.tenantId, tenantId), eq(schema.journalLines.entryId, reversalEntryId)))
      .orderBy(asc(schema.journalLines.lineNo)).all() as typeof lines;
    const chart = getActiveChart(db);
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
      txDrizzle.insert(schema.journalPostingPairs).values({ id: randomUUID(), tenantId, entryId: reversalEntryId,
        debitLineId: pair.debitLineId, creditLineId: pair.creditLineId, amount: round2(pair.amount),
        taxCaseKey: pair.taxCaseKey ?? null, datevBuKey: datevBuKey ?? null, createdAt: now }).run();
    }

    txDrizzle.update(schema.journalEntries).set({ status: 'reversed', reversedEntryId: reversalEntryId })
      .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.id, entryId))).run();

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
  const drizzle = createDrizzle(db);
  const conditions = [eq(schema.journalEntries.tenantId, tenantId)];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  if (args.accountNumbers?.length) {
    const matching = drizzle.select({ entryId: schema.journalLines.entryId }).from(schema.journalLines)
      .where(and(eq(schema.journalLines.tenantId, tenantId), inArray(schema.journalLines.accountNumber, args.accountNumbers))).all();
    const ids = [...new Set(matching.map((row) => row.entryId))];
    if (ids.length === 0) return [];
    conditions.push(inArray(schema.journalEntries.id, ids));
  }
  const rows = drizzle.select({
    id: schema.journalEntries.id, tenant_id: schema.journalEntries.tenantId, entry_number: schema.journalEntries.entryNumber,
    posting_date: schema.journalEntries.postingDate, document_date: schema.journalEntries.documentDate,
    booking_text: schema.journalEntries.bookingText, reference: schema.journalEntries.reference,
    period: schema.journalEntries.period, fiscal_year: schema.journalEntries.fiscalYear, status: schema.journalEntries.status,
    source_draft_id: schema.journalEntries.sourceDraftId, reversed_entry_id: schema.journalEntries.reversedEntryId,
    created_at: schema.journalEntries.createdAt,
  }).from(schema.journalEntries).where(and(...conditions))
    .orderBy(desc(schema.journalEntries.postingDate), desc(schema.journalEntries.entryNumber))
    .limit(Math.max(1, Math.min(5000, Math.floor(args.limit ?? 500))))
    .offset(Math.max(0, Math.floor(args.offset ?? 0))).all() as Array<{
      id: string; tenant_id: string; entry_number: number; posting_date: string; document_date: string | null;
      booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string;
      source_draft_id: string | null; reversed_entry_id: string | null; created_at: string;
    }>;

  const getLines = (entryId: string) => drizzle.select({
    id: schema.journalLines.id, account_number: schema.journalLines.accountNumber,
    debit_amount: schema.journalLines.debitAmount, credit_amount: schema.journalLines.creditAmount,
    tax_code: schema.journalLines.taxCode, tax_case_key: schema.journalLines.taxCaseKey,
    tax_rate: schema.journalLines.taxRate, net_amount: schema.journalLines.netAmount, tax_amount: schema.journalLines.taxAmount,
    gross_amount: schema.journalLines.grossAmount, country_code: schema.journalLines.countryCode,
    counterparty_vat_id: schema.journalLines.counterpartyVatId, evidence_type: schema.journalLines.evidenceType,
    evidence_reference: schema.journalLines.evidenceReference, cost_center: schema.journalLines.costCenter,
    memo: schema.journalLines.memo,
  }).from(schema.journalLines).where(and(eq(schema.journalLines.tenantId, tenantId), eq(schema.journalLines.entryId, entryId)))
    .orderBy(asc(schema.journalLines.lineNo)).all() as Array<{
      id: string; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null;
      tax_case_key: TaxCaseKey | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null;
      gross_amount: number | null; country_code: string | null; counterparty_vat_id: string | null;
      evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null;
    }>;

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
    lines: getLines(row.id).map((line) => ({
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
  const drizzle = createDrizzle(db);
  const conditions = [eq(schema.journalLines.tenantId, tenantId), eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.status, 'posted')];
  if (args.asOfDate) conditions.push(lte(schema.journalEntries.postingDate, args.asOfDate));
  const rows = drizzle.select({ account_number: schema.journalLines.accountNumber,
    debit_turnover: sum(schema.journalLines.debitAmount), credit_turnover: sum(schema.journalLines.creditAmount) })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(...conditions)).groupBy(schema.journalLines.accountNumber).orderBy(asc(schema.journalLines.accountNumber)).all() as Array<{
      account_number: string; debit_turnover: number | null; credit_turnover: number | null;
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
  const drizzle = createDrizzle(db);
  const row = drizzle.select({ c: count() }).from(schema.accountMappingsHgb)
    .where(eq(schema.accountMappingsHgb.tenantId, tenantId)).get() as { c: number };
  if (row.c > 0) return;

  const accounts = drizzle.select({ chart: schema.ledgerAccounts.chart, account_number: schema.ledgerAccounts.accountNumber })
    .from(schema.ledgerAccounts).orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).all() as Array<{ chart: string; account_number: string }>;
  if (!accounts.length) return;

  const now = new Date().toISOString();
  const insert = (values: typeof schema.accountMappingsHgb['$inferInsert']) => drizzle.insert(schema.accountMappingsHgb).values(values)
    .onConflictDoUpdate({ target: [schema.accountMappingsHgb.tenantId, schema.accountMappingsHgb.chart,
      schema.accountMappingsHgb.accountNumber, schema.accountMappingsHgb.statementType],
      set: { positionKey: values.positionKey, positionLabel: values.positionLabel, balanceSide: values.balanceSide ?? null, updatedAt: now } }).run();

  for (const account of accounts) {
    const first = account.account_number[0] ?? '';
    if (['8', '9'].includes(first)) {
      insert({ id: randomUUID(), tenantId, chart: account.chart, accountNumber: account.account_number, statementType: 'guv',
        positionKey: 'revenue', positionLabel: 'Umsatzerloese', balanceSide: null, updatedAt: now });
    } else if (['4', '5', '6', '7'].includes(first)) {
      insert({ id: randomUUID(), tenantId, chart: account.chart, accountNumber: account.account_number, statementType: 'guv',
        positionKey: 'expense', positionLabel: 'Aufwendungen', balanceSide: null, updatedAt: now });
    }

    if (['0', '1'].includes(first)) {
      insert({ id: randomUUID(), tenantId, chart: account.chart, accountNumber: account.account_number, statementType: 'bilanz',
        positionKey: 'assets', positionLabel: 'Aktiva', balanceSide: 'asset', updatedAt: now });
    } else if (['2', '3'].includes(first)) {
      insert({ id: randomUUID(), tenantId, chart: account.chart, accountNumber: account.account_number, statementType: 'bilanz',
        positionKey: 'liabilities', positionLabel: 'Passiva', balanceSide: 'liability', updatedAt: now });
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

  const conditions = [eq(schema.journalLines.tenantId, tenantId), eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.status, 'posted'), eq(schema.accountMappingsHgb.tenantId, tenantId), eq(schema.accountMappingsHgb.statementType, 'guv')];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  const sourceRows = createDrizzle(db).select({ position_key: schema.accountMappingsHgb.positionKey,
    position_label: schema.accountMappingsHgb.positionLabel, debit: schema.journalLines.debitAmount, credit: schema.journalLines.creditAmount })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .innerJoin(schema.accountMappingsHgb, and(eq(schema.accountMappingsHgb.accountNumber, schema.journalLines.accountNumber),
      eq(schema.accountMappingsHgb.tenantId, schema.journalLines.tenantId), eq(schema.accountMappingsHgb.statementType, 'guv')))
    .where(and(...conditions)).all();
  const grouped = new Map<string, { position_key: string; position_label: string; amount: number }>();
  for (const row of sourceRows) {
    const key = row.position_key;
    const current = grouped.get(key) ?? { position_key: key, position_label: row.position_label, amount: 0 };
    current.amount += Number(row.credit ?? 0) - Number(row.debit ?? 0);
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].sort((a, b) => a.position_key.localeCompare(b.position_key));

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

  const conditions = [eq(schema.journalLines.tenantId, tenantId), eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.status, 'posted'), eq(schema.accountMappingsHgb.tenantId, tenantId), eq(schema.accountMappingsHgb.statementType, 'bilanz')];
  if (args.asOfDate) conditions.push(lte(schema.journalEntries.postingDate, args.asOfDate));
  const sourceRows = createDrizzle(db).select({ balance_side: schema.accountMappingsHgb.balanceSide,
    account_number: schema.journalLines.accountNumber, debit: schema.journalLines.debitAmount, credit: schema.journalLines.creditAmount })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .innerJoin(schema.accountMappingsHgb, and(eq(schema.accountMappingsHgb.accountNumber, schema.journalLines.accountNumber),
      eq(schema.accountMappingsHgb.tenantId, schema.journalLines.tenantId), eq(schema.accountMappingsHgb.statementType, 'bilanz')))
    .where(and(...conditions)).all();
  const grouped = new Map<string, { balance_side: 'asset' | 'liability' | null; account_number: string; amount: number }>();
  for (const row of sourceRows) {
    const key = row.account_number;
    const current = grouped.get(key) ?? { balance_side: row.balance_side as 'asset' | 'liability' | null, account_number: key, amount: 0 };
    current.amount += Number(row.debit ?? 0) - Number(row.credit ?? 0);
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].sort((a, b) => a.account_number.localeCompare(b.account_number));

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
  const rows = createDrizzle(db).select({ id: schema.datevExports.id, file_path: schema.datevExports.filePath,
    record_count: schema.datevExports.recordCount, from_date: schema.datevExports.fromDate,
    to_date: schema.datevExports.toDate, created_at: schema.datevExports.createdAt }).from(schema.datevExports)
    .where(eq(schema.datevExports.tenantId, tenantId)).orderBy(desc(schema.datevExports.createdAt)).all() as Array<{
      id: string; file_path: string; record_count: number; from_date: string | null; to_date: string | null; created_at: string;
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
  createDrizzle(db).insert(schema.datevExports).values({ id, tenantId, filePath: args.filePath, recordCount: args.recordCount,
    fromDate: args.fromDate ?? null, toDate: args.toDate ?? null, createdAt, metaJson: '{}' }).run();

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
  const drizzle = createDrizzle(db);
  const draftCount = Number(drizzle.select({ c: count() }).from(schema.bookingDrafts)
    .where(eq(schema.bookingDrafts.tenantId, tenantId)).get()?.c ?? 0);
  const postedCount = Number(drizzle.select({ c: count() }).from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.status, 'posted'))).get()?.c ?? 0);
  const reversedCount = Number(drizzle.select({ c: count() }).from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.status, 'reversed'))).get()?.c ?? 0);
  const unbalancedDraftCount = Number(drizzle.select({ c: count() }).from(schema.draftValidationIssues)
    .where(and(eq(schema.draftValidationIssues.tenantId, tenantId), eq(schema.draftValidationIssues.code, 'UNBALANCED_ENTRY'))).get()?.c ?? 0);
  const lineAccounts = new Set(drizzle.select({ accountNumber: schema.journalLines.accountNumber }).from(schema.journalLines)
    .where(eq(schema.journalLines.tenantId, tenantId)).all().map((row) => row.accountNumber));
  const mappedAccounts = new Set(drizzle.select({ accountNumber: schema.accountMappingsHgb.accountNumber }).from(schema.accountMappingsHgb)
    .where(eq(schema.accountMappingsHgb.tenantId, tenantId)).all().map((row) => row.accountNumber));
  const unmappedAccountCount = [...lineAccounts].filter((accountNumber) => !mappedAccounts.has(accountNumber)).length;
  const lastDatevExport = drizzle.select({ created_at: schema.datevExports.createdAt }).from(schema.datevExports)
    .where(eq(schema.datevExports.tenantId, tenantId)).orderBy(desc(schema.datevExports.createdAt)).limit(1).get() as { created_at: string } | undefined;

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
  const conditions = [eq(schema.journalLines.tenantId, tenantId), eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.status, 'posted'), isNotNull(schema.journalLines.taxCaseKey)];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  const sourceRows = createDrizzle(db).select({ tax_case_key: schema.journalLines.taxCaseKey,
    net: schema.journalLines.netAmount, tax: schema.journalLines.taxAmount, gross: schema.journalLines.grossAmount,
    debit: schema.journalLines.debitAmount, credit: schema.journalLines.creditAmount })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(...conditions)).all();
  const grouped = new Map<string, { tax_case_key: TaxCaseKey; net_amount: number; tax_amount: number; gross_amount: number; line_count: number }>();
  for (const row of sourceRows) {
    if (!row.tax_case_key) continue;
    const current = grouped.get(row.tax_case_key) ?? { tax_case_key: row.tax_case_key as TaxCaseKey, net_amount: 0, tax_amount: 0, gross_amount: 0, line_count: 0 };
    current.net_amount += Number(row.net ?? 0);
    current.tax_amount += Number(row.tax ?? 0);
    current.gross_amount += Number(row.gross ?? (Number(row.debit ?? 0) > 0 ? row.debit : row.credit) ?? 0);
    current.line_count += 1;
    grouped.set(row.tax_case_key, current);
  }
  const rows = [...grouped.values()].sort((a, b) => a.tax_case_key.localeCompare(b.tax_case_key));

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
  const conditions = [eq(schema.journalPostingPairs.tenantId, tenantId), eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.status, 'posted')];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  const debit = alias(schema.journalLines, 'debit');
  const credit = alias(schema.journalLines, 'credit');
  const pairedRows = createDrizzle(db).select({ posting_date: schema.journalEntries.postingDate,
    entry_number: schema.journalEntries.entryNumber, booking_text: schema.journalEntries.bookingText,
    debit_account: debit.accountNumber, credit_account: credit.accountNumber,
    amount: schema.journalPostingPairs.amount, datev_bu_key: schema.journalPostingPairs.datevBuKey })
    .from(schema.journalPostingPairs).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalPostingPairs.entryId))
    .innerJoin(debit, eq(debit.id, schema.journalPostingPairs.debitLineId))
    .innerJoin(credit, eq(credit.id, schema.journalPostingPairs.creditLineId))
    .where(and(...conditions)).orderBy(asc(schema.journalEntries.postingDate), asc(schema.journalEntries.entryNumber), asc(schema.journalPostingPairs.id)).all() as Array<{
      posting_date: string; entry_number: number; booking_text: string; debit_account: string; credit_account: string;
      amount: number; datev_bu_key: string | null;
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

  const drizzle = createDrizzle(db);
  const bankCount = Number(drizzle.select({ c: count() }).from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.tenantId, tenantId)).get()?.c ?? 0);

  if (bankCount === 0) {
    const sourceTransactions = drizzle.select().from(schema.transactions).all();
    for (const transaction of sourceTransactions) {
      const createdAt = `${transaction.date}T00:00:00.000Z`;
      drizzle.insert(schema.bankTransactions).values({ id: transaction.id, tenantId, accountId: transaction.accountId,
        date: transaction.date, amount: transaction.amount, type: Number(transaction.amount) >= 0 ? 'income' : 'expense',
        counterparty: transaction.counterparty, purpose: transaction.purpose, linkedInvoiceId: transaction.linkedInvoiceId,
        status: transaction.status, sourceTransactionId: transaction.id, createdAt, updatedAt: createdAt }).onConflictDoNothing().run();
    }
  }

  seedAccountKeywords(db, scope);
  ensureDefaultMappings(db, tenantId);
};
