CREATE TABLE IF NOT EXISTS mobile_device_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  push_token TEXT,
  push_provider TEXT,
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mobile_device_sessions_owner
  ON mobile_device_sessions (tenant_id, user_id, product, created_at DESC);

CREATE TABLE IF NOT EXISTS mobile_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mobile_pairing_codes_expiry
  ON mobile_pairing_codes (expires_at);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  suggestion_json TEXT,
  confirmed_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_receipts_tenant_status
  ON receipts (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS mobile_document_mutations (
  client_mutation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_mutation_id)
);
CREATE INDEX IF NOT EXISTS idx_mobile_document_mutations_tenant
  ON mobile_document_mutations (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attachment_storage_key TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_document_deliveries_document
  ON document_deliveries (tenant_id, document_type, document_id, created_at DESC);

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS attachment_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS delivery_id TEXT REFERENCES document_deliveries(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS mobile_push_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK (product IN ('lite', 'pro')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  route TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mobile_push_outbox_status ON mobile_push_outbox (status, updated_at);
