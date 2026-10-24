-- A payment can be reversed (Zahlungsstorno) and its bank line or invoice payment then allocated anew,
-- e.g. to the right customer. The reversed payment row stays as history; only one active (not reversed)
-- payment may exist per source. The source rule of 0006 becomes a partial unique index.
ALTER TABLE open_item_payments DROP CONSTRAINT IF EXISTS open_item_payments_tenant_id_source_type_source_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_item_payments_active_source ON open_item_payments (tenant_id, source_type, source_id) WHERE status <> 'reversed';
-- A refund (Rückzahlung, Rücklastschrift) moves money the other way and takes back what was paid; a refund of
-- the surplus of an earlier payment (the customer's credit) names that payment.
ALTER TABLE open_item_payments ADD COLUMN IF NOT EXISTS refund BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE open_item_payments ADD COLUMN IF NOT EXISTS credited_payment_id TEXT;
