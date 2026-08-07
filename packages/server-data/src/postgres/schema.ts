import {
  boolean,
  bigint,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { pgSchema } from "drizzle-orm/pg-core";

const drizzleSchema = pgSchema("drizzle");
export const drizzleMigrations = drizzleSchema.table("__drizzle_migrations", {
  id: integer("id"),
  hash: text("hash"),
  createdAt: bigint("created_at", { mode: "number" }),
});

export const tenants = pgTable("tenants", {
  id: text("id"),
  slug: text("slug"),
  displayName: text("display_name"),
  product: text("product"),
  deploymentMode: text("deployment_mode"),
  status: text("status"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const userAccounts = pgTable("user_accounts", {
  id: text("id"),
  email: text("email"),
  fullName: text("full_name"),
  status: text("status"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const tenantMemberships = pgTable("tenant_memberships", {
  id: text("id"),
  tenantId: text("tenant_id"),
  userId: text("user_id"),
  role: text("role"),
  invitedByUserId: text("invited_by_user_id"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const userPasswordCredentials = pgTable("user_password_credentials", {
  userId: text("user_id"),
  passwordSalt: text("password_salt"),
  passwordHash: text("password_hash"),
  passwordAlgorithm: text("password_algorithm"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const serverSettings = pgTable("server_settings", {
  tenantId: text("tenant_id"),
  settingsJson: text("settings_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const numberReservations = pgTable("number_reservations", {
  id: text("id"),
  tenantId: text("tenant_id"),
  kind: text("kind"),
  number: text("number"),
  counterValue: integer("counter_value"),
  status: text("status"),
  documentId: text("document_id"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const clients = pgTable("clients", {
  id: text("id"),
  tenantId: text("tenant_id"),
  customerNumber: text("customer_number"),
  company: text("company"),
  contactPerson: text("contact_person"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  status: text("status"),
  avatar: text("avatar"),
  tagsJson: text("tags_json"),
  notes: text("notes"),
  addressesJson: text("addresses_json"),
  emailsJson: text("emails_json"),
  projectsJson: text("projects_json"),
  activitiesJson: text("activities_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
  taxProfileJson: text("tax_profile_json"),
});

export const invoices = pgTable("invoices", {
  id: text("id"),
  tenantId: text("tenant_id"),
  clientId: text("client_id"),
  clientNumber: text("client_number"),
  projectId: text("project_id"),
  number: text("number"),
  client: text("client"),
  clientEmail: text("client_email"),
  clientAddress: text("client_address"),
  billingAddressJson: text("billing_address_json"),
  shippingAddressJson: text("shipping_address_json"),
  date: text("date"),
  dueDate: text("due_date"),
  servicePeriod: text("service_period"),
  amount: numeric("amount"),
  status: text("status"),
  dunningLevel: integer("dunning_level"),
  itemsJson: text("items_json"),
  paymentsJson: text("payments_json"),
  historyJson: text("history_json"),
  taxMode: text("tax_mode"),
  taxMetaJson: text("tax_meta_json"),
  taxSnapshotJson: text("tax_snapshot_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const offers = pgTable("offers", {
  id: text("id"),
  tenantId: text("tenant_id"),
  clientId: text("client_id"),
  clientNumber: text("client_number"),
  projectId: text("project_id"),
  number: text("number"),
  client: text("client"),
  clientEmail: text("client_email"),
  clientAddress: text("client_address"),
  billingAddressJson: text("billing_address_json"),
  shippingAddressJson: text("shipping_address_json"),
  date: text("date"),
  validUntil: text("valid_until"),
  amount: numeric("amount"),
  status: text("status"),
  shareJson: text("share_json"),
  historyJson: text("history_json"),
  itemsJson: text("items_json"),
  taxMode: text("tax_mode"),
  taxMetaJson: text("tax_meta_json"),
  taxSnapshotJson: text("tax_snapshot_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const recurringProfiles = pgTable("recurring_profiles", {
  id: text("id"),
  tenantId: text("tenant_id"),
  clientId: text("client_id"),
  active: boolean("active"),
  name: text("name"),
  interval: text("interval"),
  nextRun: text("next_run"),
  lastRun: text("last_run"),
  endDate: text("end_date"),
  amount: numeric("amount"),
  itemsJson: text("items_json"),
  taxMode: text("tax_mode"),
  taxMetaJson: text("tax_meta_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const emailLog = pgTable("email_log", {
  id: text("id"),
  tenantId: text("tenant_id"),
  documentType: text("document_type"),
  documentId: text("document_id"),
  documentNumber: text("document_number"),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  subject: text("subject"),
  bodyText: text("body_text"),
  provider: text("provider"),
  status: text("status"),
  errorMessage: text("error_message"),
  sentAt: text("sent_at"),
  createdAt: text("created_at"),
});

export const emailOutbox = pgTable("email_outbox", {
  id: text("id"),
  tenantId: text("tenant_id"),
  dedupeKey: text("dedupe_key"),
  documentType: text("document_type"),
  documentId: text("document_id"),
  documentNumber: text("document_number"),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  subject: text("subject"),
  bodyText: text("body_text"),
  status: text("status"),
  attemptCount: integer("attempt_count"),
  maxAttempts: integer("max_attempts"),
  nextAttemptAt: text("next_attempt_at"),
  lastAttemptAt: text("last_attempt_at"),
  lockedAt: text("locked_at"),
  leaseExpiresAt: text("lease_expires_at"),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  provider: text("provider"),
  providerMessageId: text("provider_message_id"),
  sentAt: text("sent_at"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const dunningHistory = pgTable("dunning_history", {
  id: text("id"),
  tenantId: text("tenant_id"),
  invoiceId: text("invoice_id"),
  invoiceNumber: text("invoice_number"),
  dunningLevel: integer("dunning_level"),
  daysOverdue: integer("days_overdue"),
  feeApplied: numeric("fee_applied"),
  emailSent: boolean("email_sent"),
  emailLogId: text("email_log_id"),
  processedAt: text("processed_at"),
  createdAt: text("created_at"),
});

export const auditLog = pgTable("audit_log", {
  id: text("id"),
  tenantId: text("tenant_id"),
  sequence: integer("sequence"),
  ts: text("ts"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  action: text("action"),
  reason: text("reason"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  prevHash: text("prev_hash"),
  hash: text("hash"),
  actor: text("actor"),
});

export const sqliteImportRuns = pgTable("sqlite_import_runs", {
  id: text("id"),
  tenantId: text("tenant_id"),
  sourcePath: text("source_path"),
  sourceProduct: text("source_product"),
  sourceSha256: text("source_sha256"),
  status: text("status"),
  detailsJson: text("details_json"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const articles = pgTable("articles", {
  id: text("id"),
  tenantId: text("tenant_id"),
  sku: text("sku"),
  title: text("title"),
  description: text("description"),
  price: numeric("price"),
  unit: text("unit"),
  category: text("category"),
  taxRate: numeric("tax_rate"),
});

export const accounts = pgTable("accounts", {
  id: text("id"),
  tenantId: text("tenant_id"),
  name: text("name"),
  iban: text("iban"),
  balance: numeric("balance"),
  defaultSkrAccountNumber: text("default_skr_account_number"),
  type: text("type"),
  color: text("color"),
});

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: text("id"),
  chart: text("chart"),
  accountNumber: text("account_number"),
  name: text("name"),
  source: text("source"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const proWorkflowEntries = pgTable("pro_workflow_entries", {
  tenantId: text("tenant_id"),
  transactionId: text("transaction_id"),
  transactionJson: text("transaction_json"),
  draftJson: text("draft_json"),
  updatedAt: text("updated_at"),
});

export const bankTransactions = pgTable("bank_transactions", {
  id: text("id"),
  tenantId: text("tenant_id"),
  accountId: text("account_id"),
  date: text("date"),
  amount: numeric("amount"),
  type: text("type"),
  counterparty: text("counterparty"),
  purpose: text("purpose"),
  linkedInvoiceId: text("linked_invoice_id"),
  status: text("status"),
  sourceTransactionId: text("source_transaction_id"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const bookingDrafts = pgTable("booking_drafts", {
  id: text("id"),
  tenantId: text("tenant_id"),
  transactionId: text("transaction_id"),
  workflowStatus: text("workflow_status"),
  draftJson: text("draft_json"),
  updatedAt: text("updated_at"),
});

export const bookingDraftLines = pgTable("booking_draft_lines", {
  id: text("id"),
  tenantId: text("tenant_id"),
  draftId: text("draft_id"),
  lineNo: integer("line_no"),
  accountNumber: text("account_number"),
  debitAmount: numeric("debit_amount"),
  creditAmount: numeric("credit_amount"),
  taxCode: text("tax_code"),
  taxCaseKey: text("tax_case_key"),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount"),
  taxAmount: numeric("tax_amount"),
  grossAmount: numeric("gross_amount"),
  countryCode: text("country_code"),
  counterpartyVatId: text("counterparty_vat_id"),
  evidenceType: text("evidence_type"),
  evidenceReference: text("evidence_reference"),
  costCenter: text("cost_center"),
  memo: text("memo"),
});

export const draftValidationIssues = pgTable("draft_validation_issues", {
  id: text("id"),
  tenantId: text("tenant_id"),
  draftId: text("draft_id"),
  code: text("code"),
  severity: text("severity"),
  message: text("message"),
  fieldPath: text("field_path"),
  blocking: boolean("blocking"),
  source: text("source"),
  issueJson: text("issue_json"),
  createdAt: text("created_at"),
});

export const accountingPeriods = pgTable("accounting_periods", {
  id: text("id"),
  tenantId: text("tenant_id"),
  period: text("period"),
  fiscalYear: integer("fiscal_year"),
  status: text("status"),
  startsAt: text("starts_at"),
  endsAt: text("ends_at"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const journalEntries = pgTable("journal_entries", {
  id: text("id"),
  tenantId: text("tenant_id"),
  entryNumber: integer("entry_number"),
  postingDate: text("posting_date"),
  documentDate: text("document_date"),
  bookingText: text("booking_text"),
  reference: text("reference"),
  period: text("period"),
  fiscalYear: integer("fiscal_year"),
  status: text("status"),
  sourceDraftId: text("source_draft_id"),
  reversedEntryId: text("reversed_entry_id"),
  createdAt: text("created_at"),
});

export const journalLines = pgTable("journal_lines", {
  id: text("id"),
  tenantId: text("tenant_id"),
  entryId: text("entry_id"),
  lineNo: integer("line_no"),
  accountNumber: text("account_number"),
  debitAmount: numeric("debit_amount"),
  creditAmount: numeric("credit_amount"),
  taxCode: text("tax_code"),
  taxCaseKey: text("tax_case_key"),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount"),
  taxAmount: numeric("tax_amount"),
  grossAmount: numeric("gross_amount"),
  countryCode: text("country_code"),
  counterpartyVatId: text("counterparty_vat_id"),
  evidenceType: text("evidence_type"),
  evidenceReference: text("evidence_reference"),
  costCenter: text("cost_center"),
  memo: text("memo"),
});

export const accountMappingsHgb = pgTable("account_mappings_hgb", {
  id: text("id"),
  tenantId: text("tenant_id"),
  chart: text("chart"),
  accountNumber: text("account_number"),
  statementType: text("statement_type"),
  positionKey: text("position_key"),
  positionLabel: text("position_label"),
  balanceSide: text("balance_side"),
  updatedAt: text("updated_at"),
});

export const reportSnapshots = pgTable("report_snapshots", {
  id: text("id"),
  tenantId: text("tenant_id"),
  reportType: text("report_type"),
  argsJson: text("args_json"),
  payloadJson: text("payload_json"),
  createdAt: text("created_at"),
});

export const datevExports = pgTable("datev_exports", {
  id: text("id"),
  tenantId: text("tenant_id"),
  filePath: text("file_path"),
  recordCount: integer("record_count"),
  fromDate: text("from_date"),
  toDate: text("to_date"),
  createdAt: text("created_at"),
  metaJson: text("meta_json"),
});

export const taxCases = pgTable("tax_cases", {
  key: text("key"),
  label: text("label"),
  mechanism: text("mechanism"),
  defaultRate: numeric("default_rate"),
  requiresCounterpartyVatId: boolean("requires_counterparty_vat_id"),
  requiresCountry: boolean("requires_country"),
  requiresEvidence: boolean("requires_evidence"),
  active: boolean("active"),
  updatedAt: text("updated_at"),
});

export const taxCaseAccountMappings = pgTable("tax_case_account_mappings", {
  id: text("id"),
  chart: text("chart"),
  taxCaseKey: text("tax_case_key"),
  role: text("role"),
  accountNumber: text("account_number"),
  datevBuKey: text("datev_bu_key"),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  updatedAt: text("updated_at"),
});

export const vatEvidence = pgTable("vat_evidence", {
  id: text("id"),
  tenantId: text("tenant_id"),
  draftId: text("draft_id"),
  entryId: text("entry_id"),
  lineId: text("line_id"),
  taxCaseKey: text("tax_case_key"),
  evidenceType: text("evidence_type"),
  evidenceReference: text("evidence_reference"),
  countryCode: text("country_code"),
  counterpartyVatId: text("counterparty_vat_id"),
  capturedAt: text("captured_at"),
});

export const journalPostingPairs = pgTable("journal_posting_pairs", {
  id: text("id"),
  tenantId: text("tenant_id"),
  entryId: text("entry_id"),
  debitLineId: text("debit_line_id"),
  creditLineId: text("credit_line_id"),
  amount: numeric("amount"),
  taxCaseKey: text("tax_case_key"),
  datevBuKey: text("datev_bu_key"),
  createdAt: text("created_at"),
});

export const transactions = pgTable("transactions", {
  id: text("id"),
  tenantId: text("tenant_id"),
  accountId: text("account_id"),
  date: text("date"),
  amount: numeric("amount"),
  type: text("type"),
  counterparty: text("counterparty"),
  purpose: text("purpose"),
  linkedInvoiceId: text("linked_invoice_id"),
  status: text("status"),
  dedupHash: text("dedup_hash"),
  importBatchId: text("import_batch_id"),
  deletedAt: text("deleted_at"),
});

export const eurLines = pgTable("eur_lines", {
  id: text("id"),
  taxYear: integer("tax_year"),
  kennziffer: text("kennziffer"),
  label: text("label"),
  kind: text("kind"),
  exportable: boolean("exportable"),
  sortOrder: integer("sort_order"),
  computedFromJson: text("computed_from_json"),
  sourceVersion: text("source_version"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const eurClassifications = pgTable("eur_classifications", {
  id: text("id"),
  tenantId: text("tenant_id"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  taxYear: integer("tax_year"),
  eurLineId: text("eur_line_id"),
  excluded: boolean("excluded"),
  vatMode: text("vat_mode"),
  note: text("note"),
  updatedAt: text("updated_at"),
});

export const eurRules = pgTable("eur_rules", {
  id: text("id"),
  tenantId: text("tenant_id"),
  taxYear: integer("tax_year"),
  priority: integer("priority"),
  field: text("field"),
  operator: text("operator"),
  value: text("value"),
  targetEurLineId: text("target_eur_line_id"),
  active: boolean("active"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const accountKeywords = pgTable("account_keywords", {
  id: text("id"),
  tenantId: text("tenant_id"),
  chart: text("chart"),
  accountNumber: text("account_number"),
  keyword: text("keyword"),
  source: text("source"),
  active: boolean("active"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const accountSuggestionRules = pgTable("account_suggestion_rules", {
  id: text("id"),
  tenantId: text("tenant_id"),
  chart: text("chart"),
  priority: integer("priority"),
  field: text("field"),
  operator: text("operator"),
  value: text("value"),
  targetAccountNumber: text("target_account_number"),
  flowType: text("flow_type"),
  active: boolean("active"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const importBatches = pgTable("import_batches", {
  id: text("id"),
  tenantId: text("tenant_id"),
  accountId: text("account_id"),
  profile: text("profile"),
  fileName: text("file_name"),
  fileSha256: text("file_sha256"),
  mappingJson: text("mapping_json"),
  importedCount: integer("imported_count"),
  skippedCount: integer("skipped_count"),
  errorCount: integer("error_count"),
  createdAt: text("created_at"),
  rolledBackAt: text("rolled_back_at"),
  rollbackReason: text("rollback_reason"),
});

export const templates = pgTable("templates", {
  id: text("id"),
  tenantId: text("tenant_id"),
  kind: text("kind"),
  name: text("name"),
  elementsJson: text("elements_json"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const activeTemplates = pgTable("active_templates", {
  tenantId: text("tenant_id"),
  id: integer("id"),
  invoiceTemplateId: text("invoice_template_id"),
  offerTemplateId: text("offer_template_id"),
});

export const assets = pgTable("assets", {
  id: text("id"),
  tenantId: text("tenant_id"),
  assetNumber: text("asset_number"),
  name: text("name"),
  assetClass: text("asset_class"),
  status: text("status"),
  activationDate: text("activation_date"),
  acquisitionCost: numeric("acquisition_cost"),
  usefulLifeYears: integer("useful_life_years"),
  depreciationMethod: text("depreciation_method"),
  costCenter: text("cost_center"),
  location: text("location"),
  receiptLinked: boolean("receipt_linked"),
  supplier: text("supplier"),
  invoiceRef: text("invoice_ref"),
  assetAccountNumber: text("asset_account_number"),
  disposalDate: text("disposal_date"),
  disposalProceeds: numeric("disposal_proceeds"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const assetDepreciationSchedule = pgTable(
  "asset_depreciation_schedule",
  {
    id: text("id"),
    tenantId: text("tenant_id"),
    assetId: text("asset_id"),
    year: integer("year"),
    amount: numeric("amount"),
    months: integer("months"),
    status: text("status"),
    journalEntryId: text("journal_entry_id"),
    postedAt: text("posted_at"),
  },
);

export const assetMovements = pgTable("asset_movements", {
  id: text("id"),
  tenantId: text("tenant_id"),
  assetId: text("asset_id"),
  type: text("type"),
  movementDate: text("movement_date"),
  amount: numeric("amount"),
  proceeds: numeric("proceeds"),
  gainLoss: numeric("gain_loss"),
  reason: text("reason"),
  createdAt: text("created_at"),
});

export const auditHeads = pgTable("audit_heads", {
  tenantId: text("tenant_id").primaryKey(),
  sequence: integer("sequence").notNull(),
  hash: text("hash"),
});
