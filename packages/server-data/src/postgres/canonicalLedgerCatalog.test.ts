import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PgliteServerDatabase } from '../pglite/database.js';

const opos7PercentVatAccounts = [
  { chart: 'SKR03', accountNumber: '1571', name: 'Abziehbare Vorsteuer 7 %' },
  { chart: 'SKR03', accountNumber: '1771', name: 'Umsatzsteuer 7 %' },
  { chart: 'SKR04', accountNumber: '1401', name: 'Abziehbare Vorsteuer 7 %' },
  { chart: 'SKR04', accountNumber: '3801', name: 'Umsatzsteuer 7 %' },
] as const;

test('migrated database seeds the OPOS 7% VAT accounts for SKR03 and SKR04', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-ledger-catalog-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    const rows = (await database.query<{ chart: string; account_number: string; name: string }>(
      `SELECT chart, account_number, name FROM ledger_accounts WHERE (chart, account_number) IN (('SKR03','1571'),('SKR03','1771'),('SKR04','1401'),('SKR04','3801')) ORDER BY chart, account_number`,
    )).rows.map((row) => ({ chart: row.chart, accountNumber: row.account_number, name: row.name }));
    assert.deepEqual(rows, opos7PercentVatAccounts);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * Migration 0045 moves not-yet-due VAT (Ist) to 1766/1761 (SKR03) and 3816/3811 (SKR04). How this can fail:
 * a tenant that already booked Ist VAT on 1780 gets the new account mid-year (one balance split over two
 * accounts), a tenant's own mapping is overwritten, a seeded row of the old default stays on 1780 although
 * nothing was booked, a fresh tenant gets rows it never asked for, a second run changes anything again.
 */
test('migration 0045 keeps the not-yet-due VAT account of tenants that booked on it and moves the others', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-0045-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const stamp = new Date().toISOString();
  try {
    await database.migrate();
    for (const id of ['old-ist', 'old-seeded', 'old-custom', 'fresh']) {
      await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1,$1,$1,'pro',$2,$2)`, [id, stamp]);
    }
    const mapping = (tenant: string, role: string, account: string) => database.query(`INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,'SKR03',$3,$4,$5)`, [`${tenant}-${role}`, tenant, role, account, stamp]);
    const posted = (tenant: string, sourceType: string, account: string) => database.transaction({}, async (tx) => {
      const entry = `${tenant}-${sourceType}`;
      await tx.query(`INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,$2,1,'2026-03-02','2026-03-02','Rechnung','2026-03',2026,'posted',$3,$1,$4)`, [entry, tenant, sourceType, stamp]);
      await tx.query(`INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount) VALUES ($1,$2,$3,1,'1400',119,0),($4,$2,$3,2,'8400',0,100),($5,$2,$3,3,$6,0,19)`, [`${entry}-1`, tenant, entry, `${entry}-2`, `${entry}-3`, account]);
    });
    await posted('old-ist', 'outgoing_invoice', '1780');
    await mapping('old-seeded', 'output_vat_deferred', '1780');
    await mapping('old-custom', 'output_vat_deferred', '1770');
    await posted('old-custom', 'outgoing_invoice', '1770');

    const sql = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0045_server_data_tax_case_accounts.sql'), 'utf8');
    const statements = sql.split(/;\s*\n/).map((statement) => statement.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    const rows = async () => (await database.query<{ tenant_id: string; role: string; account_number: string }>(
      `SELECT tenant_id, role, account_number FROM accounting_account_mappings WHERE role LIKE 'output_vat_deferred%' ORDER BY tenant_id, role`,
    )).rows.map((row) => [row.tenant_id, row.role, row.account_number]);
    for (const run of [1, 2]) {
      for (const statement of statements) await database.query(statement);
      assert.deepEqual(await rows(), [
        ['old-custom', 'output_vat_deferred', '1770'], ['old-custom', 'output_vat_deferred_7', '1770'],
        ['old-ist', 'output_vat_deferred', '1780'], ['old-ist', 'output_vat_deferred_7', '1780'],
        ['old-seeded', 'output_vat_deferred', '1766'],
      ], `run ${run}`);
    }
    const accounts = (await database.query<{ chart: string; account_number: string }>(`SELECT chart, account_number FROM ledger_accounts WHERE (chart, account_number) IN (('SKR03','8337'),('SKR03','8736'),('SKR03','1718'),('SKR04','4736'),('SKR04','3272'),('SKR04','4100'))`)).rows.length;
    assert.equal(accounts, 6, 'the accounts per tax case are in the catalogue');
    assert.equal((await database.query(`SELECT 1 FROM tax_cases WHERE key='NON_EU_SERVICE_OUTSIDE_SCOPE'`)).rows.length, 1);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * The role accounts against the DATEV Kontenrahmen SKR 03/SKR 04, gültig für 2025 (Art.-Nr. 11174/11175). The table is
 * copied by hand from the DATEV PDF, not derived from the catalogue. How this can fail: a default points at an account
 * the PDF extraction shifted (1765 "USt nicht fällig 19 %" is 1766, SKR04 1403 is reserved, 1404 is the Erwerb
 * Vorsteuer), a migration names an account differently from the catalogue (the desktop import then refuses the
 * database), a reserved account stays bookable, a name keeps a hyphenation residue or text of the neighbouring column.
 */
const DATEV_ROLE_ACCOUNTS: Record<'SKR03' | 'SKR04', Record<string, readonly [string, string]>> = {
  SKR03: {
    accounts_receivable: ['1400', 'Forderungen aus Lieferungen und Leistungen'],
    accounts_payable: ['1600', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
    bank: ['1200', 'Bank'], cash: ['1000', 'Kasse'],
    revenue: ['8400', 'Erlöse 19 % USt'], revenue_7: ['8300', 'Erlöse 7 % USt'],
    expense: ['4900', 'Sonstige betriebliche Aufwendungen'], asset: ['0480', 'Geringwertige Wirtschaftsgüter'],
    output_vat: ['1776', 'Umsatzsteuer 19 %'], output_vat_7: ['1771', 'Umsatzsteuer 7 %'],
    output_vat_deferred: ['1766', 'Umsatzsteuer nicht fällig 19 %'], output_vat_deferred_7: ['1761', 'Umsatzsteuer nicht fällig 7 %'],
    input_vat: ['1576', 'Abziehbare Vorsteuer 19 %'], input_vat_7: ['1571', 'Abziehbare Vorsteuer 7 %'],
    revenue_small_business: ['8195', 'Erlöse als Kleinunternehmer nach § 19 Abs. 1 UStG a. F.'],
    revenue_exempt: ['8100', 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG'],
    revenue_rc_13b: ['8337', 'Erlöse aus Leistungen, für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet'],
    revenue_eu_supply: ['8125', 'Steuerfreie innergemeinschaftliche Lieferungen nach § 4 Nr. 1b UStG'],
    revenue_eu_service: ['8336', 'Erlöse aus im anderen EU-Land steuerpflichtigen sonstigen Leistungen, für die der Leistungsempfänger die Umsatzsteuer schuldet'],
    revenue_export: ['8120', 'Steuerfreie Umsätze nach § 4 Nr. 1a UStG'],
    revenue_outside_scope: ['8338', 'Erlöse aus im Drittland steuerbaren Leistungen, im Inland nicht steuerbare Umsätze'],
    cash_discount_granted: ['8736', 'Gewährte Skonti 19 % USt'], cash_discount_granted_7: ['8731', 'Gewährte Skonti 7 % USt'],
    customer_advances: ['1718', 'Erhaltene, versteuerte Anzahlungen 19 % USt (Verbindlichkeiten)'],
    customer_advances_7: ['1711', 'Erhaltene, versteuerte Anzahlungen 7 % USt (Verbindlichkeiten)'],
    dunning_fees: ['2700', 'Andere betriebs- und/oder periodenfremde (neutrale) sonstige Erträge'],
    late_interest: ['2650', 'Sonstige Zinsen und ähnliche Erträge'],
    input_vat_rc_13b: ['1577', 'Abziehbare Vorsteuer nach § 13b UStG 19 %'], output_vat_rc_13b: ['1787', 'Umsatzsteuer nach § 13b UStG 19 %'],
    input_vat_ige: ['1574', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb 19 %'], output_vat_ige: ['1774', 'Umsatzsteuer aus innergemeinschaftlichem Erwerb 19 %'],
    input_vat_ige_7: ['1572', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb'], output_vat_ige_7: ['1772', 'Umsatzsteuer aus innergemeinschaftlichem Erwerb'],
    transit: ['1360', 'Geldtransit'],
  },
  SKR04: {
    accounts_receivable: ['1200', 'Forderungen aus Lieferungen und Leistungen'],
    accounts_payable: ['3300', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
    bank: ['1800', 'Bank'], cash: ['1600', 'Kasse'],
    revenue: ['4400', 'Erlöse 19 % USt'], revenue_7: ['4300', 'Erlöse 7 % USt'],
    expense: ['6300', 'Sonstige betriebliche Aufwendungen'], asset: ['0670', 'Geringwertige Wirtschaftsgüter'],
    output_vat: ['3806', 'Umsatzsteuer 19 %'], output_vat_7: ['3801', 'Umsatzsteuer 7 %'],
    output_vat_deferred: ['3816', 'Umsatzsteuer nicht fällig 19 %'], output_vat_deferred_7: ['3811', 'Umsatzsteuer nicht fällig 7 %'],
    input_vat: ['1406', 'Abziehbare Vorsteuer 19 %'], input_vat_7: ['1401', 'Abziehbare Vorsteuer 7 %'],
    revenue_small_business: ['4185', 'Erlöse als Kleinunternehmer nach § 19 Abs. 1 UStG a. F.'],
    revenue_exempt: ['4100', 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG'],
    revenue_rc_13b: ['4337', 'Erlöse aus Leistungen, für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet'],
    revenue_eu_supply: ['4125', 'Steuerfreie innergemeinschaftliche Lieferungen nach § 4 Nr. 1b UStG'],
    revenue_eu_service: ['4336', 'Erlöse aus im anderen EU-Land steuerpflichtigen sonstigen Leistungen, für die der Leistungsempfänger die Umsatzsteuer schuldet'],
    revenue_export: ['4120', 'Steuerfreie Umsätze nach § 4 Nr. 1a UStG'],
    revenue_outside_scope: ['4338', 'Erlöse aus im Drittland steuerbaren Leistungen, im Inland nicht steuerbare Umsätze'],
    cash_discount_granted: ['4736', 'Gewährte Skonti 19 % USt'], cash_discount_granted_7: ['4731', 'Gewährte Skonti 7 % USt'],
    customer_advances: ['3272', 'Erhaltene, versteuerte Anzahlungen 19 % USt (Verbindlichkeiten)'],
    customer_advances_7: ['3260', 'Erhaltene, versteuerte Anzahlungen 7 % USt (Verbindlichkeiten)'],
    dunning_fees: ['4830', 'Sonstige betriebliche Erträge'],
    late_interest: ['7100', 'Sonstige Zinsen und ähnliche Erträge'],
    input_vat_rc_13b: ['1407', 'Abziehbare Vorsteuer nach § 13b UStG 19 %'], output_vat_rc_13b: ['3837', 'Umsatzsteuer nach § 13b UStG 19 %'],
    input_vat_ige: ['1404', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb 19 %'], output_vat_ige: ['3804', 'Umsatzsteuer aus innergemeinschaftlichem Erwerb 19 %'],
    input_vat_ige_7: ['1402', 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb'], output_vat_ige_7: ['3802', 'Umsatzsteuer aus innergemeinschaftlichem Erwerb'],
    transit: ['1460', 'Geldtransit'],
  },
};
/** Accounts the posting paths use without a role: Bewirtung 70/30, Privat, Skonti/USt without a rate. */
const DATEV_FIXED_ACCOUNTS: ReadonlyArray<readonly ['SKR03' | 'SKR04', string, string]> = [
  ['SKR03', '4650', 'Bewirtungskosten'], ['SKR03', '4654', 'Nicht abzugsfähige Bewirtungskosten'],
  ['SKR04', '6640', 'Bewirtungskosten'], ['SKR04', '6644', 'Nicht abzugsfähige Bewirtungskosten'],
  ['SKR03', '1800', 'Privatentnahmen allgemein'], ['SKR03', '1890', 'Privateinlagen'],
  ['SKR04', '2100', 'Privatentnahmen allgemein'], ['SKR04', '2180', 'Privateinlagen'],
  ['SKR03', '1760', 'Umsatzsteuer nicht fällig'], ['SKR04', '3810', 'Umsatzsteuer nicht fällig'],
  ['SKR03', '8730', 'Gewährte Skonti'], ['SKR04', '4730', 'Gewährte Skonti'],
];
const DATEV_RESERVED = [['SKR03', '1765'], ['SKR03', '1763'], ['SKR03', '1575'], ['SKR04', '3815'], ['SKR04', '3813'], ['SKR04', '1403'], ['SKR04', '3271']] as const;

test('every role account and the fixed posting accounts carry the DATEV number and name; reserved accounts are gone', async () => {
  const { ACCOUNT_ROLE_DEFAULTS } = await import('./taxAccounts.js');
  const { CANONICAL_LEDGER_ACCOUNTS } = await import('./canonicalLedgerCatalog.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-datev-catalog-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    const persisted = new Map((await database.query<{ chart: string; account_number: string; name: string }>(`SELECT chart, account_number, name FROM ledger_accounts`)).rows.map((row) => [`${row.chart}:${row.account_number}`, row.name]));
    for (const chart of ['SKR03', 'SKR04'] as const) {
      assert.deepEqual(Object.keys(ACCOUNT_ROLE_DEFAULTS[chart]).sort(), Object.keys(DATEV_ROLE_ACCOUNTS[chart]).sort(), `${chart}: every role is pinned`);
      for (const [role, [number, name]] of Object.entries(DATEV_ROLE_ACCOUNTS[chart])) {
        assert.equal(ACCOUNT_ROLE_DEFAULTS[chart][role], number, `${chart} ${role}`);
        assert.equal(persisted.get(`${chart}:${number}`), name, `${chart} ${number} (${role})`);
        assert.equal(CANONICAL_LEDGER_ACCOUNTS.find((row) => row.chart === chart && row.accountNumber === number)?.name, name, `catalogue ${chart} ${number}`);
      }
    }
    for (const [chart, number, name] of DATEV_FIXED_ACCOUNTS) assert.equal(persisted.get(`${chart}:${number}`), name, `${chart} ${number}`);
    for (const [chart, number] of DATEV_RESERVED) {
      assert.equal(persisted.has(`${chart}:${number}`), false, `${chart} ${number} is reserved in DATEV`);
      assert.equal(CANONICAL_LEDGER_ACCOUNTS.some((row) => row.chart === chart && (row.accountNumber as string) === number), false, `catalogue ${chart} ${number}`);
    }
    // The desktop import checks exactly this: every catalogue row exists with the same name.
    for (const row of CANONICAL_LEDGER_ACCOUNTS) assert.equal(persisted.get(`${row.chart}:${row.accountNumber}`), row.name, `${row.chart} ${row.accountNumber}`);
    const residue = CANONICAL_LEDGER_ACCOUNTS.filter((row) => /[a-zäöüß]- (?!und\b|oder\b|bzw\.|sowie\b)[a-zäöüß]/.test(row.name) || /\s\d{1,2}\)/.test(row.name) || /-$/.test(row.name));
    assert.deepEqual(residue, [], 'no hyphenation residue or footnote marks in the names');
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
