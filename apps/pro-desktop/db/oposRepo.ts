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
import { getAccountingPolicy } from './proAccountingRepo';

export type AccountingRole = AccountingAccountMapping['role'];
export type AccountingChart = 'SKR03' | 'SKR04';
export type VatAccountingMethod = 'soll' | 'ist';

type InvoiceRow = {
  id: string; client_id: string | null; number: string; date: string; due_date: string;
  amount: number; status: string; tax_snapshot_json: string | null; accounting_status: string;
  accounting_snapshot_json: string | null; accounting_journal_entry_id: string | null;
};

type RawLine = {
  id: number; description: string; quantity: number; price: number; total: number; tax_rate: number | null;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const cents = (value: number): number => Math.round((Number(value) + Number.EPSILON) * 100);
const amount = (value: number): number => round2(cents(value) / 100);
const now = (): string => new Date().toISOString();
const json = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};
const sha256 = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tenant = (scope: TenantScope): string => getTenantId(scope);
const period = (date: string): string => date.slice(0, 7);
const fiscalYear = (date: string): number => Number(date.slice(0, 4));

const defaultMappings: Record<AccountingChart, Record<AccountingRole, string>> = {
  SKR03: {
    accounts_receivable: '1400', accounts_payable: '1600', bank: '1200', revenue: '8400',
    expense: '4900', asset: '0480', output_vat: '1776', input_vat: '1576',
  },
  SKR04: {
    accounts_receivable: '1200', accounts_payable: '3300', bank: '1800', revenue: '4400',
    expense: '6300', asset: '0670', output_vat: '3806', input_vat: '1406',
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
  return !chartHasRows || Boolean(db.prepare('SELECT 1 FROM ledger_accounts WHERE chart = ? AND account_number = ?').get(chart, accountNumber));
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

const insertJournal = (
  db: Database.Database,
  tenantId: string,
  sourceType: string,
  sourceKey: string,
  postingDate: string,
  bookingText: string,
  lines: AccountingSnapshot['lines'],
): string => {
  const existing = db.prepare('SELECT id FROM journal_entries WHERE tenant_id = ? AND source_type = ? AND source_key = ?').get(tenantId, sourceType, sourceKey) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const entryNumber = Number((db.prepare('SELECT COALESCE(MAX(entry_number), 0) AS n FROM journal_entries WHERE tenant_id = ?').get(tenantId) as { n: number }).n) + 1;
  const entryLines = lines.map((line, index) => ({ ...line, id: randomUUID(), index }));
  const debit = entryLines.reduce((sum, line) => sum + cents(line.debitAmount), 0);
  const credit = entryLines.reduce((sum, line) => sum + cents(line.creditAmount), 0);
  if (debit !== credit || debit <= 0) throw new Error('UNBALANCED_ENTRY');
  const timestamp = now();
  db.prepare(`INSERT INTO journal_entries
    (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`).run(
    id, tenantId, entryNumber, postingDate, postingDate, bookingText, sourceKey,
    period(postingDate), fiscalYear(postingDate), sourceType, sourceKey, timestamp,
  );
  const insertLine = db.prepare(`INSERT INTO journal_lines
    (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const line of entryLines) {
    insertLine.run(line.id, tenantId, id, line.index + 1, line.accountNumber, amount(line.debitAmount), amount(line.creditAmount), null, null, line.taxRate ?? null, null, line.taxAmount ?? null, null, null, null, null, null, null, line.memo ?? null);
  }
  return id;
};

const invoiceRow = (db: Database.Database, tenantId: string, invoiceId: string): InvoiceRow | null => db.prepare(`SELECT id, client_id, number, date, due_date, amount, status, tax_snapshot_json, accounting_status, accounting_snapshot_json, accounting_journal_entry_id FROM invoices WHERE id = ?`).get(invoiceId) as InvoiceRow | null;
const invoiceLines = (db: Database.Database, invoiceId: string): RawLine[] => db.prepare('SELECT id, description, quantity, price, total, tax_rate FROM invoice_items WHERE invoice_id = ? ORDER BY position, id').all(invoiceId) as RawLine[];

const deriveTaxSnapshot = (row: InvoiceRow, lines: RawLine[], chart: AccountingChart, vatMethod: VatAccountingMethod): { snapshot?: AccountingSnapshot; issues: AccountingPostingPreview['issues'] } => {
  const explicit = json<{ netAmount?: number; vatAmount?: number; grossAmount?: number }>(row.tax_snapshot_json);
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
  const mapping = defaultMappings[chart];
  const linesOut: AccountingSnapshot['lines'] = [
    { accountNumber: mapping.accounts_receivable, debitAmount: gross, creditAmount: 0, memo: `Debitor ${row.number}` },
    { accountNumber: mapping.revenue, debitAmount: 0, creditAmount: net, taxAmount: tax },
  ];
  if (tax > 0) linesOut.push({ accountNumber: mapping.output_vat, debitAmount: 0, creditAmount: tax, taxAmount: tax });
  const snapshot: AccountingSnapshot = {
    sourceType: 'outgoing_invoice', sourceId: row.id, sourceVersion: sha256({ row, lines }), chart, vatMethod,
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
  ensureMappingDefaults(db, tenantId);
  const updatedAt = now();
  db.prepare(`INSERT INTO accounting_policies (tenant_id, active_chart, vat_method, period_policy, updated_at) VALUES (?, ?, ?, 'calendar_month', ?)
    ON CONFLICT(tenant_id) DO UPDATE SET active_chart = excluded.active_chart, vat_method = excluded.vat_method, updated_at = excluded.updated_at`).run(tenantId, input.activeChart, input.vatMethod, updatedAt);
  appendAuditLog(db, { entityType: 'accounting_policy', entityId: tenantId, action: 'update', reason: 'accounting policy changed', before: null, after: input, actor: 'pro' });
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
  const tenantId = tenant(scope);
  const row = invoiceRow(db, tenantId, invoiceId);
  if (!row) throw new Error('Invoice not found');
  const policy = getAccountingPolicyForPro(db, scope);
  const mappings = getMapping(db, tenantId, policy.activeChart);
  const issues = validateMapping(db, policy.activeChart, mappings, ['accounts_receivable', 'revenue']);
  const tax = deriveTaxSnapshot(row, invoiceLines(db, invoiceId), policy.activeChart, policy.vatMethod);
  issues.push(...tax.issues);
  if (tax.snapshot?.taxAmount) issues.push(...validateMapping(db, policy.activeChart, mappings, ['output_vat']));
  if (issues.length || !tax.snapshot) return { sourceType: 'outgoing_invoice', sourceId: invoiceId, status: 'unresolved', issues };
  // Respect tenant overrides after deriving the snapshot.
  tax.snapshot.lines[0]!.accountNumber = mappings.accounts_receivable;
  tax.snapshot.lines[1]!.accountNumber = mappings.revenue;
  if (tax.snapshot.lines[2]) tax.snapshot.lines[2].accountNumber = mappings.output_vat;
  return { sourceType: 'outgoing_invoice', sourceId: invoiceId, status: 'ready', snapshot: tax.snapshot, issues: [] };
};

export const postOutgoingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string): AccountingPostingPreview => {
  const tenantId = tenant(scope);
  const preview = previewOutgoingInvoice(db, scope, invoiceId);
  if (preview.status === 'unresolved' || !preview.snapshot) {
    db.prepare('UPDATE invoices SET accounting_status = ? WHERE id = ?').run('unresolved', invoiceId);
    return preview;
  }
  const row = invoiceRow(db, tenantId, invoiceId)!;
  if (row.accounting_status === 'posted' && row.accounting_snapshot_json) return { ...preview, snapshot: json<AccountingSnapshot>(row.accounting_snapshot_json) ?? preview.snapshot };
  const sourceKey = `outgoing-invoice:${invoiceId}`;
  const result = db.transaction(() => {
    const journalEntryId = insertJournal(db, tenantId, 'outgoing_invoice', sourceKey, row.date, `Rechnung ${row.number}`, preview.snapshot!.lines);
    const timestamp = now();
    db.prepare(`INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date, original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at)
      VALUES (?, ?, 'debtor', ?, 'outgoing_invoice', ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?)
      ON CONFLICT(tenant_id, source_type, source_id) DO NOTHING`).run(randomUUID(), tenantId, row.client_id ?? row.id, invoiceId, row.number, row.date, row.due_date, preview.snapshot!.grossAmount, preview.snapshot!.grossAmount, journalEntryId, timestamp, timestamp);
    db.prepare(`UPDATE invoices SET accounting_status = 'posted', accounting_snapshot_json = ?, accounting_journal_entry_id = ?, accounting_posted_at = ? WHERE id = ?`).run(JSON.stringify(preview.snapshot), journalEntryId, timestamp, invoiceId);
    appendAuditLog(db, { entityType: 'invoice', entityId: invoiceId, action: 'accounting_post', reason: 'outgoing invoice finalized', before: { accountingStatus: row.accounting_status }, after: { journalEntryId, snapshot: preview.snapshot }, actor: 'pro' });
    return journalEntryId;
  })();
  void result;
  return preview;
};

const vendorFromRow = (row: Record<string, string>): VendorEntity => ({ id: row.id, tenantId: row.tenant_id, vendorNumber: row.vendor_number ?? undefined, name: row.name, email: row.email ?? undefined, address: row.address ?? undefined, vatId: row.vat_id ?? undefined, iban: row.iban ?? undefined, defaultExpenseAccount: row.default_expense_account ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });

export const listVendors = (db: Database.Database, scope: TenantScope): VendorEntity[] => (db.prepare('SELECT * FROM vendors WHERE tenant_id = ? ORDER BY name').all(tenant(scope)) as Array<Record<string, string>>).map(vendorFromRow);

export const upsertVendor = (db: Database.Database, scope: TenantScope, input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>): VendorEntity => {
  const tenantId = tenant(scope); const timestamp = now(); const id = input.id || randomUUID();
  db.prepare(`INSERT INTO vendors (id, tenant_id, vendor_number, name, email, address, vat_id, iban, default_expense_account, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET vendor_number=excluded.vendor_number, name=excluded.name, email=excluded.email, address=excluded.address, vat_id=excluded.vat_id, iban=excluded.iban, default_expense_account=excluded.default_expense_account, updated_at=excluded.updated_at`).run(id, tenantId, input.vendorNumber ?? null, input.name, input.email ?? null, input.address ?? null, input.vatId ?? null, input.iban ?? null, input.defaultExpenseAccount ?? null, timestamp, timestamp);
  appendAuditLog(db, { entityType: 'vendor', entityId: id, action: 'upsert', reason: 'vendor changed', before: null, after: input, actor: 'pro' });
  return listVendors(db, scope).find((row) => row.id === id)!;
};

const incomingFromRow = (db: Database.Database, row: Record<string, any>): IncomingInvoiceEntity => {
  const lines = (db.prepare('SELECT * FROM incoming_invoice_lines WHERE incoming_invoice_id = ? ORDER BY position').all(row.id) as Array<Record<string, any>>).map((line) => ({ id: line.id, incomingInvoiceId: line.incoming_invoice_id, position: line.position, description: line.description, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), netAmount: Number(line.net_amount), taxRate: Number(line.tax_rate), taxAmount: Number(line.tax_amount), grossAmount: Number(line.gross_amount), accountNumber: line.account_number ?? undefined, assetAccountNumber: line.asset_account_number ?? undefined }));
  return { id: row.id, tenantId: row.tenant_id, vendorId: row.vendor_id, number: row.number, invoiceDate: row.invoice_date, dueDate: row.due_date, servicePeriod: row.service_period ?? undefined, netAmount: Number(row.net_amount), taxAmount: Number(row.tax_amount), grossAmount: Number(row.gross_amount), status: row.status, taxRate: Number(row.tax_rate), taxCaseKey: row.tax_case_key ?? undefined, notes: row.notes ?? undefined, lines, accountingStatus: row.accounting_status, accountingSnapshot: json<AccountingSnapshot>(row.accounting_snapshot_json), createdAt: row.created_at, updatedAt: row.updated_at };
};

export const listIncomingInvoices = (db: Database.Database, scope: TenantScope): IncomingInvoiceEntity[] => (db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? ORDER BY invoice_date DESC, number').all(tenant(scope)) as Array<Record<string, any>>).map((row) => incomingFromRow(db, row));

export const upsertIncomingInvoice = (db: Database.Database, scope: TenantScope, input: IncomingInvoiceEntity): IncomingInvoiceEntity => {
  const tenantId = tenant(scope); const timestamp = now(); const id = input.id || randomUUID();
  const lines = input.lines ?? [];
  const net = amount(input.netAmount); const tax = amount(input.taxAmount); const gross = amount(input.grossAmount);
  if (Math.abs(gross - net - tax) > 0.01 || gross < 0 || net < 0 || tax < 0) throw new Error('INVALID_INCOMING_TOTALS');
  db.transaction(() => {
    db.prepare(`INSERT INTO incoming_invoices (id, tenant_id, vendor_id, number, invoice_date, due_date, service_period, net_amount, tax_amount, gross_amount, tax_rate, tax_case_key, notes, status, accounting_status, accounting_snapshot_json, accounting_journal_entry_id, accounting_posted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET vendor_id=excluded.vendor_id, number=excluded.number, invoice_date=excluded.invoice_date, due_date=excluded.due_date, service_period=excluded.service_period, net_amount=excluded.net_amount, tax_amount=excluded.tax_amount, gross_amount=excluded.gross_amount, tax_rate=excluded.tax_rate, tax_case_key=excluded.tax_case_key, notes=excluded.notes, status=excluded.status, updated_at=excluded.updated_at`).run(id, tenantId, input.vendorId, input.number, input.invoiceDate, input.dueDate, input.servicePeriod ?? null, net, tax, gross, input.taxRate, input.taxCaseKey ?? null, input.notes ?? null, input.status, input.accountingStatus || 'unposted', timestamp, timestamp);
    db.prepare('DELETE FROM incoming_invoice_lines WHERE tenant_id = ? AND incoming_invoice_id = ?').run(tenantId, id);
    const insert = db.prepare(`INSERT INTO incoming_invoice_lines (id, tenant_id, incoming_invoice_id, position, description, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount, account_number, asset_account_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((line, index) => insert.run(line.id || randomUUID(), tenantId, id, index, line.description, line.quantity, line.unitPrice, line.netAmount, line.taxRate, line.taxAmount, line.grossAmount, line.accountNumber ?? null, line.assetAccountNumber ?? null));
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
  const lines: AccountingSnapshot['lines'] = [];
  for (const line of invoice.lines) {
    const accountNumber = line.assetAccountNumber || line.accountNumber || mappings.expense;
    if (!accountExists(db, policy.activeChart, accountNumber)) issues.push({ code: 'UNKNOWN_ACCOUNT', message: `Konto ${accountNumber} fehlt im ${policy.activeChart}.`, blocking: true });
    lines.push({ accountNumber, debitAmount: line.netAmount, creditAmount: 0, taxRate: line.taxRate, taxAmount: line.taxAmount, memo: line.description });
  }
  if (invoice.taxAmount > 0) {
    issues.push(...validateMapping(db, policy.activeChart, mappings, ['input_vat']));
    lines.push({ accountNumber: mappings.input_vat, debitAmount: invoice.taxAmount, creditAmount: 0, taxAmount: invoice.taxAmount });
  }
  lines.push({ accountNumber: mappings.accounts_payable, debitAmount: 0, creditAmount: invoice.grossAmount, memo: `Kreditor ${invoice.number}` });
  const snapshot: AccountingSnapshot = { sourceType: 'incoming_invoice', sourceId: invoiceId, sourceVersion: sha256(invoice), chart: policy.activeChart, vatMethod: policy.vatMethod, netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount, lines, capturedAt: now() };
  return issues.length ? { sourceType: 'incoming_invoice', sourceId: invoiceId, status: 'unresolved', issues } : { sourceType: 'incoming_invoice', sourceId: invoiceId, status: 'ready', snapshot, issues: [] };
};

export const postIncomingInvoice = (db: Database.Database, scope: TenantScope, invoiceId: string): AccountingPostingPreview => {
  const preview = previewIncomingInvoice(db, scope, invoiceId); const tenantId = tenant(scope);
  if (preview.status === 'unresolved' || !preview.snapshot) { db.prepare('UPDATE incoming_invoices SET accounting_status = ? WHERE tenant_id = ? AND id = ?').run('unresolved', tenantId, invoiceId); return preview; }
  const row = db.prepare('SELECT * FROM incoming_invoices WHERE tenant_id = ? AND id = ?').get(tenantId, invoiceId) as Record<string, any>;
  if (row.accounting_status === 'posted') return preview;
  const journalEntryId = db.transaction(() => {
    const id = insertJournal(db, tenantId, 'incoming_invoice', `incoming-invoice:${invoiceId}`, row.invoice_date, `Eingangsrechnung ${row.number}`, preview.snapshot!.lines);
    const timestamp = now();
    db.prepare(`INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date, original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at) VALUES (?, ?, 'creditor', ?, 'incoming_invoice', ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?) ON CONFLICT(tenant_id, source_type, source_id) DO NOTHING`).run(randomUUID(), tenantId, row.vendor_id, invoiceId, row.number, row.invoice_date, row.due_date, preview.snapshot!.grossAmount, preview.snapshot!.grossAmount, id, timestamp, timestamp);
    db.prepare('UPDATE incoming_invoices SET accounting_status = \'posted\', accounting_snapshot_json = ?, accounting_journal_entry_id = ?, accounting_posted_at = ?, status = CASE WHEN status = \'draft\' THEN \'open\' ELSE status END WHERE tenant_id = ? AND id = ?').run(JSON.stringify(preview.snapshot), id, timestamp, tenantId, invoiceId);
    appendAuditLog(db, { entityType: 'incoming_invoice', entityId: invoiceId, action: 'accounting_post', reason: 'incoming invoice confirmed', before: { accountingStatus: row.accounting_status }, after: { journalEntryId: id, snapshot: preview.snapshot }, actor: 'pro' });
    return id;
  })();
  void journalEntryId;
  return preview;
};

export const listOpenItems = (db: Database.Database, scope: TenantScope): OpenItemEntity[] => (db.prepare('SELECT * FROM open_items WHERE tenant_id = ? ORDER BY due_date, document_number').all(tenant(scope)) as Array<Record<string, any>>).map((row) => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id, sourceType: row.source_type, sourceId: row.source_id, documentNumber: row.document_number, documentDate: row.document_date, dueDate: row.due_date, originalAmount: Number(row.original_amount), allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), status: row.status, journalEntryId: row.journal_entry_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }));

const paymentFromRow = (row: Record<string, any>): OpenItemPaymentEntity => ({ id: row.id, tenantId: row.tenant_id, partyType: row.party_type, partyId: row.party_id ?? undefined, paymentDate: row.payment_date, amount: Number(row.amount), bankAccountNumber: row.bank_account_number, method: row.method ?? undefined, sourceType: row.source_type, sourceId: row.source_id, allocatedAmount: Number(row.allocated_amount), residualAmount: Number(row.residual_amount), createdAt: row.created_at });

export const allocateOpenItemPayment = (db: Database.Database, scope: TenantScope, input: { paymentId?: string; sourceType: OpenItemPaymentEntity['sourceType']; sourceId: string; partyType: OpenItemPaymentEntity['partyType']; partyId?: string; paymentDate: string; amount: number; bankAccountNumber: string; method?: string; allocations: Array<{ openItemId: string; amount: number }> }): OpenItemPaymentEntity => {
  const tenantId = tenant(scope); const paymentId = input.paymentId || randomUUID(); const timestamp = now();
  const policy = getAccountingPolicyForPro(db, scope); const mapping = getMapping(db, tenantId, policy.activeChart); const mapIssues = validateMapping(db, policy.activeChart, mapping, input.partyType === 'debtor' ? ['bank', 'accounts_receivable'] : ['bank', 'accounts_payable']); if (mapIssues.length) throw new Error(mapIssues.map((issue) => issue.message).join('; '));
  const total = amount(input.amount); if (total <= 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  const existing = db.prepare('SELECT * FROM open_item_payments WHERE tenant_id = ? AND source_type = ? AND source_id = ?').get(tenantId, input.sourceType, input.sourceId) as Record<string, any> | undefined;
  if (existing) return paymentFromRow(existing);
  const allocationTotal = amount(input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
  if (allocationTotal > total + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_PAYMENT');
  db.transaction(() => {
    db.prepare(`INSERT INTO open_item_payments (id, tenant_id, party_type, party_id, payment_date, amount, bank_account_number, method, source_type, source_id, allocated_amount, residual_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(paymentId, tenantId, input.partyType, input.partyId ?? null, input.paymentDate, total, input.bankAccountNumber, input.method ?? null, input.sourceType, input.sourceId, allocationTotal, amount(total - allocationTotal), timestamp);
    const journalLines: AccountingSnapshot['lines'] = input.partyType === 'debtor'
      ? [{ accountNumber: mapping.bank, debitAmount: total, creditAmount: 0 }, { accountNumber: mapping.accounts_receivable, debitAmount: 0, creditAmount: total }]
      : [{ accountNumber: mapping.accounts_payable, debitAmount: total, creditAmount: 0 }, { accountNumber: mapping.bank, debitAmount: 0, creditAmount: total }];
    insertJournal(db, tenantId, 'payment', `payment:${input.sourceType}:${input.sourceId}`, input.paymentDate, 'Zahlung', journalLines);
    const insertAllocation = db.prepare('INSERT INTO open_item_allocations (id, tenant_id, payment_id, open_item_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const allocation of input.allocations) {
      const item = db.prepare('SELECT * FROM open_items WHERE tenant_id = ? AND id = ?').get(tenantId, allocation.openItemId) as Record<string, any> | undefined;
      if (!item || item.party_type !== input.partyType) throw new Error('OPEN_ITEM_NOT_FOUND');
      const value = amount(allocation.amount); if (value <= 0 || value > Number(item.residual_amount) + 0.01) throw new Error('OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
      insertAllocation.run(randomUUID(), tenantId, paymentId, item.id, value, timestamp);
      const allocated = amount(Number(item.allocated_amount) + value); const residual = amount(Number(item.original_amount) - allocated);
      const status = residual > 0 ? 'partially_paid' : 'paid';
      db.prepare('UPDATE open_items SET allocated_amount = ?, residual_amount = ?, status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(allocated, Math.max(0, residual), status, timestamp, tenantId, item.id);
      const documentStatus = status === 'paid' ? 'paid' : 'open';
      if (item.source_type === 'outgoing_invoice') db.prepare('UPDATE invoices SET status = ? WHERE id = ? AND status <> \'cancelled\'').run(documentStatus, item.source_id);
      if (item.source_type === 'incoming_invoice') db.prepare('UPDATE incoming_invoices SET status = ? WHERE tenant_id = ? AND id = ? AND status <> \'cancelled\'').run(documentStatus, tenantId, item.source_id);
    }
    appendAuditLog(db, { entityType: 'open_item_payment', entityId: paymentId, action: 'allocate', reason: 'payment allocation', before: null, after: input, actor: 'pro' });
  })();
  return paymentFromRow(db.prepare('SELECT * FROM open_item_payments WHERE id = ?').get(paymentId) as Record<string, any>);
};

export const previewAccountingBackfill = (db: Database.Database, scope: TenantScope): AccountingBackfillPreview => {
  const tenantId = tenant(scope); const policy = getAccountingPolicyForPro(db, scope); ensureMappingDefaults(db, tenantId);
  const candidates: AccountingBackfillPreview['candidates'] = [];
  const invoices = db.prepare("SELECT id FROM invoices WHERE accounting_status <> 'posted' OR accounting_status IS NULL ORDER BY id").all() as Array<{ id: string }>;
  for (const row of invoices) { const preview = previewOutgoingInvoice(db, scope, row.id); candidates.push({ sourceType: 'outgoing_invoice', sourceId: row.id, status: preview.status, reason: preview.issues[0]?.message }); }
  const incoming = db.prepare("SELECT id FROM incoming_invoices WHERE accounting_status <> 'posted' OR accounting_status IS NULL ORDER BY id").all() as Array<{ id: string }>;
  for (const row of incoming) { const preview = previewIncomingInvoice(db, scope, row.id); candidates.push({ sourceType: 'incoming_invoice', sourceId: row.id, status: preview.status, reason: preview.issues[0]?.message }); }
  // Legacy transactions and invoice payments have no immutable accounting
  // snapshot. Keep them visible for a human-confirmed correction instead of
  // guessing a counter-account during migration.
  const legacyTransactions = db.prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: string }>;
  for (const row of legacyTransactions) candidates.push({ sourceType: 'legacy_transaction', sourceId: row.id, status: 'unresolved', reason: 'Legacy transaction requires explicit account and evidence review.' });
  const legacyPayments = db.prepare('SELECT id FROM invoice_payments ORDER BY id').all() as Array<{ id: string }>;
  for (const row of legacyPayments) candidates.push({ sourceType: 'legacy_transaction', sourceId: `invoice_payment:${row.id}`, status: 'unresolved', reason: 'Legacy payment requires explicit open-item allocation review.' });
  const confirmationHash = sha256({ tenantId, chart: policy.activeChart, vatMethod: policy.vatMethod, candidates });
  const runId = randomUUID();
  db.prepare('INSERT INTO accounting_backfill_runs (id, tenant_id, status, candidates_json, confirmation_hash, created_at) VALUES (?, ?, \'preview\', ?, ?, ?)').run(runId, tenantId, JSON.stringify(candidates), confirmationHash, now());
  appendAuditLog(db, { entityType: 'accounting_backfill', entityId: runId, action: 'preview', reason: 'dry-run accounting backfill', before: null, after: { readyCount: candidates.filter((candidate) => candidate.status === 'ready').length, unresolvedCount: candidates.filter((candidate) => candidate.status === 'unresolved').length, confirmationHash }, actor: 'pro' });
  return { runId, status: 'preview', candidates, readyCount: candidates.filter((candidate) => candidate.status === 'ready').length, unresolvedCount: candidates.filter((candidate) => candidate.status === 'unresolved').length, confirmationHash };
};

export const confirmAccountingBackfill = (db: Database.Database, scope: TenantScope, input: AccountingBackfillConfirmation): AccountingBackfillResult => {
  const tenantId = tenant(scope); const run = db.prepare('SELECT * FROM accounting_backfill_runs WHERE tenant_id = ? AND id = ?').get(tenantId, input.runId) as Record<string, any> | undefined;
  if (!run) throw new Error('BACKFILL_RUN_NOT_FOUND');
  if (run.status !== 'preview' || run.confirmation_hash !== input.confirmationHash) throw new Error('BACKFILL_CONFIRMATION_HASH_MISMATCH');
  const candidates = JSON.parse(run.candidates_json) as AccountingBackfillPreview['candidates']; let postedCount = 0; let unresolvedCount = 0;
  db.prepare('UPDATE accounting_backfill_runs SET status = \'confirmed\', confirmed_at = ? WHERE tenant_id = ? AND id = ?').run(now(), tenantId, input.runId);
  for (const candidate of candidates) {
    if (candidate.status !== 'ready') { unresolvedCount += 1; continue; }
    const result = candidate.sourceType === 'outgoing_invoice' ? postOutgoingInvoice(db, scope, candidate.sourceId) : postIncomingInvoice(db, scope, candidate.sourceId);
    if (result.status === 'ready') postedCount += 1; else unresolvedCount += 1;
  }
  db.prepare('UPDATE accounting_backfill_runs SET status = \'completed\', completed_at = ? WHERE tenant_id = ? AND id = ?').run(now(), tenantId, input.runId);
  appendAuditLog(db, { entityType: 'accounting_backfill', entityId: input.runId, action: 'confirm', reason: input.reason, before: { status: 'preview' }, after: { postedCount, unresolvedCount }, actor: 'pro' });
  return { runId: input.runId, postedCount, unresolvedCount, status: 'completed' };
};

export const listOpenItemAllocations = (db: Database.Database, scope: TenantScope, openItemId?: string): OpenItemAllocationEntity[] => (db.prepare(`SELECT id, tenant_id, payment_id, open_item_id, amount, created_at FROM open_item_allocations WHERE tenant_id = ? ${openItemId ? 'AND open_item_id = ?' : ''} ORDER BY created_at`).all(...(openItemId ? [tenant(scope), openItemId] : [tenant(scope)])) as Array<Record<string, any>>).map((row) => ({ id: row.id, tenantId: row.tenant_id, paymentId: row.payment_id, openItemId: row.open_item_id, amount: Number(row.amount), createdAt: row.created_at }));
