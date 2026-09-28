import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingRepository, fiscalYearForPostingDate } from './proAccountingRepository.js';

const now = '2026-03-01T00:00:00.000Z';
const scope = createSingleTenantScope('tenant-a', 'pro');
const otherScope = createSingleTenantScope('tenant-b', 'pro');

type Line = { account: string; debit?: number; credit?: number };

const gmbhProfile = (chart: 'SKR03' | 'SKR04' = 'SKR03') => ({
  jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small',
  fiscalYearStart: '01-01', chart, vatMethod: 'soll',
});
const eurProfile = () => ({
  jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll',
});

async function seedTenant(database: PgliteServerDatabase, tenantId: string, profile: unknown, chart: 'SKR03' | 'SKR04' = 'SKR03') {
  await database.query(
    `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $1, $1, 'pro', $2, $2)`,
    [tenantId, now],
  );
  await database.query(
    `INSERT INTO accounting_policies (tenant_id, active_chart, vat_method, period_policy, updated_at) VALUES ($1, $2, 'soll', 'calendar_month', $3)`,
    [tenantId, chart, now],
  );
  if (profile !== undefined) {
    await database.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [tenantId, JSON.stringify({ businessReportingProfile: profile }), now],
    );
  }
}

async function insertEntry(database: PgliteServerDatabase, tenantId: string, id: string, date: string, lines: Line[], status = 'posted') {
  const entryNumber = Number((await database.query<{ n: number }>(
    `SELECT COALESCE(MAX(entry_number), 0) + 1 AS n FROM journal_entries WHERE tenant_id = $1`, [tenantId],
  )).rows[0]!.n);
  await database.query(
    `INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, document_date, booking_text, period, fiscal_year, status, created_at)
     VALUES ($1, $2, $3, $4, $4, $1, $5, $6, $7, $8)`,
    [id, tenantId, entryNumber, date, date.slice(0, 7), Number(date.slice(0, 4)), status, now],
  );
  for (const [index, line] of lines.entries()) {
    await database.query(
      `INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`${id}-${index}`, tenantId, id, index + 1, line.account, line.debit ?? 0, line.credit ?? 0],
    );
  }
}

async function insertMapping(
  database: PgliteServerDatabase, tenantId: string, id: string, chart: string, account: string,
  reportType: string, position: string, label: string, validFrom: string | null = null,
) {
  await database.query(
    `INSERT INTO report_account_mappings (id, tenant_id, report_type, chart, account_number, position_key, position_label, valid_from, version, source, source_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'test', 'hash', $9)`,
    [id, tenantId, reportType, chart, account, position, label, validFrom, now],
  );
}

async function withRepo<T>(work: (database: PgliteServerDatabase, repo: ReturnType<typeof createPostgresProAccountingRepository>) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-reporting-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    return await work(database, createPostgresProAccountingRepository(database));
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const count = async (database: PgliteServerDatabase, sql: string, values: unknown[] = []) =>
  Number((await database.query<{ c: number }>(sql, values)).rows[0]!.c);

test('missing reporting profile fails closed', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', undefined);
  await assert.rejects(() => repo.getReportingReport(scope, { kind: 'hgb-guv', from: '2026-03-01', to: '2026-03-31' }), /REPORTING_PROFILE_REQUIRED/);
}));

test('a profile that violates the schema is rejected as invalid', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', { legalForm: 'gmbh' });
  await assert.rejects(() => repo.getReportingReport(scope, { kind: 'hgb-guv' }), /REPORTING_PROFILE_INVALID/);
}));

test('report is rejected when profile chart and accounting policy chart diverge', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile('SKR04'), 'SKR03');
  await assert.rejects(() => repo.getReportingReport(scope, { kind: 'hgb-guv' }), /REPORT_CHART_MISMATCH/);
}));

test('HGB reports stay GmbH-only while ledger BWA and management reports work for an EUR profile', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', eurProfile());
  await assert.rejects(() => repo.getReportingReport(scope, { kind: 'hgb-guv' }), /REPORTING_PROFILE_REQUIRED/);
  await assert.rejects(() => repo.getReportingReport(scope, { kind: 'hgb-bilanz' }), /REPORTING_PROFILE_REQUIRED/);
  assert.equal((await repo.getReportingReport(scope, { kind: 'management-guv' })).kind, 'management-guv');
  assert.equal((await repo.getReportingReport(scope, { kind: 'bwa01' })).kind, 'bwa01');
}));

test('balance sheet splits at fiscal-year start into current result and carried-forward result', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'fy-2025', '2025-12-31', [{ account: '1000', debit: 100 }, { account: '8000', credit: 100 }]);
  await insertEntry(database, 'tenant-a', 'fy-2026', '2026-12-31', [{ account: '1000', debit: 50 }, { account: '8000', credit: 50 }]);
  await insertMapping(database, 'tenant-a', 'map-a', 'SKR03', '1000', 'hgb-bilanz', 'assets.current.cash', 'Kasse');
  await insertMapping(database, 'tenant-a', 'map-r', 'SKR03', '8000', 'hgb-guv', 'revenue', 'Umsatz');

  const bilanz: any = await repo.getReportingReport(scope, { kind: 'hgb-bilanz', asOfDate: '2026-12-31' });
  assert.equal(bilanz.mappingHealth.blocking, false);
  assert.equal(bilanz.liabilities.find((row: any) => row.position === 'equity.result')?.amount, 50);
  assert.equal(bilanz.liabilities.find((row: any) => row.position === 'equity.profit-loss-forward')?.amount, 100);
  assert.deepEqual(bilanz.totals, { assets: 150, liabilities: 150, delta: 0 });
}));

test('a generic legacy mapping does not satisfy the HGB GuV and the report blocks', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'e1', '2026-03-01', [{ account: '9999', debit: 10 }, { account: '1200', credit: 10 }]);
  await insertMapping(database, 'tenant-a', 'legacy', 'SKR03', '9999', 'guv', 'revenue', 'Umsatz');

  const report: any = await repo.getReportingReport(scope, { kind: 'hgb-guv', from: '2026-03-01', to: '2026-03-31' });
  assert.equal(report.mappingHealth.blocking, true);
  assert.ok(report.mappingHealth.unmappedAccounts.includes('9999'));
}));

test('reading a report never writes guessed mappings', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'e1', '2026-03-01', [{ account: '9999', debit: 10 }, { account: '1200', credit: 10 }]);

  const report: any = await repo.getGuvReport(scope, { profile: 'hgb-guv', from: '2026-03-01', to: '2026-03-31' });
  assert.equal(report.mappingHealth.blocking, true);
  assert.deepEqual([...report.mappingHealth.unmappedAccounts].sort(), ['1200', '9999']);
  assert.equal(await count(database, `SELECT COUNT(*)::int AS c FROM report_account_mappings WHERE tenant_id = 'tenant-a'`), 0);
}));

test('mapping health is scoped to the requested report family', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'e1', '2026-03-01', [
    { account: '9999', debit: 10 }, { account: '1200', credit: 20 }, { account: '8400', debit: 10 },
  ]);
  await insertMapping(database, 'tenant-a', 'bilanz-1200', 'SKR03', '1200', 'hgb-bilanz', 'assets.current.cash', 'Bank');
  await insertMapping(database, 'tenant-a', 'guv-8400', 'SKR03', '8400', 'hgb-guv', 'revenue', 'Umsatz');
  const unmapped = async (reportType: 'hgb-guv' | 'hgb-bilanz' | 'management-guv') =>
    (await repo.getAccountMappingHealth(scope, 'SKR03', reportType, '2025-12-31')).unmapped.map((row) => row.accountNumber);

  assert.deepEqual(await unmapped('hgb-guv'), ['9999']);
  assert.deepEqual(await unmapped('hgb-bilanz'), ['9999']);
  assert.deepEqual(await unmapped('management-guv'), ['8400', '9999']);
}));

test('mapping health exposes unknown accounts and never matches another chart or tenant', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await seedTenant(database, 'tenant-b', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'a1', '2026-03-21', [{ account: '9999', debit: 10 }, { account: '1200', credit: 10 }]);
  await insertEntry(database, 'tenant-b', 'b1', '2026-03-21', [{ account: '9998', debit: 2 }, { account: '1200', credit: 2 }]);
  await insertMapping(database, 'tenant-a', 'other-chart', 'SKR04', '9999', 'hgb-guv', 'revenue', 'Umsatz');
  await insertMapping(database, 'tenant-b', 'tenant-b-map', 'SKR03', '9998', 'hgb-guv', 'revenue', 'Umsatz');
  const unmapped = async (s: typeof scope) => (await repo.getAccountMappingHealth(s, 'SKR03', 'hgb-guv', '2025-12-31')).unmapped.map((row) => row.accountNumber);

  assert.deepEqual(await unmapped(scope), ['1200', '9999']);
  assert.deepEqual(await unmapped(otherScope), ['1200']);
}));

test('overrides apply from their effective date and a retry on the same date updates in place', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'y25', '2025-12-31', [{ account: '8400', credit: 100 }]);
  const override = (asOfDate: string, positionKey: string, reason: string) => repo.upsertAccountMappingOverride(scope, {
    chart: 'SKR03', asOfDate, accountNumber: '8400', statementType: 'hgb-guv', positionKey, positionLabel: positionKey, mutation: { reason },
  } as never);
  await override('2025-01-01', 'revenue', '2025 mapping');
  await override('2026-03-31', 'material.services', '2026 mapping');

  const validFrom = (await database.query<{ valid_from: string }>(
    `SELECT valid_from FROM report_account_mappings WHERE account_number = '8400' AND report_type = 'hgb-guv' ORDER BY valid_from`,
  )).rows.map((row) => row.valid_from);
  assert.deepEqual(validFrom, ['2025-01-01', '2026-03-31']);
  const position = (report: any, key: string) => report.rows.find((row: any) => row.position === key)?.amount;
  const prior: any = await repo.getReportingReport(scope, { kind: 'hgb-guv', from: '2025-01-01', to: '2025-12-31' });
  const current: any = await repo.getReportingReport(scope, { kind: 'hgb-guv', to: '2026-03-31' });
  assert.equal(position(prior, 'revenue'), 100);
  assert.equal(position(prior, 'material.services'), 0);
  assert.equal(position(current, 'material.services'), 100);
  assert.equal(position(current, 'revenue'), 0);

  await override('2026-03-31', 'revenue', '2026 retry');
  const retried = (await database.query<{ c: number; p: string }>(
    `SELECT COUNT(*)::int AS c, MAX(position_key) AS p FROM report_account_mappings WHERE account_number = '8400' AND report_type = 'hgb-guv' AND valid_from = '2026-03-31'`,
  )).rows[0]!;
  assert.deepEqual({ c: retried.c, p: retried.p }, { c: 1, p: 'revenue' });
}));

test('override validation rejects unknown catalog keys, empty fields and a foreign chart', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  const base = { chart: 'SKR03', asOfDate: '2025-12-31', accountNumber: '8400', statementType: 'bwa01', positionKey: 'revenue', positionLabel: 'Umsatz', mutation: { reason: 'Kontenabstimmung' } } as const;

  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, positionKey: 'arbitrary' } as never), /REPORT_POSITION_INVALID/);
  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, accountNumber: '  ' } as never), /REPORT_MAPPING_REQUIRED/);
  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, positionLabel: '' } as never), /REPORT_MAPPING_REQUIRED/);
  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, chart: 'SKR04' } as never), /REPORT_CHART_MISMATCH/);
  assert.equal(await count(database, `SELECT COUNT(*)::int AS c FROM report_account_mappings`), 0);

  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, asOfDate: '2026-02-30' } as never), /REPORT_MAPPING_DATE_INVALID/);
  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...base, asOfDate: '2027-01-01' } as never), /PUBLIC_REPORT_CATALOG_UNAVAILABLE:2027/);

  const saved: any = await repo.upsertAccountMappingOverride(scope, base as never);
  assert.equal(saved.reportType, 'bwa01');
  assert.equal(saved.positionKey, 'revenue');
  assert.equal(saved.source, 'tenant_override');
}));

test('override requires an audit reason and records it', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  const input = { chart: 'SKR03', asOfDate: '2025-12-31', accountNumber: '8400', statementType: 'bwa01', positionKey: 'revenue', positionLabel: 'Umsatz' } as const;

  await assert.rejects(() => repo.upsertAccountMappingOverride(scope, { ...input, mutation: { reason: '   ' } } as never), /ACCOUNTING_AUDIT_REASON_REQUIRED/);
  await repo.upsertAccountMappingOverride(scope, { ...input, mutation: { reason: 'Kontenabstimmung' } } as never);
  const audited = await database.query<{ reason: string }>(
    `SELECT reason FROM audit_log WHERE tenant_id = 'tenant-a' AND entity_type = 'report_account_mapping' AND action = 'override'`,
  );
  assert.deepEqual(audited.rows.map((row) => row.reason), ['Kontenabstimmung']);
}));

test('saved snapshots are frozen, hash-stable, deduplicated and tenant-scoped', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await seedTenant(database, 'tenant-b', gmbhProfile());
  const input = { reportType: 'bwa01', args: { from: '2026-01-01', to: '2026-03-31' }, payload: { kind: 'bwa01', rows: [{ position: 'revenue', amount: 12 }] }, mutation: { reason: 'Report review' } } as never;
  const saved = await repo.saveReportSnapshot(scope, input);
  const again = await repo.saveReportSnapshot(scope, input);
  const changed = await repo.saveReportSnapshot(scope, { ...(input as object), payload: { kind: 'bwa01', rows: [{ position: 'revenue', amount: 13 }] } } as never);

  assert.match(saved.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(again.id, saved.id);
  assert.equal(again.sourceHash, saved.sourceHash);
  assert.notEqual(changed.sourceHash, saved.sourceHash);
  assert.equal((await repo.getReportSnapshot(scope, saved.id)).sourceHash, saved.sourceHash);
  assert.equal(saved.positions[0]?.positionKey, 'revenue');
  assert.deepEqual((await repo.listReportSnapshots(scope, 'bwa01')).map((s) => s.id).sort(), [saved.id, changed.id].sort());
  assert.deepEqual(await repo.listReportSnapshots(otherScope, 'bwa01'), []);
  await assert.rejects(() => repo.getReportSnapshot(otherScope, saved.id), /REPORT_SNAPSHOT_NOT_FOUND/);
  await assert.rejects(() => database.query(`UPDATE report_snapshots SET payload_json = '{}' WHERE id = $1`, [saved.id]), /immutable/);
  await assert.rejects(() => database.query(`DELETE FROM report_snapshots WHERE id = $1`, [saved.id]), /immutable/);
}));

for (const [label, payload, reportType] of [
  ['blocking mapping health', { mappingHealth: { blocking: true } }, 'hgb-guv'],
  ['blocking flag', { blocking: true }, 'bwa01'],
  ['incomplete flag', { complete: false }, 'hgb-bilanz'],
  ['unmatched EUR cash entries', { unmatchedCashEntries: [{ id: 'x' }] }, 'eur'],
] as const) {
  test(`snapshot is blocked for ${label}`, () => withRepo(async (database, repo) => {
    await seedTenant(database, 'tenant-a', gmbhProfile());
    await assert.rejects(
      () => repo.saveReportSnapshot(scope, { reportType, args: {}, payload, mutation: { reason: 'Prüfung' } } as never),
      /REPORT_SNAPSHOT_BLOCKED_INCOMPLETE_MAPPING/,
    );
    assert.equal(await count(database, `SELECT COUNT(*)::int AS c FROM report_snapshots`), 0);
  }));
}

test('SuSa snapshot is exempt from the mapping block', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  const saved: any = await repo.saveReportSnapshot(scope, { reportType: 'susa', args: {}, payload: { blocking: true, rows: [] }, mutation: { reason: 'Prüfung' } } as never);
  assert.equal(saved.reportType, 'susa');
}));

test('ledger balances and SuSa are cent-exact over the golden journal', () => withRepo(async (database, repo) => {
  await seedTenant(database, 'tenant-a', gmbhProfile());
  await insertEntry(database, 'tenant-a', 'opening', '2026-01-15', [{ account: '1200', debit: 100 }, { account: '9000', credit: 100 }]);
  await insertEntry(database, 'tenant-a', 'invoice', '2026-03-01', [{ account: '1400', debit: 119 }, { account: '8400', credit: 100 }, { account: '1776', credit: 19 }], 'reversed');
  await insertEntry(database, 'tenant-a', 'payment', '2026-03-10', [{ account: '1200', debit: 119 }, { account: '1400', credit: 119 }]);
  await insertEntry(database, 'tenant-a', 'expense', '2026-03-15', [{ account: '4900', debit: 50 }, { account: '1576', debit: 9.5 }, { account: '1600', credit: 59.5 }]);
  await insertEntry(database, 'tenant-a', 'reversal', '2026-03-20', [{ account: '1400', credit: 119 }, { account: '8400', debit: 100 }, { account: '1776', debit: 19 }]);
  await insertEntry(database, 'tenant-a', 'draft-noise', '2026-03-25', [{ account: '4900', debit: 999 }, { account: '1200', credit: 999 }], 'draft');
  const range = { from: '2026-03-01', to: '2026-03-31' };

  const balances = await repo.getLedgerBalances(scope, range);
  const byAccount = (account: string) => balances.find((row) => row.accountNumber === account);
  assert.deepEqual(byAccount('1200'), { accountNumber: '1200', openingBalance: 100, debitTurnover: 119, creditTurnover: 0, closingBalance: 219 });
  assert.deepEqual(byAccount('8400'), { accountNumber: '8400', openingBalance: 0, debitTurnover: 100, creditTurnover: 100, closingBalance: 0 });
  assert.deepEqual(byAccount('1576'), { accountNumber: '1576', openingBalance: 0, debitTurnover: 9.5, creditTurnover: 0, closingBalance: 9.5 });
  assert.equal(byAccount('4900')?.debitTurnover, 50);
  assert.deepEqual((await repo.getSusaReport(scope, range)).totals, { debit: 416.5, credit: 416.5, balance: 0 });
}));

test('the journal fiscal year follows a mid-year fiscal-year start', () => {
  assert.equal(fiscalYearForPostingDate('2026-04-14', '04-15'), 2025);
  assert.equal(fiscalYearForPostingDate('2026-04-15', '04-15'), 2026);
});
