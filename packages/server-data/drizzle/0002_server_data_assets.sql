CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_number TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  status TEXT NOT NULL,
  activation_date TEXT NOT NULL,
  acquisition_cost NUMERIC NOT NULL,
  useful_life_years INTEGER,
  depreciation_method TEXT NOT NULL,
  cost_center TEXT NOT NULL,
  location TEXT NOT NULL,
  receipt_linked BOOLEAN NOT NULL DEFAULT FALSE,
  supplier TEXT,
  invoice_ref TEXT,
  asset_account_number TEXT NOT NULL,
  disposal_date TEXT,
  disposal_proceeds NUMERIC,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, asset_number)
);

CREATE TABLE IF NOT EXISTS asset_depreciation_schedule (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  months INTEGER NOT NULL,
  status TEXT NOT NULL,
  journal_entry_id TEXT,
  posted_at TEXT,
  UNIQUE (tenant_id, asset_id, year)
);

CREATE TABLE IF NOT EXISTS asset_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  movement_date TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  proceeds NUMERIC,
  gain_loss NUMERIC,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_movements_tenant_asset_date
  ON asset_movements (tenant_id, asset_id, movement_date);
