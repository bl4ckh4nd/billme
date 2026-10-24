import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope, type AssetUpsertInput } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const now = '2026-08-21T10:00:00.000Z';
const tenantId = 'tenant-assets';
const scope = createSingleTenantScope(tenantId, 'pro');

const asset = (id: string, overrides: Partial<AssetUpsertInput> = {}): AssetUpsertInput => ({
  id,
  assetNumber: id,
  name: 'Testanlage',
  assetClass: 'IT-Hardware',
  status: 'aktiv',
  activationDate: '2026-01-01',
  acquisitionCost: 1000,
  usefulLifeYears: 1,
  depreciationMethod: 'linear',
  costCenter: 'IT',
  location: 'Berlin',
  receiptLinked: true,
  assetAccountNumber: '0440',
  ...overrides,
});

async function withDatabase<T>(work: (database: PgliteServerDatabase) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-assets-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $1, 'Assets', 'pro', $2, $2)`,
      [tenantId, now],
    );
    await database.query(
      `INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`,
      [tenantId, now],
    );
    for (const [number, name] of [['0440', 'Betriebsausstattung'], ['1600', 'Kreditoren'], ['1200', 'Bank'], ['2310', 'Anlagenabgang Verlust'], ['8829', 'Anlagenabgang Gewinn'], ['4830', 'Abschreibungen']]) {
      await database.query(
        `INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03',$2,$3,'test',$4,$4) ON CONFLICT (chart,account_number) DO NOTHING`,
        [`asset-test-${number}`, number, name, now],
      );
    }
    return await work(database);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const journalLines = async (database: PgliteServerDatabase, sourceType: string, sourceKey: string) =>
  (await database.query<{ account_number: string; debit_amount: string; credit_amount: string }>(
    `SELECT jl.account_number, jl.debit_amount, jl.credit_amount FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      WHERE je.tenant_id = $1 AND je.source_type = $2 AND je.source_key = $3 ORDER BY jl.line_no`,
    [tenantId, sourceType, sourceKey],
  )).rows.map((row) => ({ account: row.account_number, debit: Number(row.debit_amount), credit: Number(row.credit_amount) }));

const auditRow = async (database: PgliteServerDatabase, entityId: string, action: string) => {
  const row = (await database.query<{ before_json: string | null; after_json: string | null }>(
    `SELECT before_json, after_json FROM audit_log WHERE tenant_id=$1 AND entity_type='asset' AND entity_id=$2 AND action=$3 ORDER BY sequence DESC LIMIT 1`,
    [tenantId, entityId, action],
  )).rows[0];
  assert.ok(row, `audit row ${action}`);
  return { before: row.before_json ? JSON.parse(row.before_json) : null, after: row.after_json ? JSON.parse(row.after_json) : null };
};

test('activating an asset posts a 0440/1600 journal and depreciation posts AfA 4830 against the asset account', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    const created = await repository.upsertAsset(scope, asset('notebook', { acquisitionCost: 1200, usefulLifeYears: undefined, activationDate: '2026-05-01' }), 'Test asset');

    assert.deepEqual(await journalLines(database, 'asset_activation', 'asset_activation:notebook'), [
      { account: '0440', debit: 1200, credit: 0 },
      { account: '1600', debit: 0, credit: 1200 },
    ]);
    assert.equal(created.activationJournalEntryId !== undefined, true);
    assert.equal((await repository.getDepreciationSchedule(scope, created.id)).length, 4);

    const result = await repository.runDepreciation(scope, { assetId: created.id, year: 2026, postingDate: '2026-12-31', reason: 'Annual AfA' });
    assert.equal(result.scheduleEntry.status, 'posted');
    assert.equal(result.scheduleEntry.amount, 266.67);
    assert.deepEqual(await journalLines(database, 'asset_depreciation', 'asset_depreciation:notebook:2026'), [
      { account: '4830', debit: 266.67, credit: 0 },
      { account: '0440', debit: 0, credit: 266.67 },
    ]);
    assert.equal((await repository.listAssets(scope))[0]?.residualValue, 933.33);

    const audit = await auditRow(database, created.id, 'depreciation_posted');
    assert.equal(audit.before.schedule.find((entry: { year: number }) => entry.year === 2026).status, 'planned');
    assert.equal(audit.after.schedule.find((entry: { year: number }) => entry.year === 2026).status, 'posted');

    const replay = await repository.runDepreciation(scope, { assetId: created.id, year: 2026, postingDate: '2026-12-31', reason: 'Replay' });
    assert.equal(replay.journalEntryId, result.journalEntryId);
  });
});

test('asset audit snapshots persist the normalized GWG method and keep before/after fields symmetric on update', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('audit-gwg', { acquisitionCost: 800 }), 'Normalized asset audit');
    const created = await auditRow(database, 'audit-gwg', 'create');
    assert.equal(created.after.asset.depreciationMethod, 'gwg');
    assert.deepEqual(created.after.schedule.map((entry: { year: number; status: string; amount: number }) => [entry.year, entry.status, entry.amount]), [[2026, 'planned', 800]]);

    await repository.upsertAsset(scope, asset('audit-gwg', { acquisitionCost: 800, name: 'Umbenannt' }), 'Rename');
    const updated = await auditRow(database, 'audit-gwg', 'update');
    assert.deepEqual(Object.keys(updated.before.asset).sort(), Object.keys(updated.after.asset).sort());
    assert.equal(updated.before.asset.name, 'Testanlage');
    assert.equal(updated.after.asset.name, 'Umbenannt');
  });
});

test('disposal after posted AfA books the residual loss on 2310, cancels the remaining schedule, and retries idempotently', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('dispose-loss', { usefulLifeYears: 2 }), 'Disposal test');
    await repository.runDepreciation(scope, { assetId: 'dispose-loss', year: 2026, postingDate: '2026-12-31', reason: 'AfA 2026' });
    const result = await repository.disposeAsset(scope, { assetId: 'dispose-loss', disposalDate: '2026-12-31', proceeds: 100, taxRate: 0, proceedsAccountNumber: '1200', reason: 'Loss disposal' });

    assert.equal(result.residualBookValue, 500);
    assert.equal(result.gainLoss, -400);
    assert.equal(result.asset.status, 'verkauft');
    const lines = await journalLines(database, 'asset_disposal', 'asset_disposal:dispose-loss');
    assert.deepEqual(lines.map((line) => [line.account, line.debit, line.credit]).sort(), [
      ['0440', 0, 500],
      ['1200', 100, 0],
      ['2310', 400, 0],
    ]);
    const audit = await auditRow(database, 'dispose-loss', 'dispose');
    assert.equal(audit.before.asset.status, 'aktiv');
    assert.equal(audit.after.asset.status, 'verkauft');
    assert.equal(audit.after.asset.disposalDate, '2026-12-31');
    assert.deepEqual(audit.after.schedule.map((entry: { year: number; status: string }) => [entry.year, entry.status]), [[2026, 'posted'], [2027, 'cancelled']]);

    const retry = await repository.disposeAsset(scope, { assetId: 'dispose-loss', disposalDate: 'not-a-date', proceeds: 999, reason: 'Retry after lock' });
    assert.deepEqual([retry.residualBookValue, retry.gainLoss, retry.journalEntryId], [500, -400, result.journalEntryId]);
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_disposal'`, [tenantId])).rows.length, 1);
  });
});

test('disposal is rejected while posted AfA lags the depreciation due at the disposal date', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('dispose-no-afa'), 'Disposal test');
    await assert.rejects(
      () => repository.disposeAsset(scope, { assetId: 'dispose-no-afa', disposalDate: '2026-06-30', proceeds: 100, taxRate: 0, proceedsAccountNumber: '1200', reason: 'No AfA disposal' }),
      /ASSET_DISPOSAL_PROJECTION_MISMATCH/,
    );
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_disposal'`, [tenantId])).rows.length, 0);
  });
});

test('disposal after full AfA books the proceeds as gain on 8829 without crediting the asset account', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('dispose-full-afa'), 'Disposal test');
    await repository.runDepreciation(scope, { assetId: 'dispose-full-afa', year: 2026, postingDate: '2026-12-31', reason: 'Full AfA' });
    assert.equal((await database.query<{ status: string }>(`SELECT status FROM assets WHERE id='dispose-full-afa'`)).rows[0]?.status, 'voll_abgeschrieben');

    const result = await repository.disposeAsset(scope, { assetId: 'dispose-full-afa', disposalDate: '2027-01-15', proceeds: 100, taxRate: 0, proceedsAccountNumber: '1200', reason: 'Full AfA disposal' });
    assert.equal(result.residualBookValue, 0);
    assert.equal(result.gainLoss, 100);
    const lines = await journalLines(database, 'asset_disposal', 'asset_disposal:dispose-full-afa');
    assert.deepEqual(lines.map((line) => [line.account, line.debit, line.credit]).sort(), [
      ['1200', 100, 0],
      ['8829', 0, 100],
    ]);
  });
});

test('a draft asset cannot be disposed and posted assets reject direct status changes', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('draft-disposal', { status: 'entwurf', receiptLinked: false }), 'Draft');
    await assert.rejects(
      () => repository.disposeAsset(scope, { assetId: 'draft-disposal', disposalDate: '2026-06-30', proceeds: 0, reason: 'Draft disposal' }),
      /ASSET_NOT_ACTIVE/,
    );
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows.length, 0);

    await repository.upsertAsset(scope, asset('lifecycle-asset'), 'Lifecycle');
    await assert.rejects(() => database.query(`UPDATE assets SET status='stillgelegt' WHERE id='lifecycle-asset'`), /asset status and disposal fields are immutable after accounting ownership/);
    await database.query(`UPDATE assets SET name='Renamed' WHERE id='lifecycle-asset'`);
    await assert.rejects(() => database.query(`UPDATE assets SET disposal_proceeds=1 WHERE id='lifecycle-asset'`), /asset status and disposal fields are immutable after accounting ownership/);
  });
});

const seedPostedIncomingInvoice = async (database: PgliteServerDatabase, lineNet: number) => {
  await database.query(`INSERT INTO vendors (id,tenant_id,name,created_at,updated_at) VALUES ('vendor-source',$1,'Source Vendor',$2,$2)`, [tenantId, now]);
  await database.query(
    `INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,net_amount,tax_amount,gross_amount,status,tax_rate,accounting_status,created_at,updated_at)
     VALUES ('invoice-source',$1,'vendor-source','RE-SOURCE','2026-01-01','2026-01-31',1000,0,1000,'open',0,'unposted',$2,$2)`,
    [tenantId, now],
  );
  await database.query(
    `INSERT INTO incoming_invoice_lines (id,tenant_id,incoming_invoice_id,position,description,quantity,unit_price,net_amount,tax_rate,tax_amount,gross_amount,asset_account_number)
     VALUES ('invoice-source-line',$1,'invoice-source',0,'Asset',1,$2,$2,0,0,$2,'0440')`,
    [tenantId, lineNet],
  );
  await database.transaction({}, async (tx) => {
    await tx.query(
      `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,period,fiscal_year,status,source_type,source_key,created_at)
       VALUES ('journal-source',$1,1,'2026-01-01','2026-01-01','Incoming source','2026-01',2026,'posted','incoming_invoice','incoming-invoice:invoice-source',$2)`,
      [tenantId, now],
    );
    await tx.query(
      `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount)
       VALUES ('journal-source-debit',$1,'journal-source',1,'0440',1000,0),('journal-source-credit',$1,'journal-source',2,'1600',0,1000)`,
      [tenantId],
    );
  });
  await database.query(`UPDATE incoming_invoices SET accounting_status='posted', accounting_journal_entry_id='journal-source' WHERE id='invoice-source'`);
};

test('activation from a posted incoming invoice reuses its journal instead of posting a second activation', async () => {
  await withDatabase(async (database) => {
    await seedPostedIncomingInvoice(database, 1000);
    const repository = createPostgresProAccountingRepository(database);
    const activated = await repository.upsertAsset(scope, asset('sourced-asset', { sourceIncomingInvoiceId: 'invoice-source' }), 'Sourced activation');

    assert.equal(activated.activationJournalEntryId, 'journal-source');
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_activation'`, [tenantId])).rows.length, 0);
    assert.deepEqual((await database.query(`SELECT source_type, source_key, journal_entry_id FROM asset_movements WHERE asset_id='sourced-asset'`)).rows, [
      { source_type: 'incoming_invoice', source_key: 'incoming-invoice:invoice-source', journal_entry_id: 'journal-source' },
    ]);
  });
});

test('activation is rejected when the source invoice has no asset line for the acquisition cost', async () => {
  await withDatabase(async (database) => {
    await seedPostedIncomingInvoice(database, 900);
    const repository = createPostgresProAccountingRepository(database);
    await assert.rejects(
      () => repository.upsertAsset(scope, asset('mismatch-asset', { sourceIncomingInvoiceId: 'invoice-source' }), 'Mismatched activation'),
      /INCOMING_INVOICE_ASSET_LINE_MISMATCH/,
    );
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_activation'`, [tenantId])).rows.length, 0);
  });
});

test('disposal refuses to run when posted schedule and journal depreciation disagree', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await repository.upsertAsset(scope, asset('projection-asset', { usefulLifeYears: 2 }), 'Projection');
    await repository.runDepreciation(scope, { assetId: 'projection-asset', year: 2026, postingDate: '2026-12-31', reason: 'AfA' });
    await database.query(`UPDATE asset_depreciation_schedule SET amount=amount+1 WHERE asset_id='projection-asset' AND status='posted'`);

    await assert.rejects(
      () => repository.disposeAsset(scope, { assetId: 'projection-asset', disposalDate: '2027-06-30', proceeds: 0, reason: 'Projection mismatch' }),
      /ASSET_DEPRECIATION_PROJECTION_MISMATCH/,
    );
    assert.equal((await database.query(`SELECT 1 FROM journal_entries WHERE tenant_id=$1 AND source_type='asset_disposal'`, [tenantId])).rows.length, 0);
  });
});

test('a failing activation movement rolls back the asset row and its activation journal', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await database.query(`CREATE FUNCTION fail_asset_movement() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'movement unavailable'; END $$ LANGUAGE plpgsql`);
    await database.query(`CREATE TRIGGER fail_asset_movement BEFORE INSERT ON asset_movements FOR EACH ROW EXECUTE FUNCTION fail_asset_movement()`);

    await assert.rejects(() => repository.upsertAsset(scope, asset('rollback-asset'), 'Rollback'), /movement unavailable/);
    const assets = await database.query(`SELECT id FROM assets WHERE tenant_id=$1 AND id='rollback-asset'`, [tenantId]);
    assert.equal(assets.rows.length, 0);
    assert.deepEqual(await journalLines(database, 'asset_activation', 'asset_activation:rollback-asset'), []);
  });
});
