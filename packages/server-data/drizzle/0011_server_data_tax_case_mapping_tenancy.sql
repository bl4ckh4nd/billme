-- Keep seeded catalog mappings global (tenant_id NULL) and isolate mutable
-- desktop/server overrides by tenant. Existing global rows remain immutable fallbacks.
ALTER TABLE tax_case_account_mappings
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE tax_case_account_mappings
  DROP CONSTRAINT IF EXISTS tax_case_account_mappings_chart_tax_case_key_role_key;

CREATE INDEX IF NOT EXISTS idx_tax_case_account_mappings_tenant_lookup
  ON tax_case_account_mappings (tenant_id, chart, tax_case_key, role, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_tax_case_account_mappings_global_lookup
  ON tax_case_account_mappings (chart, tax_case_key, role, valid_from, valid_to)
  WHERE tenant_id IS NULL;
