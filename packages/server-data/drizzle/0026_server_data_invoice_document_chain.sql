-- Shared outgoing document aggregate: order-chain, corrections and revisions.
-- Existing invoice rows retain the legacy `invoice` kind and remain readable.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_kind TEXT NOT NULL DEFAULT 'invoice';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_document_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS root_document_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS revision_of_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 0;

UPDATE invoices
SET root_document_id = id
WHERE root_document_id IS NULL
  AND document_kind NOT IN ('order_confirmation', 'delivery_note');

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_document_kind
  ON invoices (tenant_id, document_kind, date);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_root_document
  ON invoices (tenant_id, root_document_id, date);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_source_document
  ON invoices (tenant_id, source_document_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_revision
  ON invoices (tenant_id, revision_of_id, revision_number);
