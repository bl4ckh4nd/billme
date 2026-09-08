CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  product TEXT NOT NULL,
  deployment_mode TEXT NOT NULL DEFAULT 'single-tenant',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_email_unique ON user_accounts (lower(email));

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  invited_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES user_accounts(id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS number_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  number TEXT NOT NULL,
  counter_value INTEGER NOT NULL,
  status TEXT NOT NULL,
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, number)
);
CREATE INDEX IF NOT EXISTS idx_number_reservations_status_kind ON number_reservations (tenant_id, status, kind);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
  addresses_json TEXT,
  emails_json TEXT,
  projects_json TEXT,
  activities_json TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tenant_customer_number ON clients (tenant_id, customer_number);
CREATE INDEX IF NOT EXISTS idx_clients_tenant_company ON clients (tenant_id, company);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL,
  dunning_level INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  payments_json TEXT NOT NULL DEFAULT '[]',
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_tenant_number ON invoices (tenant_id, number);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_date ON invoices (tenant_id, date);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL,
  share_json TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_tenant_number ON offers (tenant_id, number);
CREATE INDEX IF NOT EXISTS idx_offers_tenant_date ON offers (tenant_id, date);

CREATE TABLE IF NOT EXISTS recurring_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  name TEXT NOT NULL,
  interval TEXT NOT NULL,
  next_run TEXT NOT NULL,
  last_run TEXT,
  end_date TEXT,
  amount NUMERIC NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recurring_profiles_tenant_next_run ON recurring_profiles (tenant_id, next_run, active);

CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_number TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_document ON email_log (tenant_id, document_type, document_id);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_number TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT,
  locked_at TEXT,
  lease_expires_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  provider TEXT,
  provider_message_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox (tenant_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_processing_lease ON email_outbox (tenant_id, lease_expires_at) WHERE status = 'processing';
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_active_dedupe ON email_outbox (tenant_id, dedupe_key) WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS dunning_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  dunning_level INTEGER NOT NULL,
  days_overdue INTEGER NOT NULL,
  fee_applied NUMERIC NOT NULL,
  email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  email_log_id TEXT,
  processed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dunning_history_invoice ON dunning_history (tenant_id, invoice_id, dunning_level);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (tenant_id, entity_type, entity_id, sequence);

CREATE OR REPLACE FUNCTION billme_prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION billme_prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION billme_prevent_audit_log_mutation();

CREATE TABLE IF NOT EXISTS sqlite_import_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  source_product TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sqlite_import_runs_tenant_started ON sqlite_import_runs (tenant_id, started_at DESC);
