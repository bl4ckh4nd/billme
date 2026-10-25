-- DATEV Personenkonten (Pro): every OPOS party gets a fixed number per type the first time a DATEV stack is exported.
-- The account is derived from it and the Sachkontenlänge L: Debitor 1·10^L + ordinal, Kreditor 7·10^L + ordinal.
-- party_id is what OPOS stores (a customer id, otherwise the customer name; the vendor id). Numbers never change.
CREATE TABLE IF NOT EXISTS datev_party_accounts (
  tenant_id TEXT NOT NULL,
  party_type TEXT NOT NULL,
  party_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, party_type, party_id),
  UNIQUE (tenant_id, party_type, ordinal)
);
