import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  type: text('type').notNull(),
  color: text('color').notNull(),
});

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
