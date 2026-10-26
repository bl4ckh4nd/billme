-- Findings of the journal checks (Prüfungen) a person marked as OK, with the reason. One row per check and
-- subject (an entry id, a pair of entries, an account or a month); deleting it opens the finding again.
CREATE TABLE IF NOT EXISTS ledger_check_dismissals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  dismissed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, check_key, subject_key)
);

CREATE INDEX IF NOT EXISTS idx_ledger_check_dismissals_check
  ON ledger_check_dismissals (tenant_id, check_key);
