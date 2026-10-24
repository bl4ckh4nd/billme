-- Self-assessed purchases (Pro): § 13b and innergemeinschaftlicher Erwerb. An incoming invoice keeps its tax
-- evidence (supplier country, supplier VAT ID, evidence type and reference) next to its tax case, and the
-- Vorsteuer accounts of the innergemeinschaftlicher Erwerb the extracted catalogue lost are added (DATEV
-- standard numbering; 1574/1404 at 19 %, 1572/1402 without a rate in the name, used for 7 %).
ALTER TABLE incoming_invoices ADD COLUMN IF NOT EXISTS tax_meta_json TEXT;
INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES
  ('server-catalog:SKR03:1572', 'SKR03', '1572', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:1574', 'SKR03', '1574', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb 19 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:1402', 'SKR04', '1402', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:1404', 'SKR04', '1404', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb 19 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
ON CONFLICT (chart, account_number) DO NOTHING;
