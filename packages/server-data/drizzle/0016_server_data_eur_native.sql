-- Keep the 2025 EÜR catalog and classification provenance additive. Existing
-- installations advance here; never edit an already applied migration.
ALTER TABLE eur_lines ADD COLUMN IF NOT EXISTS provider_path TEXT NOT NULL DEFAULT 'main';
ALTER TABLE eur_lines ADD COLUMN IF NOT EXISTS computed_terms_json TEXT;
ALTER TABLE eur_classifications ADD COLUMN IF NOT EXISTS vat_rate NUMERIC;
