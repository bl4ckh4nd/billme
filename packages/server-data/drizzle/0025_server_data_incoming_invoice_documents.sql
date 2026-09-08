-- Immutable original files for Pro incoming invoices.  The content is kept in
-- the same tenant-scoped database so a document cannot outlive its accounting
-- context or silently point at another tenant's invoice.
CREATE TABLE IF NOT EXISTS incoming_invoice_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incoming_invoice_id TEXT NOT NULL REFERENCES incoming_invoices(id) ON DELETE RESTRICT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  content_bytes BYTEA NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_incoming_invoice_documents_invoice
  ON incoming_invoice_documents (tenant_id, incoming_invoice_id, created_at);

CREATE OR REPLACE FUNCTION billme_incoming_invoice_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incoming invoice documents are immutable';
  END IF;
  IF (to_jsonb(OLD) - 'review_status' - 'updated_at') = (to_jsonb(NEW) - 'review_status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incoming invoice documents are immutable';
END $$;

DROP TRIGGER IF EXISTS incoming_invoice_documents_immutable ON incoming_invoice_documents;
CREATE TRIGGER incoming_invoice_documents_immutable
  BEFORE UPDATE OR DELETE ON incoming_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION billme_incoming_invoice_document_immutable();
