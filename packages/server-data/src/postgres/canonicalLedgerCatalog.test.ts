import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
