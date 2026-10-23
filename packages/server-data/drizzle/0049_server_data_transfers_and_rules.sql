-- Transfers between own financial accounts (Geldtransit) and the booking-rule engine.
-- Number 0049: 0040–0048 are taken by the parallel booking-fix branch.

-- Counterparty IBAN of a bank line: a transfer is only "sicher" when it names one of the tenant's own IBANs.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS counterparty_iban TEXT;
-- A decision about one side of a transfer. Suggestions are computed on the fly;
-- only confirmed pairs and rejected suggestions are stored. A confirmed side
-- without partner is booked over Geldtransit and stays open there.
CREATE TABLE IF NOT EXISTS bank_transfer_links (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  partner_transaction_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  level TEXT CHECK (level IS NULL OR level IN ('sicher', 'wahrscheinlich')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_transfer_links_partner ON bank_transfer_links (tenant_id, partner_transaction_id);
-- Per-tenant switches for transfer detection and automatic posting. All automatic posting is off by default.
CREATE TABLE IF NOT EXISTS pro_booking_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_detection BOOLEAN NOT NULL DEFAULT TRUE,
  transfer_window_days INTEGER NOT NULL DEFAULT 7 CHECK (transfer_window_days BETWEEN 0 AND 31),
  auto_post_transfers BOOLEAN NOT NULL DEFAULT FALSE,
  auto_post_rules BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL
);
-- Booking rules (Regel-Engine). The legacy single condition (field/operator/value) and
-- target stay as a projection for older readers; conditions_json and actions_json win when set.
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'base' CHECK (stage IN ('base', 'override'));
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS logic TEXT NOT NULL DEFAULT 'and' CHECK (logic IN ('and', 'or'));
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS conditions_json TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS actions_json TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS auto_post BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS stop_processing BOOLEAN NOT NULL DEFAULT FALSE;
