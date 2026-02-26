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
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  service_period TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'standard_vat',
  tax_meta_json TEXT,
  tax_snapshot_json TEXT,
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
  date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  tax_mode TEXT NOT NULL DEFAULT 'standard_vat',
  tax_meta_json TEXT,
  tax_snapshot_json TEXT,
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
  type TEXT NOT NULL,
  color TEXT NOT NULL
);

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
