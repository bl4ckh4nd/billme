import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  clientId: text('client_id'),
  clientNumber: text('client_number'),
  projectId: text('project_id'),
  number: text('number').notNull(),
  client: text('client').notNull(),
  clientEmail: text('client_email').notNull(),
  clientAddress: text('client_address'),
  billingAddressJson: text('billing_address_json'),
  shippingAddressJson: text('shipping_address_json'),
  taxMode: text('tax_mode').notNull().default('standard_vat'),
  taxMetaJson: text('tax_meta_json'),
  taxSnapshotJson: text('tax_snapshot_json'),
  date: text('date').notNull(),
  dueDate: text('due_date').notNull(),
  servicePeriod: text('service_period'),
  amount: real('amount').notNull(),
  status: text('status').notNull(),
  dunningLevel: integer('dunning_level').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const invoiceItems = sqliteTable('invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: text('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  description: text('description').notNull(),
  articleId: text('article_id'),
  category: text('category'),
  unit: text('unit'),
  discountPercent: real('discount_percent'),
  taxRate: real('tax_rate'),
  quantity: real('quantity').notNull(),
  price: real('price').notNull(),
  total: real('total').notNull(),
});

export const invoicePayments = sqliteTable('invoice_payments', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  amount: real('amount').notNull(),
  method: text('method').notNull(),
});

export const offers = sqliteTable('offers', {
  id: text('id').primaryKey(),
  clientId: text('client_id'),
  clientNumber: text('client_number'),
  projectId: text('project_id'),
  number: text('number').notNull(),
  client: text('client').notNull(),
  clientEmail: text('client_email').notNull(),
  clientAddress: text('client_address'),
  billingAddressJson: text('billing_address_json'),
  shippingAddressJson: text('shipping_address_json'),
  date: text('date').notNull(),
  validUntil: text('valid_until').notNull(),
  taxMode: text('tax_mode').notNull().default('standard_vat'),
  taxMetaJson: text('tax_meta_json'),
  taxSnapshotJson: text('tax_snapshot_json'),
  amount: real('amount').notNull(),
  status: text('status').notNull(),
  shareToken: text('share_token'),
  sharePublishedAt: text('share_published_at'),
  acceptedAt: text('accepted_at'),
  acceptedBy: text('accepted_by'),
  acceptedEmail: text('accepted_email'),
  acceptedUserAgent: text('accepted_user_agent'),
  decision: text('decision'),
  decisionTextVersion: text('decision_text_version'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const offerItems = sqliteTable('offer_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: text('offer_id')
    .notNull()
    .references(() => offers.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  description: text('description').notNull(),
  articleId: text('article_id'),
  category: text('category'),
  unit: text('unit'),
  discountPercent: real('discount_percent'),
  taxRate: real('tax_rate'),
  quantity: real('quantity').notNull(),
  price: real('price').notNull(),
  total: real('total').notNull(),
});

export const clients = sqliteTable(
  'clients',
  {
    id: text('id').primaryKey(),
    customerNumber: text('customer_number'),
    company: text('company').notNull(),
    contactPerson: text('contact_person').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    address: text('address').notNull(),
    status: text('status').notNull(),
    avatar: text('avatar'),
    tagsJson: text('tags_json').notNull(),
    notes: text('notes').notNull(),
    taxProfileJson: text('tax_profile_json'),
  },
  (t) => ({
    byCustomerNumber: uniqueIndex('idx_clients_customer_number_unique').on(t.customerNumber),
  }),
);

export const clientAddresses = sqliteTable(
  'client_addresses',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    company: text('company'),
    contactPerson: text('contact_person'),
    street: text('street').notNull(),
    line2: text('line2'),
    zip: text('zip').notNull(),
    city: text('city').notNull(),
    country: text('country').notNull(),
    isDefaultBilling: integer('is_default_billing').notNull().default(0),
    isDefaultShipping: integer('is_default_shipping').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byClient: index('idx_client_addresses_client').on(t.clientId),
  }),
);

export const clientEmails = sqliteTable(
  'client_emails',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    email: text('email').notNull(),
    isDefaultGeneral: integer('is_default_general').notNull().default(0),
    isDefaultBilling: integer('is_default_billing').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byClient: index('idx_client_emails_client').on(t.clientId),
  }),
);

export const clientProjects = sqliteTable('client_projects', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  code: text('code'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  budget: real('budget').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  description: text('description'),
  archivedAt: text('archived_at'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const clientActivities = sqliteTable('client_activities', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  content: text('content').notNull(),
  date: text('date').notNull(),
  author: text('author').notNull(),
});

export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  sku: text('sku'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  price: real('price').notNull(),
  unit: text('unit').notNull(),
  category: text('category').notNull(),
  taxRate: real('tax_rate').notNull(),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  iban: text('iban').notNull(),
  balance: real('balance').notNull(),
  defaultSkrAccountNumber: text('default_skr_account_number').notNull(),
  type: text('type').notNull(),
  color: text('color').notNull(),
});

export const ledgerAccounts = sqliteTable(
  'ledger_accounts',
  {
    id: text('id').primaryKey(),
    chart: text('chart').notNull(),
    accountNumber: text('account_number').notNull(),
    name: text('name').notNull(),
    source: text('source').notNull().default('manual'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byChartNumber: uniqueIndex('idx_ledger_accounts_chart_number').on(t.chart, t.accountNumber),
    byChart: index('idx_ledger_accounts_chart').on(t.chart),
    byName: index('idx_ledger_accounts_name').on(t.name),
  }),
);

export const proWorkflowEntries = sqliteTable(
  'pro_workflow_entries',
  {
    tenantId: text('tenant_id').notNull().default('default'),
    transactionId: text('transaction_id').notNull(),
    transactionJson: text('transaction_json').notNull(),
    draftJson: text('draft_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.transactionId] }),
    byUpdated: index('idx_pro_workflow_entries_updated').on(t.tenantId, t.updatedAt),
  }),
);

export const bankTransactions = sqliteTable(
  'bank_transactions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    accountId: text('account_id').notNull(),
    date: text('date').notNull(),
    amount: real('amount').notNull(),
    type: text('type').notNull(),
    counterparty: text('counterparty').notNull(),
    purpose: text('purpose').notNull(),
    linkedInvoiceId: text('linked_invoice_id'),
    status: text('status').notNull(),
    sourceTransactionId: text('source_transaction_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantDate: index('idx_bank_transactions_tenant_date').on(t.tenantId, t.date),
    byTenantStatus: index('idx_bank_transactions_status').on(t.tenantId, t.status),
  }),
);

export const bookingDrafts = sqliteTable(
  'booking_drafts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    transactionId: text('transaction_id').notNull(),
    workflowStatus: text('workflow_status').notNull(),
    draftJson: text('draft_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantTransaction: uniqueIndex('idx_booking_drafts_tenant_transaction').on(t.tenantId, t.transactionId),
    byUpdated: index('idx_booking_drafts_updated').on(t.tenantId, t.updatedAt),
  }),
);

export const bookingDraftLines = sqliteTable(
  'booking_draft_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    draftId: text('draft_id')
      .notNull()
      .references(() => bookingDrafts.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountNumber: text('account_number').notNull(),
    debitAmount: real('debit_amount').notNull().default(0),
    creditAmount: real('credit_amount').notNull().default(0),
    taxCode: text('tax_code'),
    taxCaseKey: text('tax_case_key'),
    taxRate: real('tax_rate'),
    netAmount: real('net_amount'),
    taxAmount: real('tax_amount'),
    grossAmount: real('gross_amount'),
    countryCode: text('country_code'),
    counterpartyVatId: text('counterparty_vat_id'),
    evidenceType: text('evidence_type'),
    evidenceReference: text('evidence_reference'),
    costCenter: text('cost_center'),
    memo: text('memo'),
  },
  (t) => ({
    byDraft: index('idx_booking_draft_lines_draft').on(t.draftId, t.lineNo),
  }),
);

export const draftValidationIssues = sqliteTable(
  'draft_validation_issues',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    draftId: text('draft_id')
      .notNull()
      .references(() => bookingDrafts.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    fieldPath: text('field_path'),
    blocking: integer('blocking').notNull().default(0),
    source: text('source').notNull(),
    issueJson: text('issue_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byDraft: index('idx_draft_validation_issues_draft').on(t.draftId),
  }),
);

export const accountingPeriods = sqliteTable(
  'accounting_periods',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    period: text('period').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    status: text('status').notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantPeriod: uniqueIndex('idx_accounting_periods_tenant_period').on(t.tenantId, t.period),
  }),
);

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    entryNumber: integer('entry_number').notNull(),
    postingDate: text('posting_date').notNull(),
    documentDate: text('document_date'),
    bookingText: text('booking_text').notNull(),
    reference: text('reference'),
    period: text('period').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    status: text('status').notNull(),
    sourceDraftId: text('source_draft_id'),
    reversedEntryId: text('reversed_entry_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byTenantEntryNo: uniqueIndex('idx_journal_entries_tenant_entry_number').on(t.tenantId, t.entryNumber),
    byTenantPostingDate: index('idx_journal_entries_tenant_posting_date').on(t.tenantId, t.postingDate),
  }),
);

export const journalLines = sqliteTable(
  'journal_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountNumber: text('account_number').notNull(),
    debitAmount: real('debit_amount').notNull().default(0),
    creditAmount: real('credit_amount').notNull().default(0),
    taxCode: text('tax_code'),
    taxCaseKey: text('tax_case_key'),
    taxRate: real('tax_rate'),
    netAmount: real('net_amount'),
    taxAmount: real('tax_amount'),
    grossAmount: real('gross_amount'),
    countryCode: text('country_code'),
    counterpartyVatId: text('counterparty_vat_id'),
    evidenceType: text('evidence_type'),
    evidenceReference: text('evidence_reference'),
    costCenter: text('cost_center'),
    memo: text('memo'),
  },
  (t) => ({
    byEntry: index('idx_journal_lines_entry').on(t.entryId, t.lineNo),
    byAccount: index('idx_journal_lines_account').on(t.tenantId, t.accountNumber),
  }),
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    assetNumber: text('asset_number').notNull(),
    name: text('name').notNull(),
    assetClass: text('asset_class').notNull(),
    status: text('status').notNull(),
    activationDate: text('activation_date').notNull(),
    acquisitionCost: real('acquisition_cost').notNull(),
    usefulLifeYears: integer('useful_life_years'),
    depreciationMethod: text('depreciation_method').notNull(),
    costCenter: text('cost_center').notNull(),
    location: text('location').notNull(),
    receiptLinked: integer('receipt_linked').notNull().default(0),
    supplier: text('supplier'),
    invoiceRef: text('invoice_ref'),
    assetAccountNumber: text('asset_account_number').notNull(),
    disposalDate: text('disposal_date'),
    disposalProceeds: real('disposal_proceeds'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantNumber: uniqueIndex('idx_assets_tenant_number').on(t.tenantId, t.assetNumber),
  }),
);

export const assetDepreciationSchedule = sqliteTable(
  'asset_depreciation_schedule',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    amount: real('amount').notNull(),
    months: integer('months').notNull(),
    status: text('status').notNull(),
    journalEntryId: text('journal_entry_id'),
    postedAt: text('posted_at'),
  },
  (t) => ({
    byTenantAssetYear: uniqueIndex('idx_asset_schedule_tenant_asset_year').on(t.tenantId, t.assetId, t.year),
  }),
);

export const assetMovements = sqliteTable(
  'asset_movements',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    movementDate: text('movement_date').notNull(),
    amount: real('amount').notNull().default(0),
    proceeds: real('proceeds'),
    gainLoss: real('gain_loss'),
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byTenantAssetDate: index('idx_asset_movements_tenant_asset_date').on(t.tenantId, t.assetId, t.movementDate),
  }),
);

export const accountMappingsHgb = sqliteTable(
  'account_mappings_hgb',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    chart: text('chart').notNull(),
    accountNumber: text('account_number').notNull(),
    statementType: text('statement_type').notNull(),
    positionKey: text('position_key').notNull(),
    positionLabel: text('position_label').notNull(),
    balanceSide: text('balance_side'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    uniqueMapping: uniqueIndex('idx_account_mappings_unique').on(
      t.tenantId,
      t.chart,
      t.accountNumber,
      t.statementType,
    ),
  }),
);

export const reportSnapshots = sqliteTable(
  'report_snapshots',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    reportType: text('report_type').notNull(),
    argsJson: text('args_json').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byTenantType: index('idx_report_snapshots_tenant_type').on(t.tenantId, t.reportType, t.createdAt),
  }),
);

export const datevExports = sqliteTable(
  'datev_exports',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    filePath: text('file_path').notNull(),
    recordCount: integer('record_count').notNull(),
    fromDate: text('from_date'),
    toDate: text('to_date'),
    createdAt: text('created_at').notNull(),
    metaJson: text('meta_json').notNull(),
  },
  (t) => ({
    byTenantCreated: index('idx_datev_exports_tenant_created').on(t.tenantId, t.createdAt),
  }),
);

export const taxCases = sqliteTable(
  'tax_cases',
  {
    key: text('key').primaryKey(),
    label: text('label').notNull(),
    mechanism: text('mechanism').notNull(),
    defaultRate: real('default_rate').notNull().default(0),
    requiresCounterpartyVatId: integer('requires_counterparty_vat_id').notNull().default(0),
    requiresCountry: integer('requires_country').notNull().default(0),
    requiresEvidence: integer('requires_evidence').notNull().default(0),
    active: integer('active').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byActive: index('idx_tax_cases_active').on(t.active, t.key),
  }),
);

export const taxCaseAccountMappings = sqliteTable(
  'tax_case_account_mappings',
  {
    id: text('id').primaryKey(),
    chart: text('chart').notNull(),
    taxCaseKey: text('tax_case_key')
      .notNull()
      .references(() => taxCases.key, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    accountNumber: text('account_number').notNull(),
    datevBuKey: text('datev_bu_key'),
    validFrom: text('valid_from'),
    validTo: text('valid_to'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byChartCase: index('idx_tax_case_account_mappings_chart_case').on(t.chart, t.taxCaseKey),
    uniqueCaseRole: uniqueIndex('idx_tax_case_account_mappings_unique').on(
      t.chart,
      t.taxCaseKey,
      t.role,
    ),
  }),
);

export const vatEvidence = sqliteTable(
  'vat_evidence',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    draftId: text('draft_id'),
    entryId: text('entry_id'),
    lineId: text('line_id'),
    taxCaseKey: text('tax_case_key').notNull(),
    evidenceType: text('evidence_type'),
    evidenceReference: text('evidence_reference'),
    countryCode: text('country_code'),
    counterpartyVatId: text('counterparty_vat_id'),
    capturedAt: text('captured_at').notNull(),
  },
  (t) => ({
    byEntry: index('idx_vat_evidence_entry').on(t.tenantId, t.entryId),
    byDraft: index('idx_vat_evidence_draft').on(t.tenantId, t.draftId),
  }),
);

export const journalPostingPairs = sqliteTable(
  'journal_posting_pairs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    debitLineId: text('debit_line_id').notNull(),
    creditLineId: text('credit_line_id').notNull(),
    amount: real('amount').notNull(),
    taxCaseKey: text('tax_case_key'),
    datevBuKey: text('datev_bu_key'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byEntry: index('idx_journal_posting_pairs_entry').on(t.tenantId, t.entryId),
  }),
);

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  amount: real('amount').notNull(),
  type: text('type').notNull(),
  counterparty: text('counterparty').notNull(),
  purpose: text('purpose').notNull(),
  linkedInvoiceId: text('linked_invoice_id'),
  status: text('status').notNull(),
  dedupHash: text('dedup_hash'),
  importBatchId: text('import_batch_id'),
  deletedAt: text('deleted_at'),
});

export const eurLines = sqliteTable(
  'eur_lines',
  {
    id: text('id').primaryKey(),
    taxYear: integer('tax_year').notNull(),
    kennziffer: text('kennziffer'),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    exportable: integer('exportable').notNull().default(1),
    sortOrder: integer('sort_order').notNull(),
    computedFromJson: text('computed_from_json'),
    sourceVersion: text('source_version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byYearSort: index('idx_eur_lines_year_sort').on(t.taxYear, t.sortOrder),
  }),
);

export const eurClassifications = sqliteTable(
  'eur_classifications',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    taxYear: integer('tax_year').notNull(),
    eurLineId: text('eur_line_id').references(() => eurLines.id, { onDelete: 'set null' }),
    excluded: integer('excluded').notNull().default(0),
    vatMode: text('vat_mode').notNull().default('none'),
    note: text('note'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    uniqueSourceYear: uniqueIndex('idx_eur_classifications_source_year').on(
      t.sourceType,
      t.sourceId,
      t.taxYear,
    ),
    byYear: index('idx_eur_classifications_year').on(t.taxYear),
  }),
);

export const eurRules = sqliteTable(
  'eur_rules',
  {
    id: text('id').primaryKey(),
    taxYear: integer('tax_year').notNull(),
    priority: integer('priority').notNull(),
    field: text('field').notNull(),
    operator: text('operator').notNull(),
    value: text('value').notNull(),
    targetEurLineId: text('target_eur_line_id')
      .notNull()
      .references(() => eurLines.id, { onDelete: 'cascade' }),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byYearPriority: index('idx_eur_rules_year_priority').on(t.taxYear, t.priority),
  }),
);

export const accountKeywords = sqliteTable(
  'account_keywords',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    chart: text('chart').notNull(),
    accountNumber: text('account_number').notNull(),
    keyword: text('keyword').notNull(),
    source: text('source').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantChartAccount: index('idx_account_keywords_tenant_chart_account').on(
      t.tenantId,
      t.chart,
      t.accountNumber,
    ),
    byTenantChartKeyword: index('idx_account_keywords_tenant_chart_keyword').on(
      t.tenantId,
      t.chart,
      t.keyword,
    ),
    uniqueTenantChartAccountKeyword: uniqueIndex('idx_account_keywords_unique').on(
      t.tenantId,
      t.chart,
      t.accountNumber,
      t.keyword,
    ),
  }),
);

export const accountSuggestionRules = sqliteTable(
  'account_suggestion_rules',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('default'),
    chart: text('chart').notNull(),
    priority: integer('priority').notNull(),
    field: text('field').notNull(),
    operator: text('operator').notNull(),
    value: text('value').notNull(),
    targetAccountNumber: text('target_account_number').notNull(),
    flowType: text('flow_type').notNull().default('any'),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTenantChartPriority: index('idx_account_suggestion_rules_tenant_chart_priority').on(
      t.tenantId,
      t.chart,
      t.priority,
    ),
  }),
);

export const importBatches = sqliteTable('import_batches', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  profile: text('profile').notNull(),
  fileName: text('file_name').notNull(),
  fileSha256: text('file_sha256').notNull(),
  mappingJson: text('mapping_json').notNull(),
  importedCount: integer('imported_count').notNull(),
  skippedCount: integer('skipped_count').notNull(),
  errorCount: integer('error_count').notNull(),
  createdAt: text('created_at').notNull(),
  rolledBackAt: text('rolled_back_at'),
  rollbackReason: text('rollback_reason'),
});

export const recurringProfiles = sqliteTable('recurring_profiles', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  active: integer('active').notNull(),
  name: text('name').notNull(),
  interval: text('interval').notNull(),
  nextRun: text('next_run').notNull(),
  lastRun: text('last_run'),
  endDate: text('end_date'),
  amount: real('amount').notNull(),
  itemsJson: text('items_json').notNull(),
  taxMode: text('tax_mode').notNull().default('standard_vat'),
  taxMetaJson: text('tax_meta_json'),
});

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  settingsJson: text('settings_json').notNull(),
});

export const numberReservations = sqliteTable(
  'number_reservations',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    number: text('number').notNull(),
    counterValue: integer('counter_value').notNull(),
    status: text('status').notNull(),
    documentId: text('document_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byStatusKind: index('idx_number_reservations_status_kind').on(t.status, t.kind),
  }),
);

export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  elementsJson: text('elements_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const activeTemplates = sqliteTable('active_templates', {
  id: integer('id').primaryKey(),
  invoiceTemplateId: text('invoice_template_id'),
  offerTemplateId: text('offer_template_id'),
});

export const emailLog = sqliteTable(
  'email_log',
  {
    id: text('id').primaryKey(),
    documentType: text('document_type').notNull(), // 'invoice' or 'offer'
    documentId: text('document_id').notNull(),
    documentNumber: text('document_number').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    recipientName: text('recipient_name').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    provider: text('provider').notNull(), // 'smtp' or 'resend'
    status: text('status').notNull(), // 'sent', 'failed'
    errorMessage: text('error_message'),
    sentAt: text('sent_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byDocument: index('idx_email_log_document').on(t.documentType, t.documentId),
  }),
);

export const dunningHistory = sqliteTable(
  'dunning_history',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    invoiceNumber: text('invoice_number').notNull(),
    dunningLevel: integer('dunning_level').notNull(),
    daysOverdue: integer('days_overdue').notNull(),
    feeApplied: real('fee_applied').notNull(),
    emailSent: integer('email_sent').notNull().default(0), // 0 or 1 (boolean)
    emailLogId: text('email_log_id'),
    processedAt: text('processed_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byInvoice: index('idx_dunning_history_invoice').on(t.invoiceId, t.dunningLevel),
  }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sequence: integer('sequence').notNull().unique(),
    ts: text('ts').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    actor: text('actor').notNull(),
  },
  (t) => ({
    byEntity: index('idx_audit_entity').on(t.entityType, t.entityId, t.sequence),
  }),
);
