-- Reporting and filing persistence is tenant-owned. Snapshot-like rows are
-- append-only; mutable submission/job state stays separate from the evidence.
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS from_date TEXT;
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS to_date TEXT;
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS as_of_date TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_report_snapshots_id_tenant
  ON report_snapshots (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_report_snapshots_source
  ON report_snapshots (tenant_id, report_type, source_hash);

CREATE TABLE IF NOT EXISTS report_snapshot_positions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  position_key TEXT NOT NULL,
  position_label TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0,
  credit_amount NUMERIC NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id, tenant_id) REFERENCES report_snapshots(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_report_snapshot_positions_snapshot
  ON report_snapshot_positions (tenant_id, snapshot_id, position_key);

CREATE TABLE IF NOT EXISTS report_account_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  chart TEXT NOT NULL,
  account_number TEXT NOT NULL,
  position_key TEXT NOT NULL,
  position_label TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_report_account_mappings_version
  ON report_account_mappings (tenant_id, report_type, chart, account_number, version);
CREATE INDEX IF NOT EXISTS idx_report_account_mappings_effective
  ON report_account_mappings (tenant_id, report_type, chart, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS report_catalog_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  catalog_key TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_report_catalog_refs_version
  ON report_catalog_refs (tenant_id, report_type, catalog_key, catalog_version);
CREATE INDEX IF NOT EXISTS idx_report_catalog_refs_hash
  ON report_catalog_refs (tenant_id, report_type, source_hash);

CREATE TABLE IF NOT EXISTS tax_adjustments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id TEXT,
  tax_year INTEGER NOT NULL,
  period TEXT NOT NULL,
  adjustment_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  tax_code TEXT,
  reason TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_adjustments_idempotency
  ON tax_adjustments (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tax_adjustments_submission
  ON tax_adjustments (tenant_id, submission_id, period);

CREATE TABLE IF NOT EXISTS tax_submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_type TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_snapshot_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_submissions_idempotency
  ON tax_submissions (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tax_submissions_status
  ON tax_submissions (tenant_id, status, tax_year, period);

CREATE TABLE IF NOT EXISTS tax_submission_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, tenant_id) REFERENCES tax_submissions(id, tenant_id) ON DELETE CASCADE,
  CHECK (requester_id <> approver_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_submission_approvals_idempotency
  ON tax_submission_approvals (tenant_id, submission_id, approver_id, decision);

CREATE TABLE IF NOT EXISTS tax_submission_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  receipt_number TEXT,
  receipt_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, tenant_id) REFERENCES tax_submissions(id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_submission_receipts_number
  ON tax_submission_receipts (tenant_id, submission_id, receipt_type, receipt_number);

CREATE TABLE IF NOT EXISTS tax_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  credential_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  encryption_algorithm TEXT NOT NULL,
  key_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  encrypted_blob BYTEA NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_credentials_version
  ON tax_credentials (tenant_id, provider, credential_key, version);
CREATE INDEX IF NOT EXISTS idx_tax_credentials_current
  ON tax_credentials (tenant_id, provider, credential_key, version DESC);

CREATE TABLE IF NOT EXISTS tax_submission_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  locked_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, tenant_id) REFERENCES tax_submissions(id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_submission_jobs_idempotency
  ON tax_submission_jobs (tenant_id, job_type, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tax_submission_jobs_claim
  ON tax_submission_jobs (tenant_id, status, available_at, created_at);

CREATE OR REPLACE FUNCTION billme_reporting_immutable_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Tenant deletion cascades through immutable evidence rows.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS report_snapshots_immutable ON report_snapshots;
CREATE TRIGGER report_snapshots_immutable
  BEFORE UPDATE OR DELETE ON report_snapshots
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
DROP TRIGGER IF EXISTS report_snapshot_positions_immutable ON report_snapshot_positions;
CREATE TRIGGER report_snapshot_positions_immutable
  BEFORE UPDATE OR DELETE ON report_snapshot_positions
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
DROP TRIGGER IF EXISTS report_catalog_refs_immutable ON report_catalog_refs;
CREATE TRIGGER report_catalog_refs_immutable
  BEFORE UPDATE OR DELETE ON report_catalog_refs
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
DROP TRIGGER IF EXISTS tax_submission_approvals_immutable ON tax_submission_approvals;
CREATE TRIGGER tax_submission_approvals_immutable
  BEFORE UPDATE OR DELETE ON tax_submission_approvals
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
DROP TRIGGER IF EXISTS tax_submission_receipts_immutable ON tax_submission_receipts;
CREATE TRIGGER tax_submission_receipts_immutable
  BEFORE UPDATE OR DELETE ON tax_submission_receipts
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
DROP TRIGGER IF EXISTS tax_credentials_immutable ON tax_credentials;
CREATE TRIGGER tax_credentials_immutable
  BEFORE UPDATE OR DELETE ON tax_credentials
  FOR EACH ROW EXECUTE FUNCTION billme_reporting_immutable_row();
