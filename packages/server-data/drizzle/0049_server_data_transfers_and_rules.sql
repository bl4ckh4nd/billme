-- Booking-rule engine; transfers between own accounts are its built-in first rule (own IBAN → Geldtransit).
-- Number 0049: 0040–0048 are taken by the parallel booking-fix branch.

-- Counterparty IBAN of a bank line: a transfer between own accounts names one of the tenant's own IBANs.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS counterparty_iban TEXT;
-- Booking rules (Regel-Engine). The legacy single condition (field/operator/value) and
-- target stay as a projection for older readers; conditions_json and actions_json win when set.
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'base' CHECK (stage IN ('base', 'override'));
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS logic TEXT NOT NULL DEFAULT 'and' CHECK (logic IN ('and', 'or'));
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS conditions_json TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS actions_json TEXT;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS auto_post BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_suggestion_rules ADD COLUMN IF NOT EXISTS stop_processing BOOLEAN NOT NULL DEFAULT FALSE;
