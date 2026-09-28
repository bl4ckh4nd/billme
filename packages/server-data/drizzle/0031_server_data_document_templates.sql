-- Flow-layout document templates. `document_templates` holds the current
-- state; every save appends to `document_template_versions`, which frozen
-- documents reference. Versions have no FK to the template on purpose:
-- deleting a template must keep the versions issued documents point at.
CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_templates_tenant_kind_idx ON document_templates (tenant_id, kind);

CREATE TABLE IF NOT EXISTS document_template_versions (
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE TABLE IF NOT EXISTS document_template_defaults (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  template_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS layout_json TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS layout_json TEXT;
