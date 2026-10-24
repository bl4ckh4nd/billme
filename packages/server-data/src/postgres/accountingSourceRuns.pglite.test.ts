import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { journalSourceIdentity } from '@billme/accounting-engine';
import { CorrectionSettlementError } from '@billme/accounting-shared';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { sha256Hex, stableStringify } from './audit.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const now = '2026-08-21T10:00:00.000Z';
const tenantId = 'tenant-source';
const scope = createSingleTenantScope(tenantId, 'pro');
const taxBreakdown = [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }];
const snapshot = { sourceVersion: 'invoice-r1', vatBreakdown: taxBreakdown };

async function withDatabase<T>(
  work: (database: PgliteServerDatabase) => Promise<T>,
  options: { legacySourceKey?: boolean } = {},
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-source-runs-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $1, 'Source', 'pro', $2, $2)`, [tenantId, now]);
    await database.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    for (const [number, name] of [['1200', 'Bank'], ['8400', 'Revenue'], ['1400', 'Receivable'], ['1776', 'Output VAT'], ['1600', 'Payable']]) {
      await database.query(
        `INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03',$2,$3,'test',$4,$4) ON CONFLICT (chart,account_number) DO NOTHING`,
        [`source-account-${number}`, number, name, now],
      );
    }
    for (const n of [1, 2]) {
      const id = `invoice-${n}`;
      const journalId = `invoice-journal-${n}`;
      await database.query(
        `INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,items_json,payments_json,history_json,accounting_status,accounting_snapshot_json,accounting_journal_entry_id,created_at,updated_at)
         VALUES ($1,$2,$3,'Customer','customer@example.test','2026-03-15','2026-03-31',119,'open','[]','[]','[]','posted',$4,$5,$6,$6)`,
        [id, tenantId, `RE-${n}`, JSON.stringify(snapshot), journalId, now],
      );
      // The original posting with its lines in one transaction: the database enforces Soll = Haben at commit.
      await database.transaction({}, async (tx) => {
        await tx.query(
          `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_type,source_key,created_at)
           VALUES ($1,$2,$3,'2026-03-15','2026-03-15','Original invoice',$4,'2026-03',2026,'posted','outgoing_invoice',$5,$6)`,
          [journalId, tenantId, n, `RE-${n}`, `${options.legacySourceKey ? 'outgoing_invoice' : 'outgoing-invoice'}:${id}`, now],
        );
        await tx.query(
          `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount) VALUES ($1,$2,$3,1,'1400',119,0),($4,$2,$3,2,'8400',0,100),($5,$2,$3,3,'1776',0,19)`,
          [`${journalId}-1`, tenantId, journalId, `${journalId}-2`, `${journalId}-3`],
        );
      });
      await database.query(
        `INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at)
         VALUES ($1,$2,'debtor',$3,'outgoing_invoice',$4,$5,'2026-03-15','2026-03-31',119,0,119,'open',$6,$7,$7)`,
        [`open-item-${n}`, tenantId, n === 1 ? 'client-1' : 'other-party', id, `RE-${n}`, journalId, now],
      );
    }
    return await work(database);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const sourceFact = (revision: string, overrides: Record<string, unknown> = {}) => ({
  command: 'source_fact' as const,
  sourceId: 'source-1',
  sourceRevision: revision,
  idempotencyKey: `source-1:${revision}`,
  reason: 'source run test',
  input: {
    sourceType: 'standalone_source' as const,
    sourceId: 'source-1',
    sourceRevision: revision,
    effectiveDate: '2026-03-15',
    postingDate: '2026-03-15',
    period: '2026-03',
    fiscalYear: 2026,
    currency: 'EUR',
    bookingText: 'Standalone source',
    lines: [
      { accountNumber: '8400', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '1200', debitAmount: 0, creditAmount: 100 },
    ],
    ...overrides,
  },
});

const count = async (database: PgliteServerDatabase, table: string, where = '1=1') =>
  Number((await database.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND ${where}`, [tenantId])).rows[0]?.n);

const skonto = (revision: string, skontoAmount: number) => ({
  commandType: 'skonto',
  sourceId: 'settlement-1',
  sourceRevision: revision,
  idempotencyKey: `settlement-1:${revision}`,
  reason: 'settlement test',
  input: { effectiveDate: '2026-03-15', postingDate: '2026-03-15', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown, skontoAmount, originalDocumentId: 'invoice-1' },
});

test('a closed period rejects a source fact without journal or run and a soft lock demands an override', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await database.query(
      `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ('period-closed',$1,'2026-03',2026,'closed','2026-03-01','2026-03-31',$2,$2)`,
      [tenantId, now],
    );
    await assert.rejects(() => repository.runClosingCommand(scope, sourceFact('closed')), /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal(await count(database, 'accounting_source_runs'), 0);
    assert.equal(await count(database, 'journal_entries', `source_type='standalone_source'`), 0);

    await database.query(`UPDATE accounting_periods SET status='soft_locked' WHERE id='period-closed'`);
    await assert.rejects(() => repository.runClosingCommand(scope, sourceFact('soft')), /SOFT_LOCK_OVERRIDE_REQUIRED/);
    assert.equal(await count(database, 'accounting_source_runs'), 0);
  });
});

test('a linked correction keeps its original-document provenance on refetch and a second correction cannot over-credit', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    const correction = (id: string, grossAmount: number) => ({
      id,
      idempotencyKey: `${id}:key`,
      correctionDate: '2026-03-15',
      original: {
        documentId: 'invoice-1',
        documentNumber: 'RE-1',
        revision: snapshot.sourceVersion,
        snapshotHash: sha256Hex(stableStringify(snapshot)),
        taxEffectiveDate: '2026-03-15',
        taxBreakdown,
      },
      deltas: [{ rate: 19, grossAmount }],
      reason: 'correction linkage',
    });

    const posted = await repository.createCorrectionSettlement(scope, correction('correction-1', 11.9));
    const refetched = await repository.getAccountingSourceRun(scope, posted.run.id);
    assert.equal(refetched?.status, 'posted');
    assert.equal((refetched?.source as { original: { documentId: string } }).original.documentId, 'invoice-1');
    assert.equal((refetched?.result as { originalDocumentId: string }).originalDocumentId, 'invoice-1');

    await assert.rejects(
      () => repository.createCorrectionSettlement(scope, correction('correction-2', 107.11)),
      (error: unknown) => error instanceof CorrectionSettlementError && error.code === 'OVER_CREDIT',
    );
    assert.equal(await count(database, 'accounting_source_runs', `source_type='correction'`), 1);
  });
});

test('settlement reads accept legacy underscore document source keys and persist the native settlement identity', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    const result = await repository.runClosingCommand(scope, skonto('legacy-key', 11.9));
    assert.equal(result.replayed, false);
    const entry = (await database.query<{ source_key: string }>(`SELECT source_key FROM journal_entries WHERE tenant_id=$1 AND id=$2`, [tenantId, result.run.journalEntryId])).rows[0];
    assert.equal(entry?.source_key, `settlement:${journalSourceIdentity(tenantId, 'settlement:skonto', 'settlement-1', 'legacy-key')}`);
    const item = (await database.query<{ allocated_amount: string; residual_amount: string; status: string }>(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE id='open-item-1'`)).rows[0];
    assert.deepEqual([Number(item?.allocated_amount), Number(item?.residual_amount), item?.status], [11.9, 107.1, 'partially_paid']);
  }, { legacySourceKey: true });
});

test('an advance settlement across debtors is rejected before any journal or open-item change', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await assert.rejects(
      () => repository.runClosingCommand(scope, {
        commandType: 'advance_settlement',
        sourceId: 'advance-1',
        sourceRevision: 'party-mismatch',
        idempotencyKey: 'advance-1:party-mismatch',
        reason: 'party mismatch',
        input: {
          effectiveDate: '2026-03-15', postingDate: '2026-03-15', period: '2026-03', fiscalYear: 2026, currency: 'EUR',
          finalInvoiceId: 'invoice-1',
          finalInvoice: { id: 'invoice-1', grossAmount: 119, taxBreakdown },
          advances: [{ id: 'invoice-2', kind: 'advance', grossAmount: 10 }],
          advanceClearingReceivable: '1200',
          advanceClearingPayable: '1600',
        },
      }),
      /SETTLEMENT_PARTY_MISMATCH/,
    );
    assert.equal(await count(database, 'accounting_source_runs'), 0);
    assert.equal(await count(database, 'open_items', `allocated_amount > 0`), 0);
  });
});

test('an audit failure rolls back the source journal and run when the repository gets the database wrapper', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProAccountingRepository(database);
    await database.query(`CREATE FUNCTION fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql`);
    await database.query(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()`);

    await assert.rejects(() => repository.runClosingCommand(scope, sourceFact('audit')), /audit_log/);
    assert.equal(await count(database, 'accounting_source_runs'), 0);
    assert.equal(await count(database, 'journal_entries', `source_type='standalone_source'`), 0);
    assert.equal(await count(database, 'journal_lines', `entry_id NOT LIKE 'invoice-journal-%'`), 0);
  });
});
