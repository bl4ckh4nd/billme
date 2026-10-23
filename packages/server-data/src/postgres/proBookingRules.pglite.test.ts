import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingCatalogRepository } from './proAccounting.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

// Ways this can go wrong:
// - a legacy one-field rule stops matching, or its reason text changes
// - tax lines that do not balance to the cent, or the non-deductible share landing on Vorsteuer
// - an override that ignores `stop`, or a stopped rule still applied
// - regex, amount range, sign or financial-account conditions ignored; OR treated as AND
// - "Auf Bestand anwenden" rewriting a hand-edited or approved draft, or touching a posted entry
// - applying a stale preview after the data changed underneath it
// - auto-post firing with only one of the two switches on, or in a closed period
// - counterparty memory learning from Vorsteuer, bank or Geldtransit lines

const stamp = '2026-10-01T09:00:00.000Z';
const scope = createSingleTenantScope('tenant-a', 'pro');
const mutation = { reason: 'Test' };

type Repo = ReturnType<typeof createPostgresProAccountingRepository>;
type Catalog = ReturnType<typeof createPostgresProAccountingCatalogRepository>;
type Fixture = { database: PgliteServerDatabase; repository: Repo; catalog: Catalog };

async function withFixture<T>(work: (fixture: Fixture) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-rules-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('tenant-a','tenant-a','Tenant A','pro',$1,$1)`, [stamp]);
    await database.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ('tenant-a','SKR04','soll','calendar_month',$1)`, [stamp]);
    await database.query(
      `INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES
        ('giro','tenant-a','Girokonto','DE89370400440532013000',0,'1800','bank','#000'),
        ('amex','tenant-a','Amex Business','DE21500105170000004021',0,'1820','credit','#000')`,
    );
    return await work({ database, repository: createPostgresProAccountingRepository(database), catalog: createPostgresProAccountingCatalogRepository(database) });
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const bankLine = (database: PgliteServerDatabase, id: string, account: string, date: string, amount: number, counterparty: string, purpose = '') =>
  database.query(
    `INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,created_at,updated_at) VALUES ($1,'tenant-a',$2,$3,$4,$5,$6,$7,'pending',$8,$8)`,
    [id, account, date, amount, amount < 0 ? 'expense' : 'income', counterparty, purpose, stamp],
  );

const lines = (draft: { lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }> }) =>
  draft.lines.map((line) => `${line.accountNumber}:${line.debitAmount > 0 ? 'S' : 'H'}${line.debitAmount || line.creditAmount}`);

const legacy = { field: 'any' as const, operator: 'contains' as const, value: '', targetAccountNumber: '' };

test('Basisregel mit Regex, Betrag, Vorzeichen und Finanzkonto erzeugt Steuerzeilen; Overrides stapeln bis stop', async () => {
  await withFixture(async ({ database, repository, catalog }) => {
    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 10, name: 'Telefon', stage: 'base', logic: 'and', flowType: 'expense',
      conditions: [{ field: 'counterparty', operator: 'regex', value: '^(telekom|vodafone)\\b' }, { field: 'account', operator: 'equals', value: 'giro' }],
      actions: { accountNumber: '6805', taxCaseKey: 'DE_STD_19', deductiblePercent: 50, memo: 'Telefon {Gegenpartei}' },
      mutation,
    });
    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 20, name: 'Große Beträge', stage: 'override', logic: 'or', flowType: 'any',
      conditions: [{ field: 'amount', operator: 'gte', value: '800' }, { field: 'purpose', operator: 'contains', value: 'Gerät' }],
      actions: { accountNumber: '0670' }, stop: true,
      mutation,
    });
    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 30, name: 'Nach stop', stage: 'override', flowType: 'any',
      conditions: [{ field: 'purpose', operator: 'contains', value: 'gerät' }], actions: { taxCaseKey: 'DE_STD_7' },
      mutation,
    });
    // Legacy one-field rules keep matching with the same reason text.
    await catalog.upsertAccountSuggestionRule(scope, { chart: 'SKR04', priority: 40, field: 'counterparty', operator: 'contains', value: 'Hetzner', targetAccountNumber: '6815', flowType: 'expense', mutation });

    await bankLine(database, 'tel', 'giro', '2026-10-03', -119, 'Telekom Deutschland', 'Rechnung 10/2026');
    await bankLine(database, 'tel-amex', 'amex', '2026-10-03', -119, 'Telekom Deutschland', 'Rechnung 10/2026');
    await bankLine(database, 'phone', 'giro', '2026-10-04', -1190, 'Vodafone GmbH', 'Gerät');
    await bankLine(database, 'hetzner', 'giro', '2026-10-05', -23.8, 'Hetzner Online GmbH', 'R0021938112');
    await bankLine(database, 'refund', 'giro', '2026-10-06', 119, 'Telekom Deutschland', 'Gutschrift');

    const tel = (await repository.getDraftByTransactionId(scope, 'tel'))!;
    // 119 gross at 19 %: net 100, tax 19; half the Vorsteuer is not deductible and stays on the expense.
    assert.deepEqual(lines(tel), ['6805:S109.5', '1406:S9.5', '1800:H119']);
    assert.equal(tel.lines[0]!.taxCaseKey, 'DE_STD_19');
    assert.equal(tel.bookingText, 'Telefon Telekom Deutschland');
    assert.equal(tel.workflowStatus, 'suggested');
    assert.deepEqual(tel.validationIssues.filter((issue) => issue.blocking), []);
    assert.deepEqual(tel.ruleTrace?.filter((entry) => entry.matched).map((entry) => [entry.name, entry.applied]), [
      ['Telefon', ['accountNumber', 'taxCaseKey', 'deductiblePercent', 'memo']],
    ]);

    // Same counterparty on the card account: the financial-account condition fails.
    assert.ok(!(await repository.getDraftByTransactionId(scope, 'tel-amex'))!.lines.some((line) => line.accountNumber === '6805'));

    const phone = (await repository.getDraftByTransactionId(scope, 'phone'))!;
    assert.deepEqual(lines(phone), ['0670:S1095', '1406:S95', '1800:H1190']);
    const phoneTrace = phone.ruleTrace!.filter((entry) => entry.matched);
    assert.deepEqual(phoneTrace.map((entry) => entry.name), ['Telefon', 'Große Beträge']);
    assert.ok(phone.ruleTrace!.some((entry) => entry.name === 'Nach stop' && entry.skipped === 'stopped'));

    const rows = new Map((await repository.listBankTransactions(scope)).map((row) => [row.id, row]));
    assert.equal(rows.get('hetzner')!.suggestedAccountNumber, '6815');
    assert.equal(rows.get('hetzner')!.suggestionReason, 'Regel: "Hetzner"');
    // Sign condition: the incoming Telekom credit is not an expense rule hit.
    assert.notEqual(rows.get('refund')!.suggestionLayer, 'rule');
  });
});

test('Auf Bestand anwenden: Probelauf mit Diff, Handänderungen und Freigaben geschützt, Gebuchtes nur als Hinweis', async () => {
  await withFixture(async ({ database, repository, catalog }) => {
    await bankLine(database, 'untouched', 'giro', '2026-10-03', -59.5, 'Adobe Systems', 'Creative Cloud');
    await bankLine(database, 'edited', 'giro', '2026-10-04', -59.5, 'Adobe Systems', 'Creative Cloud');
    await bankLine(database, 'approved', 'giro', '2026-10-05', -59.5, 'Adobe Systems', 'Creative Cloud');
    await bankLine(database, 'posted', 'giro', '2026-10-06', -59.5, 'Adobe Systems', 'Creative Cloud');
    for (const id of ['untouched', 'edited', 'approved', 'posted']) await repository.getDraftByTransactionId(scope, id);
    const edited = (await repository.getDraftByTransactionId(scope, 'edited'))!;
    await repository.saveDraft(scope, { ...edited, lines: edited.lines.map((line) => line.accountNumber === '1800' ? line : { ...line, accountNumber: '6815' }), mutation });
    const approve = async (transactionId: string) => {
      await repository.dispatchDraftAction(scope, { transactionId, action: 'submit_for_review', mutation } as never);
      return repository.dispatchDraftAction(scope, { transactionId, action: 'approve', mutation } as never);
    };
    await approve('approved');
    const toPost = await approve('posted');
    assert.deepEqual((await repository.postDraft(scope, toPost.id, { postingDate: '2026-10-06', mutation })).issues, []);

    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 1, name: 'Software', stage: 'base', flowType: 'expense',
      conditions: [{ field: 'counterparty', operator: 'contains', value: 'adobe' }], actions: { accountNumber: '6850', taxCaseKey: 'DE_STD_19' }, mutation,
    });
    await bankLine(database, 'fresh', 'giro', '2026-10-07', -59.5, 'Adobe Systems', 'Creative Cloud');

    const preview = await repository.previewRuleApplication(scope);
    const kinds = Object.fromEntries(preview.rows.map((row) => [row.transactionId, row.kind]));
    assert.deepEqual(kinds, { untouched: 'update', edited: 'protected', approved: 'protected', posted: 'posted', fresh: 'new' });
    const untouched = preview.rows.find((row) => row.transactionId === 'untouched')!;
    assert.equal(untouched.after.accountNumber, '6850');
    assert.equal(untouched.after.taxCaseKey, 'DE_STD_19');
    assert.deepEqual(untouched.after.ruleNames, ['Software']);

    // The data changed after the preview: applying it must fail instead of guessing.
    await bankLine(database, 'late', 'giro', '2026-10-08', -59.5, 'Adobe Systems', 'Creative Cloud');
    await assert.rejects(repository.applyRules(scope, { previewHash: preview.hash, mutation }), /RULE_PREVIEW_STALE/);

    const fresh = await repository.previewRuleApplication(scope);
    const result = await repository.applyRules(scope, { previewHash: fresh.hash, mutation });
    assert.equal(result.updated, 3, 'untouched, fresh and late');
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'untouched'))!), ['6850:S50', '1406:S9.5', '1800:H59.5']);
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'edited'))!), ['6815:S59.5', '1800:H59.5']);
    assert.equal((await repository.getDraftByTransactionId(scope, 'approved'))!.workflowStatus, 'approved');
    await assert.rejects(repository.applyRules(scope, { previewHash: fresh.hash, mutation: { reason: ' ' } }), /ACCOUNTING_AUDIT_REASON_REQUIRED/);
  });
});

test('Automatisch buchen nur mit globalem Schalter und Regel-Schalter; geschlossene Perioden bleiben offen', async () => {
  await withFixture(async ({ database, repository, catalog }) => {
    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 1, name: 'Hosting', stage: 'base', flowType: 'expense', autoPost: true,
      conditions: [{ field: 'counterparty', operator: 'contains', value: 'hetzner' }], actions: { accountNumber: '6815', taxCaseKey: 'DE_STD_19' }, mutation,
    });
    await catalog.upsertAccountSuggestionRule(scope, {
      ...legacy, chart: 'SKR04', priority: 2, name: 'Ohne Auto', stage: 'base', flowType: 'expense',
      conditions: [{ field: 'counterparty', operator: 'contains', value: 'strato' }], actions: { accountNumber: '6815' }, mutation,
    });
    await bankLine(database, 'h1', 'giro', '2026-10-05', -23.8, 'Hetzner Online GmbH');
    await bankLine(database, 's1', 'giro', '2026-10-05', -11.9, 'Strato AG');
    await bankLine(database, 'h-closed', 'giro', '2026-08-05', -23.8, 'Hetzner Online GmbH');
    await database.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ('p-2026-08','tenant-a','2026-08',2026,'closed','2026-08-01','2026-08-31',$1,$1) ON CONFLICT (tenant_id,period) DO UPDATE SET status='closed'`, [stamp]);

    assert.deepEqual(await repository.autoPostAfterImport(scope, mutation), { transfers: 0, rules: 0 }, 'global switch off');
    await repository.saveBookingSettings(scope, { autoPostRules: true, mutation });
    assert.deepEqual(await repository.autoPostAfterImport(scope, mutation), { transfers: 0, rules: 1 });
    const status = new Map((await repository.listBankTransactions(scope)).map((row) => [row.id, row.status]));
    assert.deepEqual([status.get('h1'), status.get('s1'), status.get('h-closed')], ['booked', 'pending', 'pending']);

    // Memory learns the expense account of the posted Hetzner booking, never 1406 or 1800.
    await bankLine(database, 'h2', 'giro', '2026-10-09', -5, 'Hetzner Online GmbH');
    await catalog.deleteAccountSuggestionRule(scope, (await catalog.listAccountSuggestionRules(scope)).find((rule) => rule.name === 'Hosting')!.id, mutation);
    const h2 = (await repository.listBankTransactions(scope)).find((row) => row.id === 'h2')!;
    assert.deepEqual([h2.suggestionLayer, h2.suggestedAccountNumber], ['counterparty', '6815']);
  });
});
