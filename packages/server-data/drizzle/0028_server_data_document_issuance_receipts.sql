-- Idempotency receipts for atomic document-chain issuance. One row per
-- committed (tenant, product, operation id); the stored response is the
-- byte-stable replay result.
CREATE TABLE IF NOT EXISTS document_issuance_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  intent_hash TEXT NOT NULL,
  document_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, product, operation_id)
);

CREATE OR REPLACE FUNCTION billme_document_issuance_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'document_issuance_receipts is immutable';
END;
$$;

DROP TRIGGER IF EXISTS document_issuance_receipts_immutable ON document_issuance_receipts;
CREATE TRIGGER document_issuance_receipts_immutable
BEFORE UPDATE OR DELETE ON document_issuance_receipts
FOR EACH ROW EXECUTE FUNCTION billme_document_issuance_receipt_immutable();
