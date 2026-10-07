-- Long-lived tokens for the `billme` CLI, issued by the device login. Only the
-- SHA-256 of a token is stored. A token acts as its user with that user's
-- current role, so removing the user or the membership ends its access.
CREATE TABLE IF NOT EXISTS cli_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS cli_tokens_user_idx ON cli_tokens (tenant_id, product, user_id);
