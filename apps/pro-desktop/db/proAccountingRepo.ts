import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, max, or, sum } from 'drizzle-orm';
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
import { DATEV_MAX_ROWS } from '../services/datevExport';
import {
  ensureTaxCaseSeedData,
  getTaxCaseByKey,
  listTaxCaseAccountMappings,
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
  datevSachverhaltLl?: string;
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
  sourceType?: 'booking_draft' | 'reversal' | 'depreciation' | 'manual' | 'outgoing_invoice' | 'incoming_invoice' | 'payment' | 'payment_vat' | 'legacy_transaction' | 'asset_activation' | 'asset_depreciation' | 'asset_disposal';
  sourceKey?: string;
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
  sha256?: string;
  byteSize?: number;
  encoding?: 'cp1252' | 'utf8-bom';
  headerVersion?: number;
  formatVersion?: number;
  chart?: 'SKR03' | 'SKR04';
  sourceSnapshotHash?: string;
  manifestJson?: string;
  status?: string;
  validationJson?: string;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const toCents = (value: unknown): number | null => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount - cents / 100) <= 1e-9 ? cents : null;
};

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
};

const periodForDate = (date: string): string => date.slice(0, 7);

const isPeriod = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

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
  if (!isPeriod(period) || fiscalYear !== Number(period.slice(0, 4))) {
    throw new Error('Invalid accounting period');
  }
  const drizzle = createDrizzle(db);
  const existing = drizzle.select({ id: schema.accountingPeriods.id, fiscalYear: schema.accountingPeriods.fiscalYear }).from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.tenantId, tenantId), eq(schema.accountingPeriods.period, period))).get();
  if (existing) {
    if (existing.fiscalYear !== fiscalYear) throw new Error('Accounting period fiscal year mismatch');
    return;
  }

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
  const debit = draft.lines.reduce((total, line) => total + (toCents(line.debitAmount) ?? 0), 0);
  const credit = draft.lines.reduce((total, line) => total + (toCents(line.creditAmount) ?? 0), 0);

  if (draft.postingDate === undefined || !isIsoDate(draft.postingDate)) {
    issues.push({ id: randomUUID(), code: 'INVALID_POSTING_DATE', severity: 'error', message: 'Buchungsdatum muss ein gültiges Datum (YYYY-MM-DD) sein.', fieldPath: 'postingDate', blocking: true, source: 'system' });
  } else if (draft.period !== periodForDate(draft.postingDate) || draft.fiscalYear !== Number(draft.postingDate.slice(0, 4))) {
    issues.push({ id: randomUUID(), code: 'POSTING_PERIOD_MISMATCH', severity: 'error', message: 'Periode und Geschäftsjahr müssen aus dem Buchungsdatum abgeleitet werden.', fieldPath: 'period', blocking: true, source: 'system' });
  }
  if (draft.documentDate !== undefined && !isIsoDate(draft.documentDate)) {
    issues.push({ id: randomUUID(), code: 'INVALID_DOCUMENT_DATE', severity: 'error', message: 'Belegdatum muss ein gültiges Datum (YYYY-MM-DD) sein.', fieldPath: 'documentDate', blocking: true, source: 'system' });
  }
  if (!isPeriod(draft.period) || draft.fiscalYear !== Number(draft.period.slice(0, 4))) {
    issues.push({ id: randomUUID(), code: 'INVALID_PERIOD', severity: 'error', message: 'Periode oder Geschäftsjahr ist ungültig.', fieldPath: 'period', blocking: true, source: 'system' });
  }

  if (debit !== credit) {
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

  const lineIds = new Set<string>();
  draft.lines.forEach((line, idx) => {
    const debitCents = toCents(line.debitAmount);
    const creditCents = toCents(line.creditAmount);
    if (!line.accountNumber) {
      issues.push({ id: randomUUID(), code: 'MISSING_ACCOUNT', severity: 'error', message: 'Sachkonto fehlt.', fieldPath: `lines[${idx}].accountNumber`, blocking: true, source: 'system' });
    } else if (lineIds.has(line.id)) {
      issues.push({ id: randomUUID(), code: 'DUPLICATE_LINE_ID', severity: 'error', message: 'Buchungszeilen müssen eindeutige IDs haben.', fieldPath: `lines[${idx}].id`, blocking: true, source: 'system' });
    } else {
      const accountExists = createDrizzle(db).select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.chart, chart), eq(schema.ledgerAccounts.accountNumber, line.accountNumber))).get();
      const chartHasAccounts = createDrizzle(db).select({ c: count() }).from(schema.ledgerAccounts)
        .where(eq(schema.ledgerAccounts.chart, chart)).get()?.c ?? 0;
      if (Number(chartHasAccounts) > 0 && !accountExists) {
        issues.push({ id: randomUUID(), code: 'UNKNOWN_ACCOUNT', severity: 'error', message: `Sachkonto ${line.accountNumber} ist im aktiven Kontenrahmen nicht vorhanden.`, fieldPath: `lines[${idx}].accountNumber`, blocking: true, source: 'system' });
      }
    }
    if (line.id) lineIds.add(line.id);
    if (debitCents === null || creditCents === null || debitCents < 0 || creditCents < 0) {
      issues.push({ id: randomUUID(), code: 'INVALID_LINE_AMOUNT', severity: 'error', message: 'Beträge müssen endliche, nichtnegative Centbeträge sein.', fieldPath: `lines[${idx}]`, blocking: true, source: 'system' });
    } else if ((debitCents > 0) === (creditCents > 0)) {
      issues.push({ id: randomUUID(), code: 'INVALID_LINE_SIDE', severity: 'error', message: 'Jede Buchungszeile muss genau eine Soll- oder Habenseite enthalten.', fieldPath: `lines[${idx}]`, blocking: true, source: 'system' });
    }
    if ((debitCents ?? 0) + (creditCents ?? 0) <= 0) return;

    const taxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
    const isPnl = line.accountNumber.startsWith('4') || line.accountNumber.startsWith('8');
    if (isPnl && !taxCaseKey && line.evidenceType !== 'asset_depreciation') {
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

export const getAccountingPolicy = (db: Database.Database, tenantId = 'default') => {
  const row = createDrizzle(db).select({
    tenantId: schema.accountingPolicies.tenantId,
    activeChart: schema.accountingPolicies.activeChart,
    vatMethod: schema.accountingPolicies.vatMethod,
    periodPolicy: schema.accountingPolicies.periodPolicy,
    updatedAt: schema.accountingPolicies.updatedAt,
  }).from(schema.accountingPolicies).where(eq(schema.accountingPolicies.tenantId, tenantId)).get() as {
    tenantId: string;
    activeChart: 'SKR03' | 'SKR04';
    vatMethod: 'soll' | 'ist';
    periodPolicy: 'calendar_month';
    updatedAt: string;
  } | undefined;
  return row ?? { tenantId, activeChart: 'SKR03' as const, vatMethod: 'soll' as const, periodPolicy: 'calendar_month' as const, updatedAt: '' };
};

export const setAccountingPolicy = (
  db: Database.Database,
  policy: { activeChart: 'SKR03' | 'SKR04'; vatMethod?: 'soll' | 'ist'; periodPolicy?: 'calendar_month' },
  scope: TenantScope,
) => {
  const tenantId = getTenantId(scope);
  const updatedAt = new Date().toISOString();
  const vatMethod = policy.vatMethod ?? getAccountingPolicy(db, tenantId).vatMethod;
  createDrizzle(db).insert(schema.accountingPolicies).values({
    tenantId,
    activeChart: policy.activeChart,
    vatMethod,
    periodPolicy: policy.periodPolicy ?? 'calendar_month',
    updatedAt,
  }).onConflictDoUpdate({
    target: schema.accountingPolicies.tenantId,
    set: { activeChart: policy.activeChart, vatMethod, periodPolicy: policy.periodPolicy ?? 'calendar_month', updatedAt },
  }).run();
  return getAccountingPolicy(db, tenantId);
};

const getActiveChart = (db: Database.Database, tenantId: string): 'SKR03' | 'SKR04' => {
  const configured = getAccountingPolicy(db, tenantId).activeChart;
  const configuredCount = createDrizzle(db).select({ c: count() }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.chart, configured)).get()?.c ?? 0;
  if (Number(configuredCount) > 0) return configured;

  // Legacy installs may not have imported a chart yet; retain deterministic
  // fallback instead of changing chart based on row counts.
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

const getPostingChart = (db: Database.Database, tenantId: string): 'SKR03' | 'SKR04' | null => {
  const chart = getAccountingPolicy(db, tenantId).activeChart;
  const countForChart = createDrizzle(db).select({ c: count() }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.chart, chart)).get()?.c ?? 0;
  return Number(countForChart) > 0 ? chart : null;
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
  const activeChart = getActiveChart(db, tx.tenantId);
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
  const chart = getActiveChart(db, tenantId);
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
  }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.tenantId, tenantId), or(isNull(schema.bankTransactions.deletedAt), eq(schema.bankTransactions.deletedAt, ''))))
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
  }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.tenantId, tenantId), eq(schema.bankTransactions.id, transactionId), or(isNull(schema.bankTransactions.deletedAt), eq(schema.bankTransactions.deletedAt, '')))).get() as
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
  const chart = getActiveChart(db, tenantId);
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

  db.transaction(() => {
    createDrizzle(db).insert(schema.bookingDrafts).values({ id: normalized.id, tenantId, transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus, draftJson: JSON.stringify(normalized), updatedAt: now })
      .onConflictDoUpdate({ target: schema.bookingDrafts.id, set: { transactionId: normalized.transactionId, workflowStatus: normalized.workflowStatus, draftJson: JSON.stringify(normalized), updatedAt: now } }).run();
    saveDraftLinesAndIssues(db, normalized);
  })();
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
  const transitions: Record<BookingDraftEntity['workflowStatus'], BookingDraftEntity['workflowStatus'][]> = {
    imported: ['suggested', 'incomplete', 'pending_approval'],
    suggested: ['suggested', 'incomplete', 'pending_approval'],
    incomplete: ['suggested', 'incomplete', 'pending_approval'],
    ready_for_review: ['pending_approval'],
    pending_approval: ['approved', 'incomplete'],
    approved: ['approved'],
    posted: ['reversed'],
    reversed: ['corrected'],
    corrected: ['suggested', 'incomplete'],
    period_locked: ['incomplete', 'suggested'],
    integration_error: ['incomplete', 'suggested'],
  };
  const requested: Record<typeof args.action, BookingDraftEntity['workflowStatus']> = {
    save_draft: 'suggested',
    submit_for_review: 'pending_approval',
    approve: 'approved',
    reject: 'incomplete',
    post: 'approved',
    reverse: 'reversed',
    create_correction: 'corrected',
    request_receipt: 'incomplete',
  };
  const target = requested[args.action];
  if (!transitions[draft.workflowStatus].includes(target)) {
    throw new Error(`Invalid workflow transition: ${draft.workflowStatus} -> ${target}`);
  }
  switch (args.action) {
    case 'save_draft':
      next.workflowStatus = target;
      break;
    case 'submit_for_review':
      next.workflowStatus = target;
      break;
    case 'approve':
      next.workflowStatus = target;
      break;
    case 'reject':
      next.workflowStatus = target;
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
      next.workflowStatus = target;
      break;
    case 'reverse':
      next.workflowStatus = target;
      break;
    case 'create_correction':
      next.workflowStatus = target;
      break;
    case 'request_receipt':
      next.workflowStatus = target;
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

const validatePostingLinesForDatev = (lines: JournalLineEntity[]): void => {
  const lineIds = new Set<string>();
  for (const line of lines) {
    if (lineIds.has(line.id)) throw new Error('DATEV Export blockiert: Buchungszeilen enthalten doppelte IDs.');
    lineIds.add(line.id);
    const debit = Number(line.debitAmount ?? 0);
    const credit = Number(line.creditAmount ?? 0);
    const validAmount = (value: number) => Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) <= 1e-9;
    if (!validAmount(debit) || !validAmount(credit) || (debit > 0) === (credit > 0)) {
      throw new Error('DATEV Export blockiert: Jede Buchungszeile muss genau eine positive Soll- oder Habenseite mit Centgenauigkeit enthalten.');
    }
    if (!line.accountNumber || !/^\d+$/.test(line.accountNumber) || /^0+$/.test(line.accountNumber)) {
      throw new Error('DATEV Export blockiert: Buchungszeile enthält ein ungültiges Konto.');
    }
  }
};

const buildPostingPairs = (lines: JournalLineEntity[]): PostingPairSeed[] => {
  validatePostingLinesForDatev(lines);
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
  options: {
    postingDate?: string;
    idempotencyKey?: string;
    sourceType?: string;
    softLockOverride?: boolean;
    overrideReason?: string;
    // Compatibility aliases for callers that used the wording in the policy.
    allowSoftLocked?: boolean;
    reason?: string;
  } = {},
  scope: TenantScope,
): { entry: JournalEntryEntity; issues: DraftValidationIssue[] } => {
  const tenantId = getTenantId(scope);
  const drizzle = createDrizzle(db);
  const row = drizzle.select({ draft_json: schema.bookingDrafts.draftJson, workflow_status: schema.bookingDrafts.workflowStatus }).from(schema.bookingDrafts)
    .where(and(eq(schema.bookingDrafts.tenantId, tenantId), eq(schema.bookingDrafts.id, draftId))).get() as {
      draft_json: string;
      workflow_status: BookingDraftEntity['workflowStatus'];
    } | undefined;
  if (!row) throw new Error('Draft not found');

  const sourceType = options.sourceType?.trim() || 'booking_draft';
  const sourceKey = options.idempotencyKey?.trim() || `booking-draft:${draftId}`;
  const existingSource = drizzle.select({ id: schema.journalEntries.id }).from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.sourceType, sourceType), eq(schema.journalEntries.sourceKey, sourceKey))).get();
  const existingDraft = drizzle.select({ id: schema.journalEntries.id }).from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.sourceDraftId, draftId))).get();
  const existingId = existingSource?.id ?? existingDraft?.id;
  if (existingId) {
    const existing = getJournalEntryById(db, existingId, scope);
    if (existing) return { entry: existing, issues: [] };
  }

  const draft = safeJsonParse<BookingDraftEntity>(row.draft_json, null as never);
  const postingDate = options.postingDate || draft.postingDate;
  const period = postingDate && isIsoDate(postingDate) ? periodForDate(postingDate) : draft.period;
  const fiscalYear = isPeriod(period) ? Number(period.slice(0, 4)) : draft.fiscalYear;
  if (!postingDate || !isIsoDate(postingDate)) {
    return { entry: emptyJournalEntry(tenantId, postingDate || '', period, fiscalYear), issues: [{ id: randomUUID(), code: 'INVALID_POSTING_DATE', severity: 'error', message: 'Buchungsdatum muss ein gültiges Datum (YYYY-MM-DD) sein.', fieldPath: 'postingDate', blocking: true, source: 'system' }] };
  }

  ensurePeriodExists(db, period, fiscalYear, tenantId);
  const periodStatus = loadPeriodStatus(db, period, tenantId);
  const chart = getPostingChart(db, tenantId);
  if (!chart) {
    return {
      entry: emptyJournalEntry(tenantId, postingDate, period, fiscalYear),
      issues: [{ id: randomUUID(), code: 'CHART_UNAVAILABLE', severity: 'error', message: `Aktiver Kontenrahmen ${getAccountingPolicy(db, tenantId).activeChart} enthält keine Konten.`, blocking: true, source: 'system' }],
    };
  }
  const draftForPosting = { ...draft, postingDate, period, fiscalYear };
  const validationIssues = validateDraft(db, draftForPosting, periodStatus, chart);
  if (row.workflow_status !== 'approved') {
    validationIssues.push({ id: randomUUID(), code: 'DRAFT_NOT_APPROVED', severity: 'error', message: 'Nur freigegebene Buchungsentwürfe dürfen gebucht werden.', blocking: true, source: 'system' });
  }
  const blockingIssues = validationIssues.filter((issue) => issue.blocking);
  const softLockOverride = options.softLockOverride ?? options.allowSoftLocked ?? false;
  const overrideReason = (options.overrideReason ?? options.reason ?? '').trim();
  if (periodStatus === 'soft_locked' && (!softLockOverride || !overrideReason)) {
    blockingIssues.push({ id: randomUUID(), code: 'SOFT_LOCK_OVERRIDE_REQUIRED', severity: 'error', message: 'Die Periode ist vorläufig gesperrt; Freigabe und Begründung sind erforderlich.', blocking: true, source: 'system' });
  }
  if (periodStatus === 'closed') {
    blockingIssues.push({ id: randomUUID(), code: 'POSTING_DATE_IN_CLOSED_PERIOD', severity: 'error', message: 'Periode ist geschlossen.', blocking: true, source: 'system' });
  }
  if (!isOpenOrSoftLocked(periodStatus) || blockingIssues.length > 0) {
    return {
      entry: emptyJournalEntry(tenantId, postingDate, period, fiscalYear),
      issues: [...validationIssues, ...blockingIssues.filter((issue) => !validationIssues.some((existing) => existing.code === issue.code))],
    };
  }

  const validated = saveDraft(db, draftForPosting, scope);
  const postingLines: JournalLineEntity[] = [];
  validated.lines.forEach((line) => {
    const taxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
    const baseLine: JournalLineEntity = { ...line, id: line.id || randomUUID(), taxCaseKey, taxCode: toLegacyTaxCode(taxCaseKey) ?? line.taxCode };
    postingLines.push(baseLine);
    const taxCase = getTaxCaseByKey(db, taxCaseKey);
    if (!taxCase || taxCase.mechanism !== 'reverse_charge') return;
    const taxAmount = round2(Number(line.taxAmount || 0));
    if (taxAmount <= 0) return;
    const taxAccounts = resolveTaxAccountsForCase(db, chart, taxCaseKey);
    if (!taxAccounts.inputTaxAccount || !taxAccounts.outputTaxAccount) return;
    postingLines.push({ id: randomUUID(), accountNumber: taxAccounts.inputTaxAccount, debitAmount: taxAmount, creditAmount: 0, taxCode: toLegacyTaxCode(taxCaseKey), taxCaseKey, taxRate: Number(line.taxRate || taxCase.defaultRate || 0), netAmount: line.netAmount, taxAmount, grossAmount: line.grossAmount, countryCode: line.countryCode, counterpartyVatId: line.counterpartyVatId, evidenceType: line.evidenceType, evidenceReference: line.evidenceReference, memo: `RC Vorsteuer ${taxCaseKey}` });
    postingLines.push({ id: randomUUID(), accountNumber: taxAccounts.outputTaxAccount, debitAmount: 0, creditAmount: taxAmount, taxCode: toLegacyTaxCode(taxCaseKey), taxCaseKey, taxRate: Number(line.taxRate || taxCase.defaultRate || 0), netAmount: line.netAmount, taxAmount, grossAmount: line.grossAmount, countryCode: line.countryCode, counterpartyVatId: line.counterpartyVatId, evidenceType: line.evidenceType, evidenceReference: line.evidenceReference, memo: `RC Umsatzsteuer ${taxCaseKey}` });
  });

  const entryId = randomUUID();
  const createdAt = new Date().toISOString();
  let entryNumber = 0;
  let duplicateEntryId: string | undefined;
  db.transaction(() => {
    const txDrizzle = createDrizzle(db);
    const duplicate = txDrizzle.select({ id: schema.journalEntries.id }).from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.sourceType, sourceType), eq(schema.journalEntries.sourceKey, sourceKey))).get();
    if (duplicate) {
      duplicateEntryId = duplicate.id;
      return;
    }
    // Allocation deliberately occurs inside the same SQLite transaction as the
    // insert; SQLite serializes writers and the unique index is the final guard.
    entryNumber = getNextEntryNumber(db, tenantId);
    txDrizzle.insert(schema.journalEntries).values({ id: entryId, tenantId, entryNumber, postingDate, documentDate: validated.documentDate ?? null, bookingText: validated.bookingText, reference: validated.reference ?? null, period, fiscalYear, status: 'posted', sourceDraftId: validated.id, sourceType, sourceKey, reversedEntryId: null, createdAt }).run();
    postingLines.forEach((line, idx) => {
      txDrizzle.insert(schema.journalLines).values({ id: line.id, tenantId, entryId, lineNo: idx + 1, accountNumber: line.accountNumber, debitAmount: round2(line.debitAmount), creditAmount: round2(line.creditAmount), taxCode: line.taxCode ?? null, taxCaseKey: line.taxCaseKey ?? null, taxRate: line.taxRate ?? null, netAmount: line.netAmount ?? null, taxAmount: line.taxAmount ?? null, grossAmount: line.grossAmount ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, datevSachverhaltLl: line.datevSachverhaltLl ?? null, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, costCenter: line.costCenter ?? null, memo: line.memo ?? null }).run();
    });
    for (const line of postingLines) {
      const taxCase = getTaxCaseByKey(db, line.taxCaseKey ?? line.taxCode);
      if (!taxCase) continue;
      const hasEvidence = Boolean(line.evidenceType || line.evidenceReference || line.countryCode || line.counterpartyVatId);
      if (!taxCase.requiresEvidence && !hasEvidence) continue;
      txDrizzle.insert(schema.vatEvidence).values({ id: randomUUID(), tenantId, draftId: validated.id, entryId, lineId: line.id, taxCaseKey: taxCase.key, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, capturedAt: createdAt }).run();
    }
    for (const pair of buildPostingPairs(postingLines)) {
      txDrizzle.insert(schema.journalPostingPairs).values({ id: randomUUID(), tenantId, entryId, debitLineId: pair.debitLineId, creditLineId: pair.creditLineId, amount: round2(pair.amount), taxCaseKey: pair.taxCaseKey ?? null, datevBuKey: resolveDatevBuKeyForTaxCase(db, chart, pair.taxCaseKey) ?? null, createdAt }).run();
    }
    txDrizzle.update(schema.bookingDrafts).set({ workflowStatus: 'posted', draftJson: JSON.stringify({ ...validated, workflowStatus: 'posted', updatedAt: createdAt }), updatedAt: createdAt }).where(and(eq(schema.bookingDrafts.id, validated.id), eq(schema.bookingDrafts.tenantId, tenantId))).run();
    txDrizzle.update(schema.bankTransactions).set({ status: 'booked', updatedAt: createdAt }).where(and(eq(schema.bankTransactions.id, validated.transactionId), eq(schema.bankTransactions.tenantId, tenantId))).run();
    appendAuditLog(db, { entityType: 'pro_journal_entry', entityId: entryId, action: 'post', reason: overrideReason || 'Draft posted', before: null, after: { entryNumber, postingDate, period, fiscalYear, sourceDraftId: validated.id, sourceKey }, actor: 'pro' });
  })();

  if (duplicateEntryId) {
    const existing = getJournalEntryById(db, duplicateEntryId, scope);
    if (existing) return { entry: existing, issues: [] };
  }
  return { entry: { id: entryId, tenantId, entryNumber, postingDate, documentDate: validated.documentDate, bookingText: validated.bookingText, reference: validated.reference, period, fiscalYear, status: 'posted', sourceDraftId: validated.id, sourceType: sourceType as JournalEntryEntity['sourceType'], sourceKey, createdAt, lines: postingLines }, issues: validated.validationIssues };
};

const emptyJournalEntry = (tenantId: string, postingDate: string, period: string, fiscalYear: number): JournalEntryEntity => ({ id: '', tenantId, entryNumber: 0, postingDate, bookingText: '', period, fiscalYear, status: 'posted', createdAt: new Date().toISOString(), lines: [] });

export const reverseJournalEntry = (
  db: Database.Database,
  entryId: string,
  reason: string,
  scope: TenantScope,
  options: { postingDate?: string; softLockOverride?: boolean; overrideReason?: string } = {},
): { ok: true; reversalEntryId: string } => {
  const tenantId = getTenantId(scope);
  const cleanReason = reason.trim();
  if (!cleanReason) throw new Error('Reversal reason is required');
  const drizzle = createDrizzle(db);
  const entry = drizzle.select({
    id: schema.journalEntries.id, entry_number: schema.journalEntries.entryNumber,
    posting_date: schema.journalEntries.postingDate, document_date: schema.journalEntries.documentDate,
    booking_text: schema.journalEntries.bookingText, reference: schema.journalEntries.reference,
    period: schema.journalEntries.period, fiscal_year: schema.journalEntries.fiscalYear,
    status: schema.journalEntries.status, reversed_entry_id: schema.journalEntries.reversedEntryId,
    source_type: schema.journalEntries.sourceType,
  }).from(schema.journalEntries).where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.id, entryId))).get() as
    | { id: string; entry_number: number; posting_date: string; document_date: string | null; booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string; reversed_entry_id: string | null; source_type: string }
    | undefined;
  if (!entry) throw new Error('Journal entry not found');
  if (entry.status === 'reversed' || entry.reversed_entry_id || entry.source_type === 'reversal') {
    throw new Error('Journal entry cannot be reversed again');
  }

  const postingDate = options.postingDate || new Date().toISOString().slice(0, 10);
  if (!isIsoDate(postingDate)) throw new Error('Invalid reversal posting date');
  const period = periodForDate(postingDate);
  const fiscalYear = Number(postingDate.slice(0, 4));
  ensurePeriodExists(db, period, fiscalYear, tenantId);
  const periodStatus = loadPeriodStatus(db, period, tenantId);
  if (periodStatus === 'closed') throw new Error('Reversal posting period is closed');
  const overrideReason = (options.overrideReason ?? '').trim();
  if (periodStatus === 'soft_locked' && (!options.softLockOverride || !overrideReason)) {
    throw new Error('Soft-locked reversal period requires explicit override and reason');
  }

  const lineSelect = {
    id: schema.journalLines.id, account_number: schema.journalLines.accountNumber,
    debit_amount: schema.journalLines.debitAmount, credit_amount: schema.journalLines.creditAmount,
    tax_code: schema.journalLines.taxCode, tax_case_key: schema.journalLines.taxCaseKey,
    tax_rate: schema.journalLines.taxRate, net_amount: schema.journalLines.netAmount,
    tax_amount: schema.journalLines.taxAmount, gross_amount: schema.journalLines.grossAmount,
    country_code: schema.journalLines.countryCode, datev_sachverhalt_ll: schema.journalLines.datevSachverhaltLl, counterparty_vat_id: schema.journalLines.counterpartyVatId,
    evidence_type: schema.journalLines.evidenceType, evidence_reference: schema.journalLines.evidenceReference,
    cost_center: schema.journalLines.costCenter, memo: schema.journalLines.memo,
  };
  const lines = drizzle.select(lineSelect).from(schema.journalLines)
    .where(and(eq(schema.journalLines.tenantId, tenantId), eq(schema.journalLines.entryId, entryId)))
    .orderBy(asc(schema.journalLines.lineNo)).all() as Array<{
      id: string; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null;
      tax_case_key: TaxCaseKey | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null;
    gross_amount: number | null; country_code: string | null; datev_sachverhalt_ll: string | null; counterparty_vat_id: string | null;
      evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null;
    }>;
  if (!lines.length) throw new Error('Journal entry has no lines');

  const reversalEntryId = randomUUID();
  const auditReason = overrideReason ? `${cleanReason} (soft-lock override: ${overrideReason})` : cleanReason;
  const sourceKey = `reversal:${entryId}`;
  const now = new Date().toISOString();
  let reversalNumber = 0;
  db.transaction(() => {
    const txDrizzle = createDrizzle(db);
    const current = txDrizzle.select({ status: schema.journalEntries.status, reversedEntryId: schema.journalEntries.reversedEntryId })
      .from(schema.journalEntries).where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.id, entryId))).get() as { status: string; reversedEntryId: string | null } | undefined;
    if (!current || current.status === 'reversed' || current.reversedEntryId) throw new Error('Journal entry cannot be reversed again');
    const duplicate = txDrizzle.select({ id: schema.journalEntries.id }).from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.sourceType, 'reversal'), eq(schema.journalEntries.sourceKey, sourceKey))).get();
    if (duplicate) throw new Error('Journal entry already reversed');
    reversalNumber = getNextEntryNumber(db, tenantId);
    txDrizzle.insert(schema.journalEntries).values({ id: reversalEntryId, tenantId, entryNumber: reversalNumber, postingDate, documentDate: entry.document_date, bookingText: `Storno ${entry.entry_number}: ${entry.booking_text}`, reference: cleanReason, period, fiscalYear, status: 'posted', sourceDraftId: null, sourceType: 'reversal', sourceKey, reversedEntryId: entryId, createdAt: now }).run();
    const reversalLines: JournalLineEntity[] = lines.map((line) => ({
      id: randomUUID(), accountNumber: line.account_number,
      debitAmount: round2(Number(line.credit_amount || 0)), creditAmount: round2(Number(line.debit_amount || 0)),
      taxCode: line.tax_code ?? undefined, taxCaseKey: line.tax_case_key ?? undefined, taxRate: line.tax_rate ?? undefined,
      netAmount: line.net_amount === null ? undefined : -Number(line.net_amount),
      taxAmount: line.tax_amount === null ? undefined : -Number(line.tax_amount),
      grossAmount: line.gross_amount === null ? undefined : -Number(line.gross_amount),
      countryCode: line.country_code ?? undefined, counterpartyVatId: line.counterparty_vat_id ?? undefined,
      datevSachverhaltLl: line.datev_sachverhalt_ll ?? undefined,
      evidenceType: line.evidence_type ?? undefined, evidenceReference: line.evidence_reference ?? undefined,
      costCenter: line.cost_center ?? undefined, memo: line.memo ?? undefined,
    }));
    reversalLines.forEach((line, idx) => {
      txDrizzle.insert(schema.journalLines).values({ id: line.id, tenantId, entryId: reversalEntryId, lineNo: idx + 1, accountNumber: line.accountNumber, debitAmount: line.debitAmount, creditAmount: line.creditAmount, taxCode: line.taxCode ?? null, taxCaseKey: line.taxCaseKey ?? null, taxRate: line.taxRate ?? null, netAmount: line.netAmount ?? null, taxAmount: line.taxAmount ?? null, grossAmount: line.grossAmount ?? null, countryCode: line.countryCode ?? null, counterpartyVatId: line.counterpartyVatId ?? null, datevSachverhaltLl: line.datevSachverhaltLl ?? null, evidenceType: line.evidenceType ?? null, evidenceReference: line.evidenceReference ?? null, costCenter: line.costCenter ?? null, memo: line.memo ?? null }).run();
    });
    const chart = getActiveChart(db, tenantId);
    for (const pair of buildPostingPairs(reversalLines)) {
      txDrizzle.insert(schema.journalPostingPairs).values({ id: randomUUID(), tenantId, entryId: reversalEntryId, debitLineId: pair.debitLineId, creditLineId: pair.creditLineId, amount: pair.amount, taxCaseKey: pair.taxCaseKey ?? null, datevBuKey: resolveDatevBuKeyForTaxCase(db, chart, pair.taxCaseKey) ?? null, createdAt: now }).run();
    }
    txDrizzle.update(schema.journalEntries).set({ status: 'reversed', reversedEntryId: reversalEntryId })
      .where(and(eq(schema.journalEntries.tenantId, tenantId), eq(schema.journalEntries.id, entryId))).run();
    appendAuditLog(db, { entityType: 'pro_journal_entry', entityId: entryId, action: 'reverse', reason: auditReason, before: { status: 'posted' }, after: { status: 'reversed', reversalEntryId, postingDate, period, fiscalYear, reversalReason: cleanReason, softLockOverrideReason: overrideReason || undefined }, actor: 'pro' });
    appendAuditLog(db, { entityType: 'pro_journal_entry', entityId: reversalEntryId, action: 'post_reversal', reason: auditReason, before: null, after: { reversesEntryId: entryId, entryNumber: reversalNumber, postingDate, period, fiscalYear, reversalReason: cleanReason, softLockOverrideReason: overrideReason || undefined }, actor: 'pro' });
  })();
  return { ok: true, reversalEntryId };
};

export const listJournalEntries = (
  db: Database.Database,
  args: { from?: string; to?: string; accountNumbers?: string[]; status?: Array<'posted' | 'reversed'>; limit?: number; offset?: number } = {},
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
  if (args.status?.length) conditions.push(inArray(schema.journalEntries.status, args.status));
  const rows = drizzle.select({
    id: schema.journalEntries.id, tenant_id: schema.journalEntries.tenantId, entry_number: schema.journalEntries.entryNumber,
    posting_date: schema.journalEntries.postingDate, document_date: schema.journalEntries.documentDate,
    booking_text: schema.journalEntries.bookingText, reference: schema.journalEntries.reference,
    period: schema.journalEntries.period, fiscal_year: schema.journalEntries.fiscalYear, status: schema.journalEntries.status,
    source_draft_id: schema.journalEntries.sourceDraftId, source_type: schema.journalEntries.sourceType,
    source_key: schema.journalEntries.sourceKey, reversed_entry_id: schema.journalEntries.reversedEntryId,
    created_at: schema.journalEntries.createdAt,
  }).from(schema.journalEntries).where(and(...conditions))
    .orderBy(desc(schema.journalEntries.postingDate), desc(schema.journalEntries.entryNumber))
    .limit(Math.max(1, Math.min(5000, Math.floor(args.limit ?? 500))))
    .offset(Math.max(0, Math.floor(args.offset ?? 0))).all() as Array<{
      id: string; tenant_id: string; entry_number: number; posting_date: string; document_date: string | null;
      booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string;
      source_draft_id: string | null; source_type: string; source_key: string | null; reversed_entry_id: string | null; created_at: string;
    }>;

  type JournalLineRow = {
    id: string; entry_id: string; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null;
    tax_case_key: TaxCaseKey | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null;
    gross_amount: number | null; country_code: string | null; counterparty_vat_id: string | null;
    datev_sachverhalt_ll: string | null; evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null;
  };
  const lineRows = rows.length ? drizzle.select({
    id: schema.journalLines.id, entry_id: schema.journalLines.entryId, account_number: schema.journalLines.accountNumber,
    debit_amount: schema.journalLines.debitAmount, credit_amount: schema.journalLines.creditAmount,
    tax_code: schema.journalLines.taxCode, tax_case_key: schema.journalLines.taxCaseKey,
    tax_rate: schema.journalLines.taxRate, net_amount: schema.journalLines.netAmount, tax_amount: schema.journalLines.taxAmount,
    gross_amount: schema.journalLines.grossAmount, country_code: schema.journalLines.countryCode, datev_sachverhalt_ll: schema.journalLines.datevSachverhaltLl,
    counterparty_vat_id: schema.journalLines.counterpartyVatId, evidence_type: schema.journalLines.evidenceType,
    evidence_reference: schema.journalLines.evidenceReference, cost_center: schema.journalLines.costCenter,
    memo: schema.journalLines.memo,
  }).from(schema.journalLines).where(and(eq(schema.journalLines.tenantId, tenantId), inArray(schema.journalLines.entryId, rows.map((row) => row.id))))
    .orderBy(asc(schema.journalLines.entryId), asc(schema.journalLines.lineNo)).all() as JournalLineRow[] : [];
  const linesByEntry = new Map<string, JournalLineRow[]>();
  for (const line of lineRows) linesByEntry.set(line.entry_id, [...(linesByEntry.get(line.entry_id) ?? []), line]);

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
    sourceType: row.source_type as JournalEntryEntity['sourceType'],
    sourceKey: row.source_key ?? undefined,
    reversedEntryId: row.reversed_entry_id ?? undefined,
    createdAt: row.created_at,
    lines: (linesByEntry.get(row.id) ?? []).map((line) => ({
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
      datevSachverhaltLl: line.datev_sachverhalt_ll ?? undefined,
      countryCode: line.country_code ?? undefined,
      counterpartyVatId: line.counterparty_vat_id ?? undefined,
      evidenceType: line.evidence_type ?? undefined,
      evidenceReference: line.evidence_reference ?? undefined,
      costCenter: line.cost_center ?? undefined,
      memo: line.memo ?? undefined,
    })),
  }));
};

/**
 * DATEV is deliberately independent of the UI listing cap. The normal journal
 * listing is capped at 5,000 rows, while DATEV permits 99,999 booking rows and
 * must observe the overflow instead of silently exporting a truncated prefix.
 */
const listDatevJournalEntries = (
  db: Database.Database,
  args: { from: string; to: string },
  scope: TenantScope,
): JournalEntryEntity[] => {
  const pageSize = 5_000;
  const entries: JournalEntryEntity[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = listJournalEntries(db, { ...args, status: ['posted', 'reversed'], limit: pageSize, offset }, scope);
    entries.push(...page);
    if (page.length < pageSize || entries.length > DATEV_MAX_ROWS) break;
  }
  return entries;
};

// Idempotent mutations must not depend on the paginated journal listing.
// Keep this lookup intentionally direct so a replay remains correct after the
// journal grows beyond the list endpoint's page cap.
function getJournalEntryById(
  db: Database.Database,
  entryId: string,
  scope: TenantScope,
): JournalEntryEntity | null {
  const tenantId = getTenantId(scope);
  const drizzle = createDrizzle(db);
  const row = drizzle.select({
    id: schema.journalEntries.id, tenant_id: schema.journalEntries.tenantId, entry_number: schema.journalEntries.entryNumber,
    posting_date: schema.journalEntries.postingDate, document_date: schema.journalEntries.documentDate,
    booking_text: schema.journalEntries.bookingText, reference: schema.journalEntries.reference,
    period: schema.journalEntries.period, fiscal_year: schema.journalEntries.fiscalYear, status: schema.journalEntries.status,
    source_draft_id: schema.journalEntries.sourceDraftId, source_type: schema.journalEntries.sourceType,
    source_key: schema.journalEntries.sourceKey, reversed_entry_id: schema.journalEntries.reversedEntryId,
    created_at: schema.journalEntries.createdAt,
  }).from(schema.journalEntries).where(and(
    eq(schema.journalEntries.tenantId, tenantId),
    eq(schema.journalEntries.id, entryId),
  )).get() as {
    id: string; tenant_id: string; entry_number: number; posting_date: string; document_date: string | null;
    booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string;
    source_draft_id: string | null; source_type: string; source_key: string | null; reversed_entry_id: string | null; created_at: string;
  } | undefined;
  if (!row) return null;

  const lines = drizzle.select({
    id: schema.journalLines.id, account_number: schema.journalLines.accountNumber,
    debit_amount: schema.journalLines.debitAmount, credit_amount: schema.journalLines.creditAmount,
    tax_code: schema.journalLines.taxCode, tax_case_key: schema.journalLines.taxCaseKey,
    tax_rate: schema.journalLines.taxRate, net_amount: schema.journalLines.netAmount, tax_amount: schema.journalLines.taxAmount,
    gross_amount: schema.journalLines.grossAmount, country_code: schema.journalLines.countryCode, datev_sachverhalt_ll: schema.journalLines.datevSachverhaltLl,
    counterparty_vat_id: schema.journalLines.counterpartyVatId, evidence_type: schema.journalLines.evidenceType,
    evidence_reference: schema.journalLines.evidenceReference, cost_center: schema.journalLines.costCenter,
    memo: schema.journalLines.memo,
  }).from(schema.journalLines).where(and(
    eq(schema.journalLines.tenantId, tenantId),
    eq(schema.journalLines.entryId, row.id),
  )).orderBy(asc(schema.journalLines.lineNo)).all() as Array<{
    id: string; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null;
    tax_case_key: TaxCaseKey | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null;
      gross_amount: number | null; country_code: string | null; datev_sachverhalt_ll: string | null; counterparty_vat_id: string | null;
    evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null;
  }>;

  return {
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
    sourceType: row.source_type as JournalEntryEntity['sourceType'],
    sourceKey: row.source_key ?? undefined,
    reversedEntryId: row.reversed_entry_id ?? undefined,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
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
      datevSachverhaltLl: line.datev_sachverhalt_ll ?? undefined,
      countryCode: line.country_code ?? undefined,
      counterpartyVatId: line.counterparty_vat_id ?? undefined,
      evidenceType: line.evidence_type ?? undefined,
      evidenceReference: line.evidence_reference ?? undefined,
      costCenter: line.cost_center ?? undefined,
      memo: line.memo ?? undefined,
    })),
  };
}

type ReportJournalLineRow = {
  account_number: string;
  posting_date: string;
  debit_amount: number | null;
  credit_amount: number | null;
};

type HgbMappingRow = {
  account_number: string;
  statement_type: 'guv' | 'bilanz';
  position_key: string;
  position_label: string;
  balance_side: 'asset' | 'liability' | null;
};

type AccountingMappingRole =
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'bank'
  | 'revenue'
  | 'expense'
  | 'asset'
  | 'output_vat'
  | 'output_vat_deferred'
  | 'input_vat';

type HgbRoleDefaults = {
  statementType: 'guv' | 'bilanz';
  positionKey: string;
  positionLabel: string;
  balanceSide?: 'asset' | 'liability';
};

const hgbRoleDefaults: Record<AccountingMappingRole, HgbRoleDefaults> = {
  accounts_receivable: { statementType: 'bilanz', positionKey: 'receivables', positionLabel: 'Forderungen', balanceSide: 'asset' },
  accounts_payable: { statementType: 'bilanz', positionKey: 'payables', positionLabel: 'Verbindlichkeiten', balanceSide: 'liability' },
  bank: { statementType: 'bilanz', positionKey: 'bank', positionLabel: 'Bank', balanceSide: 'asset' },
  revenue: { statementType: 'guv', positionKey: 'revenue', positionLabel: 'Umsatzerlöse' },
  expense: { statementType: 'guv', positionKey: 'expense', positionLabel: 'Aufwendungen' },
  asset: { statementType: 'bilanz', positionKey: 'fixed_assets', positionLabel: 'Sachanlagen', balanceSide: 'asset' },
  output_vat: { statementType: 'bilanz', positionKey: 'output_vat', positionLabel: 'Umsatzsteuer', balanceSide: 'liability' },
  output_vat_deferred: { statementType: 'bilanz', positionKey: 'output_vat_deferred', positionLabel: 'Umsatzsteuer nicht fällig', balanceSide: 'liability' },
  input_vat: { statementType: 'bilanz', positionKey: 'input_vat', positionLabel: 'Vorsteuer', balanceSide: 'asset' },
};

const centsForReport = (value: unknown): number => Math.round(Number(value || 0) * 100);
const amountForReport = (cents: number): number => cents === 0 ? 0 : cents / 100;

const loadReportJournalLines = (
  db: Database.Database,
  tenantId: string,
  args: { from?: string; to?: string } = {},
): ReportJournalLineRow[] => {
  const conditions = [
    eq(schema.journalLines.tenantId, tenantId),
    eq(schema.journalEntries.tenantId, tenantId),
    inArray(schema.journalEntries.status, ['posted', 'reversed']),
  ];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  return createDrizzle(db).select({
    account_number: schema.journalLines.accountNumber,
    posting_date: schema.journalEntries.postingDate,
    debit_amount: schema.journalLines.debitAmount,
    credit_amount: schema.journalLines.creditAmount,
  }).from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(...conditions)).all() as ReportJournalLineRow[];
};

const loadHgbMappings = (
  db: Database.Database,
  tenantId: string,
  chart: 'SKR03' | 'SKR04',
): HgbMappingRow[] => {
  const conditions = [
    eq(schema.accountMappingsHgb.tenantId, tenantId),
    eq(schema.accountMappingsHgb.chart, chart),
  ];
  return createDrizzle(db).select({
    account_number: schema.accountMappingsHgb.accountNumber,
    statement_type: schema.accountMappingsHgb.statementType,
    position_key: schema.accountMappingsHgb.positionKey,
    position_label: schema.accountMappingsHgb.positionLabel,
    balance_side: schema.accountMappingsHgb.balanceSide,
  }).from(schema.accountMappingsHgb).where(and(...conditions)).all() as HgbMappingRow[];
};

const defaultHgbMappings: Record<'SKR03' | 'SKR04', Array<{
  accountNumber: string;
  statementType: 'guv' | 'bilanz';
  positionKey: string;
  positionLabel: string;
  balanceSide?: 'asset' | 'liability';
}>> = {
  SKR03: [
    { accountNumber: '8400', statementType: 'guv', positionKey: 'revenue', positionLabel: 'Umsatzerlöse' },
    { accountNumber: '4900', statementType: 'guv', positionKey: 'expense', positionLabel: 'Aufwendungen' },
    { accountNumber: '1200', statementType: 'bilanz', positionKey: 'bank', positionLabel: 'Bank', balanceSide: 'asset' },
    { accountNumber: '1400', statementType: 'bilanz', positionKey: 'receivables', positionLabel: 'Forderungen', balanceSide: 'asset' },
    { accountNumber: '1576', statementType: 'bilanz', positionKey: 'input_vat', positionLabel: 'Vorsteuer 19 %', balanceSide: 'asset' },
    { accountNumber: '1571', statementType: 'bilanz', positionKey: 'input_vat_7', positionLabel: 'Vorsteuer 7 %', balanceSide: 'asset' },
    { accountNumber: '1574', statementType: 'bilanz', positionKey: 'input_vat_rc', positionLabel: 'Vorsteuer Reverse Charge', balanceSide: 'asset' },
    { accountNumber: '0480', statementType: 'bilanz', positionKey: 'fixed_assets', positionLabel: 'Sachanlagen', balanceSide: 'asset' },
    { accountNumber: '1600', statementType: 'bilanz', positionKey: 'payables', positionLabel: 'Verbindlichkeiten', balanceSide: 'liability' },
    { accountNumber: '1776', statementType: 'bilanz', positionKey: 'output_vat', positionLabel: 'Umsatzsteuer 19 %', balanceSide: 'liability' },
    { accountNumber: '1771', statementType: 'bilanz', positionKey: 'output_vat_7', positionLabel: 'Umsatzsteuer 7 %', balanceSide: 'liability' },
    { accountNumber: '1774', statementType: 'bilanz', positionKey: 'output_vat_rc', positionLabel: 'Umsatzsteuer Reverse Charge', balanceSide: 'liability' },
    { accountNumber: '1780', statementType: 'bilanz', positionKey: 'output_vat_deferred', positionLabel: 'Umsatzsteuer nicht fällig', balanceSide: 'liability' },
    { accountNumber: '9000', statementType: 'bilanz', positionKey: 'equity', positionLabel: 'Eigenkapital', balanceSide: 'liability' },
  ],
  SKR04: [
    { accountNumber: '4400', statementType: 'guv', positionKey: 'revenue', positionLabel: 'Umsatzerlöse' },
    { accountNumber: '6300', statementType: 'guv', positionKey: 'expense', positionLabel: 'Aufwendungen' },
    { accountNumber: '1800', statementType: 'bilanz', positionKey: 'bank', positionLabel: 'Bank', balanceSide: 'asset' },
    { accountNumber: '1200', statementType: 'bilanz', positionKey: 'receivables', positionLabel: 'Forderungen', balanceSide: 'asset' },
    { accountNumber: '1406', statementType: 'bilanz', positionKey: 'input_vat', positionLabel: 'Vorsteuer 19 %', balanceSide: 'asset' },
    { accountNumber: '1401', statementType: 'bilanz', positionKey: 'input_vat_7', positionLabel: 'Vorsteuer 7 %', balanceSide: 'asset' },
    { accountNumber: '1404', statementType: 'bilanz', positionKey: 'input_vat_rc', positionLabel: 'Vorsteuer Reverse Charge', balanceSide: 'asset' },
    { accountNumber: '0670', statementType: 'bilanz', positionKey: 'fixed_assets', positionLabel: 'Sachanlagen', balanceSide: 'asset' },
    { accountNumber: '3300', statementType: 'bilanz', positionKey: 'payables', positionLabel: 'Verbindlichkeiten', balanceSide: 'liability' },
    { accountNumber: '3806', statementType: 'bilanz', positionKey: 'output_vat', positionLabel: 'Umsatzsteuer 19 %', balanceSide: 'liability' },
    { accountNumber: '3801', statementType: 'bilanz', positionKey: 'output_vat_7', positionLabel: 'Umsatzsteuer 7 %', balanceSide: 'liability' },
    { accountNumber: '3804', statementType: 'bilanz', positionKey: 'output_vat_rc', positionLabel: 'Umsatzsteuer Reverse Charge', balanceSide: 'liability' },
    { accountNumber: '3810', statementType: 'bilanz', positionKey: 'output_vat_deferred', positionLabel: 'Umsatzsteuer nicht fällig', balanceSide: 'liability' },
    { accountNumber: '2900', statementType: 'bilanz', positionKey: 'equity', positionLabel: 'Eigenkapital', balanceSide: 'liability' },
  ],
};

/**
 * OPOS account mappings are tenant/chart policy, while HGB mappings are the
 * report classification.  Keep the built-in HGB seed intentionally small,
 * but reconcile every explicitly configured OPOS role into that classification
 * so a custom account (for example deferred VAT 1790) is never silently lost.
 * Existing HGB rows win; this is additive and does not overwrite a deliberate
 * user classification.
 */
const reconcileAccountingRoleMappings = (
  db: Database.Database,
  tenantId: string,
  chart: 'SKR03' | 'SKR04',
): void => {
  const drizzle = createDrizzle(db);
  const roleRows = drizzle.select({
    account_number: schema.accountingAccountMappings.accountNumber,
    role: schema.accountingAccountMappings.role,
  }).from(schema.accountingAccountMappings).where(and(
    eq(schema.accountingAccountMappings.tenantId, tenantId),
    eq(schema.accountingAccountMappings.chart, chart),
  )).all() as Array<{ account_number: string; role: string }>;
  const now = new Date().toISOString();
  for (const row of roleRows) {
    const definition = hgbRoleDefaults[row.role as AccountingMappingRole];
    if (!definition) continue;
    const existing = drizzle.select({ id: schema.accountMappingsHgb.id })
      .from(schema.accountMappingsHgb)
      .where(and(
        eq(schema.accountMappingsHgb.tenantId, tenantId),
        eq(schema.accountMappingsHgb.chart, chart),
        eq(schema.accountMappingsHgb.accountNumber, row.account_number),
      ))
      .get();
    if (existing) continue;
    drizzle.insert(schema.accountMappingsHgb).values({
      id: `accounting-role:${tenantId}:${chart}:${row.role}:${row.account_number}`,
      tenantId,
      chart,
      accountNumber: row.account_number,
      statementType: definition.statementType,
      positionKey: definition.positionKey,
      positionLabel: definition.positionLabel,
      balanceSide: definition.balanceSide ?? null,
      updatedAt: now,
    }).onConflictDoNothing().run();
  }
};

const ensureDefaultMappings = (
  db: Database.Database,
  tenantId: string,
  chart = getAccountingPolicy(db, tenantId).activeChart,
): void => {
  const drizzle = createDrizzle(db);
  const now = new Date().toISOString();
  for (const mapping of defaultHgbMappings[chart]) {
    drizzle.insert(schema.accountMappingsHgb).values({
      id: randomUUID(), tenantId, chart, accountNumber: mapping.accountNumber,
      statementType: mapping.statementType, positionKey: mapping.positionKey,
      positionLabel: mapping.positionLabel, balanceSide: mapping.balanceSide ?? null, updatedAt: now,
    }).onConflictDoNothing().run();
  }
  reconcileAccountingRoleMappings(db, tenantId, chart);
};

const aggregateUnmapped = (
  rows: ReportJournalLineRow[],
  mappedAccounts: Set<string>,
  amount: (row: ReportJournalLineRow) => number,
): Array<{ accountNumber: string; amount: number }> => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (mappedAccounts.has(row.account_number)) continue;
    totals.set(row.account_number, (totals.get(row.account_number) ?? 0) + amount(row));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountNumber, cents]) => ({ accountNumber, amount: amountForReport(cents) }));
};

export const getLedgerBalances = (
  db: Database.Database,
  args: { from?: string; to?: string; asOfDate?: string } = {},
  scope: TenantScope,
): LedgerBalanceRow[] => {
  const tenantId = getTenantId(scope);
  const upperDate = args.to ?? args.asOfDate;
  const rows = loadReportJournalLines(db, tenantId);
  const balances = new Map<string, { opening: number; debit: number; credit: number }>();

  for (const row of rows) {
    if (upperDate && row.posting_date > upperDate) continue;
    const current = balances.get(row.account_number) ?? { opening: 0, debit: 0, credit: 0 };
    const debit = centsForReport(row.debit_amount);
    const credit = centsForReport(row.credit_amount);
    if (args.from && row.posting_date < args.from) current.opening += debit - credit;
    else {
      current.debit += debit;
      current.credit += credit;
    }
    balances.set(row.account_number, current);
  }

  return [...balances.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([accountNumber, value]) => ({
    accountNumber,
    openingBalance: amountForReport(value.opening),
    debitTurnover: amountForReport(value.debit),
    creditTurnover: amountForReport(value.credit),
    closingBalance: amountForReport(value.opening + value.debit - value.credit),
  }));
};

export const getSusaReport = (
  db: Database.Database,
  args: { from?: string; to?: string; asOfDate?: string } = {},
  scope: TenantScope,
): {
  from?: string;
  to?: string;
  chart: 'SKR03' | 'SKR04';
  asOfDate: string;
  rows: Array<LedgerBalanceRow & { mappedTo?: string; hasWarnings?: boolean }>;
  totals: { debit: number; credit: number; balance: number };
  unmappedAccounts: Array<{ accountNumber: string; amount: number }>;
  blocking: boolean;
} => {
  const tenantId = getTenantId(scope);
  const chart = getAccountingPolicy(db, tenantId).activeChart;
  ensureDefaultMappings(db, tenantId, chart);
  const upperDate = args.to ?? args.asOfDate;
  const rows = getLedgerBalances(db, args, scope);
  const allRows = loadReportJournalLines(db, tenantId, upperDate ? { to: upperDate } : {});
  const mappings = loadHgbMappings(db, tenantId, chart);
  const mappingByAccount = new Map(mappings.map((mapping) => [mapping.account_number, mapping]));
  const knownAccounts = new Set(mappings.map((mapping) => mapping.account_number));
  const unmappedAccounts = aggregateUnmapped(allRows, knownAccounts, (row) => centsForReport(row.debit_amount) - centsForReport(row.credit_amount));
  const totals = rows.reduce(
    (acc, row) => {
      acc.debit += centsForReport(row.debitTurnover);
      acc.credit += centsForReport(row.creditTurnover);
      acc.balance += centsForReport(row.closingBalance);
      return acc;
    },
    { debit: 0, credit: 0, balance: 0 },
  );
  return {
    from: args.from,
    to: upperDate,
    chart,
    asOfDate: upperDate ?? new Date().toISOString().slice(0, 10),
    rows: rows.map((row) => {
      const mapping = mappingByAccount.get(row.accountNumber);
      return {
        ...row,
        mappedTo: mapping?.position_key,
        hasWarnings: !mapping,
      };
    }),
    totals: {
      debit: amountForReport(totals.debit),
      credit: amountForReport(totals.credit),
      balance: amountForReport(totals.balance),
    },
    unmappedAccounts,
    blocking: unmappedAccounts.length > 0,
  };
};

export const getGuvReport = (
  db: Database.Database,
  args: { from?: string; to?: string } = {},
  scope: TenantScope,
): {
  from?: string;
  to?: string;
  chart: 'SKR03' | 'SKR04';
  rows: Array<{ positionKey: string; positionLabel: string; amount: number; accountRefs: string[] }>;
  netResult: number;
  unmappedAccounts: Array<{ accountNumber: string; amount: number }>;
  blocking: boolean;
} => {
  const tenantId = getTenantId(scope);
  const chart = getAccountingPolicy(db, tenantId).activeChart;
  ensureDefaultMappings(db, tenantId, chart);
  const sourceRows = loadReportJournalLines(db, tenantId, args);
  const mappings = loadHgbMappings(db, tenantId, chart);
  const guvMappings = new Map(mappings.filter((mapping) => mapping.statement_type === 'guv').map((mapping) => [mapping.account_number, mapping]));
  const knownAccounts = new Set(mappings.map((mapping) => mapping.account_number));
  const unmappedAccounts = aggregateUnmapped(sourceRows, knownAccounts, (row) => centsForReport(row.credit_amount) - centsForReport(row.debit_amount));
  const grouped = new Map<string, { positionKey: string; positionLabel: string; amount: number; accountRefs: Set<string> }>();
  for (const row of sourceRows) {
    const mapping = guvMappings.get(row.account_number);
    if (!mapping) continue;
    const current = grouped.get(mapping.position_key) ?? { positionKey: mapping.position_key, positionLabel: mapping.position_label, amount: 0, accountRefs: new Set<string>() };
    current.amount += centsForReport(row.credit_amount) - centsForReport(row.debit_amount);
    current.accountRefs.add(row.account_number);
    grouped.set(mapping.position_key, current);
  }
  const rows = [...grouped.values()].sort((left, right) => left.positionKey.localeCompare(right.positionKey)).map((row) => ({
    positionKey: row.positionKey,
    positionLabel: row.positionLabel,
    amount: amountForReport(row.amount),
    accountRefs: [...row.accountRefs].sort(),
  }));
  const revenue = rows.filter((row) => row.positionKey === 'revenue').reduce((sum, row) => sum + centsForReport(row.amount), 0);
  const expenses = rows.filter((row) => row.positionKey === 'expense').reduce((sum, row) => sum + centsForReport(row.amount), 0);
  return {
    from: args.from,
    to: args.to,
    chart,
    rows,
    netResult: amountForReport(revenue + expenses),
    unmappedAccounts,
    blocking: unmappedAccounts.length > 0,
  };
};

export const getBilanzReport = (
  db: Database.Database,
  args: { asOfDate?: string; to?: string } = {},
  scope: TenantScope,
): {
  chart: 'SKR03' | 'SKR04';
  asOfDate: string;
  assets: Array<{ accountNumber: string; amount: number }>;
  liabilities: Array<{ accountNumber: string; amount: number }>;
  totals: { assets: number; liabilities: number; delta: number };
  unmappedAccounts: Array<{ accountNumber: string; amount: number }>;
  blocking: boolean;
} => {
  const tenantId = getTenantId(scope);
  const chart = getAccountingPolicy(db, tenantId).activeChart;
  ensureDefaultMappings(db, tenantId, chart);
  const upperDate = args.to ?? args.asOfDate;
  const sourceRows = loadReportJournalLines(db, tenantId, upperDate ? { to: upperDate } : {});
  const mappings = loadHgbMappings(db, tenantId, chart);
  const balanceMappings = new Map(mappings.filter((mapping) => mapping.statement_type === 'bilanz').map((mapping) => [mapping.account_number, mapping]));
  const knownAccounts = new Set(mappings.map((mapping) => mapping.account_number));
  const unmappedAccounts = aggregateUnmapped(sourceRows, knownAccounts, (row) => centsForReport(row.debit_amount) - centsForReport(row.credit_amount));
  const grouped = new Map<string, { balanceSide: 'asset' | 'liability'; amount: number }>();
  for (const row of sourceRows) {
    const mapping = balanceMappings.get(row.account_number);
    if (!mapping || !mapping.balance_side) continue;
    const current = grouped.get(row.account_number) ?? { balanceSide: mapping.balance_side, amount: 0 };
    current.amount += centsForReport(row.debit_amount) - centsForReport(row.credit_amount);
    grouped.set(row.account_number, current);
  }
  const assets = [...grouped.entries()].filter(([, row]) => row.balanceSide === 'asset')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountNumber, row]) => ({ accountNumber, amount: amountForReport(row.amount) }));
  const liabilities = [...grouped.entries()].filter(([, row]) => row.balanceSide === 'liability')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountNumber, row]) => ({ accountNumber, amount: amountForReport(-row.amount) }));
  const totalAssets = assets.reduce((sum, row) => sum + centsForReport(row.amount), 0);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + centsForReport(row.amount), 0);
  return {
    chart,
    asOfDate: upperDate ?? new Date().toISOString().slice(0, 10),
    assets,
    liabilities,
    totals: {
      assets: amountForReport(totalAssets),
      liabilities: amountForReport(totalLiabilities),
      delta: amountForReport(totalAssets - totalLiabilities),
    },
    unmappedAccounts,
    blocking: unmappedAccounts.length > 0,
  };
};

export const listDatevExports = (db: Database.Database, scope: TenantScope): DatevExportResult[] => {
  const tenantId = getTenantId(scope);
  const rows = createDrizzle(db).select({ id: schema.datevExports.id, file_path: schema.datevExports.filePath,
    record_count: schema.datevExports.recordCount, from_date: schema.datevExports.fromDate,
    to_date: schema.datevExports.toDate, created_at: schema.datevExports.createdAt,
    sha256: schema.datevExports.sha256, byte_size: schema.datevExports.byteSize, encoding: schema.datevExports.encoding,
    header_version: schema.datevExports.headerVersion, format_version: schema.datevExports.formatVersion,
    chart: schema.datevExports.chart, source_snapshot_hash: schema.datevExports.sourceSnapshotHash,
    manifest_json: schema.datevExports.manifestJson, status: schema.datevExports.status,
    validation_json: schema.datevExports.validationJson }).from(schema.datevExports)
    .where(eq(schema.datevExports.tenantId, tenantId)).orderBy(desc(schema.datevExports.createdAt)).all() as Array<{
      id: string; file_path: string; record_count: number; from_date: string | null; to_date: string | null; created_at: string;
      sha256: string | null; byte_size: number | null; encoding: string | null; header_version: number | null;
      format_version: number | null; chart: 'SKR03' | 'SKR04' | null; source_snapshot_hash: string | null;
      manifest_json: string | null; status: string | null; validation_json: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    recordCount: row.record_count,
    fromDate: row.from_date ?? undefined,
    toDate: row.to_date ?? undefined,
    createdAt: row.created_at,
    sha256: row.sha256 ?? undefined,
    byteSize: row.byte_size ?? undefined,
    encoding: row.encoding === 'cp1252' || row.encoding === 'utf8-bom' ? row.encoding : undefined,
    headerVersion: row.header_version ?? undefined,
    formatVersion: row.format_version ?? undefined,
    chart: row.chart ?? undefined,
    sourceSnapshotHash: row.source_snapshot_hash ?? undefined,
    manifestJson: row.manifest_json ?? undefined,
    status: row.status ?? undefined,
    validationJson: row.validation_json ?? undefined,
  }));
};

export const insertDatevExport = (
  db: Database.Database,
  args: {
    id?: string;
    filePath: string;
    recordCount: number;
    fromDate?: string;
    toDate?: string;
    sha256?: string;
    byteSize?: number;
    encoding?: 'cp1252' | 'utf8-bom';
    headerVersion?: number;
    formatVersion?: number;
    chart?: 'SKR03' | 'SKR04';
    sourceSnapshotHash?: string;
    manifestJson?: string;
    status?: string;
    validationJson?: string;
  },
  scope: TenantScope,
): DatevExportResult => {
  const tenantId = getTenantId(scope);
  const id = args.id ?? randomUUID();
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    createDrizzle(db).insert(schema.datevExports).values({ id, tenantId, filePath: args.filePath, recordCount: args.recordCount,
      fromDate: args.fromDate ?? null, toDate: args.toDate ?? null, createdAt, metaJson: args.manifestJson ?? '{}',
      sha256: args.sha256 ?? null, byteSize: args.byteSize ?? null, encoding: args.encoding ?? null,
      headerVersion: args.headerVersion ?? null, formatVersion: args.formatVersion ?? null, chart: args.chart ?? null,
      sourceSnapshotHash: args.sourceSnapshotHash ?? null, manifestJson: args.manifestJson ?? null,
      status: args.status ?? 'validated', validationJson: args.validationJson ?? null }).run();

    appendAuditLog(db, {
      entityType: 'pro_datev_export',
      entityId: id,
      action: 'export',
      reason: 'DATEV Buchungsstapel generated',
      before: null,
      after: { ...args, id },
      actor: 'pro',
    });
  })();

  return {
    id,
    filePath: args.filePath,
    recordCount: args.recordCount,
    fromDate: args.fromDate,
    toDate: args.toDate,
    createdAt,
    sha256: args.sha256,
    byteSize: args.byteSize,
    encoding: args.encoding,
    headerVersion: args.headerVersion,
    formatVersion: args.formatVersion,
    chart: args.chart,
    sourceSnapshotHash: args.sourceSnapshotHash,
    manifestJson: args.manifestJson,
    status: args.status ?? 'validated',
    validationJson: args.validationJson,
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
  unmappedAccounts: string[];
  blocking: boolean;
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
  const activeChart = getAccountingPolicy(db, tenantId).activeChart;
  ensureDefaultMappings(db, tenantId, activeChart);
  const lineAccounts = new Set(loadReportJournalLines(db, tenantId).map((row) => row.account_number));
  const mappedAccounts = new Set(loadHgbMappings(db, tenantId, activeChart).map((row) => row.account_number));
  const unmappedAccounts = [...lineAccounts].filter((accountNumber) => !mappedAccounts.has(accountNumber)).sort();
  const unmappedAccountCount = unmappedAccounts.length;
  const lastDatevExport = drizzle.select({ created_at: schema.datevExports.createdAt }).from(schema.datevExports)
    .where(eq(schema.datevExports.tenantId, tenantId)).orderBy(desc(schema.datevExports.createdAt)).limit(1).get() as { created_at: string } | undefined;

  return {
    draftCount,
    postedCount,
    reversedCount,
    unbalancedDraftCount,
    unmappedAccountCount,
    unmappedAccounts,
    blocking: unmappedAccountCount > 0,
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
    inArray(schema.journalEntries.status, ['posted', 'reversed']), isNotNull(schema.journalLines.taxCaseKey)];
  if (args.from) conditions.push(gte(schema.journalEntries.postingDate, args.from));
  if (args.to) conditions.push(lte(schema.journalEntries.postingDate, args.to));
  const sourceRows = createDrizzle(db).select({ tax_case_key: schema.journalLines.taxCaseKey,
    net: schema.journalLines.netAmount, tax: schema.journalLines.taxAmount, gross: schema.journalLines.grossAmount,
    debit: schema.journalLines.debitAmount, credit: schema.journalLines.creditAmount, status: schema.journalEntries.status })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(...conditions)).all();
  const grouped = new Map<string, { tax_case_key: TaxCaseKey; net_amount: number; tax_amount: number; gross_amount: number; line_count: number }>();
  for (const row of sourceRows) {
    if (!row.tax_case_key) continue;
    const current = grouped.get(row.tax_case_key) ?? { tax_case_key: row.tax_case_key as TaxCaseKey, net_amount: 0, tax_amount: 0, gross_amount: 0, line_count: 0 };
    // Reversal lines persist the negated tax basis. The original entry remains
    // visible as reversed, so summing stored signed values yields net zero.
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

const resolveDatevBuKeyForPosting = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
  taxCaseKey: string | undefined,
  postingDate: string,
): string | undefined => {
  const normalized = normalizeTaxCaseKey(taxCaseKey);
  if (!normalized) return undefined;
  const candidates = listTaxCaseAccountMappings(db, { chart, taxCaseKey: normalized })
    .filter((mapping) => mapping.role === 'datev_bu')
    .filter((mapping) => (!mapping.validFrom || mapping.validFrom <= postingDate) && (!mapping.validTo || mapping.validTo >= postingDate))
    .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? '') || b.updatedAt.localeCompare(a.updatedAt));
  const key = candidates[0]?.datevBuKey;
  const taxCase = getTaxCaseByKey(db, normalized);
  if (!taxCase) throw new Error(`DATEV Steuerfall-Mapping fehlt für ${normalized}.`);
  if (!key && taxCase && taxCase.mechanism !== 'exempt' && taxCase.mechanism !== 'zero_rate') {
    throw new Error(`DATEV BU-Schlüssel fehlt für Steuerfall ${normalized} am ${postingDate}.`);
  }
  if (key !== undefined && !/^\d{1,4}$/.test(key)) throw new Error(`DATEV BU-Schlüssel ist ungültig für Steuerfall ${normalized}.`);
  return key?.padStart(4, '0');
};

interface DatevTaxDetails {
  euLandUstId?: string;
  euSteuersatz?: number;
  sachverhaltLl?: string;
}

/**
 * DATEV's extended tax fields are not inferred from a BU key. They are built
 * only from the persisted tax/evidence values on the journal line; incomplete
 * EU or §13b evidence blocks the complete export instead of emitting a
 * misleading booking.
 */
const resolveDatevTaxDetails = (
  db: Database.Database,
  line: JournalLineEntity,
  taxCaseKey: string | undefined,
): DatevTaxDetails => {
  const normalized = normalizeTaxCaseKey(taxCaseKey ?? line.taxCaseKey ?? line.taxCode);
  if (!normalized) return {};
  const taxCase = getTaxCaseByKey(db, normalized);
  if (!taxCase) throw new Error(`DATEV Steuerfall-Mapping fehlt für ${normalized}.`);
  const euDestinationCases = new Set(['EU_B2C_OSS', 'DE_TRIANGULAR_25B', 'EU_B2B_SERVICE_RC', 'EU_IGL_GOODS_0', 'EU_IGE_GOODS_RC'] as const);
  const needsEuDestination = euDestinationCases.has(normalized as typeof euDestinationCases extends Set<infer Key> ? Key : never);
  const details: DatevTaxDetails = {};
  if (needsEuDestination) {
    const country = line.countryCode;
    const vatId = line.counterpartyVatId;
    if (!country || !/^[A-Z]{2}$/.test(country)) {
      throw new Error(`DATEV Export blockiert: EU-Land fehlt für ${normalized}.`);
    }
    // OSS is a B2C case: the canonical tax case intentionally does not
    // require a counterparty VAT ID. Other EU cases persist one as evidence.
    if (taxCase.requiresCounterpartyVatId && (!vatId || !/^[A-Z0-9]+$/.test(vatId))) {
      throw new Error(`DATEV Export blockiert: EU-USt-IdNr. fehlt für ${normalized}.`);
    }
    if (vatId && (vatId.length > 13 || (vatId.length >= 2 && /^[A-Z]{2}/.test(vatId) && !vatId.startsWith(country)))) {
      throw new Error(`DATEV Export blockiert: EU-USt-IdNr. ist ungültig für ${normalized}.`);
    }
    const combinedVatId = !vatId ? country : vatId.startsWith(country) ? vatId : `${country}${vatId}`;
    if (combinedVatId.length > 15) throw new Error(`DATEV Export blockiert: EU-USt-IdNr. ist zu lang für ${normalized}.`);
    const rate = Number(line.taxRate);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 100 || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-9) {
      throw new Error(`DATEV Export blockiert: EU-Steuersatz fehlt oder ist ungültig für ${normalized}.`);
    }
    details.euLandUstId = combinedVatId;
    details.euSteuersatz = rate;
  }
  if (['DE_RC_13B_DOMESTIC', 'EU_B2B_SERVICE_RC', 'EU_IGE_GOODS_RC', 'NON_EU_SERVICE_RC'].includes(normalized)) {
    const fact = line.datevSachverhaltLl ?? line.evidenceReference;
    if (!fact || !/^[1-9]\d{0,2}$/.test(fact)) {
      throw new Error(`DATEV Export blockiert: Sachverhalt L+L (§13b) fehlt für ${normalized}.`);
    }
    details.sachverhaltLl = fact;
  }
  return details;
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
  euLandUstId?: string;
  euSteuersatz?: number;
  sachverhaltLl?: string;
  umsatz: number;
}> => {
  if (!args.from || !args.to || !isIsoDate(args.from) || !isIsoDate(args.to) || args.from > args.to) {
    throw new Error('DATEV Export benötigt einen gültigen, geschlossenen Zeitraum.');
  }
  if (periodForDate(args.from) !== periodForDate(args.to)) throw new Error('DATEV Export darf genau eine Buchungsperiode enthalten.');
  const tenantId = getTenantId(scope);
  const chart = getActiveChart(db, tenantId);
  const entries = listDatevJournalEntries(db, { from: args.from, to: args.to }, scope);
  if (entries.length === 0) return [];
  const entryIds = entries.map((entry) => entry.id);
  const storedPairs = createDrizzle(db).select({
    id: schema.journalPostingPairs.id,
    entry_id: schema.journalPostingPairs.entryId,
    debit_line_id: schema.journalPostingPairs.debitLineId,
    credit_line_id: schema.journalPostingPairs.creditLineId,
    amount: schema.journalPostingPairs.amount,
    tax_case_key: schema.journalPostingPairs.taxCaseKey,
    datev_bu_key: schema.journalPostingPairs.datevBuKey,
  }).from(schema.journalPostingPairs).where(and(eq(schema.journalPostingPairs.tenantId, tenantId), inArray(schema.journalPostingPairs.entryId, entryIds)))
    .orderBy(asc(schema.journalPostingPairs.id)).all() as Array<{
      id: string; entry_id: string; debit_line_id: string; credit_line_id: string; amount: number; tax_case_key: string | null; datev_bu_key: string | null;
    }>;
  const byEntry = new Map<string, typeof storedPairs>();
  for (const pair of storedPairs) byEntry.set(pair.entry_id, [...(byEntry.get(pair.entry_id) ?? []), pair]);

  const exportTransaction = db.transaction(() => entries.flatMap((entry) => {
    validatePostingLinesForDatev(entry.lines);
    const lines = new Map(entry.lines.map((line) => [line.id, line]));
    let pairs = [...(byEntry.get(entry.id) ?? [])];
    if (pairs.length === 0) {
      const seeds = buildPostingPairs(entry.lines);
      const debitTotal = round2(entry.lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
      const creditTotal = round2(entry.lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0));
      const pairTotal = round2(seeds.reduce((sum, pair) => sum + pair.amount, 0));
      if (debitTotal <= 0 || debitTotal !== creditTotal || pairTotal !== debitTotal || seeds.length === 0) {
        throw new Error(`DATEV Export blockiert: Buchung ${entry.entryNumber} ist ungepaart oder unausgeglichen.`);
      }
      pairs = seeds.map((pair) => {
        const id = randomUUID();
        const datevBuKey = resolveDatevBuKeyForPosting(db, chart, pair.taxCaseKey, entry.postingDate) ?? null;
        createDrizzle(db).insert(schema.journalPostingPairs).values({ id, tenantId, entryId: entry.id, debitLineId: pair.debitLineId, creditLineId: pair.creditLineId, amount: pair.amount, taxCaseKey: pair.taxCaseKey ?? null, datevBuKey, createdAt: new Date().toISOString() }).run();
        return { id, entry_id: entry.id, debit_line_id: pair.debitLineId, credit_line_id: pair.creditLineId, amount: pair.amount, tax_case_key: pair.taxCaseKey ?? null, datev_bu_key: datevBuKey };
      });
    }
    // Pair rows are persisted with UUIDs. Sort by the stable journal line
    // order instead of UUID insertion order so a repeat export is byte-identical.
    const lineOrder = new Map(entry.lines.map((line, index) => [line.id, index]));
    pairs.sort((a, b) => (lineOrder.get(a.debit_line_id) ?? Number.MAX_SAFE_INTEGER) - (lineOrder.get(b.debit_line_id) ?? Number.MAX_SAFE_INTEGER)
      || (lineOrder.get(a.credit_line_id) ?? Number.MAX_SAFE_INTEGER) - (lineOrder.get(b.credit_line_id) ?? Number.MAX_SAFE_INTEGER)
      || String(a.tax_case_key ?? '').localeCompare(String(b.tax_case_key ?? ''))
      || String(a.datev_bu_key ?? '').localeCompare(String(b.datev_bu_key ?? ''))
      || Number(a.amount) - Number(b.amount));
    const pairTotal = round2(pairs.reduce((sum, pair) => sum + Number(pair.amount || 0), 0));
    const debitTotal = round2(entry.lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
    if (pairTotal !== debitTotal) throw new Error(`DATEV Export blockiert: Persistierte Paare für Buchung ${entry.entryNumber} sind unvollständig.`);
    const debitPaired = new Map<string, number>();
    const creditPaired = new Map<string, number>();
    for (const pair of pairs) {
      debitPaired.set(pair.debit_line_id, round2((debitPaired.get(pair.debit_line_id) ?? 0) + Number(pair.amount || 0)));
      creditPaired.set(pair.credit_line_id, round2((creditPaired.get(pair.credit_line_id) ?? 0) + Number(pair.amount || 0)));
    }
    for (const line of entry.lines) {
      const expected = Number(line.debitAmount || 0) > 0 ? debitPaired.get(line.id) : creditPaired.get(line.id);
      const actual = Number(line.debitAmount || line.creditAmount || 0);
      if (round2(expected ?? 0) !== round2(actual)) throw new Error(`DATEV Export blockiert: Persistierte Paare für Buchung ${entry.entryNumber} stimmen nicht mit den Buchungszeilen überein.`);
    }
    return pairs.map((pair) => {
      const debit = lines.get(pair.debit_line_id);
      const credit = lines.get(pair.credit_line_id);
      const pairAmount = Number(pair.amount);
      if (!debit || !credit || debit.id === credit.id || debit.accountNumber === credit.accountNumber || !Number.isFinite(pairAmount) || pairAmount <= 0 || Math.abs(pairAmount * 100 - Math.round(pairAmount * 100)) > 1e-9) {
        throw new Error(`DATEV Export blockiert: Buchung ${entry.entryNumber} enthält ein ungültiges Paar.`);
      }
      const persistedBuKey = pair.datev_bu_key;
      if (persistedBuKey !== null && !/^\d{1,4}$/.test(persistedBuKey)) throw new Error(`DATEV BU-Schlüssel ist ungültig für Buchung ${entry.entryNumber}.`);
      const taxCaseKey = pair.tax_case_key ?? debit.taxCaseKey ?? credit.taxCaseKey ?? debit.taxCode ?? credit.taxCode;
      const buKey = resolveDatevBuKeyForPosting(db, chart, taxCaseKey, entry.postingDate)
        ?? persistedBuKey?.padStart(4, '0');
      const debitTaxCase = normalizeTaxCaseKey(debit.taxCaseKey ?? debit.taxCode);
      const taxLine = debitTaxCase === normalizeTaxCaseKey(taxCaseKey) ? debit : credit;
      const taxDetails = resolveDatevTaxDetails(db, taxLine, taxCaseKey);
      return {
        date: entry.documentDate ?? entry.postingDate,
        belegfeld1: entry.reference ?? String(entry.entryNumber),
        buchungstext: entry.bookingText,
        konto: debit.accountNumber,
        gegenkonto: credit.accountNumber,
        sollHabenKennzeichen: 'S' as const,
        buSchluessel: buKey,
        ...taxDetails,
        umsatz: round2(pairAmount),
      };
    });
  }));
  const result = exportTransaction();
  if (result.length > DATEV_MAX_ROWS) throw new Error(`DATEV Buchungsstapel darf höchstens ${DATEV_MAX_ROWS} Buchungen enthalten.`);
  return result;
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
    const sourceTransactions = drizzle.select().from(schema.transactions).where(or(isNull(schema.transactions.deletedAt), eq(schema.transactions.deletedAt, ''))).all();
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
