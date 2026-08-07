ALTER TABLE clients ADD COLUMN IF NOT EXISTS tax_profile_json TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'standard_vat';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_meta_json TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_snapshot_json TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'standard_vat';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS tax_meta_json TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS tax_snapshot_json TEXT;
ALTER TABLE recurring_profiles ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'standard_vat';
ALTER TABLE recurring_profiles ADD COLUMN IF NOT EXISTS tax_meta_json TEXT;
