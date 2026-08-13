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
  accounting_status TEXT NOT NULL DEFAULT 'unposted',
  accounting_snapshot_json TEXT,
  accounting_journal_entry_id TEXT,
  accounting_posted_at TEXT,
  dunning_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  line_meta_json TEXT,
  article_id TEXT,
  category TEXT,
  unit TEXT,
  discount_percent REAL,
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
  line_meta_json TEXT,
  article_id TEXT,
  category TEXT,
  unit TEXT,
  discount_percent REAL,
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
  notes TEXT NOT NULL,
  tax_profile_json TEXT
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
  deleted_at TEXT,
  rollback_reason TEXT,
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

CREATE TABLE IF NOT EXISTS accounting_policies (
  tenant_id TEXT PRIMARY KEY,
  active_chart TEXT NOT NULL DEFAULT 'SKR03' CHECK (active_chart IN ('SKR03', 'SKR04')),
  vat_method TEXT NOT NULL DEFAULT 'soll' CHECK (vat_method IN ('soll', 'ist')),
  period_policy TEXT NOT NULL DEFAULT 'calendar_month' CHECK (period_policy IN ('calendar_month')),
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

/* One append-only provenance seam for all non-document accounting sources. */
CREATE TABLE IF NOT EXISTS accounting_source_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fact_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'rejected', 'noop')),
  journal_entry_id TEXT,
  effective_date TEXT NOT NULL,
  posting_date TEXT NOT NULL,
  period TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  currency TEXT NOT NULL,
  booking_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_source_runs_revision
  ON accounting_source_runs(tenant_id, source_type, source_id, source_revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_source_runs_idempotency
  ON accounting_source_runs(tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_accounting_source_runs_created
  ON accounting_source_runs(tenant_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS accounting_source_runs_no_update
BEFORE UPDATE ON accounting_source_runs
BEGIN
  SELECT RAISE(ABORT, 'accounting_source_runs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS accounting_source_runs_no_delete
BEFORE DELETE ON accounting_source_runs
BEGIN
  SELECT RAISE(ABORT, 'accounting_source_runs are immutable');
END;

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
  datev_sachverhalt_ll TEXT,
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
  acquisition_offset_account_number TEXT,
  source_incoming_invoice_id TEXT,
  activation_journal_entry_id TEXT,
  accounting_repair_required INTEGER NOT NULL DEFAULT 0 CHECK (accounting_repair_required IN (0,1)),
  accounting_repair_reason TEXT,
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
  source_type TEXT,
  source_key TEXT,
  posted_at TEXT,
  CHECK (status <> 'posted' OR (journal_entry_id IS NOT NULL AND source_type IS NOT NULL AND source_key IS NOT NULL))
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
  journal_entry_id TEXT,
  source_type TEXT,
  source_key TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (type NOT IN ('activation', 'depreciation', 'disposal') OR (journal_entry_id IS NOT NULL AND source_type IS NOT NULL AND source_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_asset_movements_tenant_asset_date
  ON asset_movements(tenant_id, asset_id, movement_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_movements_tenant_source
  ON asset_movements(tenant_id, source_type, source_key)
  WHERE source_type IS NOT NULL AND source_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS assets_protect_accounting_fields
BEFORE UPDATE ON assets FOR EACH ROW
WHEN (EXISTS (SELECT 1 FROM asset_movements m WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id)
  OR EXISTS (SELECT 1 FROM asset_depreciation_schedule s WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'posted')
  OR COALESCE(OLD.accounting_repair_required, 0) = 1)
  AND (
    NEW.asset_number != OLD.asset_number OR NEW.asset_class != OLD.asset_class OR
    NEW.activation_date != OLD.activation_date OR NEW.acquisition_cost != OLD.acquisition_cost OR
    COALESCE(NEW.useful_life_years, -1) != COALESCE(OLD.useful_life_years, -1) OR
    NEW.depreciation_method != OLD.depreciation_method OR NEW.asset_account_number != OLD.asset_account_number OR
    COALESCE(NEW.acquisition_offset_account_number, '') != COALESCE(OLD.acquisition_offset_account_number, '') OR
    COALESCE(NEW.source_incoming_invoice_id, '') != COALESCE(OLD.source_incoming_invoice_id, '') OR
    COALESCE(NEW.activation_journal_entry_id, '') != COALESCE(OLD.activation_journal_entry_id, '') OR
    COALESCE(NEW.accounting_repair_required, 0) != COALESCE(OLD.accounting_repair_required, 0) OR
    COALESCE(NEW.accounting_repair_reason, '') != COALESCE(OLD.accounting_repair_reason, '') OR
    COALESCE(NEW.status, '') != COALESCE(OLD.status, '') OR
    COALESCE(NEW.disposal_date, '') != COALESCE(OLD.disposal_date, '') OR
    COALESCE(NEW.disposal_proceeds, -1) != COALESCE(OLD.disposal_proceeds, -1)
  )
  AND NOT (
    OLD.status = 'aktiv' AND NEW.status = 'voll_abgeschrieben' AND
    NEW.disposal_date IS NULL AND OLD.disposal_date IS NULL AND
    NOT EXISTS (SELECT 1 FROM asset_depreciation_schedule s
                WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'planned') AND
    COALESCE((SELECT SUM(s.amount) FROM asset_depreciation_schedule s
              WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'posted'), 0) >= OLD.acquisition_cost AND
    EXISTS (SELECT 1 FROM asset_movements m
            WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id
              AND m.type = 'depreciation' AND m.source_type = 'asset_depreciation'
              AND m.journal_entry_id IS NOT NULL)
  )
  AND NOT (
    OLD.accounting_repair_required = 1 AND NEW.accounting_repair_required = 0 AND
    NEW.status = OLD.status AND COALESCE(NEW.disposal_date, '') = COALESCE(OLD.disposal_date, '') AND
    COALESCE(NEW.disposal_proceeds, -1) = COALESCE(OLD.disposal_proceeds, -1) AND
    NEW.asset_number = OLD.asset_number AND NEW.asset_class = OLD.asset_class AND
    NEW.activation_date = OLD.activation_date AND NEW.acquisition_cost = OLD.acquisition_cost AND
    COALESCE(NEW.useful_life_years, -1) = COALESCE(OLD.useful_life_years, -1) AND
    NEW.depreciation_method = OLD.depreciation_method AND NEW.asset_account_number = OLD.asset_account_number AND
    COALESCE(NEW.acquisition_offset_account_number, '') = COALESCE(OLD.acquisition_offset_account_number, '') AND
    NEW.activation_journal_entry_id IS NOT NULL AND NEW.source_incoming_invoice_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id AND m.type = 'activation'
        AND m.journal_entry_id = NEW.activation_journal_entry_id AND m.source_type = 'incoming_invoice'
        AND m.source_key = 'incoming-invoice:' || NEW.source_incoming_invoice_id
        AND j.source_type = m.source_type AND j.source_key = m.source_key
    )
  )
  AND NOT (
    OLD.status IN ('aktiv', 'voll_abgeschrieben') AND OLD.disposal_date IS NULL AND
    NEW.status IN ('verkauft', 'stillgelegt') AND NEW.disposal_date IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id
        AND m.type = 'disposal' AND m.source_type = 'asset_disposal'
        AND m.source_key = 'asset_disposal:' || OLD.id AND m.journal_entry_id IS NOT NULL
        AND m.movement_date = NEW.disposal_date
        AND COALESCE(m.proceeds, -1) = COALESCE(NEW.disposal_proceeds, -1)
        AND ((m.proceeds > 0 AND NEW.status = 'verkauft') OR
             (COALESCE(m.proceeds, 0) = 0 AND NEW.status = 'stillgelegt'))
        AND j.source_type = m.source_type AND j.source_key = m.source_key
    )
  )
BEGIN SELECT RAISE(ABORT, 'accounting-affecting asset fields are immutable'); END;

CREATE TRIGGER IF NOT EXISTS asset_movements_require_source
BEFORE INSERT ON asset_movements FOR EACH ROW
WHEN NEW.type IN ('activation', 'depreciation', 'disposal') AND (
  NEW.journal_entry_id IS NULL OR NEW.source_type IS NULL OR NEW.source_key IS NULL OR
  (NEW.type = 'activation' AND NEW.source_type NOT IN ('asset_activation', 'incoming_invoice')) OR
  (NEW.type = 'depreciation' AND NEW.source_type != 'asset_depreciation') OR
  (NEW.type = 'disposal' AND NEW.source_type != 'asset_disposal') OR
  NOT EXISTS (SELECT 1 FROM journal_entries j
              WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id
                AND j.source_type = NEW.source_type AND j.source_key = NEW.source_key)
)
BEGIN SELECT RAISE(ABORT, 'asset movement requires a valid journal source'); END;

CREATE TRIGGER IF NOT EXISTS asset_movements_no_update
BEFORE UPDATE ON asset_movements FOR EACH ROW
WHEN NOT (
  EXISTS (
    SELECT 1 FROM assets a
    JOIN journal_entries j ON j.tenant_id = a.tenant_id AND j.id = NEW.journal_entry_id
    WHERE a.id = OLD.asset_id AND a.tenant_id = OLD.tenant_id
      AND a.accounting_repair_required = 1
      AND NEW.id = OLD.id AND NEW.asset_id = OLD.asset_id AND NEW.type = OLD.type
      AND NEW.movement_date = OLD.movement_date AND NEW.amount = OLD.amount
      AND COALESCE(NEW.proceeds, -1) = COALESCE(OLD.proceeds, -1)
      AND COALESCE(NEW.gain_loss, -1) = COALESCE(OLD.gain_loss, -1)
      AND NEW.reason = OLD.reason AND NEW.created_at = OLD.created_at
      AND NEW.type = 'activation' AND NEW.journal_entry_id IS NOT NULL
      AND OLD.journal_entry_id IS NULL AND OLD.source_type IS NULL AND OLD.source_key IS NULL
      AND NEW.source_type = 'incoming_invoice'
      AND NEW.source_key IS NOT NULL
      AND j.source_type = NEW.source_type AND j.source_key = NEW.source_key
  )
)
BEGIN SELECT RAISE(ABORT, 'asset movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS asset_movements_no_delete
BEFORE DELETE ON asset_movements FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'asset movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS asset_schedule_posted_no_update
BEFORE UPDATE ON asset_depreciation_schedule FOR EACH ROW WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted depreciation schedules are immutable'); END;
CREATE TRIGGER IF NOT EXISTS asset_schedule_posted_no_delete
BEFORE DELETE ON asset_depreciation_schedule FOR EACH ROW WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted depreciation schedules are immutable'); END;
CREATE TRIGGER IF NOT EXISTS asset_delete_with_movements
BEFORE DELETE ON assets FOR EACH ROW WHEN EXISTS (SELECT 1 FROM asset_movements WHERE asset_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'accounting asset cannot be deleted'); END;

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
  statement_type TEXT NOT NULL CHECK (statement_type IN ('bwa01', 'management-guv', 'hgb-guv', 'hgb-gkv', 'hgb-bilanz', 'hgb-balance', 'eur', 'guv', 'bilanz')),
  position_key TEXT NOT NULL,
  position_label TEXT NOT NULL,
  balance_side TEXT CHECK (balance_side IN ('asset', 'liability')),
  valid_from TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_mappings_unique
  ON account_mappings_hgb(tenant_id, chart, account_number, statement_type, valid_from);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  report_type TEXT NOT NULL,
  args_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type
  ON report_snapshots(tenant_id, report_type, created_at DESC);

CREATE TRIGGER IF NOT EXISTS report_snapshots_no_update
BEFORE UPDATE ON report_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'report_snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_snapshots_no_delete
BEFORE DELETE ON report_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'report_snapshots are immutable');
END;

CREATE TABLE IF NOT EXISTS datev_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  file_path TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  from_date TEXT,
  to_date TEXT,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  sha256 TEXT,
  byte_size INTEGER,
  encoding TEXT,
  header_version INTEGER,
  format_version INTEGER,
  chart TEXT,
  source_snapshot_hash TEXT,
  manifest_json TEXT,
  status TEXT,
  validation_json TEXT
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
  import_batch_id TEXT,
  linked_payment_id TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS eur_lines (
  id TEXT PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  provider_path TEXT NOT NULL DEFAULT 'main',
  kennziffer TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'computed')),
  exportable INTEGER NOT NULL DEFAULT 1 CHECK (exportable IN (0, 1)),
  sort_order INTEGER NOT NULL,
  computed_from_json TEXT,
  computed_terms_json TEXT,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eur_lines_year_sort ON eur_lines(tax_year, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_lines_year_provider_kennziffer
  ON eur_lines(tax_year, provider_path, kennziffer)
  WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> '';

CREATE TABLE IF NOT EXISTS eur_classifications (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('transaction', 'invoice')),
  source_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  eur_line_id TEXT REFERENCES eur_lines(id) ON DELETE SET NULL,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  vat_mode TEXT NOT NULL DEFAULT 'none' CHECK (vat_mode IN ('none', 'default')),
  vat_rate REAL,
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
  created_at TEXT NOT NULL,
  rolled_back_at TEXT,
  rollback_reason TEXT
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
  items_json TEXT NOT NULL,
  tax_mode TEXT NOT NULL DEFAULT 'standard_vat',
  tax_meta_json TEXT
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

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  vendor_number TEXT,
  name TEXT NOT NULL,
  email TEXT,
  address TEXT,
  vat_id TEXT,
  iban TEXT,
  default_expense_account TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_tenant_number
  ON vendors(tenant_id, vendor_number);
CREATE INDEX IF NOT EXISTS idx_vendors_tenant_name ON vendors(tenant_id, name);

CREATE TABLE IF NOT EXISTS incoming_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  service_period TEXT,
  net_amount REAL NOT NULL,
  tax_amount REAL NOT NULL,
  gross_amount REAL NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_case_key TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  accounting_status TEXT NOT NULL DEFAULT 'unposted',
  accounting_snapshot_json TEXT,
  accounting_journal_entry_id TEXT,
  accounting_posted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_invoices_tenant_number
  ON incoming_invoices(tenant_id, number);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_tenant_due_date
  ON incoming_invoices(tenant_id, due_date);

CREATE TABLE IF NOT EXISTS incoming_invoice_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  incoming_invoice_id TEXT NOT NULL REFERENCES incoming_invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  net_amount REAL NOT NULL,
  tax_rate REAL NOT NULL,
  tax_amount REAL NOT NULL,
  gross_amount REAL NOT NULL,
  account_number TEXT,
  asset_account_number TEXT
);
CREATE INDEX IF NOT EXISTS idx_incoming_invoice_lines_invoice
  ON incoming_invoice_lines(incoming_invoice_id, position);

CREATE TABLE IF NOT EXISTS accounting_account_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
  role TEXT NOT NULL,
  account_number TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_account_mappings_tenant_chart_role
  ON accounting_account_mappings(tenant_id, chart, role);

CREATE TABLE IF NOT EXISTS open_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  party_type TEXT NOT NULL CHECK (party_type IN ('debtor', 'creditor')),
  party_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  original_amount REAL NOT NULL,
  allocated_amount REAL NOT NULL DEFAULT 0,
  residual_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_items_tenant_source
  ON open_items(tenant_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_open_items_tenant_status_due_date
  ON open_items(tenant_id, status, due_date);

CREATE TABLE IF NOT EXISTS open_item_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  party_type TEXT NOT NULL CHECK (party_type IN ('debtor', 'creditor')),
  party_id TEXT,
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  bank_account_number TEXT NOT NULL,
  method TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  allocated_amount REAL NOT NULL DEFAULT 0,
  residual_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  journal_entry_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_item_payments_tenant_source
  ON open_item_payments(tenant_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS open_item_allocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payment_id TEXT NOT NULL REFERENCES open_item_payments(id) ON DELETE CASCADE,
  open_item_id TEXT NOT NULL REFERENCES open_items(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_item_allocations_payment
  ON open_item_allocations(tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_open_item_allocations_open_item
  ON open_item_allocations(tenant_id, open_item_id);

CREATE TABLE IF NOT EXISTS accounting_backfill_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  confirmation_hash TEXT NOT NULL,
  result_json TEXT,
  confirmed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounting_backfill_runs_tenant_status
  ON accounting_backfill_runs(tenant_id, status);
`;
