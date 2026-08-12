ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_source ON journal_entries (tenant_id, source_type, source_key) WHERE source_type IS NOT NULL AND source_key IS NOT NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_mode TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_meta_json TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_snapshot_json TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_status TEXT NOT NULL DEFAULT 'unposted';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_snapshot_json TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_journal_entry_id TEXT;

CREATE TABLE IF NOT EXISTS accounting_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  active_chart TEXT NOT NULL DEFAULT 'SKR03',
  vat_method TEXT NOT NULL DEFAULT 'soll',
  period_policy TEXT NOT NULL DEFAULT 'calendar_month',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounting_account_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chart TEXT NOT NULL,
  role TEXT NOT NULL,
  account_number TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, chart, role)
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_number TEXT,
  name TEXT NOT NULL,
  email TEXT,
  address TEXT,
  vat_id TEXT,
  iban TEXT,
  default_expense_account TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_tenant_number ON vendors (tenant_id, vendor_number) WHERE vendor_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS incoming_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  service_period TEXT,
  net_amount NUMERIC NOT NULL,
  tax_amount NUMERIC NOT NULL,
  gross_amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  tax_case_key TEXT,
  notes TEXT,
  accounting_status TEXT NOT NULL DEFAULT 'unposted',
  accounting_snapshot_json TEXT,
  accounting_journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accounting_posted_at TEXT,
  UNIQUE (tenant_id, number)
);
CREATE TABLE IF NOT EXISTS incoming_invoice_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incoming_invoice_id TEXT NOT NULL REFERENCES incoming_invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  net_amount NUMERIC NOT NULL,
  tax_rate NUMERIC NOT NULL,
  tax_amount NUMERIC NOT NULL,
  gross_amount NUMERIC NOT NULL,
  account_number TEXT,
  asset_account_number TEXT,
  UNIQUE (tenant_id, incoming_invoice_id, position)
);

CREATE TABLE IF NOT EXISTS open_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_type TEXT NOT NULL,
  party_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  original_amount NUMERIC NOT NULL,
  allocated_amount NUMERIC NOT NULL DEFAULT 0,
  residual_amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_type, source_id)
);
CREATE TABLE IF NOT EXISTS open_item_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_type TEXT NOT NULL,
  party_id TEXT,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  bank_account_number TEXT NOT NULL,
  method TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  allocated_amount NUMERIC NOT NULL DEFAULT 0,
  residual_amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_type, source_id)
);
CREATE TABLE IF NOT EXISTS open_item_allocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL REFERENCES open_item_payments(id) ON DELETE CASCADE,
  open_item_id TEXT NOT NULL REFERENCES open_items(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, payment_id, open_item_id)
);

CREATE TABLE IF NOT EXISTS accounting_backfill_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  confirmation_hash TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  completed_at TEXT,
  config_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_items_tenant_status ON open_items (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_open_item_payments_tenant_date ON open_item_payments (tenant_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_incoming_invoice_lines_invoice ON incoming_invoice_lines (tenant_id, incoming_invoice_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_source_draft ON journal_entries (tenant_id, source_draft_id) WHERE source_draft_id IS NOT NULL;

CREATE OR REPLACE FUNCTION billme_protect_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'journal entries are immutable'; END IF;
  IF OLD.status = 'posted' AND NEW.status = 'reversed'
     AND NEW.reversed_entry_id IS NOT NULL
     AND (to_jsonb(OLD) - 'status' - 'reversed_entry_id') = (to_jsonb(NEW) - 'status' - 'reversed_entry_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'journal entries are immutable';
END $$;
DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION billme_protect_journal_entry();

CREATE OR REPLACE FUNCTION billme_protect_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'journal lines are immutable'; END $$;
DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION billme_protect_journal_lines();

CREATE OR REPLACE FUNCTION billme_protect_datev_exports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'DATEV exports are immutable'; END $$;
DROP TRIGGER IF EXISTS datev_exports_immutable ON datev_exports;
CREATE TRIGGER datev_exports_immutable BEFORE UPDATE OR DELETE ON datev_exports FOR EACH ROW EXECUTE FUNCTION billme_protect_datev_exports();

CREATE OR REPLACE FUNCTION billme_protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accounting_status IN ('posted','reversed')
     AND NEW.accounting_status IN ('reversed')
     AND (to_jsonb(OLD) - 'accounting_status' - 'status' - 'updated_at') = (to_jsonb(NEW) - 'accounting_status' - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.accounting_status IN ('posted','reversed') THEN RAISE EXCEPTION 'posted accounting documents are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoices_posted_immutable ON invoices;
CREATE TRIGGER invoices_posted_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_document();
DROP TRIGGER IF EXISTS incoming_invoices_posted_immutable ON incoming_invoices;
CREATE TRIGGER incoming_invoices_posted_immutable BEFORE UPDATE OR DELETE ON incoming_invoices FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_document();


CREATE OR REPLACE FUNCTION billme_protect_posted_incoming_invoice_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM incoming_invoices
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.incoming_invoice_id ELSE NEW.incoming_invoice_id END
      AND tenant_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END
      AND accounting_status IN ('posted','reversed')
  ) THEN
    RAISE EXCEPTION 'posted incoming invoice lines are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS incoming_invoice_lines_posted_immutable ON incoming_invoice_lines;
CREATE TRIGGER incoming_invoice_lines_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_lines FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_incoming_invoice_lines();
