CREATE TABLE lite_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_json JSONB NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE TABLE lite_cash_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cash_date TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  flow_type TEXT NOT NULL CHECK (flow_type IN ('income', 'expense')),
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  receipt_id TEXT,
  matched_transaction_id TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES lite_receipts(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, matched_transaction_id)
);
ALTER TABLE transactions ADD CONSTRAINT transactions_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE lite_cash_entries ADD CONSTRAINT lite_cash_entries_tenant_transaction_fk
  FOREIGN KEY (tenant_id, matched_transaction_id) REFERENCES transactions(tenant_id, id) ON DELETE RESTRICT;
CREATE INDEX idx_lite_cash_entries_period ON lite_cash_entries (tenant_id, cash_date);
CREATE TABLE lite_receipt_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 10485760),
  sha256 TEXT NOT NULL,
  content_bytes BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES lite_receipts(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, receipt_id, sha256)
);
CREATE OR REPLACE FUNCTION billme_lite_receipt_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Lite receipt originals are immutable';
END $$;
CREATE TRIGGER lite_receipt_file_immutable BEFORE UPDATE OR DELETE ON lite_receipt_files
  FOR EACH ROW EXECUTE FUNCTION billme_lite_receipt_file_immutable();
