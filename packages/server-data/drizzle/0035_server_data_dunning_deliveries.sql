CREATE TABLE dunning_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  level INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing','sending','sent','failed','unknown')),
  fee NUMERIC NOT NULL,
  updated_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  error TEXT,
  UNIQUE (tenant_id, invoice_id, level),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX dunning_deliveries_active_invoice ON dunning_deliveries (tenant_id,invoice_id)
  WHERE state IN ('preparing','sending','unknown');
