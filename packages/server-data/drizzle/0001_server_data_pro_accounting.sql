CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  category TEXT NOT NULL,
  tax_rate NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_tenant_title ON articles (tenant_id, title);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  iban TEXT NOT NULL,
  balance NUMERIC NOT NULL,
  default_skr_account_number TEXT NOT NULL,
  type TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_name ON accounts (tenant_id, name);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  chart TEXT NOT NULL,
  account_number TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chart, account_number)
);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_chart ON ledger_accounts (chart);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_name ON ledger_accounts (name);

CREATE TABLE IF NOT EXISTS pro_workflow_entries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  transaction_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_pro_workflow_entries_updated ON pro_workflow_entries (tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  type TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  linked_invoice_id TEXT,
  status TEXT NOT NULL,
  source_transaction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_date ON bank_transactions (tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions (tenant_id, status);

CREATE TABLE IF NOT EXISTS booking_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  workflow_status TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_drafts_updated ON booking_drafts (tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS booking_draft_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_number TEXT NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0,
  credit_amount NUMERIC NOT NULL DEFAULT 0,
  tax_code TEXT,
  tax_case_key TEXT,
  tax_rate NUMERIC,
  net_amount NUMERIC,
  tax_amount NUMERIC,
  gross_amount NUMERIC,
  country_code TEXT,
  counterparty_vat_id TEXT,
  evidence_type TEXT,
  evidence_reference TEXT,
  cost_center TEXT,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS idx_booking_draft_lines_draft ON booking_draft_lines (draft_id, line_no);

CREATE TABLE IF NOT EXISTS draft_validation_issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  field_path TEXT,
  blocking BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  issue_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_validation_issues_draft ON draft_validation_issues (draft_id);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  status TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_number INTEGER NOT NULL,
  posting_date TEXT NOT NULL,
  document_date TEXT,
  booking_text TEXT NOT NULL,
  reference TEXT,
  period TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_draft_id TEXT,
  reversed_entry_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, entry_number)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_posting_date ON journal_entries (tenant_id, posting_date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_number TEXT NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0,
  credit_amount NUMERIC NOT NULL DEFAULT 0,
  tax_code TEXT,
  tax_case_key TEXT,
  tax_rate NUMERIC,
  net_amount NUMERIC,
  tax_amount NUMERIC,
  gross_amount NUMERIC,
  country_code TEXT,
  counterparty_vat_id TEXT,
  evidence_type TEXT,
  evidence_reference TEXT,
  cost_center TEXT,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines (entry_id, line_no);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines (tenant_id, account_number);

CREATE TABLE IF NOT EXISTS account_mappings_hgb (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chart TEXT NOT NULL,
  account_number TEXT NOT NULL,
  statement_type TEXT NOT NULL,
  position_key TEXT NOT NULL,
  position_label TEXT NOT NULL,
  balance_side TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, chart, account_number, statement_type)
);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  args_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type ON report_snapshots (tenant_id, report_type, created_at);

CREATE TABLE IF NOT EXISTS datev_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  from_date TEXT,
  to_date TEXT,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datev_exports_tenant_created ON datev_exports (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS tax_cases (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  default_rate NUMERIC NOT NULL DEFAULT 0,
  requires_counterparty_vat_id BOOLEAN NOT NULL DEFAULT FALSE,
  requires_country BOOLEAN NOT NULL DEFAULT FALSE,
  requires_evidence BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tax_cases_active ON tax_cases (active, key);

CREATE TABLE IF NOT EXISTS tax_case_account_mappings (
  id TEXT PRIMARY KEY,
  chart TEXT NOT NULL,
  tax_case_key TEXT NOT NULL REFERENCES tax_cases(key) ON DELETE CASCADE,
  role TEXT NOT NULL,
  account_number TEXT NOT NULL,
  datev_bu_key TEXT,
  valid_from TEXT,
  valid_to TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (chart, tax_case_key, role)
);
CREATE INDEX IF NOT EXISTS idx_tax_case_account_mappings_chart_case ON tax_case_account_mappings (chart, tax_case_key);

CREATE TABLE IF NOT EXISTS vat_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_vat_evidence_entry ON vat_evidence (tenant_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_vat_evidence_draft ON vat_evidence (tenant_id, draft_id);

CREATE TABLE IF NOT EXISTS journal_posting_pairs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  debit_line_id TEXT NOT NULL,
  credit_line_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  tax_case_key TEXT,
  datev_bu_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_posting_pairs_entry ON journal_posting_pairs (tenant_id, entry_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  type TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  linked_invoice_id TEXT,
  status TEXT NOT NULL,
  dedup_hash TEXT,
  import_batch_id TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_date ON transactions (tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_import_batch ON transactions (tenant_id, import_batch_id);

CREATE TABLE IF NOT EXISTS eur_lines (
  id TEXT PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  kennziffer TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  exportable BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL,
  computed_from_json TEXT,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eur_lines_year_sort ON eur_lines (tax_year, sort_order);

CREATE TABLE IF NOT EXISTS eur_classifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  eur_line_id TEXT REFERENCES eur_lines(id) ON DELETE SET NULL,
  excluded BOOLEAN NOT NULL DEFAULT FALSE,
  vat_mode TEXT NOT NULL DEFAULT 'none',
  note TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, tax_year)
);
CREATE INDEX IF NOT EXISTS idx_eur_classifications_year ON eur_classifications (tenant_id, tax_year);

CREATE TABLE IF NOT EXISTS eur_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  value TEXT NOT NULL,
  target_eur_line_id TEXT NOT NULL REFERENCES eur_lines(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eur_rules_year_priority ON eur_rules (tenant_id, tax_year, priority);

CREATE TABLE IF NOT EXISTS account_keywords (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chart TEXT NOT NULL,
  account_number TEXT NOT NULL,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, chart, account_number, keyword)
);
CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_account ON account_keywords (tenant_id, chart, account_number);
CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_keyword ON account_keywords (tenant_id, chart, keyword);

CREATE TABLE IF NOT EXISTS account_suggestion_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chart TEXT NOT NULL,
  priority INTEGER NOT NULL,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  value TEXT NOT NULL,
  target_account_number TEXT NOT NULL,
  flow_type TEXT NOT NULL DEFAULT 'any',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_suggestion_rules_tenant_chart_priority ON account_suggestion_rules (tenant_id, chart, priority);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  imported_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rolled_back_at TEXT,
  rollback_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_created ON import_batches (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  elements_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant_kind_name ON templates (tenant_id, kind, name);

CREATE TABLE IF NOT EXISTS active_templates (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  invoice_template_id TEXT,
  offer_template_id TEXT
);
