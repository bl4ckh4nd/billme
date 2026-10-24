-- Accounts per tax case (Pro). Revenue, not-yet-due VAT (Ist), granted Skonto and customer advances get an
-- account per tax case and rate; the defaults live in server-data taxAccounts.ts. This adds the SKR accounts the
-- extracted catalogue lost (DATEV standard numbering), the accounts for Mahngebühren (SKR04 4830) and Verzugszinsen
-- (SKR03 2650), and the tax case for non-taxable Drittland services.
INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES
  ('server-catalog:SKR03:1711', 'SKR03', '1711', 'Erhaltene, versteuerte Anzahlungen 7 % USt (Verbindlichkeiten)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:1718', 'SKR03', '1718', 'Erhaltene, versteuerte Anzahlungen 19 % USt (Verbindlichkeiten)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:2650', 'SKR03', '2650', 'Sonstige Zinsen und ähnliche Erträge', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:4654', 'SKR03', '4654', 'Nicht abzugsfähige Bewirtungskosten', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:1761', 'SKR03', '1761', 'Umsatzsteuer nicht fällig 7 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:1766', 'SKR03', '1766', 'Umsatzsteuer nicht fällig 19 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:8100', 'SKR03', '8100', 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:8120', 'SKR03', '8120', 'Steuerfreie Umsätze § 4 Nr. 1a UStG (Ausfuhr Drittland)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:8337', 'SKR03', '8337', 'Erlöse aus Leistungen, für die der Leistungsempfänger die Steuer nach § 13b UStG schuldet', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:8731', 'SKR03', '8731', 'Gewährte Skonti 7 % USt', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR03:8736', 'SKR03', '8736', 'Gewährte Skonti 19 % USt', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:3260', 'SKR04', '3260', 'Erhaltene, versteuerte Anzahlungen 7 % USt (Verbindlichkeiten)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:3272', 'SKR04', '3272', 'Erhaltene, versteuerte Anzahlungen 19 % USt (Verbindlichkeiten)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:3811', 'SKR04', '3811', 'Umsatzsteuer nicht fällig 7 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:3816', 'SKR04', '3816', 'Umsatzsteuer nicht fällig 19 %', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4100', 'SKR04', '4100', 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4120', 'SKR04', '4120', 'Steuerfreie Umsätze § 4 Nr. 1a UStG (Ausfuhr Drittland)', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4337', 'SKR04', '4337', 'Erlöse aus Leistungen, für die der Leistungsempfänger die Steuer nach § 13b UStG schuldet', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4731', 'SKR04', '4731', 'Gewährte Skonti 7 % USt', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4736', 'SKR04', '4736', 'Gewährte Skonti 19 % USt', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:4830', 'SKR04', '4830', 'Sonstige betriebliche Erträge', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text),
  ('server-catalog:SKR04:6644', 'SKR04', '6644', 'Nicht abzugsfähige Bewirtungskosten', 'server-catalog', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
ON CONFLICT (chart, account_number) DO NOTHING;
INSERT INTO tax_cases (key, label, mechanism, default_rate, requires_counterparty_vat_id, requires_country, requires_evidence, active, updated_at) VALUES
  ('NON_EU_SERVICE_OUTSIDE_SCOPE', 'Drittland sonstige Leistung, im Inland nicht steuerbar', 'exempt', 0, FALSE, TRUE, TRUE, TRUE, CURRENT_TIMESTAMP::text)
ON CONFLICT (key) DO NOTHING;
-- Not-yet-due VAT (Ist) moves from 1780 (SKR03, that is the USt-Vorauszahlungen account) and 3810 for every rate
-- (SKR04) to the DATEV accounts per rate: 1766/1761 and 3816/3811 (Kontenrahmen 2025; 1765/3815 are reserved). A tenant that already booked on its old account keeps it for both
-- rates until the year is closed: switching mid-year would split one account's balance over two. New tenants and
-- tenants without such postings get the new accounts.
INSERT INTO accounting_account_mappings (id, tenant_id, chart, role, account_number, updated_at)
SELECT 'migration-0045:' || used.tenant_id || ':' || used.chart || ':' || roles.role, used.tenant_id, used.chart, roles.role, used.account_number, CURRENT_TIMESTAMP::text
FROM (
  SELECT tn.id AS tenant_id, legacy.chart, COALESCE(mapped.account_number, legacy.account_number) AS account_number
  FROM tenants tn
  CROSS JOIN (VALUES ('SKR03', '1780'), ('SKR04', '3810')) AS legacy(chart, account_number)
  LEFT JOIN accounting_account_mappings mapped ON mapped.tenant_id = tn.id AND mapped.chart = legacy.chart AND mapped.role = 'output_vat_deferred'
) AS used
CROSS JOIN (VALUES ('output_vat_deferred'), ('output_vat_deferred_7')) AS roles(role)
WHERE EXISTS (
  SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
  WHERE jl.tenant_id = used.tenant_id AND jl.account_number = used.account_number AND je.source_type IN ('outgoing_invoice', 'payment_vat')
)
ON CONFLICT (tenant_id, chart, role) DO NOTHING;
UPDATE accounting_account_mappings AS m
SET account_number = CASE m.chart WHEN 'SKR03' THEN '1766' ELSE '3816' END, updated_at = CURRENT_TIMESTAMP::text
WHERE m.role = 'output_vat_deferred'
  AND ((m.chart = 'SKR03' AND m.account_number = '1780') OR (m.chart = 'SKR04' AND m.account_number = '3810'))
  AND NOT EXISTS (
    SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
    WHERE jl.tenant_id = m.tenant_id AND jl.account_number = m.account_number AND je.source_type IN ('outgoing_invoice', 'payment_vat')
  );
