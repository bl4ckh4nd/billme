-- Existing installations already applied 0002 before asset accounting
-- provenance and repair metadata were introduced. Keep this migration
-- additive and idempotent so legacy assets retain their rows unchanged.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS acquisition_offset_account_number TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_incoming_invoice_id TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS activation_journal_entry_id TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS accounting_repair_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS accounting_repair_reason TEXT;

-- The desktop lifecycle also records immutable source identities for
-- depreciation and movement rows. Preserve those identities on server import.
ALTER TABLE asset_depreciation_schedule ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE asset_depreciation_schedule ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE asset_movements ADD COLUMN IF NOT EXISTS journal_entry_id TEXT;
ALTER TABLE asset_movements ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE asset_movements ADD COLUMN IF NOT EXISTS source_key TEXT;
