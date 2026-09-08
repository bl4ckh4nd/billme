import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AccountingAccountMapping,
  AccountingBackfillConfirmation,
  AccountingBackfillPreview,
  AccountingBackfillResult,
  AccountingDocumentSource,
  AccountingPostingPreview,
  AccountingSnapshot,
  AccountingMutationContext,
  IncomingInvoiceEntity,
  IncomingInvoiceLineEntity,
  OpenItemAllocationEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  VendorEntity,
} from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { appendAuditLog } from './audit';
import { getTenantId } from '../tenantScope';
import { AccountingPolicyError } from '@billme/accounting-shared';
import { getAccountingPolicy, reverseDocumentJournalEntry } from './proAccountingRepo';
import { getTaxCaseByKey, listTaxCaseAccountMappings, resolveTaxAccountsForCase, type TaxCaseKey } from './taxCasesRepo';

export type AccountingRole = AccountingAccountMapping['role'];
export type AccountingChart = 'SKR03' | 'SKR04';
export type VatAccountingMethod = 'soll' | 'ist';

type InvoiceRow = {
  id: string; client_id: string | null; client?: string | null; client_email?: string | null; client_address?: string | null; billing_address_json?: string | null; shipping_address_json?: string | null; tax_meta_json?: string | null;
  number: string; document_kind?: string | null; source_document_id?: string | null; date: string; due_date: string; service_period?: string | null;
  amount: number; status: string; tax_mode?: string | null; tax_snapshot_json: string | null; accounting_status: string;
  accounting_snapshot_json: string | null; accounting_journal_entry_id: string | null;
};

type RawLine = {
  id: number; description: string; quantity: number; price: number; total: number; tax_rate: number | null; line_meta_json?: string | null; article_id?: string | null; category?: string | null; unit?: string | null; discount_percent?: number | null;
};

type DatevTaxEvidence = {
  buyerCountryCode?: string;
  buyerVatId?: string;
  destinationVatRate?: number;
  datevSachverhaltLl?: string;
  datevEvidenceType?: string;
  datevEvidenceReference?: string;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const cents = (value: number): number => Math.round((Number(value) + Number.EPSILON) * 100);
const amount = (value: number): number => round2(cents(value) / 100);
const now = (): string => new Date().toISOString();
const auditReason = (reason?: string): string => {
  const value = reason?.trim();
  if (!value) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
  return value;
};
const allocationEvent = (value?: string): string => {
  const eventId = value?.trim();
  if (!eventId) throw new Error('ALLOCATION_EVENT_ID_REQUIRED');
  return eventId;
};
const json = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};
const sha256 = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableSnapshot = (snapshot?: AccountingSnapshot): AccountingSnapshot | undefined => snapshot ? { ...snapshot, capturedAt: '' } : undefined;
const tenant = (scope: TenantScope): string => getTenantId(scope);
const assertDesktopTenant = (scope: TenantScope): string => {
  const tenantId = tenant(scope);
  if (tenantId !== 'default') throw new Error('DESKTOP_SINGLE_TENANT_ONLY');
  return tenantId;
};
const isNonBillingDocument = (row: InvoiceRow): boolean => row.document_kind === 'order_confirmation' || row.document_kind === 'delivery_note';
const isCorrectionDocument = (row: InvoiceRow): boolean => row.document_kind === 'credit_note' || row.document_kind === 'cancellation_invoice';
const period = (date: string): string => date.slice(0, 7);
const fiscalYear = (date: string): number => Number(date.slice(0, 4));
const taxCaseForRate = (rate: number, taxMode?: string | null, einvoiceCategoryCode?: string): string => {
  if (taxMode === 'small_business_19_ustg') return 'DE_KU19';
  if (taxMode === 'reverse_charge_13b') return 'DE_RC_13B_DOMESTIC';
  if (taxMode === 'intra_eu_supply_6a') return 'EU_IGL_GOODS_0';
  if (taxMode === 'intra_eu_service_reverse_charge') return 'EU_B2B_SERVICE_RC';
  if (taxMode === 'export_third_country') return 'NON_EU_EXPORT_0';
  if (taxMode === 'vat_exempt_4_ustg') return 'DE_ZERO_EXEMPT';
  if (taxMode === 'non_taxable_outside_scope') return 'NON_EU_SERVICE_RC';
  if (einvoiceCategoryCode === 'K') return 'EU_IGL_GOODS_0';
  if (einvoiceCategoryCode === 'G') return 'NON_EU_EXPORT_0';
  if (einvoiceCategoryCode === 'AE') return 'DE_RC_13B_DOMESTIC';
  if (einvoiceCategoryCode === 'E' || einvoiceCategoryCode === 'O') return 'DE_ZERO_EXEMPT';
  if (rate === 0) return 'DE_ZERO_EXEMPT';
  return Math.abs(rate - 7) < 0.01 ? 'DE_STD_7' : 'DE_STD_19';
};
const outputTaxAccount = (db: Database.Database, chart: AccountingChart, taxCaseKey: string, fallback: string): string => resolveTaxAccountsForCase(db, chart, taxCaseKey).outputTaxAccount ?? fallback;

const resolvePostingBuKey = (db: Database.Database, chart: AccountingChart, taxCaseKey: string | undefined, postingDate: string): string | undefined => {
  if (!taxCaseKey) return undefined;
  const mapping = listTaxCaseAccountMappings(db, { chart, taxCaseKey: taxCaseKey as TaxCaseKey })
    .filter((candidate) => candidate.role === 'datev_bu')
    .filter((candidate) => (!candidate.validFrom || candidate.validFrom <= postingDate) && (!candidate.validTo || candidate.validTo >= postingDate))
    .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? '') || b.updatedAt.localeCompare(a.updatedAt))[0];
  return mapping?.datevBuKey;
};

const defaultMappings: Record<AccountingChart, Record<AccountingRole, string>> = {
  SKR03: {
    accounts_receivable: '1400', accounts_payable: '1600', bank: '1200', revenue: '8400',
    expense: '4900', asset: '0480', output_vat: '1776', output_vat_deferred: '1780', input_vat: '1576',
  },
  SKR04: {
    accounts_receivable: '1200', accounts_payable: '3300', bank: '1800', revenue: '4400',
    expense: '6300', asset: '0670', output_vat: '3806', output_vat_deferred: '3810', input_vat: '1406',
  },
};

const ensureMappingDefaults = (db: Database.Database, tenantId: string): void => {
  const insert = db.prepare(`INSERT OR IGNORE INTO accounting_account_mappings
    (id, tenant_id, chart, role, account_number, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const timestamp = now();
  db.transaction(() => {
    for (const [chart, roles] of Object.entries(defaultMappings) as Array<[AccountingChart, Record<AccountingRole, string>]>) {
      for (const [role, accountNumber] of Object.entries(roles) as Array<[AccountingRole, string]>) {
        insert.run(`${tenantId}-${chart}-${role}`, tenantId, chart, role, accountNumber, timestamp);
      }
    }
  })();
};

const getMapping = (db: Database.Database, tenantId: string, chart: AccountingChart): Record<AccountingRole, string> => {
  ensureMappingDefaults(db, tenantId);
  const rows = db.prepare('SELECT role, account_number FROM accounting_account_mappings WHERE tenant_id = ? AND chart = ?').all(tenantId, chart) as Array<{ role: AccountingRole; account_number: string }>;
  const mapping = { ...defaultMappings[chart] };
  for (const row of rows) if (row.role in mapping) mapping[row.role] = row.account_number;
  return mapping;
};

const accountExists = (db: Database.Database, chart: AccountingChart, accountNumber: string): boolean => {
  const chartHasRows = Number((db.prepare('SELECT COUNT(*) AS c FROM ledger_accounts WHERE chart = ?').get(chart) as { c: number }).c) > 0;
  return chartHasRows && Boolean(db.prepare('SELECT 1 FROM ledger_accounts WHERE chart = ? AND account_number = ?').get(chart, accountNumber));
};

const validateMapping = (db: Database.Database, chart: AccountingChart, mapping: Record<AccountingRole, string>, roles: AccountingRole[] = Object.keys(mapping) as AccountingRole[]): Array<{ code: string; message: string; blocking: boolean }> => {
  const issues: Array<{ code: string; message: string; blocking: boolean }> = [];
  for (const role of roles) {
    const accountNumber = mapping[role];
    if (!accountNumber || !accountExists(db, chart, accountNumber)) {
      issues.push({ code: 'UNKNOWN_ACCOUNT', message: `Konto ${accountNumber || '(leer)'} (${role}) fehlt im ${chart}.`, blocking: true });
    }
  }
  return issues;
};

const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** The only OPOS journal insertion seam.  Every document/payment posting goes
 * through this function so the SQLite transaction contains all accounting
 * invariants, evidence, pairs and audit information. */
const insertJournal = (
  db: Database.Database,
  tenantId: string,
  sourceType: string,
  sourceKey: string,
  postingDate: string,
  bookingText: string,
  lines: AccountingSnapshot['lines'],
  options: { chart: AccountingChart; softLockOverride?: boolean; overrideReason?: string } = { chart: 'SKR03' },
): string => {
  const existing = db.prepare('SELECT id FROM journal_entries WHERE tenant_id = ? AND source_type = ? AND source_key = ?').get(tenantId, sourceType, sourceKey) as { id: string } | undefined;
  if (existing) return existing.id;
  if (!isIsoDate(postingDate)) throw new Error('INVALID_POSTING_DATE');
  const periodKey = period(postingDate);
  const periodRow = db.prepare('SELECT status FROM accounting_periods WHERE tenant_id = ? AND period = ?').get(tenantId, periodKey) as { status: string } | undefined;
  const periodStatus = periodRow?.status ?? 'open';
  if (periodStatus === 'closed') throw new Error('POSTING_DATE_IN_CLOSED_PERIOD');
  if (periodStatus === 'soft_locked' && (!(options.softLockOverride) || !(options.overrideReason ?? '').trim())) throw new Error('SOFT_LOCK_OVERRIDE_REQUIRED');
  const chartHasRows = Number((db.prepare('SELECT COUNT(*) AS c FROM ledger_accounts WHERE chart = ?').get(options.chart) as { c: number }).c) > 0;
  if (!chartHasRows) throw new Error('CHART_UNAVAILABLE');
  const entryLines = lines.map((line, index) => ({ ...line, id: randomUUID(), index })) as Array<AccountingSnapshot['lines'][number] & { id: string; index: number; countryCode?: string; counterpartyVatId?: string; datevSachverhaltLl?: string }>;
  if (!entryLines.length) throw new Error('EMPTY_ENTRY');
  for (const line of entryLines) {
    const debit = cents(line.debitAmount); const credit = cents(line.creditAmount);
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0) || !accountExists(db, options.chart, line.accountNumber)) throw new Error(`INVALID_JOURNAL_LINE:${line.accountNumber}`);
  }
  const debit = entryLines.reduce((sum, line) => sum + cents(line.debitAmount), 0);
  const credit = entryLines.reduce((sum, line) => sum + cents(line.creditAmount), 0);
  if (debit !== credit || debit <= 0) throw new Error('UNBALANCED_ENTRY');
  const id = randomUUID();
  const entryNumber = Number((db.prepare('SELECT COALESCE(MAX(entry_number), 0) AS n FROM journal_entries WHERE tenant_id = ?').get(tenantId) as { n: number }).n) + 1;
  const timestamp = now();
  db.prepare(`INSERT INTO journal_entries
    (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`).run(
    id, tenantId, entryNumber, postingDate, postingDate, bookingText, sourceKey,
    periodKey, fiscalYear(postingDate), sourceType, sourceKey, timestamp,
  );
  const insertLine = db.prepare(`INSERT INTO journal_lines
    (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id, evidence_type, evidence_reference, datev_sachverhalt_ll, cost_center, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const line of entryLines) {
    insertLine.run(line.id, tenantId, id, line.index + 1, line.accountNumber, amount(line.debitAmount), amount(line.creditAmount), null, line.taxCaseKey ?? null, line.taxRate ?? null, line.netAmount ?? null, line.taxAmount ?? null, line.grossAmount ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, line.evidenceType ?? null, line.evidenceReference ?? null, line.datevSachverhaltLl ?? null, null, line.memo ?? null);
  }
  const pairTaxCase = (line: AccountingSnapshot['lines'][number]): string | undefined => line.taxCaseKey
    ?? (line.memo?.startsWith('Vorsteuer ') ? line.memo.slice('Vorsteuer '.length) : undefined)
    ?? (line.memo?.startsWith('UStBasis ') ? line.memo.slice('UStBasis '.length) : undefined);
  const debits = entryLines.filter((line) => cents(line.debitAmount) > 0).map((line) => ({ id: line.id, remaining: amount(line.debitAmount), taxCaseKey: pairTaxCase(line) }));
  const credits = entryLines.filter((line) => cents(line.creditAmount) > 0).map((line) => ({ id: line.id, remaining: amount(line.creditAmount), taxCaseKey: pairTaxCase(line) }));
  const insertPair = db.prepare('INSERT INTO journal_posting_pairs (id, tenant_id, entry_id, debit_line_id, credit_line_id, amount, tax_case_key, datev_bu_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let creditCursor = 0;
  for (const debitLine of debits) {
    while (debitLine.remaining > 0.0001 && creditCursor < credits.length) {
      const creditLine = credits[creditCursor]!;
      if (creditLine.remaining <= 0.0001) { creditCursor += 1; continue; }
      const pairAmount = amount(Math.min(debitLine.remaining, creditLine.remaining));
      const taxCaseKey = debitLine.taxCaseKey ?? creditLine.taxCaseKey;
      insertPair.run(randomUUID(), tenantId, id, debitLine.id, creditLine.id, pairAmount, taxCaseKey ?? null, resolvePostingBuKey(db, options.chart, taxCaseKey, postingDate) ?? null, timestamp);
      debitLine.remaining = amount(debitLine.remaining - pairAmount);
      creditLine.remaining = amount(creditLine.remaining - pairAmount);
    }
  }
  for (const line of entryLines.filter((candidate) => cents(candidate.taxAmount ?? 0) > 0 || Boolean(candidate.taxCaseKey && (candidate.countryCode || candidate.counterpartyVatId || candidate.evidenceType || candidate.evidenceReference)))) {
    db.prepare('INSERT INTO vat_evidence (id, tenant_id, draft_id, entry_id, line_id, tax_case_key, evidence_type, evidence_reference, country_code, counterparty_vat_id, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), tenantId, sourceKey, id, line.id, line.taxCaseKey ?? 'standard_vat', line.evidenceType ?? null, line.evidenceReference ?? null, line.countryCode ?? null, line.counterpartyVatId ?? null, timestamp);
  }
  appendAuditLog(db, { entityType: 'pro_journal_entry', entityId: id, action: 'post', reason: options.overrideReason?.trim() || 'OPOS posting', before: null, after: { sourceType, sourceKey, entryNumber, postingDate }, actor: 'pro' });
  return id;
};

const invoiceRow = (db: Database.Database, tenantId: string, invoiceId: string): InvoiceRow | null => db.prepare(`SELECT * FROM invoices WHERE id = ? AND ? = 'default'`).get(invoiceId, tenantId) as InvoiceRow | null;
const invoiceLines = (db: Database.Database, invoiceId: string): RawLine[] => db.prepare('SELECT id, description, quantity, price, total, tax_rate, line_meta_json, article_id, category, unit, discount_percent FROM invoice_items WHERE invoice_id = ? ORDER BY position, id').all(invoiceId) as RawLine[];

const outgoingSourceVersion = (row: InvoiceRow, lines: RawLine[]): string => sha256({ id: row.id, clientId: row.client_id, client: row.client, clientEmail: row.client_email, clientAddress: row.client_address, billingAddress: json(row.billing_address_json) ?? null, shippingAddress: json(row.shipping_address_json) ?? null, number: row.number, date: row.date, dueDate: row.due_date, servicePeriod: row.service_period, amount: row.amount, taxMode: row.tax_mode, taxMeta: json(row.tax_meta_json) ?? null, taxSnapshot: json(row.tax_snapshot_json) ?? null, lines: lines.map((line) => ({ id: line.id, description: line.description, quantity: line.quantity, price: line.price, total: line.total, taxRate: line.tax_rate, lineMeta: json(line.line_meta_json) ?? null, articleId: line.article_id, category: line.category, unit: line.unit, discountPercent: line.discount_percent })) });

const deriveTaxSnapshot = (db: Database.Database, row: InvoiceRow, lines: RawLine[], chart: AccountingChart, vatMethod: VatAccountingMethod): { snapshot?: AccountingSnapshot; issues: AccountingPostingPreview['issues'] } => {
  const explicit = json<{ netAmount?: number; vatAmount?: number; grossAmount?: number; vatBreakdown?: Array<{ rate: number; netAmount: number; vatAmount: number }>; einvoiceCategoryCode?: string }>(row.tax_snapshot_json);
  const taxEvidence = json<DatevTaxEvidence>(row.tax_meta_json) ?? {};
  let net = Number(explicit?.netAmount);
  let tax = Number(explicit?.vatAmount);
  let gross = Number(explicit?.grossAmount);
  if (!Number.isFinite(net) || !Number.isFinite(tax) || !Number.isFinite(gross)) {
    if (!lines.length || lines.some((line) => !Number.isFinite(Number(line.total)) || line.tax_rate === null)) {
      return { issues: [{ code: 'AMBIGUOUS_TAX_SNAPSHOT', message: 'Rechnung hat keinen verwertbaren taxSnapshot oder vollständige Zeilensteuer.', blocking: true }] };
    }
    gross = amount(lines.reduce((sum, line) => sum + Number(line.total), 0));
    net = amount(lines.reduce((sum, line) => sum + Number(line.total) / (1 + Number(line.tax_rate) / 100), 0));
    tax = amount(gross - net);
  }
  if (gross <= 0 || net < 0 || tax < 0 || Math.abs(gross - net - tax) > 0.01) {
    return { issues: [{ code: 'INVALID_TAX_SNAPSHOT', message: 'Netto, Steuer und Brutto der Rechnung sind nicht konsistent.', blocking: true }] };
  }
  const grouped = new Map<number, { rate: number; netAmount: number; vatAmount: number }>();
  for (const line of lines) {
    if (line.tax_rate === null || !Number.isFinite(Number(line.tax_rate))) continue;
    const rate = Number(line.tax_rate);
    const lineGross = Number(line.total);
    const current = grouped.get(rate) ?? { rate, netAmount: 0, vatAmount: 0 };
    const lineNet = lineGross / (1 + rate / 100);
    current.netAmount += lineNet;
    current.vatAmount += lineGross - lineNet;
    grouped.set(rate, current);
  }
  const breakdown = (explicit?.vatBreakdown?.length ? explicit.vatBreakdown : [...grouped.values()]).map((entry) => ({ rate: Number(entry.rate), netAmount: amount(entry.netAmount), vatAmount: amount(entry.vatAmount) }));
  if (!breakdown.length) breakdown.push({ rate: Number(lines.find((line) => line.tax_rate !== null)?.tax_rate ?? (tax > 0 ? 19 : 0)), netAmount: net, vatAmount: tax });
  const breakdownNet = amount(breakdown.reduce((sum, entry) => sum + entry.netAmount, 0));
  const breakdownTax = amount(breakdown.reduce((sum, entry) => sum + entry.vatAmount, 0));
  if (Math.abs(breakdownNet - net) > 0.02 || Math.abs(breakdownTax - tax) > 0.02) return { issues: [{ code: 'INVALID_TAX_BREAKDOWN', message: 'Die Steueraufteilung stimmt nicht mit dem taxSnapshot überein.', blocking: true }] };

  const mapping = defaultMappings[chart];
  const linesOut: AccountingSnapshot['lines'] = [{ accountNumber: mapping.accounts_receivable, debitAmount: gross, creditAmount: 0, memo: `Debitor ${row.number}` }];
  for (const entry of breakdown) {
    const taxCaseKey = taxCaseForRate(entry.rate, row.tax_mode, explicit?.einvoiceCategoryCode);
    const isEuDestinationCase = ['EU_B2C_OSS', 'DE_TRIANGULAR_25B', 'EU_B2B_SERVICE_RC', 'EU_IGL_GOODS_0', 'EU_IGE_GOODS_RC'].includes(taxCaseKey);
    const destinationRate = isEuDestinationCase ? Number(taxEvidence.destinationVatRate) : entry.rate;
    const taxCase = getTaxCaseByKey(db, taxCaseKey);
    const needsEvidence = taxCase?.requiresEvidence || taxCase?.requiresCounterpartyVatId || taxCase?.requiresCountry;
    const evidenceReference = taxEvidence.datevEvidenceReference ?? taxEvidence.datevSachverhaltLl;
    if (needsEvidence && taxCase?.requiresCountry && (!taxEvidence.buyerCountryCode || !/^[A-Z]{2}$/.test(taxEvidence.buyerCountryCode))) {
      return { issues: [{ code: 'MISSING_TAX_COUNTRY', message: `Ländercode fehlt für Steuerfall ${taxCaseKey}.`, blocking: true }] };
    }
    if (needsEvidence && taxCase?.requiresCounterpartyVatId && (!taxEvidence.buyerVatId || !/^[A-Z0-9]+$/i.test(taxEvidence.buyerVatId))) {
      return { issues: [{ code: 'MISSING_COUNTERPARTY_VAT_ID', message: `USt-IdNr. fehlt für Steuerfall ${taxCaseKey}.`, blocking: true }] };
    }
    if (needsEvidence && taxCase?.requiresEvidence && (!taxEvidence.datevEvidenceType || !evidenceReference)) {
      return { issues: [{ code: 'MISSING_TAX_EVIDENCE', message: `Steuernachweis fehlt für Steuerfall ${taxCaseKey}.`, blocking: true }] };
    }
    if (isEuDestinationCase && (!Number.isFinite(destinationRate) || destinationRate < 0 || destinationRate >= 100)) {
      return { issues: [{ code: 'MISSING_DESTINATION_VAT_RATE', message: `EU-Bestimmungsland-Steuersatz fehlt für Steuerfall ${taxCaseKey}.`, blocking: true }] };
    }
    const requiresDatevLl = ['DE_RC_13B_DOMESTIC', 'EU_B2B_SERVICE_RC', 'EU_IGE_GOODS_RC', 'NON_EU_SERVICE_RC'].includes(taxCaseKey);
    const datevSachverhaltLl = taxEvidence.datevSachverhaltLl ?? (taxEvidence.datevEvidenceReference && /^[1-9]\d{0,2}$/.test(taxEvidence.datevEvidenceReference) ? taxEvidence.datevEvidenceReference : undefined);
    if (requiresDatevLl && !datevSachverhaltLl) {
      return { issues: [{ code: 'MISSING_DATEV_SACHVERHALT', message: `DATEV Sachverhalt L+L fehlt für Steuerfall ${taxCaseKey}.`, blocking: true }] };
    }
    const evidenceMetadata = {
      countryCode: taxEvidence.buyerCountryCode?.trim().toUpperCase(),
      counterpartyVatId: taxEvidence.buyerVatId?.trim().toUpperCase(),
      evidenceType: taxEvidence.datevEvidenceType,
      evidenceReference,
      datevSachverhaltLl,
    };
    const basisMetadata = vatMethod === 'soll' || entry.vatAmount <= 0 ? { taxCaseKey, netAmount: entry.netAmount, taxRate: destinationRate, taxAmount: entry.vatAmount, grossAmount: amount(entry.netAmount + entry.vatAmount), ...evidenceMetadata } : {};
    linesOut.push({ accountNumber: mapping.revenue, debitAmount: 0, creditAmount: entry.netAmount, memo: vatMethod === 'ist' ? `UStBasis ${taxCaseKey}` : undefined, ...basisMetadata });
    if (entry.vatAmount > 0) {
      const fallbackTaxAccount = vatMethod === 'ist' ? mapping.output_vat_deferred : mapping.output_vat;
      // Ist-USt stays on the configured deferred account until payment.  The
      // tax-case output mapping is only used for Soll invoices and for the
      // later payment recognition journal.
      const taxAccount = vatMethod === 'ist' ? fallbackTaxAccount : outputTaxAccount(db, chart, taxCaseKey, fallbackTaxAccount);
      // Keep the tax case on the single revenue basis line.  The VAT control
      // line is deliberately unannotated so VAT summaries cannot count the
      // same tax base twice; the memo preserves the case for account mapping.
      linesOut.push({ accountNumber: taxAccount, debitAmount: 0, creditAmount: entry.vatAmount, memo: `USt ${taxCaseKey}` });
    }
  }
  const snapshot: AccountingSnapshot = {
    sourceType: 'outgoing_invoice', sourceId: row.id, sourceVersion: outgoingSourceVersion(row, lines), chart, vatMethod,
    netAmount: net, taxAmount: tax, grossAmount: gross, lines: linesOut, capturedAt: now(),
  };
  return { snapshot, issues: [] };
};

export const getAccountingPolicyForPro = (db: Database.Database, scope: TenantScope): { tenantId: string; activeChart: AccountingChart; vatMethod: VatAccountingMethod; periodPolicy: 'calendar_month'; updatedAt: string } => {
  const policy = getAccountingPolicy(db, tenant(scope));
  return { ...policy, vatMethod: policy.vatMethod ?? 'soll' };
};

export const setAccountingPolicyForPro = (db: Database.Database, scope: TenantScope, input: { activeChart: AccountingChart; vatMethod: VatAccountingMethod }): ReturnType<typeof getAccountingPolicyForPro> => {
  const tenantId = tenant(scope);
  const before = getAccountingPolicyForPro(db, scope);
  if (input.activeChart !== before.activeChart
    && db.prepare("SELECT 1 FROM journal_entries WHERE tenant_id = ? AND status = 'posted' LIMIT 1").get(tenantId)) {
    throw new AccountingPolicyError(
      'ACCOUNTING_CHART_LOCKED',
      'Der Kontenrahmen kann nach einer gebuchten Journalbuchung nicht mehr geändert werden.',
    );
  }
  ensureMappingDefaults(db, tenantId);
  const updatedAt = now();
  db.prepare(`INSERT INTO accounting_policies (tenant_id, active_chart, vat_method, period_policy, updated_at) VALUES (?, ?, ?, 'calendar_month', ?)
    ON CONFLICT(tenant_id) DO UPDATE SET active_chart = excluded.active_chart, vat_method = excluded.vat_method, updated_at = excluded.updated_at`).run(tenantId, input.activeChart, input.vatMethod, updatedAt);
  appendAuditLog(db, { entityType: 'accounting_policy', entityId: tenantId, action: 'update', reason: 'accounting policy changed', before, after: input, actor: 'pro' });
  return getAccountingPolicyForPro(db, scope);
};

export const listAccountingAccountMappings = (db: Database.Database, scope: TenantScope, chart?: AccountingChart): AccountingAccountMapping[] => {
  const tenantId = tenant(scope);
  ensureMappingDefaults(db, tenantId);
  return (db.prepare(`SELECT id, tenant_id, chart, role, account_number, updated_at FROM accounting_account_mappings WHERE tenant_id = ? ${chart ? 'AND chart = ?' : ''} ORDER BY chart, role`).all(...(chart ? [tenantId, chart] : [tenantId])) as Array<Record<string, string>>).map((row) => ({ id: row.id, tenantId: row.tenant_id, chart: row.chart as AccountingChart, role: row.role as AccountingRole, accountNumber: row.account_number, updatedAt: row.updated_at }));
};

export const upsertAccountingAccountMapping = (db: Database.Database, scope: TenantScope, input: { id?: string; chart: AccountingChart; role: AccountingRole; accountNumber: string }): AccountingAccountMapping => {
  const tenantId = tenant(scope);
  if (!accountExists(db, input.chart, input.accountNumber)) throw new Error(`UNKNOWN_ACCOUNT:${input.accountNumber}`);
  const id = input.id ?? `${tenantId}-${input.chart}-${input.role}`;
  const updatedAt = now();
  db.prepare(`INSERT INTO accounting_account_mappings (id, tenant_id, chart, role, account_number, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, chart, role) DO UPDATE SET account_number = excluded.account_number, updated_at = excluded.updated_at`).run(id, tenantId, input.chart, input.role, input.accountNumber, updatedAt);
  appendAuditLog(db, { entityType: 'accounting_account_mapping', entityId: id, action: 'upsert', reason: 'account mapping changed', before: null, after: input, actor: 'pro' });
  return listAccountingAccountMappings(db, scope, input.chart).find((row) => row.role === input.role)!;
};

export const previewOutgoingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string): AccountingPostingPreview => {
  const tenantId = assertDesktopTenant(scope);
  const row = invoiceRow(db, tenantId, invoiceId);
  if (!row) throw new Error('Invoice not found');
  if (isNonBillingDocument(row)) {
    return {
      sourceType: 'outgoing_invoice',
      sourceId: invoiceId,
      status: 'unresolved',
      reason: 'Auftragsbestätigungen und Lieferscheine werden nicht gebucht.',
      issues: [{ code: 'NON_BILLING_DOCUMENT', message: 'Dieses Dokument ist nicht buchungsfähig.', blocking: true }],
    };
  }
  const policy = getAccountingPolicyForPro(db, scope);
  const mappings = getMapping(db, tenantId, policy.activeChart);
  const issues = validateMapping(db, policy.activeChart, mappings, ['accounts_receivable', 'revenue']);
  const tax = deriveTaxSnapshot(db, row, invoiceLines(db, invoiceId), policy.activeChart, policy.vatMethod);
  issues.push(...tax.issues);
  // Resolve tenant-configured ledger accounts before validating the derived
  // default snapshot. This keeps custom deferred VAT mappings valid even when
  // the chart intentionally does not contain the built-in 1780/3810 account.
  if (tax.snapshot) {
    for (const [index, line] of tax.snapshot.lines.entries()) {
      if (index === 0) line.accountNumber = mappings.accounts_receivable;
      else if (line.memo?.startsWith('USt ') && line.netAmount === undefined && line.taxAmount === undefined) {
        const taxCaseKey = line.memo.slice('USt '.length);
        line.accountNumber = policy.vatMethod === 'ist'
          ? mappings.output_vat_deferred
          : resolveTaxAccountsForCase(db, policy.activeChart, taxCaseKey).outputTaxAccount ?? mappings.output_vat;
      } else line.accountNumber = mappings.revenue;
    }
  }
  if (tax.snapshot?.taxAmount) issues.push(...validateMapping(db, policy.activeChart, mappings, [policy.vatMethod === 'ist' ? 'output_vat_deferred' : 'output_vat']));
  if (tax.snapshot) for (const line of tax.snapshot.lines) if (!accountExists(db, policy.activeChart, line.accountNumber)) issues.push({ code: 'UNKNOWN_ACCOUNT', message: `Konto ${line.accountNumber} fehlt im ${policy.activeChart}.`, blocking: true });
  if (issues.length || !tax.snapshot) return { sourceType: 'outgoing_invoice', sourceId: invoiceId, status: 'unresolved', issues };
  return { sourceType: 'outgoing_invoice', sourceId: invoiceId, status: 'ready', snapshot: tax.snapshot, issues: [] };
};

export const postOutgoingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string, options: { softLockOverride?: boolean; overrideReason?: string; reservationId?: string; requireFinalizedReservation?: boolean } = {}): AccountingPostingPreview => {
  const tenantId = assertDesktopTenant(scope);
  const existingRow = invoiceRow(db, tenantId, invoiceId);
  if (!existingRow) throw new Error('Invoice not found');
  if (isNonBillingDocument(existingRow)) {
    return {
      sourceType: 'outgoing_invoice',
      sourceId: invoiceId,
      status: 'unresolved',
      reason: 'Auftragsbestätigungen und Lieferscheine werden nicht gebucht.',
      issues: [{ code: 'NON_BILLING_DOCUMENT', message: 'Dieses Dokument ist nicht buchungsfähig.', blocking: true }],
    };
  }
  // Reversed/cancelled documents are terminal. Reject before preview/journal
  // creation so the SQLite immutability trigger is not the domain guard.
  if (existingRow.accounting_status === 'reversed' || existingRow.status === 'cancelled') throw new Error('DOCUMENT_NOT_POSTABLE');
  if (existingRow.status === 'draft' && !finalizedInvoiceReservation(db, existingRow)) throw new Error('INVOICE_MUST_BE_FINALIZED');
  if (options.requireFinalizedReservation) {
    if (existingRow.status === 'draft') throw new Error('INVOICE_MUST_BE_FINALIZED');
    const reservation = db.prepare(`SELECT id FROM number_reservations
      WHERE id = ? AND kind = 'invoice' AND status = 'finalized' AND document_id = ? AND number = ?`).get(options.reservationId ?? '', invoiceId, existingRow.number) as { id: string } | undefined;
    if (!reservation) throw new Error('NUMBER_FINALIZATION_REQUIRED');
  }
  if (existingRow.accounting_status === 'posted' && existingRow.accounting_snapshot_json) {
    const snapshot = json<AccountingSnapshot>(existingRow.accounting_snapshot_json);
    if (snapshot) return { sourceType: 'outgoing_invoice', sourceId: invoiceId, status: 'ready', snapshot, issues: [] };
  }
  const preview = previewOutgoingInvoice(db, scope, invoiceId);
  if (preview.status === 'unresolved' || !preview.snapshot) {
    db.prepare('UPDATE invoices SET accounting_status = ? WHERE id = ?').run('unresolved', invoiceId);
    return preview;
  }
  const row = existingRow;
  if (row.accounting_status === 'posted' && row.accounting_snapshot_json) return { ...preview, snapshot: json<AccountingSnapshot>(row.accounting_snapshot_json) ?? preview.snapshot };
  const correction = isCorrectionDocument(row);
  const accountingSnapshot = correction
    ? {
      ...preview.snapshot,
      lines: preview.snapshot.lines.map((line) => ({ ...line, debitAmount: line.creditAmount, creditAmount: line.debitAmount })),
    }
    : preview.snapshot;
  const sourceKey = correction ? `outgoing-correction:${invoiceId}` : `outgoing-invoice:${invoiceId}`;
  const result = db.transaction(() => {
    const journalEntryId = insertJournal(db, tenantId, 'outgoing_invoice', sourceKey, row.date, `${row.document_kind === 'credit_note' ? 'Gutschrift' : row.document_kind === 'cancellation_invoice' ? 'Stornorechnung' : 'Rechnung'} ${row.number}`, accountingSnapshot!.lines, { chart: accountingSnapshot!.chart, ...options });
    const timestamp = now();
    if (correction && row.source_document_id) {
      const original = db.prepare(`SELECT id, original_amount, allocated_amount, residual_amount
        FROM open_items WHERE tenant_id = ? AND source_type = 'outgoing_invoice' AND source_id = ?`).get(tenantId, row.source_document_id) as { id: string; original_amount: number; allocated_amount: number; residual_amount: number } | undefined;
      if (original) {
        const allocation = amount(Math.min(Math.max(0, original.residual_amount), Math.abs(accountingSnapshot!.grossAmount)));
        const allocated = amount(original.allocated_amount + allocation);
        const residual = amount(Math.max(0, original.original_amount - allocated));
        db.prepare(`UPDATE open_items SET allocated_amount = ?, residual_amount = ?, status = ?, updated_at = ? WHERE id = ?`).run(
          allocated,
          residual,
          residual <= 0 ? 'paid' : allocated > 0 ? 'partially_paid' : 'open',
          timestamp,
          original.id,
        );
      }
    } else {
      db.prepare(`INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date, original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at)
        VALUES (?, ?, 'debtor', ?, 'outgoing_invoice', ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?)
        ON CONFLICT(tenant_id, source_type, source_id) DO NOTHING`).run(randomUUID(), tenantId, row.client_id ?? row.id, invoiceId, row.number, row.date, row.due_date, preview.snapshot!.grossAmount, preview.snapshot!.grossAmount, journalEntryId, timestamp, timestamp);
    }
    db.prepare(`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'open' ELSE status END, accounting_status = 'posted', accounting_snapshot_json = ?, accounting_journal_entry_id = ?, accounting_posted_at = ? WHERE id = ?`).run(JSON.stringify(accountingSnapshot), journalEntryId, timestamp, invoiceId);
    appendAuditLog(db, { entityType: 'invoice', entityId: invoiceId, action: 'accounting_post', reason: 'outgoing invoice finalized', before: { accountingStatus: row.accounting_status }, after: { journalEntryId, snapshot: preview.snapshot }, actor: 'pro' });
    return journalEntryId;
  })();
  void result;
  return preview;
};

const vendorFromRow = (row: Record<string, string>): VendorEntity => ({ id: row.id, tenantId: row.tenant_id, vendorNumber: row.vendor_number ?? undefined, name: row.name, email: row.email ?? undefined, address: row.address ?? undefined, vatId: row.vat_id ?? undefined, iban: row.iban ?? undefined, defaultExpenseAccount: row.default_expense_account ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });

export const listVendors = (db: Database.Database, scope: TenantScope): VendorEntity[] => (db.prepare('SELECT * FROM vendors WHERE tenant_id = ? ORDER BY name').all(tenant(scope)) as Array<Record<string, string>>).map(vendorFromRow);

export const upsertVendor = (db: Database.Database, scope: TenantScope, input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'> & { mutation?: AccountingMutationContext }): VendorEntity => {
  const reason = auditReason(input.mutation?.reason);
  const tenantId = tenant(scope); const timestamp = now(); const id = input.id || randomUUID();
  const owner = db.prepare('SELECT tenant_id FROM vendors WHERE id = ?').get(id) as { tenant_id: string } | undefined;
  if (owner && owner.tenant_id !== tenantId) throw new Error('TENANT_MISMATCH');
  db.transaction(() => {
    db.prepare(`INSERT INTO vendors (id, tenant_id, vendor_number, name, email, address, vat_id, iban, default_expense_account, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET vendor_number=excluded.vendor_number, name=excluded.name, email=excluded.email, address=excluded.address, vat_id=excluded.vat_id, iban=excluded.iban, default_expense_account=excluded.default_expense_account, updated_at=excluded.updated_at`).run(id, tenantId, input.vendorNumber ?? null, input.name, input.email ?? null, input.address ?? null, input.vatId ?? null, input.iban ?? null, input.defaultExpenseAccount ?? null, timestamp, timestamp);
    appendAuditLog(db, { entityType: 'vendor', entityId: id, action: 'upsert', reason, before: null, after: input, actor: input.mutation?.actor?.displayName || 'pro' });
  })();
  return listVendors(db, scope).find((row) => row.id === id)!;
};

const incomingFromRow = (db: Database.Database, row: Record<string, any>): IncomingInvoiceEntity => {
  const lines = (db.prepare('SELECT * FROM incoming_invoice_lines WHERE tenant_id = ? AND incoming_invoice_id = ? ORDER BY position').all(row.tenant_id, row.id) as Array<Record<string, any>>).map((line) => ({ id: line.id, incomingInvoiceId: line.incoming_invoice_id, position: line.position, description: line.description, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), netAmount: Number(line.net_amount), taxRate: Number(line.tax_rate), taxAmount: Number(line.tax_amount), grossAmount: Number(line.gross_amount), accountNumber: line.account_number ?? undefined, assetAccountNumber: line.asset_account_number ?? undefined }));
  return { id: row.id, tenantId: row.tenant_id, vendorId: row.vendor_id, number: row.number, invoiceDate: row.invoice_date, dueDate: row.due_date, servicePeriod: row.service_period ?? undefined, netAmount: Number(row.net_amount), taxAmount: Number(row.tax_amount), grossAmount: Number(row.gross_amount), status: row.status, taxRate: Number(row.tax_rate), taxCaseKey: row.tax_case_key ?? undefined, notes: row.notes ?? undefined, lines, accountingStatus: row.accounting_status, accountingSnapshot: json<AccountingSnapshot>(row.accounting_snapshot_json), createdAt: row.created_at, updatedAt: row.updated_at };
};
const incomingSourceVersion = (invoice: IncomingInvoiceEntity): string => sha256({ id: invoice.id, vendorId: invoice.vendorId, number: invoice.number, invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate, netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount, taxRate: invoice.taxRate, taxCaseKey: invoice.taxCaseKey, lines: invoice.lines.map((line) => ({ id: line.id, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, netAmount: line.netAmount, taxRate: line.taxRate, taxAmount: line.taxAmount, grossAmount: line.grossAmount, accountNumber: line.accountNumber, assetAccountNumber: line.assetAccountNumber })) });
const incomingBackfillSourceVersion = (invoice: IncomingInvoiceEntity, accountingStatus: string): string => sha256({ documentVersion: incomingSourceVersion(invoice), eligibility: { status: invoice.status, accountingStatus } });

export const listIncomingInvoices = (db: Database.Database, scope: TenantScope): IncomingInvoiceEntity[] => (db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? ORDER BY invoice_date DESC, number').all(tenant(scope)) as Array<Record<string, any>>).map((row) => incomingFromRow(db, row));

export const upsertIncomingInvoice = (db: Database.Database, scope: TenantScope, input: IncomingInvoiceEntity & { mutation?: AccountingMutationContext }): IncomingInvoiceEntity => {
  const reason = auditReason(input.mutation?.reason);
  const tenantId = tenant(scope); const timestamp = now(); const id = input.id || randomUUID();
  const lines = input.lines ?? [];
  const net = amount(input.netAmount); const tax = amount(input.taxAmount); const gross = amount(input.grossAmount);
  if (Math.abs(gross - net - tax) > 0.01 || gross < 0 || net < 0 || tax < 0) throw new Error('INVALID_INCOMING_TOTALS');
  const owner = db.prepare('SELECT tenant_id, accounting_status FROM incoming_invoices WHERE id = ?').get(id) as { tenant_id: string; accounting_status: string } | undefined;
  if (owner && owner.tenant_id !== tenantId) throw new Error('TENANT_MISMATCH');
  if (owner?.accounting_status === 'posted') throw new Error('POSTED_DOCUMENT_IMMUTABLE');
  const vendorOwner = db.prepare('SELECT tenant_id FROM vendors WHERE id = ?').get(input.vendorId) as { tenant_id: string } | undefined;
  if (!vendorOwner || vendorOwner.tenant_id !== tenantId) throw new Error('VENDOR_TENANT_MISMATCH');
  db.transaction(() => {
    db.prepare(`INSERT INTO incoming_invoices (id, tenant_id, vendor_id, number, invoice_date, due_date, service_period, net_amount, tax_amount, gross_amount, tax_rate, tax_case_key, notes, status, accounting_status, accounting_snapshot_json, accounting_journal_entry_id, accounting_posted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET vendor_id=excluded.vendor_id, number=excluded.number, invoice_date=excluded.invoice_date, due_date=excluded.due_date, service_period=excluded.service_period, net_amount=excluded.net_amount, tax_amount=excluded.tax_amount, gross_amount=excluded.gross_amount, tax_rate=excluded.tax_rate, tax_case_key=excluded.tax_case_key, notes=excluded.notes, status=excluded.status, updated_at=excluded.updated_at`).run(id, tenantId, input.vendorId, input.number, input.invoiceDate, input.dueDate, input.servicePeriod ?? null, net, tax, gross, input.taxRate, input.taxCaseKey ?? null, input.notes ?? null, input.status, input.accountingStatus || 'unposted', timestamp, timestamp);
    db.prepare('DELETE FROM incoming_invoice_lines WHERE tenant_id = ? AND incoming_invoice_id = ?').run(tenantId, id);
    const insert = db.prepare(`INSERT INTO incoming_invoice_lines (id, tenant_id, incoming_invoice_id, position, description, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount, account_number, asset_account_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((line, index) => insert.run(line.id || randomUUID(), tenantId, id, index, line.description, line.quantity, line.unitPrice, line.netAmount, line.taxRate, line.taxAmount, line.grossAmount, line.accountNumber ?? null, line.assetAccountNumber ?? null));
    appendAuditLog(db, { entityType: 'incoming_invoice', entityId: id, action: 'upsert', reason, before: null, after: input, actor: input.mutation?.actor?.displayName || 'pro' });
  })();
  return listIncomingInvoices(db, scope).find((row) => row.id === id)!;
};

export const previewIncomingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string): AccountingPostingPreview => {
  const row = db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? AND id = ?').get(tenant(scope), invoiceId) as Record<string, any> | undefined;
  if (!row) throw new Error('Incoming invoice not found');
  const policy = getAccountingPolicyForPro(db, scope); const mappings = getMapping(db, tenant(scope), policy.activeChart);
  const issues = validateMapping(db, policy.activeChart, mappings, ['accounts_payable']);
  const invoice = incomingFromRow(db, row);
  if (!invoice.lines.length) issues.push({ code: 'AMBIGUOUS_INVOICE_LINES', message: 'Eingangsrechnung benötigt mindestens eine Position.', blocking: true });
  if (Math.abs(invoice.grossAmount - invoice.netAmount - invoice.taxAmount) > 0.01) issues.push({ code: 'INVALID_INCOMING_TOTALS', message: 'Eingangsrechnung ist nicht ausgeglichen.', blocking: true });
  const computedNet = amount(invoice.lines.reduce((sum, line) => sum + line.netAmount, 0));
  const computedTax = amount(invoice.lines.reduce((sum, line) => sum + line.taxAmount, 0));
  if (invoice.lines.length && (Math.abs(computedNet - invoice.netAmount) > 0.01 || Math.abs(computedTax - invoice.taxAmount) > 0.01)) issues.push({ code: 'INCOMING_LINES_TOTAL_MISMATCH', message: 'Zeilensummen stimmen nicht mit dem Beleg überein.', blocking: true });
  // Incoming invoices currently have no persisted tax-evidence seam. Resolve
  // the requirement from the canonical tax-case definitions across the invoice
  // and its lines, then refuse to post before creating an unexportable journal.
  const incomingTaxCaseKeys = new Set<string>();
  if (invoice.taxCaseKey) incomingTaxCaseKeys.add(invoice.taxCaseKey);
  for (const line of invoice.lines) {
    const lineTaxCase = invoice.taxCaseKey ?? taxCaseForRate(line.taxRate);
    if (lineTaxCase) incomingTaxCaseKeys.add(lineTaxCase);
  }
  const incomingMissingDatevEvidence = [...incomingTaxCaseKeys].some((taxCaseKey) => {
    const definition = getTaxCaseByKey(db, taxCaseKey);
    return Boolean(definition && (definition.requiresCountry || definition.requiresCounterpartyVatId || definition.requiresEvidence));
  });
  if (incomingMissingDatevEvidence) {
    issues.push({ code: 'INCOMING_DATEV_EVIDENCE_REQUIRED', message: 'Dieser Steuerfall benötigt persistierte DATEV-Steuer- und Nachweisdaten vor der Buchung.', blocking: true });
  }
  const lines: AccountingSnapshot['lines'] = [];
  const inputVatByCase = new Map<string, number>();
  for (const line of invoice.lines) {
    const accountNumber = line.assetAccountNumber || line.accountNumber || mappings.expense;
    if (!accountExists(db, policy.activeChart, accountNumber)) issues.push({ code: 'UNKNOWN_ACCOUNT', message: `Konto ${accountNumber} fehlt im ${policy.activeChart}.`, blocking: true });
    const candidateTaxCase = invoice.taxCaseKey ?? taxCaseForRate(line.taxRate);
    const definition = getTaxCaseByKey(db, candidateTaxCase);
    const carriesDatevCase = Boolean(definition && (definition.mechanism === 'reverse_charge' || definition.requiresCountry || definition.requiresEvidence));
    // Preserve the tax case even when the stated VAT is zero (notably
    // NON_EU_SERVICE_RC); the evidence guard above still prevents posting until
    // the incoming document model can carry the required facts.
    const taxCaseKey = line.taxAmount > 0 || carriesDatevCase ? candidateTaxCase : undefined;
    lines.push({ accountNumber, debitAmount: line.netAmount, creditAmount: 0, taxCaseKey, netAmount: line.taxAmount > 0 ? line.netAmount : undefined, taxRate: line.taxAmount > 0 ? line.taxRate : undefined, taxAmount: line.taxAmount > 0 ? line.taxAmount : undefined, grossAmount: line.taxAmount > 0 ? line.grossAmount : undefined, memo: line.description });
    if (taxCaseKey) inputVatByCase.set(taxCaseKey, amount((inputVatByCase.get(taxCaseKey) ?? 0) + line.taxAmount));
  }
  if (invoice.taxAmount > 0) {
    if (!inputVatByCase.size) inputVatByCase.set(invoice.taxCaseKey ?? taxCaseForRate(invoice.taxRate), invoice.taxAmount);
    for (const [taxCaseKey, taxAmount] of inputVatByCase) {
      const inputAccount = resolveTaxAccountsForCase(db, policy.activeChart, taxCaseKey).inputTaxAccount ?? mappings.input_vat;
      if (!accountExists(db, policy.activeChart, inputAccount)) issues.push({ code: 'UNKNOWN_ACCOUNT', message: `Konto ${inputAccount} fehlt im ${policy.activeChart}.`, blocking: true });
      lines.push({ accountNumber: inputAccount, debitAmount: taxAmount, creditAmount: 0, memo: `Vorsteuer ${taxCaseKey}` });
    }
  }
  lines.push({ accountNumber: mappings.accounts_payable, debitAmount: 0, creditAmount: invoice.grossAmount, memo: `Kreditor ${invoice.number}` });
  const snapshot: AccountingSnapshot = { sourceType: 'incoming_invoice', sourceId: invoiceId, sourceVersion: incomingSourceVersion(invoice), chart: policy.activeChart, vatMethod: policy.vatMethod, netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount, lines, capturedAt: now() };
  return issues.length ? { sourceType: 'incoming_invoice', sourceId: invoiceId, status: 'unresolved', issues } : { sourceType: 'incoming_invoice', sourceId: invoiceId, status: 'ready', snapshot, issues: [] };
};

export const postIncomingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string, options: { softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext } = {}): AccountingPostingPreview => {
  const reason = auditReason(options.mutation?.reason);
  const tenantId = tenant(scope);
  const existingRow = db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? AND id = ?').get(tenantId, invoiceId) as Record<string, any> | undefined;
  if (!existingRow) throw new Error('Incoming invoice not found');
  if (existingRow.accounting_status === 'posted' && existingRow.accounting_snapshot_json) {
    const snapshot = json<AccountingSnapshot>(existingRow.accounting_snapshot_json);
    if (snapshot) return { sourceType: 'incoming_invoice', sourceId: invoiceId, status: 'ready', snapshot, issues: [] };
  }
  if (existingRow.accounting_status === 'reversed' || existingRow.status === 'cancelled' || existingRow.status === 'draft') throw new Error('DOCUMENT_NOT_POSTABLE');
  const preview = previewIncomingInvoice(db, scope, invoiceId);
  if (preview.status === 'unresolved' || !preview.snapshot) { db.prepare('UPDATE incoming_invoices SET accounting_status = ? WHERE tenant_id = ? AND id = ?').run('unresolved', tenantId, invoiceId); return preview; }
  const row = existingRow;
  if (row.accounting_status === 'posted') return preview;
  const journalEntryId = db.transaction(() => {
    const id = insertJournal(db, tenantId, 'incoming_invoice', `incoming-invoice:${invoiceId}`, row.invoice_date, `Eingangsrechnung ${row.number}`, preview.snapshot!.lines, { chart: preview.snapshot!.chart, ...options });
    const timestamp = now();
    db.prepare(`INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date, original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at) VALUES (?, ?, 'creditor', ?, 'incoming_invoice', ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?) ON CONFLICT(tenant_id, source_type, source_id) DO NOTHING`).run(randomUUID(), tenantId, row.vendor_id, invoiceId, row.number, row.invoice_date, row.due_date, preview.snapshot!.grossAmount, preview.snapshot!.grossAmount, id, timestamp, timestamp);
    db.prepare('UPDATE incoming_invoices SET accounting_status = \'posted\', accounting_snapshot_json = ?, accounting_journal_entry_id = ?, accounting_posted_at = ?, status = CASE WHEN status = \'draft\' THEN \'open\' ELSE status END WHERE tenant_id = ? AND id = ?').run(JSON.stringify(preview.snapshot), id, timestamp, tenantId, invoiceId);
    appendAuditLog(db, { entityType: 'incoming_invoice', entityId: invoiceId, action: 'accounting_post', reason, before: { accountingStatus: row.accounting_status }, after: { journalEntryId: id, snapshot: preview.snapshot }, actor: options.mutation?.actor?.displayName || 'pro' });
    return id;
  })();
  void journalEntryId;
  return preview;
};

export const listOpenItems = (db: Database.Database, scope: TenantScope): OpenItemEntity[] => (db.prepare('SELECT * FROM open_items WHERE tenant_id = ? ORDER BY due_date, document_number').all(tenant(scope)) as Array<Record<string, any>>).map((row) => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id, sourceType: row.source_type, sourceId: row.source_id, documentNumber: row.document_number, documentDate: row.document_date, dueDate: row.due_date, originalAmount: Number(row.original_amount), allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }));

const paymentFromRow = (row: Record<string, any>): OpenItemPaymentEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status ?? (Number(row.residual_amount) > 0 ? 'overpaid' : 'allocated'), journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at });

type PaymentInput = { paymentId?: string; sourceType: OpenItemPaymentEntity['sourceType']; sourceId: string; partyType: OpenItemPaymentEntity['partyType']; partyId?: string; paymentDate: string; amount: number; bankAccountNumber: string; method?: string; allocations: Array<{ openItemId: string; amount: number }>; reason?: string; allocationEventId?: string; mutation?: AccountingMutationContext };

const validatePaymentSource = (db: Database.Database, tenantId: string, input: PaymentInput, allowBookedSource = false): { partyId?: string } => {
  if (!isIsoDate(input.paymentDate)) throw new Error('INVALID_PAYMENT_DATE');
  const total = amount(input.amount);
  if (total <= 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  if (input.sourceType === 'bank_transaction') {
    const row = db.prepare('SELECT tenant_id, amount, date, status, linked_invoice_id FROM bank_transactions WHERE tenant_id = ? AND id = ?').get(tenantId, input.sourceId) as { tenant_id: string; amount: number; date: string; status: string; linked_invoice_id: string | null } | undefined;
    if (!row) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    if (amount(Math.abs(row.amount)) !== total || row.date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (!allowBookedSource && (row.status === 'booked' || row.linked_invoice_id)) throw new Error('PAYMENT_SOURCE_ALREADY_BOOKED');
  } else if (input.sourceType === 'invoice_payment') {
    const row = db.prepare('SELECT p.amount, p.date, i.client_id FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?').get(input.sourceId) as { amount: number; date: string; client_id: string | null } | undefined;
    if (!row) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    if (amount(Math.abs(row.amount)) !== total || row.date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    return { partyId: row.client_id ?? undefined };
  }
  return {};
};

const addPaymentAllocations = (db: Database.Database, tenantId: string, payment: Record<string, any>, allocations: Array<{ openItemId: string; amount: number }>, policy: ReturnType<typeof getAccountingPolicyForPro>): void => {
  const timestamp = now();
  const requestedAmount = amount(allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
  const existingAmount = Number((db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM open_item_allocations WHERE tenant_id = ? AND payment_id = ?').get(tenantId, payment.id) as { total: number }).total);
  if (amount(existingAmount + requestedAmount) > amount(payment.amount) + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
  const insertAllocation = db.prepare('INSERT INTO open_item_allocations (id, tenant_id, payment_id, open_item_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const allocation of allocations) {
    const value = amount(allocation.amount);
    if (value <= 0) throw new Error('INVALID_PAYMENT_ALLOCATION');
    const item = db.prepare('SELECT * FROM open_items WHERE tenant_id = ? AND id = ?').get(tenantId, allocation.openItemId) as Record<string, any> | undefined;
    if (!item || item.party_type !== payment.party_type || (payment.party_id && item.party_id !== payment.party_id)) throw new Error('OPEN_ITEM_PARTY_MISMATCH');
    if (value > Number(item.residual_amount) + 0.01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
    const beforeAllocated = amount(item.allocated_amount);
    const allocationId = randomUUID();
    insertAllocation.run(allocationId, tenantId, payment.id, item.id, value, timestamp);
    const allocated = amount(beforeAllocated + value); const residual = amount(Number(item.original_amount) - allocated);
    const status = residual > 0 ? 'partially_paid' : 'paid';
    db.prepare('UPDATE open_items SET allocated_amount = ?, residual_amount = ?, status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(allocated, Math.max(0, residual), status, timestamp, tenantId, item.id);
    const documentStatus = status === 'paid' ? 'paid' : 'open';
    if (item.source_type === 'outgoing_invoice') db.prepare("UPDATE invoices SET status = ? WHERE id = ? AND accounting_status = 'posted' AND status <> 'cancelled'").run(documentStatus, item.source_id);
    if (item.source_type === 'incoming_invoice') db.prepare("UPDATE incoming_invoices SET status = ? WHERE tenant_id = ? AND id = ? AND accounting_status = 'posted' AND status <> 'cancelled'").run(documentStatus, tenantId, item.source_id);

    // Ist-USt is recognized only for the allocated share, using the immutable
    // posted snapshot.  Residual/overpayment never creates VAT recognition.
    if (item.source_type === 'outgoing_invoice' && policy.vatMethod === 'ist') {
      const snapshotRow = db.prepare('SELECT accounting_snapshot_json FROM invoices WHERE id = ?').get(item.source_id) as { accounting_snapshot_json: string | null } | undefined;
      const snapshot = json<AccountingSnapshot>(snapshotRow?.accounting_snapshot_json);
      const invoiceGross = snapshot?.grossAmount ?? Number(item.original_amount);
      if (snapshot && invoiceGross > 0) {
        const basisLines = snapshot.lines.filter((line) => line.creditAmount > 0 && line.memo?.startsWith('UStBasis '));
        const taxByCase = new Map<string, { accountNumber: string; taxAmount: number }>();
        for (const line of snapshot.lines.filter((candidate) => candidate.memo?.startsWith('USt '))) {
          const taxCaseKey = line.memo!.slice('USt '.length);
          taxByCase.set(taxCaseKey, { accountNumber: line.accountNumber, taxAmount: amount(line.creditAmount) });
        }
        // Soll snapshots carry the case/net/tax metadata on the revenue basis
        // line. Ist snapshots intentionally omit it from journal metadata so
        // VAT is not reported before payment; their stable basis memo above
        // supplies the same immutable breakdown here.
        const metadataBases = snapshot.lines.filter((line) => line.creditAmount > 0 && line.taxCaseKey && line.netAmount !== undefined && line.taxAmount !== undefined && line.grossAmount !== undefined);
        const bases = basisLines.length ? basisLines : metadataBases;
        const fallbackTax = snapshot.taxAmount ?? 0;
        const fallbackCase = metadataBases[0]?.taxCaseKey ?? 'DE_STD_19';
        const fallbackTaxAccount = getMapping(db, tenantId, policy.activeChart).output_vat_deferred;
        const payableLines: AccountingSnapshot['lines'] = [];
        for (const basis of bases.length ? bases : [{ creditAmount: snapshot.netAmount, memo: `UStBasis ${fallbackCase}` } as AccountingSnapshot['lines'][number]]) {
          const taxCaseKey = basis.taxCaseKey ?? basis.memo?.slice('UStBasis '.length) ?? fallbackCase;
          const control = taxByCase.get(taxCaseKey);
          const taxForBasis = control?.taxAmount ?? (bases.length === 1 ? fallbackTax : 0);
          const basisGross = control ? amount(basis.creditAmount + taxForBasis) : (basis.grossAmount ?? amount(basis.creditAmount + taxForBasis));
          const previousRecognized = amount((taxForBasis * Math.min(beforeAllocated, invoiceGross) * basisGross) / (invoiceGross * basisGross));
          const recognized = amount((taxForBasis * Math.min(allocated, invoiceGross) * basisGross) / (invoiceGross * basisGross));
          const delta = amount(recognized - previousRecognized);
          if (delta <= 0) continue;
          const grossShare = amount((Math.min(value, invoiceGross) * basisGross) / invoiceGross);
          const netShare = amount(grossShare - delta);
          const deferred = control?.accountNumber ?? fallbackTaxAccount;
          const output = resolveTaxAccountsForCase(db, policy.activeChart, taxCaseKey).outputTaxAccount ?? getMapping(db, tenantId, policy.activeChart).output_vat;
          payableLines.push({ accountNumber: deferred, debitAmount: delta, creditAmount: 0, taxCaseKey, netAmount: netShare, taxAmount: delta, grossAmount: grossShare });
          payableLines.push({ accountNumber: output, debitAmount: 0, creditAmount: delta });
        }
        if (payableLines.length) insertJournal(db, tenantId, 'payment_vat', `payment-vat:${payment.id}:${allocationId}`, payment.payment_date, 'USt Vereinnahmung', payableLines, { chart: policy.activeChart });
      }
    }
  }
  const allocatedAmount = amount((db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM open_item_allocations WHERE tenant_id = ? AND payment_id = ?').get(tenantId, payment.id) as { total: number }).total);
  const residualAmount = amount(Number(payment.amount) - allocatedAmount);
  db.prepare('UPDATE open_item_payments SET allocated_amount = ?, residual_amount = ?, status = ? WHERE tenant_id = ? AND id = ?').run(allocatedAmount, residualAmount, residualAmount > 0 ? 'overpaid' : 'allocated', tenantId, payment.id);
  if (payment.source_type === 'bank_transaction') {
    const linked = db.prepare(`SELECT source_id FROM open_items oi JOIN open_item_allocations oa ON oa.open_item_id = oi.id
      WHERE oa.tenant_id = ? AND oa.payment_id = ? AND oi.source_type = 'outgoing_invoice' ORDER BY oa.created_at LIMIT 1`).get(tenantId, payment.id) as { source_id: string } | undefined;
    db.prepare("UPDATE bank_transactions SET status = 'booked', linked_invoice_id = COALESCE(?, linked_invoice_id), updated_at = ? WHERE tenant_id = ? AND id = ?").run(linked?.source_id ?? null, timestamp, tenantId, payment.source_id);
  }
};

export const allocateOpenItemPayment = (db: Database.Database, scope: TenantScope, input: PaymentInput): OpenItemPaymentEntity => {
  const reason = auditReason(input.mutation?.reason ?? input.reason);
  const allocationEventId = allocationEvent(input.allocationEventId);
  const tenantId = assertDesktopTenant(scope); const timestamp = now();
  const knownDuplicate = !input.paymentId ? db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND source_type = ? AND source_id = ?').get(tenantId, input.sourceType, input.sourceId) as Record<string, any> | undefined : undefined;
  if (knownDuplicate) {
    if (knownDuplicate.party_type !== input.partyType || (input.partyId && knownDuplicate.party_id !== input.partyId) || amount(knownDuplicate.amount) !== amount(input.amount) || knownDuplicate.payment_date !== input.paymentDate || knownDuplicate.bank_account_number !== input.bankAccountNumber) throw new Error('PAYMENT_SOURCE_MISMATCH');
    return paymentFromRow(knownDuplicate);
  }
  const policy = getAccountingPolicyForPro(db, scope); const mapping = getMapping(db, tenantId, policy.activeChart);
  const source = validatePaymentSource(db, tenantId, input, Boolean(input.paymentId));
  if ((input.sourceType === 'bank_transaction' || input.sourceType === 'invoice_payment') && !input.partyId && !source.partyId) throw new Error('PAYMENT_PARTY_REQUIRED');
  if (source.partyId && input.partyId && source.partyId !== input.partyId) throw new Error('PAYMENT_PARTY_MISMATCH');
  if (input.paymentId) {
    const existing = db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, input.paymentId) as Record<string, any> | undefined;
    if (!existing) throw new Error('PAYMENT_NOT_FOUND');
    if (existing.source_type !== input.sourceType || existing.source_id !== input.sourceId || existing.party_type !== input.partyType || amount(existing.amount) !== amount(input.amount) || existing.payment_date !== input.paymentDate) throw new Error('PAYMENT_SOURCE_MISMATCH');
    if (amount(input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)) > Number(existing.residual_amount) + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
    db.transaction(() => {
      addPaymentAllocations(db, tenantId, existing, input.allocations, policy);
    })();
    return paymentFromRow(db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, existing.id) as Record<string, any>);
  }
  if (!accountExists(db, policy.activeChart, input.bankAccountNumber)) throw new Error(`UNKNOWN_ACCOUNT:${input.bankAccountNumber}`);
  const total = amount(input.amount); const allocationTotal = amount(input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
  if (allocationTotal > total + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_PAYMENT');
  const itemRows = input.allocations.map((allocation) => db.prepare('SELECT party_type, party_id FROM open_items WHERE tenant_id = ? AND id = ?').get(tenantId, allocation.openItemId) as { party_type: string; party_id: string } | undefined).filter(Boolean) as Array<{ party_type: string; party_id: string }>;
  const derivedParty = source.partyId ?? itemRows[0]?.party_id;
  if (!derivedParty) throw new Error('PAYMENT_PARTY_REQUIRED');
  if (input.partyId && derivedParty && input.partyId !== derivedParty) throw new Error('PAYMENT_PARTY_MISMATCH');
  if (itemRows.some((item) => item.party_type !== input.partyType || item.party_id !== (input.partyId ?? derivedParty))) throw new Error('PAYMENT_PARTY_MISMATCH');
  const paymentId = randomUUID();
  db.transaction(() => {
    const journalLines: AccountingSnapshot['lines'] = input.partyType === 'debtor'
      ? [{ accountNumber: input.bankAccountNumber, debitAmount: total, creditAmount: 0 }, { accountNumber: mapping.accounts_receivable, debitAmount: 0, creditAmount: total }]
      : [{ accountNumber: mapping.accounts_payable, debitAmount: total, creditAmount: 0 }, { accountNumber: input.bankAccountNumber, debitAmount: 0, creditAmount: total }];
    const journalEntryId = insertJournal(db, tenantId, 'payment', `payment:${input.sourceType}:${input.sourceId}`, input.paymentDate, 'Zahlung', journalLines, { chart: policy.activeChart });
    db.prepare(`INSERT INTO open_item_payments (id, tenant_id, party_type, party_id, payment_date, amount, bank_account_number, method, source_type, source_id, allocated_amount, residual_amount, status, journal_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'overpaid', ?, ?)`).run(paymentId, tenantId, input.partyType, input.partyId ?? derivedParty ?? null, input.paymentDate, total, input.bankAccountNumber, input.method ?? null, input.sourceType, input.sourceId, total, journalEntryId, timestamp);
    const payment = db.prepare('SELECT * FROM open_item_payments WHERE id = ?').get(paymentId) as Record<string, any>;
    addPaymentAllocations(db, tenantId, payment, input.allocations, policy);
    if (input.sourceType === 'bank_transaction') {
      const linked = input.allocations.find((allocation) => (db.prepare('SELECT source_type FROM open_items WHERE tenant_id = ? AND id = ?').get(tenantId, allocation.openItemId) as { source_type: string } | undefined)?.source_type === 'outgoing_invoice');
      db.prepare('UPDATE bank_transactions SET status = \'booked\', linked_invoice_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(linked ? (db.prepare('SELECT source_id FROM open_items WHERE tenant_id = ? AND id = ?').get(tenantId, linked.openItemId) as { source_id: string }).source_id : null, timestamp, tenantId, input.sourceId);
    }
    appendAuditLog(db, { entityType: 'open_item_payment', entityId: paymentId, action: 'allocate', reason, before: null, after: { ...input, allocationEventId }, actor: input.mutation?.actor?.displayName || 'pro' });
  })();
  return paymentFromRow(db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, paymentId) as Record<string, any>);
};

export const allocateRemainingOpenItemPayment = (db: Database.Database, scope: TenantScope, paymentId: string, allocations: Array<{ openItemId: string; amount: number }>, allocationEventId?: string, mutation?: AccountingMutationContext): OpenItemPaymentEntity => {
  const reason = auditReason(mutation?.reason);
  const eventId = allocationEvent(allocationEventId);
  const tenantId = assertDesktopTenant(scope);
  const payment = db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, paymentId) as Record<string, any> | undefined;
  if (!payment) throw new Error('PAYMENT_NOT_FOUND');
  const priorEvents = db.prepare("SELECT after_json FROM audit_log WHERE entity_type = 'open_item_payment' AND entity_id = ? AND action = 'allocate_remaining'").all(paymentId) as Array<{ after_json?: string | null }>;
  if (priorEvents.some(({ after_json }) => {
    try { return JSON.parse(after_json ?? 'null')?.allocationEventId === eventId; } catch { return false; }
  })) return paymentFromRow(db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, paymentId) as Record<string, any>);
  const policy = getAccountingPolicyForPro(db, scope);
  db.transaction(() => {
    const requested = amount(allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
    if (requested > Number(payment.residual_amount) + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
    addPaymentAllocations(db, tenantId, payment, allocations, policy);
    const allocated = db.prepare('SELECT allocated_amount, amount FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, paymentId) as { allocated_amount: number; amount: number };
    const residual = amount(allocated.amount - allocated.allocated_amount);
    db.prepare('UPDATE open_item_payments SET residual_amount = ?, status = ? WHERE tenant_id = ? AND id = ?').run(residual, residual > 0 ? 'overpaid' : 'allocated', tenantId, paymentId);
    appendAuditLog(db, { entityType: 'open_item_payment', entityId: paymentId, action: 'allocate_remaining', reason, before: { residualAmount: payment.residual_amount }, after: { allocations, allocationEventId: eventId }, actor: mutation?.actor?.displayName || 'pro' });
  })();
  return paymentFromRow(db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND id = ?').get(tenantId, paymentId) as Record<string, any>);
};

type FinalizedInvoiceReservation = { id: string; kind: string; number: string; status: string; document_id: string };

const finalizedInvoiceReservation = (db: Database.Database, row: InvoiceRow | null): FinalizedInvoiceReservation | null => row ? (db.prepare(`SELECT id, kind, number, status, document_id
  FROM number_reservations
  WHERE kind = 'invoice' AND status = 'finalized' AND document_id = ? AND number = ?
  LIMIT 1`).get(row.id, row.number) as FinalizedInvoiceReservation | undefined) ?? null : null;

const outgoingBackfillSourceVersion = (row: InvoiceRow, lines: RawLine[], reservation: FinalizedInvoiceReservation | null): string => sha256({
  documentVersion: outgoingSourceVersion(row, lines),
  eligibility: {
    status: row.status,
    accountingStatus: row.accounting_status,
    reservation: reservation ? { id: reservation.id, kind: reservation.kind, number: reservation.number, status: reservation.status, documentId: reservation.document_id } : null,
  },
});

const backfillCandidateVersion = (db: Database.Database, candidate: AccountingBackfillPreview['candidates'][number], scope: TenantScope): { sourceVersion: string; snapshot?: unknown; status: 'ready' | 'unresolved'; reason?: string } => {
  if (candidate.sourceType === 'outgoing_invoice') {
    const row = invoiceRow(db, 'default', candidate.sourceId);
    if (!row) return { sourceVersion: sha256({ missing: candidate.sourceId }), status: 'unresolved', reason: 'Invoice not found.' };
    const preview = previewOutgoingInvoice(db, scope, candidate.sourceId);
    const lines = invoiceLines(db, candidate.sourceId);
    const reservation = finalizedInvoiceReservation(db, row);
    const eligible = Boolean(row.status !== 'draft' && row.status !== 'cancelled' && reservation && row.accounting_status !== 'posted' && row.accounting_status !== 'reversed');
    return {
      sourceVersion: outgoingBackfillSourceVersion(row, lines, reservation),
      snapshot: stableSnapshot(preview.snapshot),
      status: eligible ? preview.status : 'unresolved',
      reason: eligible ? preview.issues[0]?.message : 'Outgoing invoice is not finalized for accounting backfill.',
    };
  }
  if (candidate.sourceType === 'incoming_invoice') {
    const row = db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? AND id = ?').get('default', candidate.sourceId) as Record<string, any> | undefined;
    if (!row) return { sourceVersion: sha256({ missing: candidate.sourceId }), status: 'unresolved', reason: 'Incoming invoice not found.' };
    const preview = previewIncomingInvoice(db, scope, candidate.sourceId);
    const invoice = incomingFromRow(db, row);
    const eligible = row.status !== 'draft' && row.status !== 'cancelled' && row.accounting_status !== 'posted' && row.accounting_status !== 'reversed';
    return { sourceVersion: incomingBackfillSourceVersion(invoice, row.accounting_status), snapshot: stableSnapshot(preview.snapshot), status: eligible ? preview.status : 'unresolved', reason: eligible ? preview.issues[0]?.message : 'Incoming invoice is not eligible for accounting backfill.' };
  }
  const id = candidate.sourceId.startsWith('invoice_payment:') ? candidate.sourceId.slice('invoice_payment:'.length) : candidate.sourceId;
  const row = db.prepare(candidate.sourceId.startsWith('invoice_payment:') ? 'SELECT id, invoice_id, date, amount, method FROM invoice_payments WHERE id = ?' : 'SELECT id, date, amount, type, counterparty, purpose, linked_invoice_id, status, account_id FROM transactions WHERE id = ?').get(id) as Record<string, any> | undefined;
  return { sourceVersion: sha256(row ?? { id, missing: true }), status: 'unresolved', reason: candidate.reason };
};

export const previewAccountingBackfill = (db: Database.Database, scope: TenantScope): AccountingBackfillPreview => {
  const tenantId = assertDesktopTenant(scope); const policy = getAccountingPolicyForPro(db, scope); ensureMappingDefaults(db, tenantId);
  const candidates: AccountingBackfillPreview['candidates'] = [];
  const invoices = db.prepare(`SELECT i.id
    FROM invoices i
    JOIN number_reservations nr ON nr.kind = 'invoice' AND nr.status = 'finalized' AND nr.document_id = i.id AND nr.number = i.number
    WHERE i.status NOT IN ('draft', 'cancelled') AND COALESCE(i.accounting_status, 'unposted') NOT IN ('posted', 'reversed')
      AND COALESCE(i.document_kind, 'invoice') NOT IN ('order_confirmation', 'delivery_note')
    ORDER BY i.id`).all() as Array<{ id: string }>;
  for (const row of invoices) {
    const preview = previewOutgoingInvoice(db, scope, row.id);
    const source = invoiceRow(db, tenantId, row.id);
    const lines = source ? invoiceLines(db, row.id) : [];
    const reservation = finalizedInvoiceReservation(db, source);
    candidates.push({ sourceType: 'outgoing_invoice', sourceId: row.id, status: preview.status, reason: preview.issues[0]?.message, sourceVersion: source ? outgoingBackfillSourceVersion(source, lines, reservation) : sha256({ missing: row.id }), snapshot: stableSnapshot(preview.snapshot) });
  }
  const incoming = db.prepare("SELECT id FROM incoming_invoices WHERE tenant_id = ? AND accounting_status NOT IN ('posted', 'reversed') AND status NOT IN ('draft', 'cancelled') ORDER BY id").all(tenantId) as Array<{ id: string }>;
  for (const row of incoming) { const preview = previewIncomingInvoice(db, scope, row.id); const source = db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? AND id = ?').get(tenantId, row.id) as Record<string, any> | undefined; const invoice = source ? incomingFromRow(db, source) : undefined; candidates.push({ sourceType: 'incoming_invoice', sourceId: row.id, status: preview.status, reason: preview.issues[0]?.message, sourceVersion: source && invoice ? incomingBackfillSourceVersion(invoice, source.accounting_status) : sha256({ missing: row.id }), snapshot: stableSnapshot(preview.snapshot) }); }
  const legacyTransactions = db.prepare('SELECT id, date, amount, type, counterparty, purpose, linked_invoice_id, status, account_id FROM transactions ORDER BY id').all() as Array<Record<string, any>>;
  for (const row of legacyTransactions) candidates.push({ sourceType: 'legacy_transaction', sourceId: row.id, status: 'unresolved', reason: 'Legacy transaction requires explicit account and evidence review.', sourceVersion: sha256(row), snapshot: row });
  const legacyPayments = db.prepare('SELECT id, invoice_id, date, amount, method FROM invoice_payments ORDER BY id').all() as Array<Record<string, any>>;
  for (const row of legacyPayments) candidates.push({ sourceType: 'legacy_transaction', sourceId: `invoice_payment:${row.id}`, status: 'unresolved', reason: 'Legacy payment requires explicit open-item allocation review.', sourceVersion: sha256(row), snapshot: row });
  const confirmationHash = sha256({ tenantId, chart: policy.activeChart, vatMethod: policy.vatMethod, candidates });
  const runId = randomUUID();
  db.prepare('INSERT INTO accounting_backfill_runs (id, tenant_id, status, candidates_json, confirmation_hash, result_json, created_at) VALUES (?, ?, \'preview\', ?, ?, NULL, ?)').run(runId, tenantId, JSON.stringify(candidates), confirmationHash, now());
  appendAuditLog(db, { entityType: 'accounting_backfill', entityId: runId, action: 'preview', reason: 'dry-run accounting backfill', before: null, after: { readyCount: candidates.filter((candidate) => candidate.status === 'ready').length, unresolvedCount: candidates.filter((candidate) => candidate.status === 'unresolved').length, confirmationHash }, actor: 'pro' });
  return { runId, status: 'preview', candidates, readyCount: candidates.filter((candidate) => candidate.status === 'ready').length, unresolvedCount: candidates.filter((candidate) => candidate.status === 'unresolved').length, confirmationHash };
};

export const confirmAccountingBackfill = (db: Database.Database, scope: TenantScope, input: AccountingBackfillConfirmation): AccountingBackfillResult => {
  const tenantId = assertDesktopTenant(scope); const run = db.prepare('SELECT * FROM accounting_backfill_runs WHERE tenant_id = ? AND id = ?').get(tenantId, input.runId) as Record<string, any> | undefined;
  if (!run) throw new Error('BACKFILL_RUN_NOT_FOUND');
  if (run.status === 'completed' && run.result_json) return JSON.parse(run.result_json) as AccountingBackfillResult;
  if (run.status !== 'preview' || run.confirmation_hash !== input.confirmationHash) throw new Error('BACKFILL_CONFIRMATION_HASH_MISMATCH');
  const candidates = JSON.parse(run.candidates_json) as AccountingBackfillPreview['candidates'];
  // Revalidate the immutable candidate set before opening the write transaction.
  for (const candidate of candidates) {
    const current = backfillCandidateVersion(db, candidate, scope);
    if (current.sourceVersion !== candidate.sourceVersion || current.status !== candidate.status || (candidate.snapshot && JSON.stringify(current.snapshot) !== JSON.stringify(candidate.snapshot))) throw new Error('BACKFILL_STALE_PREVIEW');
  }
  let postedCount = 0; let unresolvedCount = 0;
  const result = db.transaction(() => {
    for (const candidate of candidates) {
      if (candidate.status !== 'ready') { unresolvedCount += 1; continue; }
      const posted = candidate.sourceType === 'outgoing_invoice'
        ? postOutgoingInvoice(db, scope, candidate.sourceId, { requireFinalizedReservation: true, reservationId: finalizedInvoiceReservation(db, invoiceRow(db, tenantId, candidate.sourceId))?.id })
        : postIncomingInvoice(db, scope, candidate.sourceId, { mutation: { reason: input.reason, actor: { type: 'system', displayName: 'accounting backfill' } } });
      if (posted.status === 'ready') postedCount += 1; else unresolvedCount += 1;
    }
    const output: AccountingBackfillResult = { runId: input.runId, postedCount, unresolvedCount, status: 'completed' };
    db.prepare('UPDATE accounting_backfill_runs SET status = \'completed\', confirmed_at = ?, completed_at = ?, result_json = ? WHERE tenant_id = ? AND id = ?').run(now(), now(), JSON.stringify(output), tenantId, input.runId);
    appendAuditLog(db, { entityType: 'accounting_backfill', entityId: input.runId, action: 'confirm', reason: input.reason, before: { status: 'preview' }, after: output, actor: 'pro' });
    return output;
  })();
  return result;
};

export const listOpenItemAllocations = (db: Database.Database, scope: TenantScope, openItemId?: string): OpenItemAllocationEntity[] => (db.prepare(`SELECT id, tenant_id, payment_id, open_item_id, amount, created_at FROM open_item_allocations WHERE tenant_id = ? ${openItemId ? 'AND open_item_id = ?' : ''} ORDER BY created_at`).all(...(openItemId ? [tenant(scope), openItemId] : [tenant(scope)])) as Array<Record<string, any>>).map((row) => ({ id: row.id, tenantId: row.tenant_id, paymentId: row.payment_id, openItemId: row.open_item_id, amount: Number(row.amount), createdAt: row.created_at }));

export const reverseDocumentAccounting = (db: Database.Database, scope: TenantScope, input: { documentType: 'outgoing_invoice' | 'incoming_invoice'; documentId: string; reason: string; postingDate?: string; softLockOverride?: boolean; overrideReason?: string }): { ok: true; reversalEntryId: string } => {
  const tenantId = assertDesktopTenant(scope);
  return db.transaction(() => {
    const table = input.documentType === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices';
    const row = db.prepare(`SELECT accounting_status, accounting_journal_entry_id FROM ${table} WHERE id = ? ${table === 'incoming_invoices' ? 'AND tenant_id = ?' : ''}`).get(...(table === 'incoming_invoices' ? [input.documentId, tenantId] : [input.documentId])) as { accounting_status: string; accounting_journal_entry_id: string | null } | undefined;
    if (!row || row.accounting_status !== 'posted' || !row.accounting_journal_entry_id) throw new Error('DOCUMENT_NOT_POSTED');
    if (input.documentType === 'incoming_invoice' && db.prepare(`SELECT 1 FROM assets
      WHERE tenant_id = ? AND (activation_journal_entry_id = ? OR source_incoming_invoice_id = ?)
      LIMIT 1`).get(tenantId, row.accounting_journal_entry_id, input.documentId)) {
      throw new Error('ASSET_CORRECTION_REQUIRED: correct linked asset before reversing its source document');
    }
    const item = db.prepare('SELECT id FROM open_items WHERE tenant_id = ? AND source_type = ? AND source_id = ?').get(tenantId, input.documentType, input.documentId) as { id: string } | undefined;
    if (item && Number((db.prepare('SELECT COUNT(*) AS c FROM open_item_allocations WHERE tenant_id = ? AND open_item_id = ?').get(tenantId, item.id) as { c: number }).c) > 0) throw new Error('DOCUMENT_HAS_ALLOCATIONS');
    const reversal = reverseDocumentJournalEntry(db, row.accounting_journal_entry_id, input.reason, scope, { postingDate: input.postingDate, softLockOverride: input.softLockOverride, overrideReason: input.softLockOverride ? input.overrideReason : undefined });
    if (item) db.prepare("UPDATE open_items SET status = 'unresolved', residual_amount = 0, updated_at = ? WHERE tenant_id = ? AND id = ?").run(now(), tenantId, item.id);
    if (table === 'invoices') db.prepare("UPDATE invoices SET accounting_status = 'reversed', status = 'cancelled' WHERE id = ?").run(input.documentId);
    else db.prepare("UPDATE incoming_invoices SET accounting_status = 'reversed', status = 'cancelled' WHERE tenant_id = ? AND id = ?").run(tenantId, input.documentId);
    const overrideReason = input.overrideReason?.trim();
    const auditReason = overrideReason ? `${input.reason.trim()} (soft-lock override: ${overrideReason})` : input.reason.trim();
    appendAuditLog(db, { entityType: input.documentType, entityId: input.documentId, action: 'accounting_reverse', reason: auditReason, before: { accountingStatus: 'posted' }, after: { ...reversal, reversalReason: input.reason.trim(), softLockOverrideReason: overrideReason || undefined }, actor: 'pro' });
    return reversal;
  })();
};
