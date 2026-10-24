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
 * Migration 0045 moves not-yet-due VAT (Ist) to 1765/1760 (SKR03) and 3815/3810 (SKR04). How this can fail:
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
        ['old-seeded', 'output_vat_deferred', '1765'],
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
