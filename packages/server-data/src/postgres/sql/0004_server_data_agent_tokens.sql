CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_tenant_product
  ON agent_tokens (tenant_id, product, revoked_at);
