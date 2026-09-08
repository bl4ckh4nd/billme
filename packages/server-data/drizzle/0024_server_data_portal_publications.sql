-- Bearer tokens for server-owned portal publications live outside the
-- immutable audit chain. Audit entries retain only a non-reversible hash.
CREATE TABLE IF NOT EXISTS portal_publications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('offer', 'invoice')),
  document_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  customer_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  expires_at TEXT,
  UNIQUE (tenant_id, document_type, document_id),
  UNIQUE (tenant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_portal_publications_tenant
  ON portal_publications (tenant_id, document_type, updated_at DESC);
