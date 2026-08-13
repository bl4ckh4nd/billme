CREATE TABLE IF NOT EXISTS eur_cash_facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount_net NUMERIC NOT NULL,
  flow_type TEXT,
  eur_line_id TEXT,
  splits_json TEXT,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  idempotency_key TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT eur_cash_facts_source_year_unique UNIQUE (tenant_id, source_type, source_id, tax_year)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_cash_facts_idempotency
  ON eur_cash_facts (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eur_cash_facts_year
  ON eur_cash_facts (tenant_id, tax_year);

CREATE TABLE IF NOT EXISTS eur_annex_facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  annex TEXT NOT NULL,
  line_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  source_id TEXT,
  fact_date TEXT,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  idempotency_key TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_annex_facts_idempotency
  ON eur_annex_facts (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eur_annex_facts_year
  ON eur_annex_facts (tenant_id, tax_year, annex);

CREATE TABLE IF NOT EXISTS eur_report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  catalog_source_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT eur_report_snapshots_source_unique UNIQUE (tenant_id, tax_year, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_eur_report_snapshots_tenant_year
  ON eur_report_snapshots (tenant_id, tax_year, created_at DESC);
CREATE OR REPLACE FUNCTION eur_report_snapshots_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'eur_report_snapshots are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS eur_report_snapshots_no_update ON eur_report_snapshots;
CREATE TRIGGER eur_report_snapshots_no_update BEFORE UPDATE ON eur_report_snapshots FOR EACH ROW EXECUTE FUNCTION eur_report_snapshots_immutable();
DROP TRIGGER IF EXISTS eur_report_snapshots_no_delete ON eur_report_snapshots;
CREATE TRIGGER eur_report_snapshots_no_delete BEFORE DELETE ON eur_report_snapshots FOR EACH ROW EXECUTE FUNCTION eur_report_snapshots_immutable();
