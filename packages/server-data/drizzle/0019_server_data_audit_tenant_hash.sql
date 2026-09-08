ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_hash_key;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_hash_unique UNIQUE (tenant_id, hash);
