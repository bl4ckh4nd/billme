import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BookingDraftEntity } from '@billme/accounting-shared';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

/**
 * Pro posting against PGlite.
 *
 * How this can fail:
 * - a draft posts into a closed month, or into a soft-locked month without an override and a reason
 * - an entry whose debit and credit totals differ (or that has fewer than two lines) is committed by
 *   a path that bypasses the repository check, because the database itself does not enforce Soll = Haben
 * - lines are appended to an entry that an earlier transaction already posted
 * - an empty or missing chart of accounts lets any account number through (fail-open)
 * - a repeated post creates a second journal entry, or fractions of a cent slip through as floats
 * - a reversal leaves a VAT cent behind or reverses asset/payment journals generically
 */

const stamp = '2026-03-01T09:00:00.000Z';
const scope = createSingleTenantScope('tenant-a', 'pro');

type Fixture = { database: PgliteServerDatabase; repository: ReturnType<typeof createPostgresProAccountingRepository> };

async function withFixture<T>(work: (fixture: Fixture) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-posting-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('tenant-a','tenant-a','Tenant A','pro',$1,$1)`, [stamp]);
    await database.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ('tenant-a','SKR03','soll','calendar_month',$1)`, [stamp]);
    await database.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ('bank-1','tenant-a','Bank','DE00',0,'1200','bank','#000')`);
    await database.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ('t-1200','SKR03','1200','Bank','test',$1,$1),('t-6000','SKR03','6000','Aufwand','test',$1,$1),('t-6100','SKR03','6100','Aufwand 2','test',$1,$1) ON CONFLICT (chart,account_number) DO NOTHING`, [stamp]);
    await database.query(`INSERT INTO tax_case_account_mappings (id,chart,tax_case_key,role,account_number,datev_bu_key,updated_at) VALUES ('m-std19-bu','SKR03','DE_STD_19','datev_bu','1576','1',$1)`, [stamp]);
    return await work({ database, repository: createPostgresProAccountingRepository(database) });
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const count = async (database: PgliteServerDatabase, table: string): Promise<number> =>
  Number((await database.query<{ c: string }>(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0]?.c);

async function approvedDraft(
  { database, repository }: Fixture,
  id: string,
  date = '2026-03-01',
  overrides: { debit?: number; credit?: number; account?: string; workflowStatus?: BookingDraftEntity['workflowStatus'] } = {},
): Promise<BookingDraftEntity> {
  await database.query(
    `INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,source_transaction_id,created_at,updated_at) VALUES ($1,'tenant-a','bank-1',$2,-119,'expense','Lieferant GmbH','Eingangsrechnung','pending',$1,$3,$3)`,
    [id, date, stamp],
  );
  const draft = (await repository.getDraftByTransactionId(scope, id))!;
  const debit = overrides.debit ?? 119;
  const credit = overrides.credit ?? debit;
  return repository.saveDraft(scope, {
    ...draft,
    postingDate: date,
    documentDate: date,
    period: date.slice(0, 7),
    fiscalYear: Number(date.slice(0, 4)),
    workflowStatus: overrides.workflowStatus ?? 'approved',
    lines: [
      { ...draft.lines[0]!, id: `${id}-debit`, accountNumber: overrides.account ?? '6000', debitAmount: debit, creditAmount: 0, taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
      { ...draft.lines[1]!, id: `${id}-credit`, accountNumber: '1200', debitAmount: 0, creditAmount: credit, taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ],
  });
}

test('geschlossene Periode blockiert Validierung und Buchung', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    await database.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ('p-2026-02','tenant-a','2026-02',2026,'closed','2026-02-01','2026-02-28',$1,$1)`, [stamp]);
    const saved = await approvedDraft(fixture, 'tx-closed', '2026-02-15');
    assert.ok(saved.validationIssues.some((item) => item.code === 'POSTING_DATE_IN_CLOSED_PERIOD' && item.blocking));
    assert.equal(saved.workflowStatus, 'period_locked');

    await database.query(`UPDATE booking_drafts SET workflow_status='approved' WHERE id=$1`, [saved.id]);
    const result = await repository.postDraft(scope, saved.id, { postingDate: '2026-02-15' });
    assert.ok(result.issues.some((item) => item.code === 'POSTING_DATE_IN_CLOSED_PERIOD'));
    assert.equal(await count(database, 'journal_entries'), 0);
  });
});

test('gebuchte Journale und Zeilen sind per Trigger unveränderlich', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const draft = await approvedDraft(fixture, 'tx-immutable');
    const { entry, issues } = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    assert.deepEqual(issues, []);

    await assert.rejects(() => database.query(`UPDATE journal_entries SET booking_text='manipuliert' WHERE id=$1`, [entry.id]), /journal entries are immutable/);
    await assert.rejects(() => database.query(`DELETE FROM journal_entries WHERE id=$1`, [entry.id]), /journal entries are immutable/);
    await assert.rejects(() => database.query(`UPDATE journal_lines SET debit_amount=debit_amount+1 WHERE entry_id=$1`, [entry.id]), /journal lines are immutable/);
    await assert.rejects(() => database.query(`DELETE FROM journal_lines WHERE entry_id=$1`, [entry.id]), /journal lines are immutable/);
    assert.equal((await database.query<{ booking_text: string }>(`SELECT booking_text FROM journal_entries WHERE id=$1`, [entry.id])).rows[0]?.booking_text, entry.bookingText);
  });
});

test('die Datenbank erzwingt Soll = Haben je Buchung und nimmt keine Zeilen in gebuchte Einträge an', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const draft = await approvedDraft(fixture, 'tx-guard');
    const { entry } = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    const insertEntry = (session: { query: (text: string, values?: unknown[]) => Promise<unknown> }, id: string, number: number) => session.query(`INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,'tenant-a',$2,'2026-03-02','2026-03-02','Direkt','2026-03',2026,'posted','standalone_source',$1,$3)`, [id, number, stamp]);
    const insertLine = (session: { query: (text: string, values?: unknown[]) => Promise<unknown> }, entryId: string, no: number, account: string, debit: number, credit: number) => session.query(`INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount) VALUES ($1,'tenant-a',$2,$3,$4,$5,$6)`, [`${entryId}-${no}-${account}-${debit}`, entryId, no, account, debit, credit]);
    const before = await count(database, 'journal_lines');

    await assert.rejects(() => database.transaction({}, async (tx) => {
      await insertLine(tx, entry.id, 3, '6000', 5, 0);
      await insertLine(tx, entry.id, 4, '1200', 0, 5);
    }), /JOURNAL_ENTRY_ALREADY_POSTED/, 'even a balanced pair cannot be added to a posted entry');
    await assert.rejects(() => database.transaction({}, async (tx) => {
      await insertEntry(tx, 'e-unbalanced', 900);
      await insertLine(tx, 'e-unbalanced', 1, '6000', 10, 0);
      await insertLine(tx, 'e-unbalanced', 2, '1200', 0, 9.99);
    }), /UNBALANCED_ENTRY/, 'debit and credit differ by a cent');
    await assert.rejects(() => database.transaction({}, async (tx) => { await insertEntry(tx, 'e-empty', 901); }), /UNBALANCED_ENTRY/, 'an entry without lines');
    await assert.rejects(() => database.transaction({}, async (tx) => {
      await insertEntry(tx, 'e-zero', 902);
      await insertLine(tx, 'e-zero', 1, '6000', 0, 0);
      await insertLine(tx, 'e-zero', 2, '1200', 0, 0);
    }), /UNBALANCED_ENTRY/, 'a zero entry');
    assert.equal(await count(database, 'journal_lines'), before, 'nothing of the refused transactions was kept');

    await database.transaction({}, async (tx) => {
      await insertEntry(tx, 'e-balanced', 903);
      await insertLine(tx, 'e-balanced', 1, '6000', 10, 0);
      await insertLine(tx, 'e-balanced', 2, '1200', 0, 10);
    });
    assert.equal(await count(database, 'journal_lines'), before + 2, 'a balanced entry written in one transaction is accepted');
  });
});

test('ohne Kontenkatalog wird kein Konto akzeptiert (fail-closed)', async () => {
  await withFixture(async (fixture) => {
    const { database } = fixture;
    await database.query(`DELETE FROM ledger_accounts WHERE chart='SKR03'`);
    const saved = await approvedDraft(fixture, 'tx-no-catalog');
    assert.ok(saved.validationIssues.some((item) => item.code === 'UNKNOWN_ACCOUNT' && item.blocking), JSON.stringify(saved.validationIssues));
  });
});

test('listJournalEntries filtert nach Konto vor der Paginierung', async () => {
  await withFixture(async (fixture) => {
    const { repository } = fixture;
    const older = await approvedDraft(fixture, 'tx-filter-old', '2026-03-02', { account: '6100' });
    const newer = await approvedDraft(fixture, 'tx-filter-new', '2026-03-05');
    const olderEntry = (await repository.postDraft(scope, older.id, { postingDate: '2026-03-02' })).entry;
    await repository.postDraft(scope, newer.id, { postingDate: '2026-03-05' });

    const filtered = await repository.listJournalEntries(scope, { accountNumbers: ['6100'], limit: 1 });
    assert.deepEqual(filtered.map((entry) => entry.id), [olderEntry.id]);
    assert.deepEqual(await repository.listJournalEntries(scope, { accountNumbers: ['does-not-exist'] }), []);
    assert.equal((await repository.listJournalEntries(scope, { limit: 1 }))[0]?.id === olderEntry.id, false);
  });
});

test('wiederholtes Buchen erzeugt genau ein Journal', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const draft = await approvedDraft(fixture, 'tx-idempotent');
    const first = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    const second = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    assert.ok(first.entry.id);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(await count(database, 'journal_entries'), 1);
    assert.equal(await count(database, 'journal_lines'), 2);
  });
});

test('Centbeträge mit Dezimalstellen erzeugen keine Gleitkomma-Fehlalarme, Bruchcents schon', async () => {
  await withFixture(async (fixture) => {
    for (const amount of [0.07, 1.1, 19.99]) {
      const saved = await approvedDraft(fixture, `tx-decimal-${amount}`, '2026-03-01', { debit: amount });
      const codes = saved.validationIssues.map((item) => item.code);
      assert.ok(!codes.includes('INVALID_LINE_AMOUNT'), `${amount}: ${codes}`);
      assert.ok(!codes.includes('UNBALANCED_ENTRY'), `${amount}: ${codes}`);
    }
    const fractional = await approvedDraft(fixture, 'tx-decimal-fractional', '2026-03-01', { debit: 0.001, credit: 0.001 });
    assert.ok(fractional.validationIssues.some((item) => item.code === 'INVALID_LINE_AMOUNT'));
  });
});

test('Buchen verlangt persistierte Freigabe und setzt den Status atomar auf posted', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const imported = await approvedDraft(fixture, 'tx-approval', '2026-03-01', { workflowStatus: 'imported' });
    const blocked = await repository.postDraft(scope, imported.id, { postingDate: '2026-03-01' });
    assert.ok(blocked.issues.some((item) => item.code === 'DRAFT_NOT_APPROVED'));
    assert.equal(await count(database, 'journal_entries'), 0);
    assert.equal((await database.query<{ status: string }>(`SELECT status FROM bank_transactions WHERE id='tx-approval'`)).rows[0]?.status, 'pending');

    await database.query(`UPDATE booking_drafts SET workflow_status='approved' WHERE id=$1`, [imported.id]);
    const posted = await repository.postDraft(scope, imported.id, { postingDate: '2026-03-01' });
    assert.ok(posted.entry.id);
    const persisted = (await database.query<{ workflow_status: string; draft_json: string }>(`SELECT workflow_status,draft_json FROM booking_drafts WHERE id=$1`, [imported.id])).rows[0]!;
    assert.equal(persisted.workflow_status, 'posted');
    assert.equal(JSON.parse(persisted.draft_json).workflowStatus, 'posted');
    assert.equal((await database.query<{ status: string }>(`SELECT status FROM bank_transactions WHERE id='tx-approval'`)).rows[0]?.status, 'booked');
  });
});

test('vorläufig gesperrte Periode verlangt Override mit Begründung', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    await database.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ('p-2026-03','tenant-a','2026-03',2026,'soft_locked','2026-03-01','2026-03-31',$1,$1)`, [stamp]);
    const draft = await approvedDraft(fixture, 'tx-soft-lock');
    const blocked = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    assert.ok(blocked.issues.some((item) => item.code === 'SOFT_LOCK_OVERRIDE_REQUIRED'));
    const blankReason = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01', softLockOverride: true, overrideReason: '  ' });
    assert.ok(blankReason.issues.some((item) => item.code === 'SOFT_LOCK_OVERRIDE_REQUIRED'));
    assert.equal(await count(database, 'journal_entries'), 0);

    const allowed = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01', softLockOverride: true, overrideReason: 'Korrektur nach Belegprüfung' });
    assert.ok(allowed.entry.id);
    assert.equal(await count(database, 'journal_entries'), 1);
  });
});

test('ungültige Zeilen und unbekannte Konten werden beim Speichern und Buchen abgewiesen', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const draft = await approvedDraft(fixture, 'tx-invalid-lines');
    const invalid = await repository.saveDraft(scope, {
      ...draft,
      workflowStatus: 'approved',
      lines: [
        { ...draft.lines[0]!, accountNumber: '9999', debitAmount: 1, creditAmount: 1 },
        { ...draft.lines[1]!, debitAmount: 0, creditAmount: 0 },
      ],
    });
    const codes = invalid.validationIssues.map((item) => item.code);
    assert.ok(codes.includes('UNKNOWN_ACCOUNT'));
    assert.ok(codes.includes('INVALID_LINE_AMOUNT'));

    await database.query(`UPDATE booking_drafts SET workflow_status='approved' WHERE id=$1`, [draft.id]);
    const result = await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' });
    assert.ok(result.issues.some((item) => item.code === 'UNKNOWN_ACCOUNT'));
    assert.equal(await count(database, 'journal_entries'), 0);
  });
});

test('Storno bucht zum gewünschten Datum, neutralisiert jeden USt-Cent und speichert Buchungspaare', async () => {
  await withFixture(async (fixture) => {
    const { database, repository } = fixture;
    const draft = await approvedDraft(fixture, 'tx-reversal');
    const posted = (await repository.postDraft(scope, draft.id, { postingDate: '2026-03-01' })).entry;
    const reversal = await repository.reverseJournalEntry(scope, posted.id, 'Beleg storniert', { postingDate: '2026-04-15' });

    const original = (await repository.getJournalEntryById(scope, posted.id))!;
    const reversed = (await repository.getJournalEntryById(scope, reversal.reversalEntryId))!;
    assert.equal(original.status, 'reversed');
    assert.equal(original.reversedEntryId, reversal.reversalEntryId);
    assert.equal(reversed.postingDate, '2026-04-15');
    assert.equal(reversed.period, '2026-04');
    assert.equal(reversed.fiscalYear, 2026);
    assert.equal(reversed.sourceType, 'reversal');
    await assert.rejects(() => repository.reverseJournalEntry(scope, reversal.reversalEntryId, 'Storno des Stornos', { postingDate: '2026-04-16' }), /cannot be reversed/i);
    await assert.rejects(() => repository.reverseJournalEntry(scope, posted.id, '   ', { postingDate: '2026-04-16' }), /Reversal reason is required/);

    const balances = (await database.query<{ net: string }>(`SELECT ROUND(SUM(debit_amount-credit_amount),2) AS net FROM journal_lines GROUP BY account_number`)).rows;
    assert.equal(balances.length, 2);
    assert.ok(balances.every((row) => Number(row.net) === 0));
    const vat = (await repository.getVatSummary(scope, {})).rows;
    assert.equal(vat.length, 1);
    assert.equal(vat[0]?.taxCaseKey, 'DE_STD_19');
    assert.equal(vat[0]?.lineCount, 4);
    assert.deepEqual([vat[0]?.netAmount, vat[0]?.taxAmount, vat[0]?.grossAmount], [0, 0, 0]);

    const pairs = (await database.query<{ debit_line_id: string; credit_line_id: string; tax_case_key: string | null; datev_bu_key: string | null }>(
      `SELECT debit_line_id,credit_line_id,tax_case_key,datev_bu_key FROM journal_posting_pairs WHERE entry_id=$1`, [reversal.reversalEntryId])).rows;
    const originalPairs = (await database.query<{ tax_case_key: string | null; datev_bu_key: string | null }>(
      `SELECT tax_case_key,datev_bu_key FROM journal_posting_pairs WHERE entry_id=$1`, [posted.id])).rows;
    const reversalLineIds = new Set(reversed.lines.map((line) => line.id));
    assert.ok(pairs.length > 0);
    assert.ok(originalPairs.some((pair) => pair.tax_case_key === 'DE_STD_19' && pair.datev_bu_key === '1'));
    assert.ok(pairs.every((pair) => reversalLineIds.has(pair.debit_line_id) && reversalLineIds.has(pair.credit_line_id)));
    assert.ok(pairs.some((pair) => pair.tax_case_key === 'DE_STD_19' && pair.datev_bu_key === '1'));
    assert.deepEqual(pairs.map((pair) => [pair.tax_case_key, pair.datev_bu_key]), originalPairs.map((pair) => [pair.tax_case_key, pair.datev_bu_key]));
  });
});

test('generisches Storno von Anlagen- und Zahlungsjournalen wird abgewiesen', async () => {
  await withFixture(async ({ database, repository }) => {
    const cases: Array<[string, string, RegExp]> = [
      ['asset-owned', 'asset_activation', /ASSET_REVERSAL_REQUIRED/],
      ['payment-owned', 'payment', /PAYMENT_REVERSAL_REQUIRED/],
      ['payment-vat-owned', 'payment_vat', /PAYMENT_REVERSAL_REQUIRED/],
    ];
    for (const [index, [id, sourceType]] of cases.entries()) await database.transaction({}, async (tx) => {
      await tx.query(
        `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,'tenant-a',$2,'2026-03-01','2026-03-01','Quelle','2026-03',2026,'posted',$3,$4,$5)`,
        [id, index + 1, sourceType, `${sourceType}:${id}`, stamp],
      );
      await tx.query(
        `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount) VALUES ($1,'tenant-a',$2,1,'1200',10,0),($3,'tenant-a',$2,2,'6000',0,10)`,
        [`${id}-l1`, id, `${id}-l2`],
      );
    });
    for (const [id, , pattern] of cases) {
      await assert.rejects(() => repository.reverseJournalEntry(scope, id, 'generisches Storno'), pattern);
    }
    assert.equal(await count(database, 'journal_entries'), 3);
  });
});

test('Bankseite des Entwurfs kommt aus dem SKR-Konto des Finanzkontos', async () => {
  await withFixture(async ({ database, repository }) => {
    await database.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ('card-1','tenant-a','Amex','DE03500105170000004021',0,'1820','credit','#000'),('cash-1','tenant-a','Ohne SKR','DE01',0,NULL,'bank','#000')`);
    await database.query(
      `INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,created_at,updated_at) VALUES ('tx-card','tenant-a','card-1','2026-03-02',-65.44,'expense','Adobe','Creative Cloud','pending',$1,$1),('tx-card-in','tenant-a','card-1','2026-03-03',42.1,'income','Amex','Gutschrift','pending',$1,$1),('tx-noskr','tenant-a','cash-1','2026-03-04',-10,'expense','Kiosk','Zeitung','pending',$1,$1)`,
      [stamp],
    );
    const expense = (await repository.getDraftByTransactionId(scope, 'tx-card'))!;
    assert.equal(expense.lines[1]!.accountNumber, '1820');
    assert.equal(expense.lines[1]!.creditAmount, 65.44);
    const income = (await repository.getDraftByTransactionId(scope, 'tx-card-in'))!;
    assert.equal(income.lines[0]!.accountNumber, '1820');
    // Without an SKR number on the account the chart's bank role stays the fallback.
    const fallback = (await repository.getDraftByTransactionId(scope, 'tx-noskr'))!;
    assert.equal(fallback.lines[1]!.accountNumber, '1200');
  });
});
