-- Belege attached to a Pro bank line (booking draft): immutable originals in the
-- tenant database, like incoming_invoice_documents. No foreign key to
-- bank_transactions: an archived Beleg outlives an import rollback (GoBD retention).
CREATE TABLE IF NOT EXISTS bank_transaction_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_transaction_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  content_bytes BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, bank_transaction_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_bank_transaction_documents_line
  ON bank_transaction_documents (tenant_id, bank_transaction_id, created_at);

CREATE OR REPLACE FUNCTION billme_bank_transaction_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank transaction documents are immutable';
END $$;

DROP TRIGGER IF EXISTS bank_transaction_documents_immutable ON bank_transaction_documents;
CREATE TRIGGER bank_transaction_documents_immutable
  BEFORE UPDATE OR DELETE ON bank_transaction_documents
  FOR EACH ROW EXECUTE FUNCTION billme_bank_transaction_document_immutable();
