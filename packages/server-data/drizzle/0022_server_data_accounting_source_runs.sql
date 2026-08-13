-- Immutable, tenant-scoped source/result facts for corrections, closing, and
-- tax preparation.  A source revision is the replay/conflict boundary.
CREATE TABLE IF NOT EXISTS accounting_source_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'prepared', 'noop')),
  source_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  source_hash TEXT NOT NULL,
  created_by TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, source_revision),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounting_source_runs_id_tenant
  ON accounting_source_runs (id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounting_source_runs_list
  ON accounting_source_runs (tenant_id, source_type, created_at DESC);

CREATE OR REPLACE FUNCTION billme_accounting_source_run_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'accounting_source_runs is immutable';
END;
$$;

DROP TRIGGER IF EXISTS accounting_source_runs_immutable ON accounting_source_runs;
CREATE TRIGGER accounting_source_runs_immutable
  BEFORE UPDATE OR DELETE ON accounting_source_runs
  FOR EACH ROW EXECUTE FUNCTION billme_accounting_source_run_immutable();
