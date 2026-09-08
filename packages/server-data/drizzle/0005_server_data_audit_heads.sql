CREATE TABLE IF NOT EXISTS audit_heads (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL DEFAULT 0,
  hash TEXT
);
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_sequence_key;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_sequence_unique UNIQUE (tenant_id, sequence);
