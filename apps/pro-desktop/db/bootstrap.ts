export const bootstrapSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  client_number TEXT,
  project_id TEXT,
  number TEXT NOT NULL,
  client TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_address TEXT,
  billing_address_json TEXT,
  shipping_address_json TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'standard_vat',
  tax_meta_json TEXT,
  tax_snapshot_json TEXT,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  service_period TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  dunning_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  tax_rate REAL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  client_number TEXT,
  project_id TEXT,
  number TEXT NOT NULL,
  client TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_address TEXT,
  billing_address_json TEXT,
  shipping_address_json TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'standard_vat',
  tax_meta_json TEXT,
  tax_snapshot_json TEXT,
  date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  share_token TEXT,
  share_published_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT,
  accepted_email TEXT,
  accepted_user_agent TEXT,
  decision TEXT,
  decision_text_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  tax_rate REAL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  customer_number TEXT,
  company TEXT NOT NULL,
  contact_person TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  avatar TEXT,
  tags_json TEXT NOT NULL,
  notes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_addresses (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  company TEXT,
  contact_person TEXT,
  street TEXT NOT NULL,
  line2 TEXT,
  zip TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  is_default_billing INTEGER NOT NULL DEFAULT 0,
  is_default_shipping INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_addresses_client ON client_addresses(client_id);

CREATE TABLE IF NOT EXISTS client_emails (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  email TEXT NOT NULL,
  is_default_general INTEGER NOT NULL DEFAULT 0,
  is_default_billing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_emails_client ON client_emails(client_id);

CREATE TABLE IF NOT EXISTS client_projects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  budget REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  description TEXT,
  archived_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS client_activities (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  date TEXT NOT NULL,
  author TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  sku TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL NOT NULL,
  unit TEXT NOT NULL,
  category TEXT NOT NULL,
  tax_rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  iban TEXT NOT NULL,
  balance REAL NOT NULL,
  default_skr_account_number TEXT NOT NULL DEFAULT '1200',
  type TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
  account_number TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_chart_number
  ON ledger_accounts(chart, account_number);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_chart
  ON ledger_accounts(chart);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_name
  ON ledger_accounts(name);

CREATE TABLE IF NOT EXISTS pro_workflow_entries (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  transaction_id TEXT NOT NULL,
  transaction_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_pro_workflow_entries_updated
  ON pro_workflow_entries(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  linked_invoice_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'booked')),
  source_transaction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_date
  ON bank_transactions(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_status
  ON bank_transactions(tenant_id, status);

CREATE TABLE IF NOT EXISTS booking_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  transaction_id TEXT NOT NULL,
  workflow_status TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_drafts_tenant_transaction
  ON booking_drafts(tenant_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_booking_drafts_updated
  ON booking_drafts(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS booking_draft_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_number TEXT NOT NULL,
  debit_amount REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0,
  tax_code TEXT,
  tax_case_key TEXT,
  tax_rate REAL,
  net_amount REAL,
  tax_amount REAL,
  gross_amount REAL,
  country_code TEXT,
  counterparty_vat_id TEXT,
  evidence_type TEXT,
  evidence_reference TEXT,
  cost_center TEXT,
  memo TEXT
);

CREATE INDEX IF NOT EXISTS idx_booking_draft_lines_draft
  ON booking_draft_lines(draft_id, line_no);

CREATE TABLE IF NOT EXISTS draft_validation_issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  field_path TEXT,
  blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0,1)),
  source TEXT NOT NULL,
  issue_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_draft_validation_issues_draft
  ON draft_validation_issues(draft_id);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  period TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'soft_locked', 'closed')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_periods_tenant_period
  ON accounting_periods(tenant_id, period);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  entry_number INTEGER NOT NULL,
  posting_date TEXT NOT NULL,
  document_date TEXT,
  booking_text TEXT NOT NULL,
  reference TEXT,
  period TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'reversed')),
  source_draft_id TEXT,
  reversed_entry_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_entry_number
  ON journal_entries(tenant_id, entry_number);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_posting_date
  ON journal_entries(tenant_id, posting_date DESC);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_number TEXT NOT NULL,
  debit_amount REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0,
  tax_code TEXT,
  tax_case_key TEXT,
  tax_rate REAL,
  net_amount REAL,
  tax_amount REAL,
  gross_amount REAL,
  country_code TEXT,
  counterparty_vat_id TEXT,
  evidence_type TEXT,
  evidence_reference TEXT,
  cost_center TEXT,
  memo TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry
  ON journal_lines(entry_id, line_no);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account
  ON journal_lines(tenant_id, account_number);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  asset_number TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  status TEXT NOT NULL,
  activation_date TEXT NOT NULL,
  acquisition_cost REAL NOT NULL,
  useful_life_years INTEGER,
  depreciation_method TEXT NOT NULL,
  cost_center TEXT NOT NULL,
  location TEXT NOT NULL,
  receipt_linked INTEGER NOT NULL DEFAULT 0 CHECK (receipt_linked IN (0,1)),
  supplier TEXT,
  invoice_ref TEXT,
  asset_account_number TEXT NOT NULL,
  disposal_date TEXT,
  disposal_proceeds REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_tenant_number
  ON assets(tenant_id, asset_number);

CREATE TABLE IF NOT EXISTS asset_depreciation_schedule (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  amount REAL NOT NULL,
  months INTEGER NOT NULL,
  status TEXT NOT NULL,
  journal_entry_id TEXT,
  posted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_schedule_tenant_asset_year
  ON asset_depreciation_schedule(tenant_id, asset_id, year);

CREATE TABLE IF NOT EXISTS asset_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  movement_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  proceeds REAL,
  gain_loss REAL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_movements_tenant_asset_date
  ON asset_movements(tenant_id, asset_id, movement_date);

CREATE TRIGGER IF NOT EXISTS journal_entries_protect_core_fields
BEFORE UPDATE ON journal_entries
FOR EACH ROW
WHEN
  NEW.id != OLD.id OR
  NEW.tenant_id != OLD.tenant_id OR
  NEW.entry_number != OLD.entry_number OR
  NEW.posting_date != OLD.posting_date OR
  COALESCE(NEW.document_date, '') != COALESCE(OLD.document_date, '') OR
  NEW.booking_text != OLD.booking_text OR
  COALESCE(NEW.reference, '') != COALESCE(OLD.reference, '') OR
  NEW.period != OLD.period OR
  NEW.fiscal_year != OLD.fiscal_year OR
  COALESCE(NEW.source_draft_id, '') != COALESCE(OLD.source_draft_id, '') OR
  NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'journal_entries core fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
BEFORE UPDATE ON journal_lines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
BEFORE DELETE ON journal_lines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are immutable');
END;

CREATE TABLE IF NOT EXISTS account_mappings_hgb (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chart TEXT NOT NULL,
  account_number TEXT NOT NULL,
  statement_type TEXT NOT NULL CHECK (statement_type IN ('guv', 'bilanz')),
  position_key TEXT NOT NULL,
  position_label TEXT NOT NULL,
  balance_side TEXT CHECK (balance_side IN ('asset', 'liability')),
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_mappings_unique
  ON account_mappings_hgb(tenant_id, chart, account_number, statement_type);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  report_type TEXT NOT NULL,
  args_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type
  ON report_snapshots(tenant_id, report_type, created_at DESC);

CREATE TABLE IF NOT EXISTS datev_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  file_path TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  from_date TEXT,
  to_date TEXT,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_datev_exports_tenant_created
  ON datev_exports(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tax_cases (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  mechanism TEXT NOT NULL CHECK (mechanism IN ('standard_vat', 'reverse_charge', 'zero_rate', 'exempt')),
  default_rate REAL NOT NULL DEFAULT 0,
  requires_counterparty_vat_id INTEGER NOT NULL DEFAULT 0 CHECK (requires_counterparty_vat_id IN (0, 1)),
  requires_country INTEGER NOT NULL DEFAULT 0 CHECK (requires_country IN (0, 1)),
  requires_evidence INTEGER NOT NULL DEFAULT 0 CHECK (requires_evidence IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_cases_active
  ON tax_cases(active, key);

CREATE TABLE IF NOT EXISTS tax_case_account_mappings (
  id TEXT PRIMARY KEY,
  chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
  tax_case_key TEXT NOT NULL REFERENCES tax_cases(key) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('output_tax', 'input_tax', 'datev_bu')),
  account_number TEXT NOT NULL,
  datev_bu_key TEXT,
  valid_from TEXT,
  valid_to TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_case_account_mappings_unique
  ON tax_case_account_mappings(chart, tax_case_key, role);
CREATE INDEX IF NOT EXISTS idx_tax_case_account_mappings_chart_case
  ON tax_case_account_mappings(chart, tax_case_key);

CREATE TABLE IF NOT EXISTS vat_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  draft_id TEXT,
  entry_id TEXT,
  line_id TEXT,
  tax_case_key TEXT NOT NULL,
  evidence_type TEXT,
  evidence_reference TEXT,
  country_code TEXT,
  counterparty_vat_id TEXT,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vat_evidence_entry
  ON vat_evidence(tenant_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_vat_evidence_draft
  ON vat_evidence(tenant_id, draft_id);

CREATE TABLE IF NOT EXISTS journal_posting_pairs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  debit_line_id TEXT NOT NULL,
  credit_line_id TEXT NOT NULL,
  amount REAL NOT NULL,
  tax_case_key TEXT,
  datev_bu_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_posting_pairs_entry
  ON journal_posting_pairs(tenant_id, entry_id);

CREATE TRIGGER IF NOT EXISTS datev_exports_no_update
BEFORE UPDATE ON datev_exports
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'datev_exports are immutable');
END;

CREATE TRIGGER IF NOT EXISTS datev_exports_no_delete
BEFORE DELETE ON datev_exports
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'datev_exports are immutable');
END;

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  linked_invoice_id TEXT,
  status TEXT NOT NULL,
  dedup_hash TEXT,
  import_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS eur_lines (
  id TEXT PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  kennziffer TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'computed')),
  exportable INTEGER NOT NULL DEFAULT 1 CHECK (exportable IN (0, 1)),
  sort_order INTEGER NOT NULL,
  computed_from_json TEXT,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eur_lines_year_sort ON eur_lines(tax_year, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_lines_year_kennziffer
  ON eur_lines(tax_year, kennziffer)
  WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> '';

CREATE TABLE IF NOT EXISTS eur_classifications (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('transaction', 'invoice')),
  source_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  eur_line_id TEXT REFERENCES eur_lines(id) ON DELETE SET NULL,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  vat_mode TEXT NOT NULL DEFAULT 'none' CHECK (vat_mode IN ('none', 'default')),
  note TEXT,
  updated_at TEXT NOT NULL,
  CHECK (NOT (excluded = 1 AND eur_line_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_classifications_source_year
  ON eur_classifications(source_type, source_id, tax_year);
CREATE INDEX IF NOT EXISTS idx_eur_classifications_year
  ON eur_classifications(tax_year);

CREATE TABLE IF NOT EXISTS account_keywords (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
  account_number TEXT NOT NULL,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('name', 'curated', 'user', 'import')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_account
  ON account_keywords(tenant_id, chart, account_number);
CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_keyword
  ON account_keywords(tenant_id, chart, keyword);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_keywords_unique
  ON account_keywords(tenant_id, chart, account_number, keyword);

CREATE TABLE IF NOT EXISTS account_suggestion_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
  priority INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('counterparty', 'purpose', 'any')),
  operator TEXT NOT NULL CHECK (operator IN ('contains', 'equals', 'startsWith')),
  value TEXT NOT NULL,
  target_account_number TEXT NOT NULL,
  flow_type TEXT NOT NULL DEFAULT 'any' CHECK (flow_type IN ('income', 'expense', 'any')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_suggestion_rules_tenant_chart_priority
  ON account_suggestion_rules(tenant_id, chart, priority);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  imported_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_batches_account ON import_batches(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recurring_profiles (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  active INTEGER NOT NULL,
  name TEXT NOT NULL,
  interval TEXT NOT NULL,
  next_run TEXT NOT NULL,
  last_run TEXT,
  end_date TEXT,
  amount REAL NOT NULL,
  items_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS number_reservations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  number TEXT NOT NULL,
  counter_value INTEGER NOT NULL,
  status TEXT NOT NULL,
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_number_reservations_status_kind
  ON number_reservations(status, kind);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  elements_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_templates (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  invoice_template_id TEXT,
  offer_template_id TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, sequence);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
`;
