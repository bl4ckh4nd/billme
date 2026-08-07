import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Database as SqliteDatabaseType } from 'better-sqlite3';
import type { Pool } from 'pg';
import { count, eq } from 'drizzle-orm';
import { createSingleTenantScope, type Client, type Invoice, type Offer, type RecurringProfile, type ServerProduct, type Tenant } from '@billme/server-core';
import { DEFAULT_TAX_MODE } from '@billme/server-core/services';
import { verifyAuditChainRows, verifyPostgresAuditChain } from './audit.js';
import {
  countTenantCoreRows,
  createPostgresBillingDependencies,
  insertAuditRow,
  insertEmailLogRow,
  saveServerNumberReservation,
  saveServerSettings,
} from './billing.js';
import { withPostgresTransaction } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import { runPostgresMigrations } from './migrations.js';
import {
  saveServerAccountKeyword,
  saveServerAccountMappingHgb,
  saveServerAccountSuggestionRule,
  saveServerAccountingPeriod,
  saveServerActiveTemplates,
  saveServerArticle,
  saveServerBankAccount,
  saveServerBankTransaction,
  saveServerBookingDraft,
  saveServerBookingDraftLine,
  saveServerDatevExport,
  saveServerDraftValidationIssue,
  saveServerEurClassification,
  saveServerEurLine,
  saveServerEurRule,
  saveServerImportBatch,
  saveServerImportedTransaction,
  saveServerJournalEntry,
  saveServerJournalLine,
  saveServerJournalPostingPair,
  saveServerLedgerAccount,
  saveServerProWorkflowEntry,
  saveServerReportSnapshot,
  saveServerTaxCase,
  saveServerTaxCaseAccountMapping,
  saveServerTemplate,
  saveServerVatEvidence,
  type ServerAccountKeywordRecord,
  type ServerAccountMappingHgbRecord,
  type ServerAccountingPeriodRecord,
  type ServerActiveTemplatesRecord,
  type ServerArticleRecord,
  type ServerBankAccountRecord,
  type ServerBankTransactionRecord,
  type ServerBookingDraftLineRecord,
  type ServerBookingDraftRecord,
  type ServerDatevExportRecord,
  type ServerDraftValidationIssueRecord,
  type ServerEurClassificationRecord,
  type ServerEurLineRecord,
  type ServerEurRuleRecord,
  type ServerImportBatchRecord,
  type ServerImportedTransactionRecord,
  type ServerJournalEntryRecord,
  type ServerJournalLineRecord,
  type ServerJournalPostingPairRecord,
  type ServerProWorkflowRecord,
  type ServerReportSnapshotRecord,
  type ServerTaxCaseRecord,
  type ServerTemplateRecord,
  type ServerVatEvidenceRecord,
} from './proAccounting.js';

type SqliteDatabaseCtor = new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabaseType;
type SqliteTableRow = { name: string };

type SqliteClientRow = { id: string; customer_number: string | null; company: string; contact_person: string; email: string; phone: string; address: string; status: Client['status']; avatar: string | null; tags_json: string; notes: string; tax_profile_json?: string | null };
type SqliteClientAddressRow = { id: string; client_id: string; label: string; kind: 'billing' | 'shipping' | 'other'; company: string | null; contact_person: string | null; street: string; line2: string | null; zip: string; city: string; country: string; is_default_billing: number; is_default_shipping: number };
type SqliteClientEmailRow = { id: string; client_id: string; label: string; kind: 'general' | 'billing' | 'shipping' | 'other'; email: string; is_default_general: number; is_default_billing: number };
type SqliteClientProjectRow = { id: string; client_id: string; code: string | null; name: string; status: string; budget: number; start_date: string; end_date: string | null; description: string | null; archived_at: string | null; created_at: string | null; updated_at: string | null };
type SqliteClientActivityRow = { id: string; client_id: string; type: 'note' | 'email' | 'call' | 'meeting'; content: string; date: string; author: string };
type SqliteInvoiceRow = { id: string; client_id: string | null; client_number: string | null; project_id: string | null; number: string; client: string; client_email: string; client_address: string | null; billing_address_json: string | null; shipping_address_json: string | null; tax_mode?: Invoice['taxMode'] | null; tax_meta_json?: string | null; tax_snapshot_json?: string | null; date: string; due_date: string; service_period: string | null; amount: number; status: Invoice['status']; dunning_level: number; created_at: string; updated_at: string };
type SqliteInvoiceItemRow = { invoice_id: string; position: number; description: string; article_id: string | null; category: string | null; tax_rate?: number | null; quantity: number; price: number; total: number };
type SqliteInvoicePaymentRow = { id: string; invoice_id: string; date: string; amount: number; method: string };
type SqliteOfferRow = { id: string; client_id: string | null; client_number: string | null; project_id: string | null; number: string; client: string; client_email: string; client_address: string | null; billing_address_json: string | null; shipping_address_json: string | null; tax_mode?: Offer['taxMode'] | null; tax_meta_json?: string | null; tax_snapshot_json?: string | null; date: string; valid_until: string; amount: number; status: Offer['status']; share_token: string | null; share_published_at: string | null; accepted_at: string | null; accepted_by: string | null; accepted_email: string | null; accepted_user_agent: string | null; decision: string | null; decision_text_version: string | null; created_at: string; updated_at: string };
type SqliteOfferItemRow = { offer_id: string; position: number; description: string; article_id: string | null; category: string | null; tax_rate?: number | null; quantity: number; price: number; total: number };
type SqliteRecurringRow = { id: string; client_id: string; active: number; name: string; interval: RecurringProfile['interval']; next_run: string; last_run: string | null; end_date: string | null; amount: number; items_json: string; tax_mode?: RecurringProfile['taxMode'] | null; tax_meta_json?: string | null };
type SqliteEmailLogRow = { id: string; document_type: string; document_id: string; document_number: string; recipient_email: string; recipient_name: string; subject: string; body_text: string; provider: string; status: string; error_message: string | null; sent_at: string; created_at: string };
type SqliteDunningHistoryRow = { id: string; invoice_id: string; invoice_number: string; dunning_level: number; days_overdue: number; fee_applied: number; email_sent: number; email_log_id: string | null; processed_at: string; created_at: string };
type SqliteAuditRow = { sequence: number; ts: string; entity_type: string; entity_id: string; action: string; reason: string | null; before_json: string | null; after_json: string | null; prev_hash: string | null; hash: string; actor: string };
type SqliteArticleRow = { id: string; sku: string | null; title: string; description: string; price: number; unit: string; category: string; tax_rate: number };
type SqliteAccountRow = { id: string; name: string; iban: string; balance: number; default_skr_account_number: string; type: string; color: string };
type SqliteLedgerAccountRow = { id: string; chart: 'SKR03' | 'SKR04'; account_number: string; name: string; source: string; created_at: string; updated_at: string };
type SqliteProWorkflowEntryRow = { transaction_id: string; transaction_json: string; draft_json: string; updated_at: string };
type SqliteBankTransactionRow = { id: string; account_id: string; date: string; amount: number; type: ServerBankTransactionRecord['type']; counterparty: string; purpose: string; linked_invoice_id: string | null; status: ServerBankTransactionRecord['status']; source_transaction_id: string | null; created_at: string; updated_at: string };
type SqliteBookingDraftRow = { id: string; transaction_id: string; workflow_status: string; draft_json: string; updated_at: string };
type SqliteBookingDraftLineRow = { id: string; draft_id: string; line_no: number; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null; tax_case_key: string | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null; gross_amount: number | null; country_code: string | null; counterparty_vat_id: string | null; evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null };
type SqliteDraftValidationIssueRow = { id: string; draft_id: string; code: string; severity: ServerDraftValidationIssueRecord['severity']; message: string; field_path: string | null; blocking: number; source: ServerDraftValidationIssueRecord['source']; issue_json: string; created_at: string };
type SqliteAccountingPeriodRow = { id: string; period: string; fiscal_year: number; status: string; starts_at: string; ends_at: string; created_at: string; updated_at: string };
type SqliteJournalEntryRow = { id: string; entry_number: number; posting_date: string; document_date: string | null; booking_text: string; reference: string | null; period: string; fiscal_year: number; status: string; source_draft_id: string | null; reversed_entry_id: string | null; created_at: string };
type SqliteJournalLineRow = { id: string; entry_id: string; line_no: number; account_number: string; debit_amount: number; credit_amount: number; tax_code: string | null; tax_case_key: string | null; tax_rate: number | null; net_amount: number | null; tax_amount: number | null; gross_amount: number | null; country_code: string | null; counterparty_vat_id: string | null; evidence_type: string | null; evidence_reference: string | null; cost_center: string | null; memo: string | null };
type SqliteAssetRow = { id: string; asset_number: string; name: string; asset_class: string; status: string; activation_date: string; acquisition_cost: number; useful_life_years: number | null; depreciation_method: string; cost_center: string; location: string; receipt_linked: number; supplier: string | null; invoice_ref: string | null; asset_account_number: string; disposal_date: string | null; disposal_proceeds: number | null; created_at: string; updated_at: string };
type SqliteAssetScheduleRow = { id: string; asset_id: string; year: number; amount: number; months: number; status: string; journal_entry_id: string | null; posted_at: string | null };
type SqliteAssetMovementRow = { id: string; asset_id: string; type: string; movement_date: string; amount: number; proceeds: number | null; gain_loss: number | null; reason: string; created_at: string };
type SqliteAccountMappingHgbRow = { id: string; chart: string; account_number: string; statement_type: string; position_key: string; position_label: string; balance_side: string | null; updated_at: string };
type SqliteReportSnapshotRow = { id: string; report_type: string; args_json: string; payload_json: string; created_at: string };
type SqliteDatevExportRow = { id: string; file_path: string; record_count: number; from_date: string | null; to_date: string | null; created_at: string; meta_json: string };
type SqliteTaxCaseRow = { key: ServerTaxCaseRecord['key']; label: string; mechanism: ServerTaxCaseRecord['mechanism']; default_rate: number; requires_counterparty_vat_id: number; requires_country: number; requires_evidence: number; active: number; updated_at: string };
type SqliteTaxCaseAccountMappingRow = { id: string; chart: 'SKR03' | 'SKR04'; tax_case_key: ServerTaxCaseRecord['key']; role: 'output_tax' | 'input_tax' | 'datev_bu'; account_number: string; datev_bu_key: string | null; valid_from: string | null; valid_to: string | null; updated_at: string };
type SqliteVatEvidenceRow = { id: string; draft_id: string | null; entry_id: string | null; line_id: string | null; tax_case_key: string; evidence_type: string | null; evidence_reference: string | null; country_code: string | null; counterparty_vat_id: string | null; captured_at: string };
type SqliteJournalPostingPairRow = { id: string; entry_id: string; debit_line_id: string; credit_line_id: string; amount: number; tax_case_key: string | null; datev_bu_key: string | null; created_at: string };
type SqliteImportedTransactionRow = { id: string; account_id: string; date: string; amount: number; type: string; counterparty: string; purpose: string; linked_invoice_id: string | null; status: string; dedup_hash: string | null; import_batch_id: string | null; deleted_at: string | null };
type SqliteEurLineRow = { id: string; tax_year: number; kennziffer: string | null; label: string; kind: string; exportable: number; sort_order: number; computed_from_json: string | null; source_version: string; created_at: string; updated_at: string };
type SqliteEurClassificationRow = { id: string; source_type: string; source_id: string; tax_year: number; eur_line_id: string | null; excluded: number; vat_mode: string; note: string | null; updated_at: string };
type SqliteEurRuleRow = { id: string; tax_year: number; priority: number; field: string; operator: string; value: string; target_eur_line_id: string; active: number; created_at: string; updated_at: string };
type SqliteAccountKeywordRow = { id: string; chart: string; account_number: string; keyword: string; source: string; active: number; created_at: string; updated_at: string };
type SqliteAccountSuggestionRuleRow = { id: string; chart: 'SKR03' | 'SKR04'; priority: number; field: ServerAccountKeywordRecord['source'] | 'counterparty' | 'purpose' | 'any'; operator: 'contains' | 'equals' | 'startsWith'; value: string; target_account_number: string; flow_type: 'income' | 'expense' | 'any'; active: number; created_at: string; updated_at: string };
type SqliteImportBatchRow = { id: string; account_id: string; profile: string; file_name: string; file_sha256: string; mapping_json: string; imported_count: number; skipped_count: number; error_count: number; created_at: string; rolled_back_at: string | null; rollback_reason: string | null };
type SqliteTemplateRow = { id: string; kind: string; name: string; elements_json: string; created_at: string; updated_at: string };
type SqliteActiveTemplateRow = { id: number; invoice_template_id: string | null; offer_template_id: string | null };

export interface DesktopSqliteImportOptions {
  pool: Pool;
  sqlitePath: string;
  product: ServerProduct;
  tenant: Pick<Tenant, 'id' | 'slug' | 'displayName'>;
  failOnUnsupportedData?: boolean;
}

export interface DesktopSqliteImportCounts {
  clients: number;
  invoices: number;
  offers: number;
  recurringProfiles: number;
  articles: number;
  accounts: number;
  templates: number;
  activeTemplates: number;
  ledgerAccounts: number;
  proWorkflowEntries: number;
  bankTransactions: number;
  bookingDrafts: number;
  bookingDraftLines: number;
  draftValidationIssues: number;
  accountingPeriods: number;
  journalEntries: number;
  journalLines: number;
  assets: number;
  assetDepreciationSchedule: number;
  assetMovements: number;
  accountMappingsHgb: number;
  reportSnapshots: number;
  datevExports: number;
  taxCases: number;
  taxCaseAccountMappings: number;
  vatEvidence: number;
  journalPostingPairs: number;
  transactions: number;
  eurLines: number;
  eurClassifications: number;
  eurRules: number;
  accountKeywords: number;
  accountSuggestionRules: number;
  importBatches: number;
  emailLog: number;
  dunningHistory: number;
  auditLog: number;
  numberReservations: number;
}

export interface DesktopSqliteImportResult {
  importRunId: string;
  counts: DesktopSqliteImportCounts;
  unsupportedTables: Array<{ table: string; rowCount: number }>;
}

export const desktopSqliteImportedTables = [
  'settings',
  'number_reservations',
  'clients',
  'client_addresses',
  'client_emails',
  'client_projects',
  'client_activities',
  'invoices',
  'invoice_items',
  'invoice_payments',
  'offers',
  'offer_items',
  'recurring_profiles',
  'articles',
  'accounts',
  'ledger_accounts',
  'pro_workflow_entries',
  'bank_transactions',
  'booking_drafts',
  'booking_draft_lines',
  'draft_validation_issues',
  'accounting_periods',
  'journal_entries',
  'journal_lines',
  'assets',
  'asset_depreciation_schedule',
  'asset_movements',
  'account_mappings_hgb',
  'report_snapshots',
  'datev_exports',
  'tax_cases',
  'tax_case_account_mappings',
  'vat_evidence',
  'journal_posting_pairs',
  'transactions',
  'eur_lines',
  'eur_classifications',
  'eur_rules',
  'account_keywords',
  'account_suggestion_rules',
  'import_batches',
  'templates',
  'active_templates',
  'email_log',
  'dunning_history',
  'audit_log',
] as const;

export const desktopSqliteIgnoredTables = ['migration_log'] as const;

const importableTables: ReadonlySet<string> = new Set<string>([
  ...desktopSqliteImportedTables,
  ...desktopSqliteIgnoredTables,
]);
const systemTable = (name: string): boolean => name.startsWith('sqlite_') || name.startsWith('__drizzle_');
const parseJson = <T>(value: string | null, fallback: T): T => { if (!value) return fallback; try { return JSON.parse(value) as T; } catch { return fallback; } };
const loadSqliteModule = async (): Promise<SqliteDatabaseCtor> => { const module = await import('better-sqlite3'); return module.default as unknown as SqliteDatabaseCtor; };
const sha256File = async (targetPath: string): Promise<string> => createHash('sha256').update(await readFile(targetPath)).digest('hex');
const tableExists = (db: SqliteDatabaseType, table: string): boolean => Boolean((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: string } | undefined)?.name);
const listTables = (db: SqliteDatabaseType): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as SqliteTableRow[]).map((row) => row.name).filter(Boolean);
const countTable = (db: SqliteDatabaseType, table: string): number => Number(((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count) ?? 0);

export const detectUnsupportedSqliteTables = (tables: string[], countLookup: (table: string) => number): Array<{ table: string; rowCount: number }> => {
  return tables.filter((table) => !systemTable(table) && !importableTables.has(table)).map((table) => ({ table, rowCount: countLookup(table) })).filter((entry) => entry.rowCount > 0).sort((left, right) => left.table.localeCompare(right.table));
};

const loadClients = (db: SqliteDatabaseType, tenantId: string): Client[] => {
  if (!tableExists(db, 'clients')) return [];
  const clientRows = db.prepare('SELECT * FROM clients ORDER BY company ASC, id ASC').all() as SqliteClientRow[];
  const addressRows = tableExists(db, 'client_addresses') ? (db.prepare('SELECT * FROM client_addresses ORDER BY client_id, id ASC').all() as SqliteClientAddressRow[]) : [];
  const emailRows = tableExists(db, 'client_emails') ? (db.prepare('SELECT * FROM client_emails ORDER BY client_id, id ASC').all() as SqliteClientEmailRow[]) : [];
  const projectRows = tableExists(db, 'client_projects') ? (db.prepare('SELECT * FROM client_projects ORDER BY client_id, id ASC').all() as SqliteClientProjectRow[]) : [];
  const activityRows = tableExists(db, 'client_activities') ? (db.prepare('SELECT * FROM client_activities ORDER BY client_id, date ASC, id ASC').all() as SqliteClientActivityRow[]) : [];
  const addressesByClient = new Map<string, SqliteClientAddressRow[]>();
  const emailsByClient = new Map<string, SqliteClientEmailRow[]>();
  const projectsByClient = new Map<string, SqliteClientProjectRow[]>();
  const activitiesByClient = new Map<string, SqliteClientActivityRow[]>();
  for (const row of addressRows) { const list = addressesByClient.get(row.client_id) ?? []; list.push(row); addressesByClient.set(row.client_id, list); }
  for (const row of emailRows) { const list = emailsByClient.get(row.client_id) ?? []; list.push(row); emailsByClient.set(row.client_id, list); }
  for (const row of projectRows) { const list = projectsByClient.get(row.client_id) ?? []; list.push(row); projectsByClient.set(row.client_id, list); }
  for (const row of activityRows) { const list = activitiesByClient.get(row.client_id) ?? []; list.push(row); activitiesByClient.set(row.client_id, list); }
  return clientRows.map((row) => ({ id: row.id, tenantId, customerNumber: row.customer_number ?? undefined, company: row.company, contactPerson: row.contact_person, email: row.email, phone: row.phone, address: row.address, status: row.status, avatar: row.avatar ?? undefined, tags: parseJson(row.tags_json, []), notes: row.notes, taxProfile: parseJson(row.tax_profile_json ?? null, undefined), addresses: (addressesByClient.get(row.id) ?? []).map((address) => ({ id: address.id, clientId: address.client_id, label: address.label, kind: address.kind, company: address.company ?? undefined, contactPerson: address.contact_person ?? undefined, street: address.street, line2: address.line2 ?? undefined, zip: address.zip, city: address.city, country: address.country, isDefaultBilling: Boolean(address.is_default_billing), isDefaultShipping: Boolean(address.is_default_shipping) })), emails: (emailsByClient.get(row.id) ?? []).map((email) => ({ id: email.id, clientId: email.client_id, label: email.label, kind: email.kind, email: email.email, isDefaultGeneral: Boolean(email.is_default_general), isDefaultBilling: Boolean(email.is_default_billing) })), projects: (projectsByClient.get(row.id) ?? []).map((project) => ({ id: project.id, clientId: project.client_id, code: project.code ?? undefined, name: project.name, status: project.status as Client['projects'][number]['status'], budget: project.budget, startDate: project.start_date, endDate: project.end_date ?? undefined, description: project.description ?? undefined, archivedAt: project.archived_at ?? undefined, createdAt: project.created_at ?? undefined, updatedAt: project.updated_at ?? undefined })), activities: (activitiesByClient.get(row.id) ?? []).map((activity) => ({ id: activity.id, clientId: activity.client_id, type: activity.type, content: activity.content, date: activity.date, author: activity.author })) }));
};

const loadInvoices = (db: SqliteDatabaseType, tenantId: string): Invoice[] => {
  if (!tableExists(db, 'invoices')) return [];
  const rows = db.prepare('SELECT * FROM invoices ORDER BY date DESC, created_at DESC').all() as SqliteInvoiceRow[];
  const itemRows = tableExists(db, 'invoice_items') ? (db.prepare('SELECT * FROM invoice_items ORDER BY invoice_id, position ASC').all() as SqliteInvoiceItemRow[]) : [];
  const paymentRows = tableExists(db, 'invoice_payments') ? (db.prepare('SELECT * FROM invoice_payments ORDER BY invoice_id, date DESC').all() as SqliteInvoicePaymentRow[]) : [];
  const itemsByInvoice = new Map<string, SqliteInvoiceItemRow[]>();
  const paymentsByInvoice = new Map<string, SqliteInvoicePaymentRow[]>();
  for (const row of itemRows) { const list = itemsByInvoice.get(row.invoice_id) ?? []; list.push(row); itemsByInvoice.set(row.invoice_id, list); }
  for (const row of paymentRows) { const list = paymentsByInvoice.get(row.invoice_id) ?? []; list.push(row); paymentsByInvoice.set(row.invoice_id, list); }
  return rows.map((row) => ({ kind: 'invoice', id: row.id, tenantId, clientId: row.client_id ?? undefined, clientNumber: row.client_number ?? undefined, projectId: row.project_id ?? undefined, number: row.number, client: row.client, clientEmail: row.client_email, clientAddress: row.client_address ?? undefined, billingAddress: parseJson(row.billing_address_json, undefined), shippingAddress: parseJson(row.shipping_address_json, undefined), taxMode: row.tax_mode ?? DEFAULT_TAX_MODE, taxMeta: parseJson(row.tax_meta_json ?? null, undefined), taxSnapshot: parseJson(row.tax_snapshot_json ?? null, undefined), date: row.date, dueDate: row.due_date, servicePeriod: row.service_period ?? undefined, amount: row.amount, status: row.status, dunningLevel: row.dunning_level, items: (itemsByInvoice.get(row.id) ?? []).map((item) => ({ description: item.description, quantity: item.quantity, price: item.price, total: item.total, articleId: item.article_id ?? undefined, category: item.category ?? undefined, taxRate: item.tax_rate ?? undefined })), payments: (paymentsByInvoice.get(row.id) ?? []).map((payment) => ({ id: payment.id, date: payment.date, amount: payment.amount, method: payment.method })), history: [], createdAt: row.created_at, updatedAt: row.updated_at }));
};

const loadOffers = (db: SqliteDatabaseType, tenantId: string): Offer[] => {
  if (!tableExists(db, 'offers')) return [];
  const rows = db.prepare('SELECT * FROM offers ORDER BY date DESC, created_at DESC').all() as SqliteOfferRow[];
  const itemRows = tableExists(db, 'offer_items') ? (db.prepare('SELECT * FROM offer_items ORDER BY offer_id, position ASC').all() as SqliteOfferItemRow[]) : [];
  const itemsByOffer = new Map<string, SqliteOfferItemRow[]>();
  for (const row of itemRows) { const list = itemsByOffer.get(row.offer_id) ?? []; list.push(row); itemsByOffer.set(row.offer_id, list); }
  return rows.map((row) => ({ kind: 'offer', id: row.id, tenantId, clientId: row.client_id ?? undefined, clientNumber: row.client_number ?? undefined, projectId: row.project_id ?? undefined, number: row.number, client: row.client, clientEmail: row.client_email, clientAddress: row.client_address ?? undefined, billingAddress: parseJson(row.billing_address_json, undefined), shippingAddress: parseJson(row.shipping_address_json, undefined), taxMode: row.tax_mode ?? DEFAULT_TAX_MODE, taxMeta: parseJson(row.tax_meta_json ?? null, undefined), taxSnapshot: parseJson(row.tax_snapshot_json ?? null, undefined), date: row.date, validUntil: row.valid_until, amount: row.amount, status: row.status, share: row.share_token || row.share_published_at || row.decision || row.decision_text_version || row.accepted_at || row.accepted_by || row.accepted_email || row.accepted_user_agent ? { token: row.share_token ?? undefined, publishedAt: row.share_published_at ?? undefined, decision: row.decision as NonNullable<Offer['share']>['decision'] | undefined, decisionTextVersion: row.decision_text_version ?? undefined, acceptedAt: row.accepted_at ?? undefined, acceptedBy: row.accepted_by ?? undefined, acceptedEmail: row.accepted_email ?? undefined, acceptedUserAgent: row.accepted_user_agent ?? undefined } : undefined, items: (itemsByOffer.get(row.id) ?? []).map((item) => ({ description: item.description, quantity: item.quantity, price: item.price, total: item.total, articleId: item.article_id ?? undefined, category: item.category ?? undefined, taxRate: item.tax_rate ?? undefined })), history: [], createdAt: row.created_at, updatedAt: row.updated_at }));
};

const loadRecurringProfiles = (db: SqliteDatabaseType, tenantId: string): RecurringProfile[] => {
  if (!tableExists(db, 'recurring_profiles')) return [];
  return (db.prepare('SELECT * FROM recurring_profiles ORDER BY next_run ASC, id ASC').all() as SqliteRecurringRow[]).map((row) => ({ id: row.id, tenantId, clientId: row.client_id, active: Boolean(row.active), name: row.name, interval: row.interval, nextRun: row.next_run, lastRun: row.last_run ?? undefined, endDate: row.end_date ?? undefined, amount: row.amount, taxMode: row.tax_mode ?? DEFAULT_TAX_MODE, taxMeta: parseJson(row.tax_meta_json ?? null, undefined), items: parseJson(row.items_json, []) }));
};

const loadEmailLog = (db: SqliteDatabaseType): SqliteEmailLogRow[] => tableExists(db, 'email_log') ? (db.prepare('SELECT * FROM email_log ORDER BY created_at ASC').all() as SqliteEmailLogRow[]) : [];
const loadDunningHistory = (db: SqliteDatabaseType): SqliteDunningHistoryRow[] => tableExists(db, 'dunning_history') ? (db.prepare('SELECT * FROM dunning_history ORDER BY created_at ASC').all() as SqliteDunningHistoryRow[]) : [];
const loadAuditLog = (db: SqliteDatabaseType): SqliteAuditRow[] => tableExists(db, 'audit_log') ? (db.prepare('SELECT sequence, ts, entity_type, entity_id, action, reason, before_json, after_json, prev_hash, hash, actor FROM audit_log ORDER BY sequence ASC').all() as SqliteAuditRow[]) : [];
const loadSettingsJson = (db: SqliteDatabaseType): string | null => tableExists(db, 'settings') ? ((db.prepare('SELECT settings_json FROM settings ORDER BY id ASC LIMIT 1').get() as { settings_json?: string } | undefined)?.settings_json ?? null) : null;
const loadNumberReservations = (db: SqliteDatabaseType, tenantId: string) => tableExists(db, 'number_reservations') ? ((db.prepare('SELECT id, kind, number, counter_value, status, document_id, created_at, updated_at FROM number_reservations ORDER BY created_at ASC').all() as Array<{ id: string; kind: 'invoice' | 'offer' | 'customer'; number: string; counter_value: number; status: 'reserved' | 'released' | 'finalized'; document_id: string | null; created_at: string; updated_at: string }>).map((row) => ({ id: row.id, tenantId, kind: row.kind, number: row.number, counterValue: row.counter_value, status: row.status, documentId: row.document_id, createdAt: row.created_at, updatedAt: row.updated_at }))) : [];
const loadArticles = (db: SqliteDatabaseType, tenantId: string): ServerArticleRecord[] => tableExists(db, 'articles') ? (db.prepare('SELECT * FROM articles ORDER BY title ASC, id ASC').all() as SqliteArticleRow[]).map((row) => ({ id: row.id, tenantId, sku: row.sku ?? undefined, title: row.title, description: row.description, price: row.price, unit: row.unit, category: row.category, taxRate: row.tax_rate })) : [];
const loadAccounts = (db: SqliteDatabaseType, tenantId: string): ServerBankAccountRecord[] => tableExists(db, 'accounts') ? (db.prepare('SELECT * FROM accounts ORDER BY name ASC, id ASC').all() as SqliteAccountRow[]).map((row) => ({ id: row.id, tenantId, name: row.name, iban: row.iban, balance: row.balance, defaultSkrAccountNumber: row.default_skr_account_number, type: row.type, color: row.color })) : [];
const loadLedgerAccounts = (db: SqliteDatabaseType): SqliteLedgerAccountRow[] => tableExists(db, 'ledger_accounts') ? (db.prepare('SELECT * FROM ledger_accounts ORDER BY chart ASC, account_number ASC').all() as SqliteLedgerAccountRow[]) : [];
const loadProWorkflowEntries = (db: SqliteDatabaseType, tenantId: string): ServerProWorkflowRecord[] => tableExists(db, 'pro_workflow_entries') ? (db.prepare('SELECT transaction_id, transaction_json, draft_json, updated_at FROM pro_workflow_entries ORDER BY updated_at DESC, transaction_id ASC').all() as SqliteProWorkflowEntryRow[]).map((row) => ({ tenantId, transactionId: row.transaction_id, transactionJson: row.transaction_json, draftJson: row.draft_json, updatedAt: row.updated_at })) : [];
const loadBankTransactions = (db: SqliteDatabaseType, tenantId: string): ServerBankTransactionRecord[] => tableExists(db, 'bank_transactions') ? (db.prepare('SELECT id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at FROM bank_transactions ORDER BY date DESC, id ASC').all() as SqliteBankTransactionRow[]).map((row) => ({ id: row.id, tenantId, accountId: row.account_id, date: row.date, amount: row.amount, type: row.type, counterparty: row.counterparty, purpose: row.purpose, linkedInvoiceId: row.linked_invoice_id ?? undefined, status: row.status, sourceTransactionId: row.source_transaction_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadBookingDrafts = (db: SqliteDatabaseType, tenantId: string): ServerBookingDraftRecord[] => tableExists(db, 'booking_drafts') ? (db.prepare('SELECT id, transaction_id, workflow_status, draft_json, updated_at FROM booking_drafts ORDER BY updated_at DESC, id ASC').all() as SqliteBookingDraftRow[]).map((row) => ({ id: row.id, tenantId, transactionId: row.transaction_id, workflowStatus: row.workflow_status, draftJson: row.draft_json, updatedAt: row.updated_at })) : [];
const loadBookingDraftLines = (db: SqliteDatabaseType, tenantId: string): ServerBookingDraftLineRecord[] => tableExists(db, 'booking_draft_lines') ? (db.prepare('SELECT * FROM booking_draft_lines ORDER BY draft_id ASC, line_no ASC').all() as SqliteBookingDraftLineRow[]).map((row) => ({ id: row.id, tenantId, draftId: row.draft_id, lineNo: row.line_no, accountNumber: row.account_number, debitAmount: row.debit_amount, creditAmount: row.credit_amount, taxCode: row.tax_code ?? undefined, taxCaseKey: row.tax_case_key ?? undefined, taxRate: row.tax_rate ?? undefined, netAmount: row.net_amount ?? undefined, taxAmount: row.tax_amount ?? undefined, grossAmount: row.gross_amount ?? undefined, countryCode: row.country_code ?? undefined, counterpartyVatId: row.counterparty_vat_id ?? undefined, evidenceType: row.evidence_type ?? undefined, evidenceReference: row.evidence_reference ?? undefined, costCenter: row.cost_center ?? undefined, memo: row.memo ?? undefined })) : [];
const loadDraftValidationIssues = (db: SqliteDatabaseType, tenantId: string): ServerDraftValidationIssueRecord[] => tableExists(db, 'draft_validation_issues') ? (db.prepare('SELECT * FROM draft_validation_issues ORDER BY created_at ASC, id ASC').all() as SqliteDraftValidationIssueRow[]).map((row) => ({ id: row.id, tenantId, draftId: row.draft_id, code: row.code, severity: row.severity, message: row.message, fieldPath: row.field_path ?? undefined, blocking: Boolean(row.blocking), source: row.source, issueJson: row.issue_json, createdAt: row.created_at })) : [];
const loadAccountingPeriods = (db: SqliteDatabaseType, tenantId: string): ServerAccountingPeriodRecord[] => tableExists(db, 'accounting_periods') ? (db.prepare('SELECT * FROM accounting_periods ORDER BY fiscal_year ASC, period ASC').all() as SqliteAccountingPeriodRow[]).map((row) => ({ id: row.id, tenantId, period: row.period, fiscalYear: row.fiscal_year, status: row.status, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadJournalEntries = (db: SqliteDatabaseType, tenantId: string): ServerJournalEntryRecord[] => tableExists(db, 'journal_entries') ? (db.prepare('SELECT * FROM journal_entries ORDER BY posting_date DESC, entry_number DESC').all() as SqliteJournalEntryRow[]).map((row) => ({ id: row.id, tenantId, entryNumber: row.entry_number, postingDate: row.posting_date, documentDate: row.document_date ?? undefined, bookingText: row.booking_text, reference: row.reference ?? undefined, period: row.period, fiscalYear: row.fiscal_year, status: row.status, sourceDraftId: row.source_draft_id ?? undefined, reversedEntryId: row.reversed_entry_id ?? undefined, createdAt: row.created_at })) : [];
const loadJournalLines = (db: SqliteDatabaseType, tenantId: string): ServerJournalLineRecord[] => tableExists(db, 'journal_lines') ? (db.prepare('SELECT * FROM journal_lines ORDER BY entry_id ASC, line_no ASC').all() as SqliteJournalLineRow[]).map((row) => ({ id: row.id, tenantId, entryId: row.entry_id, lineNo: row.line_no, accountNumber: row.account_number, debitAmount: row.debit_amount, creditAmount: row.credit_amount, taxCode: row.tax_code ?? undefined, taxCaseKey: row.tax_case_key ?? undefined, taxRate: row.tax_rate ?? undefined, netAmount: row.net_amount ?? undefined, taxAmount: row.tax_amount ?? undefined, grossAmount: row.gross_amount ?? undefined, countryCode: row.country_code ?? undefined, counterpartyVatId: row.counterparty_vat_id ?? undefined, evidenceType: row.evidence_type ?? undefined, evidenceReference: row.evidence_reference ?? undefined, costCenter: row.cost_center ?? undefined, memo: row.memo ?? undefined })) : [];
const loadAssets = (db: SqliteDatabaseType): SqliteAssetRow[] => tableExists(db, 'assets') ? db.prepare('SELECT * FROM assets ORDER BY asset_number ASC').all() as SqliteAssetRow[] : [];
const loadAssetSchedule = (db: SqliteDatabaseType): SqliteAssetScheduleRow[] => tableExists(db, 'asset_depreciation_schedule') ? db.prepare('SELECT * FROM asset_depreciation_schedule ORDER BY asset_id, year').all() as SqliteAssetScheduleRow[] : [];
const loadAssetMovements = (db: SqliteDatabaseType): SqliteAssetMovementRow[] => tableExists(db, 'asset_movements') ? db.prepare('SELECT * FROM asset_movements ORDER BY movement_date, id').all() as SqliteAssetMovementRow[] : [];
const loadAccountMappingsHgb = (db: SqliteDatabaseType, tenantId: string): ServerAccountMappingHgbRecord[] => tableExists(db, 'account_mappings_hgb') ? (db.prepare('SELECT * FROM account_mappings_hgb ORDER BY chart ASC, account_number ASC').all() as SqliteAccountMappingHgbRow[]).map((row) => ({ id: row.id, tenantId, chart: row.chart, accountNumber: row.account_number, statementType: row.statement_type, positionKey: row.position_key, positionLabel: row.position_label, balanceSide: row.balance_side ?? undefined, updatedAt: row.updated_at })) : [];
const loadReportSnapshots = (db: SqliteDatabaseType, tenantId: string): ServerReportSnapshotRecord[] => tableExists(db, 'report_snapshots') ? (db.prepare('SELECT * FROM report_snapshots ORDER BY created_at ASC, id ASC').all() as SqliteReportSnapshotRow[]).map((row) => ({ id: row.id, tenantId, reportType: row.report_type, argsJson: row.args_json, payloadJson: row.payload_json, createdAt: row.created_at })) : [];
const loadDatevExports = (db: SqliteDatabaseType, tenantId: string): ServerDatevExportRecord[] => tableExists(db, 'datev_exports') ? (db.prepare('SELECT * FROM datev_exports ORDER BY created_at ASC, id ASC').all() as SqliteDatevExportRow[]).map((row) => ({ id: row.id, tenantId, filePath: row.file_path, recordCount: row.record_count, fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined, createdAt: row.created_at, metaJson: row.meta_json })) : [];
const loadTaxCases = (db: SqliteDatabaseType): ServerTaxCaseRecord[] => tableExists(db, 'tax_cases') ? (db.prepare('SELECT * FROM tax_cases ORDER BY key ASC').all() as SqliteTaxCaseRow[]).map((row) => ({ key: row.key, label: row.label, mechanism: row.mechanism, defaultRate: row.default_rate, requiresCounterpartyVatId: Boolean(row.requires_counterparty_vat_id), requiresCountry: Boolean(row.requires_country), requiresEvidence: Boolean(row.requires_evidence), active: Boolean(row.active), updatedAt: row.updated_at })) : [];
const loadTaxCaseAccountMappings = (db: SqliteDatabaseType) => tableExists(db, 'tax_case_account_mappings') ? (db.prepare('SELECT * FROM tax_case_account_mappings ORDER BY chart ASC, tax_case_key ASC, role ASC').all() as SqliteTaxCaseAccountMappingRow[]).map((row) => ({ id: row.id, chart: row.chart, taxCaseKey: row.tax_case_key, role: row.role, accountNumber: row.account_number, datevBuKey: row.datev_bu_key ?? undefined, validFrom: row.valid_from ?? undefined, validTo: row.valid_to ?? undefined, updatedAt: row.updated_at })) : [];
const loadVatEvidence = (db: SqliteDatabaseType, tenantId: string): ServerVatEvidenceRecord[] => tableExists(db, 'vat_evidence') ? (db.prepare('SELECT * FROM vat_evidence ORDER BY captured_at ASC, id ASC').all() as SqliteVatEvidenceRow[]).map((row) => ({ id: row.id, tenantId, draftId: row.draft_id ?? undefined, entryId: row.entry_id ?? undefined, lineId: row.line_id ?? undefined, taxCaseKey: row.tax_case_key, evidenceType: row.evidence_type ?? undefined, evidenceReference: row.evidence_reference ?? undefined, countryCode: row.country_code ?? undefined, counterpartyVatId: row.counterparty_vat_id ?? undefined, capturedAt: row.captured_at })) : [];
const loadJournalPostingPairs = (db: SqliteDatabaseType, tenantId: string): ServerJournalPostingPairRecord[] => tableExists(db, 'journal_posting_pairs') ? (db.prepare('SELECT * FROM journal_posting_pairs ORDER BY created_at ASC, id ASC').all() as SqliteJournalPostingPairRow[]).map((row) => ({ id: row.id, tenantId, entryId: row.entry_id, debitLineId: row.debit_line_id, creditLineId: row.credit_line_id, amount: row.amount, taxCaseKey: row.tax_case_key ?? undefined, datevBuKey: row.datev_bu_key ?? undefined, createdAt: row.created_at })) : [];
const loadTransactions = (db: SqliteDatabaseType, tenantId: string): ServerImportedTransactionRecord[] => tableExists(db, 'transactions') ? (db.prepare('SELECT * FROM transactions ORDER BY date DESC, id ASC').all() as SqliteImportedTransactionRow[]).map((row) => ({ id: row.id, tenantId, accountId: row.account_id, date: row.date, amount: row.amount, type: row.type, counterparty: row.counterparty, purpose: row.purpose, linkedInvoiceId: row.linked_invoice_id ?? undefined, status: row.status, dedupHash: row.dedup_hash ?? undefined, importBatchId: row.import_batch_id ?? undefined, deletedAt: row.deleted_at ?? undefined })) : [];
const loadEurLines = (db: SqliteDatabaseType): ServerEurLineRecord[] => tableExists(db, 'eur_lines') ? (db.prepare('SELECT * FROM eur_lines ORDER BY tax_year ASC, sort_order ASC, id ASC').all() as SqliteEurLineRow[]).map((row) => ({ id: row.id, taxYear: row.tax_year, kennziffer: row.kennziffer ?? undefined, label: row.label, kind: row.kind, exportable: Boolean(row.exportable), sortOrder: row.sort_order, computedFromJson: row.computed_from_json ?? undefined, sourceVersion: row.source_version, createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadEurClassifications = (db: SqliteDatabaseType, tenantId: string): ServerEurClassificationRecord[] => tableExists(db, 'eur_classifications') ? (db.prepare('SELECT * FROM eur_classifications ORDER BY tax_year ASC, source_type ASC, source_id ASC').all() as SqliteEurClassificationRow[]).map((row) => ({ id: row.id, tenantId, sourceType: row.source_type, sourceId: row.source_id, taxYear: row.tax_year, eurLineId: row.eur_line_id ?? undefined, excluded: Boolean(row.excluded), vatMode: row.vat_mode, note: row.note ?? undefined, updatedAt: row.updated_at })) : [];
const loadEurRules = (db: SqliteDatabaseType, tenantId: string): ServerEurRuleRecord[] => tableExists(db, 'eur_rules') ? (db.prepare('SELECT * FROM eur_rules ORDER BY tax_year ASC, priority ASC, id ASC').all() as SqliteEurRuleRow[]).map((row) => ({ id: row.id, tenantId, taxYear: row.tax_year, priority: row.priority, field: row.field, operator: row.operator, value: row.value, targetEurLineId: row.target_eur_line_id, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadAccountKeywords = (db: SqliteDatabaseType, tenantId: string): ServerAccountKeywordRecord[] => tableExists(db, 'account_keywords') ? (db.prepare('SELECT * FROM account_keywords ORDER BY chart ASC, account_number ASC, keyword ASC').all() as SqliteAccountKeywordRow[]).map((row) => ({ id: row.id, tenantId, chart: row.chart, accountNumber: row.account_number, keyword: row.keyword, source: row.source, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadAccountSuggestionRules = (db: SqliteDatabaseType, tenantId: string) => tableExists(db, 'account_suggestion_rules') ? (db.prepare('SELECT * FROM account_suggestion_rules ORDER BY chart ASC, priority ASC, created_at ASC').all() as SqliteAccountSuggestionRuleRow[]).map((row) => ({ id: row.id, tenantId, chart: row.chart, priority: row.priority, field: row.field as 'counterparty' | 'purpose' | 'any', operator: row.operator, value: row.value, targetAccountNumber: row.target_account_number, flowType: row.flow_type, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadImportBatches = (db: SqliteDatabaseType, tenantId: string): ServerImportBatchRecord[] => tableExists(db, 'import_batches') ? (db.prepare('SELECT * FROM import_batches ORDER BY created_at ASC, id ASC').all() as SqliteImportBatchRow[]).map((row) => ({ id: row.id, tenantId, accountId: row.account_id, profile: row.profile, fileName: row.file_name, fileSha256: row.file_sha256, mappingJson: row.mapping_json, importedCount: row.imported_count, skippedCount: row.skipped_count, errorCount: row.error_count, createdAt: row.created_at, rolledBackAt: row.rolled_back_at ?? undefined, rollbackReason: row.rollback_reason ?? undefined })) : [];
const loadTemplates = (db: SqliteDatabaseType, tenantId: string): ServerTemplateRecord[] => tableExists(db, 'templates') ? (db.prepare('SELECT * FROM templates ORDER BY kind ASC, name ASC, id ASC').all() as SqliteTemplateRow[]).map((row) => ({ id: row.id, tenantId, kind: row.kind, name: row.name, elementsJson: row.elements_json, createdAt: row.created_at, updatedAt: row.updated_at })) : [];
const loadActiveTemplates = (db: SqliteDatabaseType, tenantId: string): ServerActiveTemplatesRecord | null => {
  if (!tableExists(db, 'active_templates')) return null;
  const row = db.prepare('SELECT * FROM active_templates ORDER BY id ASC LIMIT 1').get() as SqliteActiveTemplateRow | undefined;
  if (!row) return null;
  return { tenantId, id: row.id, invoiceTemplateId: row.invoice_template_id ?? undefined, offerTemplateId: row.offer_template_id ?? undefined };
};

const emptyCounts = (): DesktopSqliteImportCounts => ({
  clients: 0,
  invoices: 0,
  offers: 0,
  recurringProfiles: 0,
  articles: 0,
  accounts: 0,
  templates: 0,
  activeTemplates: 0,
  ledgerAccounts: 0,
  proWorkflowEntries: 0,
  bankTransactions: 0,
  bookingDrafts: 0,
  bookingDraftLines: 0,
  draftValidationIssues: 0,
  accountingPeriods: 0,
  journalEntries: 0,
  journalLines: 0,
  assets: 0,
  assetDepreciationSchedule: 0,
  assetMovements: 0,
  accountMappingsHgb: 0,
  reportSnapshots: 0,
  datevExports: 0,
  taxCases: 0,
  taxCaseAccountMappings: 0,
  vatEvidence: 0,
  journalPostingPairs: 0,
  transactions: 0,
  eurLines: 0,
  eurClassifications: 0,
  eurRules: 0,
  accountKeywords: 0,
  accountSuggestionRules: 0,
  importBatches: 0,
  emailLog: 0,
  dunningHistory: 0,
  auditLog: 0,
  numberReservations: 0,
});

export const importDesktopSqliteToPostgres = async (options: DesktopSqliteImportOptions): Promise<DesktopSqliteImportResult> => {
  const Database = await loadSqliteModule();
  const sqliteDb = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  try {
    await runPostgresMigrations(options.pool);
    const allTables = listTables(sqliteDb);
    const unsupportedTables = detectUnsupportedSqliteTables(allTables, (table) => countTable(sqliteDb, table));
    if (unsupportedTables.length > 0 && options.failOnUnsupportedData !== false) {
      throw new Error(`SQLite source contains unsupported populated tables: ${unsupportedTables.map((entry) => `${entry.table} (${entry.rowCount})`).join(', ')}`);
    }
    const tenantId = options.tenant.id;
    const scope = createSingleTenantScope(tenantId, options.product);
    const counts = emptyCounts();
    const sourceAuditRows = loadAuditLog(sqliteDb);
    const sourceAuditVerification = verifyAuditChainRows(sourceAuditRows);
    if (!sourceAuditVerification.ok) {
      throw new Error(`SQLite audit log verification failed: ${sourceAuditVerification.errors.map((entry) => `#${entry.sequence} ${entry.message}`).join(', ')}`);
    }
    const importRunId = randomUUID();
    const drizzle = createDrizzle(options.pool);
    await drizzle.insert(schema.sqliteImportRuns).values({ id: importRunId, tenantId, sourcePath: options.sqlitePath,
      sourceProduct: options.product, sourceSha256: await sha256File(options.sqlitePath), status: 'started',
      detailsJson: JSON.stringify({ unsupportedTables }), startedAt: new Date().toISOString(), completedAt: null });
    try {
      await withPostgresTransaction(options.pool, async (client) => {
        if ((await countTenantCoreRows(client, tenantId)) > 0) throw new Error(`Target tenant ${tenantId} already contains server billing data`);
        const auditCount = await createDrizzle(client).select({ count: count() }).from(schema.auditLog)
          .where(eq(schema.auditLog.tenantId, tenantId));
        if (Number(auditCount[0]?.count ?? 0) > 0) throw new Error(`Target tenant ${tenantId} already contains audit log rows`);
        const dependencies = createPostgresBillingDependencies(client);
        await dependencies.tenantRepo.save({ id: tenantId, slug: options.tenant.slug, displayName: options.tenant.displayName, product: options.product, deploymentMode: 'single-tenant', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const settingsJson = loadSettingsJson(sqliteDb);
        if (settingsJson) await saveServerSettings(client, { tenantId, settingsJson, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        for (const reservation of loadNumberReservations(sqliteDb, tenantId)) { await saveServerNumberReservation(client, reservation); counts.numberReservations += 1; }
        for (const article of loadArticles(sqliteDb, tenantId)) { await saveServerArticle(client, article); counts.articles += 1; }
        for (const account of loadAccounts(sqliteDb, tenantId)) { await saveServerBankAccount(client, account); counts.accounts += 1; }
        for (const template of loadTemplates(sqliteDb, tenantId)) { await saveServerTemplate(client, template); counts.templates += 1; }
        const activeTemplates = loadActiveTemplates(sqliteDb, tenantId);
        if (activeTemplates) { await saveServerActiveTemplates(client, activeTemplates); counts.activeTemplates += 1; }
        for (const clientRecord of loadClients(sqliteDb, tenantId)) { await dependencies.clientRepo.save(scope, clientRecord); counts.clients += 1; }
        for (const invoice of loadInvoices(sqliteDb, tenantId)) { await dependencies.invoiceRepo.save(scope, invoice); counts.invoices += 1; }
        for (const offer of loadOffers(sqliteDb, tenantId)) { await dependencies.offerRepo.save(scope, offer); counts.offers += 1; }
        for (const profile of loadRecurringProfiles(sqliteDb, tenantId)) { await dependencies.recurringProfileRepo.save(scope, profile); counts.recurringProfiles += 1; }
        for (const ledgerAccount of loadLedgerAccounts(sqliteDb)) { await saveServerLedgerAccount(client, { id: ledgerAccount.id, chart: ledgerAccount.chart, accountNumber: ledgerAccount.account_number, name: ledgerAccount.name, source: ledgerAccount.source, createdAt: ledgerAccount.created_at, updatedAt: ledgerAccount.updated_at }); counts.ledgerAccounts += 1; }
        for (const taxCase of loadTaxCases(sqliteDb)) { await saveServerTaxCase(client, taxCase); counts.taxCases += 1; }
        for (const mapping of loadTaxCaseAccountMappings(sqliteDb)) { await saveServerTaxCaseAccountMapping(client, mapping); counts.taxCaseAccountMappings += 1; }
        for (const eurLine of loadEurLines(sqliteDb)) { await saveServerEurLine(client, eurLine); counts.eurLines += 1; }
        for (const eurRule of loadEurRules(sqliteDb, tenantId)) { await saveServerEurRule(client, eurRule); counts.eurRules += 1; }
        for (const keyword of loadAccountKeywords(sqliteDb, tenantId)) { await saveServerAccountKeyword(client, keyword); counts.accountKeywords += 1; }
        for (const rule of loadAccountSuggestionRules(sqliteDb, tenantId)) { await saveServerAccountSuggestionRule(client, rule); counts.accountSuggestionRules += 1; }
        for (const workflowEntry of loadProWorkflowEntries(sqliteDb, tenantId)) { await saveServerProWorkflowEntry(client, workflowEntry); counts.proWorkflowEntries += 1; }
        for (const row of loadBankTransactions(sqliteDb, tenantId)) { await saveServerBankTransaction(client, row); counts.bankTransactions += 1; }
        for (const row of loadBookingDrafts(sqliteDb, tenantId)) { await saveServerBookingDraft(client, row); counts.bookingDrafts += 1; }
        for (const row of loadBookingDraftLines(sqliteDb, tenantId)) { await saveServerBookingDraftLine(client, row); counts.bookingDraftLines += 1; }
        for (const row of loadDraftValidationIssues(sqliteDb, tenantId)) { await saveServerDraftValidationIssue(client, row); counts.draftValidationIssues += 1; }
        for (const row of loadAccountingPeriods(sqliteDb, tenantId)) { await saveServerAccountingPeriod(client, row); counts.accountingPeriods += 1; }
        for (const row of loadJournalEntries(sqliteDb, tenantId)) { await saveServerJournalEntry(client, row); counts.journalEntries += 1; }
        for (const row of loadJournalLines(sqliteDb, tenantId)) { await saveServerJournalLine(client, row); counts.journalLines += 1; }
        for (const row of loadAssets(sqliteDb)) {
          await createDrizzle(client).insert(schema.assets).values({ id: row.id, tenantId, assetNumber: row.asset_number, name: row.name,
            assetClass: row.asset_class, status: row.status, activationDate: row.activation_date, acquisitionCost: row.acquisition_cost,
            usefulLifeYears: row.useful_life_years, depreciationMethod: row.depreciation_method, costCenter: row.cost_center,
            location: row.location, receiptLinked: Boolean(row.receipt_linked), supplier: row.supplier, invoiceRef: row.invoice_ref,
            assetAccountNumber: row.asset_account_number, disposalDate: row.disposal_date, disposalProceeds: row.disposal_proceeds,
            createdAt: row.created_at, updatedAt: row.updated_at } as any);
          counts.assets += 1;
        }
        for (const row of loadAssetSchedule(sqliteDb)) {
          await createDrizzle(client).insert(schema.assetDepreciationSchedule).values({ id: row.id, tenantId, assetId: row.asset_id,
            year: row.year, amount: row.amount, months: row.months, status: row.status, journalEntryId: row.journal_entry_id, postedAt: row.posted_at } as any);
          counts.assetDepreciationSchedule += 1;
        }
        for (const row of loadAssetMovements(sqliteDb)) {
          await createDrizzle(client).insert(schema.assetMovements).values({ id: row.id, tenantId, assetId: row.asset_id, type: row.type,
            movementDate: row.movement_date, amount: row.amount, proceeds: row.proceeds, gainLoss: row.gain_loss, reason: row.reason, createdAt: row.created_at } as any);
          counts.assetMovements += 1;
        }
        for (const row of loadAccountMappingsHgb(sqliteDb, tenantId)) { await saveServerAccountMappingHgb(client, row); counts.accountMappingsHgb += 1; }
        for (const row of loadReportSnapshots(sqliteDb, tenantId)) { await saveServerReportSnapshot(client, row); counts.reportSnapshots += 1; }
        for (const row of loadDatevExports(sqliteDb, tenantId)) { await saveServerDatevExport(client, row); counts.datevExports += 1; }
        for (const row of loadVatEvidence(sqliteDb, tenantId)) { await saveServerVatEvidence(client, row); counts.vatEvidence += 1; }
        for (const row of loadJournalPostingPairs(sqliteDb, tenantId)) { await saveServerJournalPostingPair(client, row); counts.journalPostingPairs += 1; }
        for (const row of loadImportBatches(sqliteDb, tenantId)) { await saveServerImportBatch(client, row); counts.importBatches += 1; }
        for (const row of loadTransactions(sqliteDb, tenantId)) { await saveServerImportedTransaction(client, row); counts.transactions += 1; }
        for (const row of loadEurClassifications(sqliteDb, tenantId)) { await saveServerEurClassification(client, row); counts.eurClassifications += 1; }
        for (const row of loadEmailLog(sqliteDb)) { await insertEmailLogRow(client, tenantId, { id: row.id, documentType: row.document_type, documentId: row.document_id, documentNumber: row.document_number, recipientEmail: row.recipient_email, recipientName: row.recipient_name, subject: row.subject, bodyText: row.body_text, provider: row.provider, status: row.status, errorMessage: row.error_message, sentAt: row.sent_at, createdAt: row.created_at }); counts.emailLog += 1; }
        for (const row of loadDunningHistory(sqliteDb)) { await createDrizzle(client).insert(schema.dunningHistory).values({ id: row.id, tenantId, invoiceId: row.invoice_id, invoiceNumber: row.invoice_number, dunningLevel: row.dunning_level, daysOverdue: row.days_overdue, feeApplied: row.fee_applied, emailSent: Boolean(row.email_sent), emailLogId: row.email_log_id, processedAt: row.processed_at, createdAt: row.created_at } as any); counts.dunningHistory += 1; }
        for (const row of sourceAuditRows) { await insertAuditRow(client, tenantId, { sequence: row.sequence, ts: row.ts, entityType: row.entity_type, entityId: row.entity_id, action: row.action, reason: row.reason, beforeJson: row.before_json, afterJson: row.after_json, prevHash: row.prev_hash, hash: row.hash, actor: row.actor }); counts.auditLog += 1; }
        const importedVerification = await verifyPostgresAuditChain(client, tenantId);
        if (!importedVerification.ok) throw new Error(`Imported audit log verification failed: ${importedVerification.errors.map((entry) => `#${entry.sequence} ${entry.message}`).join(', ')}`);
      });
      await createDrizzle(options.pool).update(schema.sqliteImportRuns).set({ status: 'completed', detailsJson: JSON.stringify({ counts, unsupportedTables }), completedAt: new Date().toISOString() }).where(eq(schema.sqliteImportRuns.id, importRunId));
    } catch (error) {
      await createDrizzle(options.pool).update(schema.sqliteImportRuns).set({ status: 'failed', detailsJson: JSON.stringify({ counts, unsupportedTables, error: error instanceof Error ? error.message : String(error) }), completedAt: new Date().toISOString() }).where(eq(schema.sqliteImportRuns.id, importRunId));
      throw error;
    }
    return { importRunId, counts, unsupportedTables };
  } finally {
    sqliteDb.close();
  }
};
