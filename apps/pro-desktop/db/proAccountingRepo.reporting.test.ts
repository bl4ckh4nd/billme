import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import type { HgbBilanzReport, ReportResult } from '@billme/accounting-shared';
import { bootstrapSql } from './bootstrap';
import {
  fiscalYearForPostingDate,
  getGuvReport,
  getReportingReport,
  getReportMappingHealth,
  getReportSnapshot,
  listReportSnapshots,
  saveReportSnapshot,
  upsertReportMappingOverride,
} from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  return db;
};

const insertPostedEntry = (db: Database.Database): void => {
  db.prepare(`INSERT INTO journal_entries
    (id, tenant_id, entry_number, posting_date, document_date, booking_text, period, fiscal_year, status, created_at)
    VALUES ('entry-1', 'default', 1, '2026-03-01', '2026-03-01', 'Test', '2026-03', 2026, 'posted', '2026-03-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO journal_lines
    (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount)
    VALUES ('line-1', 'default', 'entry-1', 1, '9999', 10, 0),
           ('line-2', 'default', 'entry-1', 2, '1200', 0, 10)`).run();
};

const insertGmbhSettings = (db: Database.Database, chart: 'SKR03' | 'SKR04' = 'SKR03'): void => {
  const settings = structuredClone(MOCK_SETTINGS);
  settings.businessReportingProfile = {
    jurisdiction: 'DE',
    legalForm: 'gmbh',
    profitDetermination: 'double_entry',
    hgbSizeClass: 'small',
    fiscalYearStart: '01-01',
    chart,
    vatMethod: 'soll',
  };
  db.prepare(`INSERT INTO settings (id, settings_json) VALUES (1, ?)`)
    .run(JSON.stringify(settings));
};

const insertEurSettings = (db: Database.Database, chart?: 'SKR03' | 'SKR04'): void => {
  const settings = structuredClone(MOCK_SETTINGS);
  settings.businessReportingProfile = {
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'eur',
    fiscalYearStart: '01-01',
    ...(chart ? { chart } : {}),
    vatMethod: 'soll',
  };
  db.prepare(`INSERT INTO settings (id, settings_json) VALUES (1, ?)`).run(JSON.stringify(settings));
};

describe('Pro reporting repository invariants', () => {
  it('fails closed when the authoritative reporting profile is missing', async () => {
    const db = createDb();
    await expect(getReportingReport(db, { kind: 'hgb-guv', from: '2026-03-01', to: '2026-03-31' }, createProTenantScope('default')))
      .rejects.toThrow('REPORTING_PROFILE_REQUIRED');
  });

  it('rejects a report when profile and accounting policy charts diverge', async () => {
    const db = createDb();
    insertGmbhSettings(db, 'SKR04');
    await expect(getReportingReport(db, { kind: 'hgb-guv' }, createProTenantScope('default')))
      .rejects.toThrow('REPORTING_CHART_MISMATCH');
  });

  it('allows ledger BWA and management reports for a valid sole-proprietor EÜR profile', async () => {
    const db = createDb();
    insertEurSettings(db);

    await expect(getReportingReport(db, { kind: 'management-guv' }, createProTenantScope('default'))).resolves.toMatchObject({ kind: 'management-guv' });
    await expect(getReportingReport(db, { kind: 'bwa01' }, createProTenantScope('default'))).resolves.toMatchObject({ kind: 'bwa01' });
  });

  it('splits desktop balance snapshots at FY start and derives current/prior HGB results', async () => {
    const db = createDb();
    insertGmbhSettings(db);
    db.exec(`
      INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, document_date, booking_text, period, fiscal_year, status, created_at)
      VALUES ('fy-2025', 'default', 1, '2025-12-31', '2025-12-31', 'Prior', '2025-12', 2025, 'posted', '2025-12-31T00:00:00.000Z'),
             ('fy-2026', 'default', 2, '2026-12-31', '2026-12-31', 'Current', '2026-12', 2026, 'posted', '2026-12-31T00:00:00.000Z');
      INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount)
      VALUES ('fy-2025-a', 'default', 'fy-2025', 1, '1000', 100, 0),
             ('fy-2025-r', 'default', 'fy-2025', 2, '8000', 0, 100),
             ('fy-2026-a', 'default', 'fy-2026', 1, '1000', 50, 0),
             ('fy-2026-r', 'default', 'fy-2026', 2, '8000', 0, 50);
      INSERT INTO account_mappings_hgb (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES ('fy-map-a', 'default', 'SKR03', '1000', 'hgb-bilanz', 'assets.current.cash', 'Kasse', 'asset', '2026-12-31T00:00:00.000Z'),
             ('fy-map-r', 'default', 'SKR03', '8000', 'hgb-guv', 'revenue', 'Umsatz', NULL, '2026-12-31T00:00:00.000Z');
    `);
    const report = await getReportingReport(
      db,
      { kind: 'hgb-bilanz', asOfDate: '2026-12-31' },
      createProTenantScope('default'),
    );
    const bilanz = report as ReportResult<HgbBilanzReport>;
    expect(bilanz).toMatchObject({ kind: 'hgb-bilanz', mappingHealth: { blocking: false } });
    expect(bilanz.liabilities.find((row) => row.position === 'equity.result')?.amount).toBe(50);
    expect(bilanz.liabilities.find((row) => row.position === 'equity.profit-loss-forward')?.amount).toBe(100);
    expect(bilanz.totals).toEqual({ assets: 150, liabilities: 150, delta: 0 });
  });

  it('keeps HGB reports GmbH-only for a sole-proprietor EÜR profile', async () => {
    const db = createDb();
    insertEurSettings(db);

    await expect(getReportingReport(db, { kind: 'hgb-guv' }, createProTenantScope('default')))
      .rejects.toThrow('REPORTING_PROFILE_REQUIRED');
    await expect(getReportingReport(db, { kind: 'hgb-bilanz' }, createProTenantScope('default')))
      .rejects.toThrow('REPORTING_PROFILE_REQUIRED');
  });

  it('keeps legacy generic mappings blocking until report-specific override', async () => {
    const db = createDb();
    insertGmbhSettings(db);
    insertPostedEntry(db);
    db.prepare(`INSERT INTO account_mappings_hgb
      (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES ('legacy-guv', 'default', 'SKR03', '9999', 'guv', 'revenue', 'Umsatz', NULL, '2026-03-01T00:00:00.000Z')`).run();

    const report = await getReportingReport(db, { kind: 'hgb-guv', from: '2026-03-01', to: '2026-03-31' }, createProTenantScope('default'));
    expect(report.mappingHealth.blocking).toBe(true);
    expect(report.mappingHealth.unmappedAccounts).toContain('9999');
  });

  it('does not create guessed report mappings while reading a report', () => {
    const db = createDb();
    insertPostedEntry(db);
    const scope = createProTenantScope('default');

    const report = getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope);

    expect(report.blocking).toBe(true);
    expect(report.unmappedAccounts).toEqual([{ accountNumber: '1200', amount: 10 }, { accountNumber: '9999', amount: -10 }]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM account_mappings_hgb WHERE tenant_id = 'default'`).get()).toEqual({ count: 0 });
  });

  it('scopes mapping health to the requested report family', () => {
    const db = createDb();
    insertPostedEntry(db);
    db.prepare(`INSERT INTO journal_lines
      (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount)
      VALUES ('line-3', 'default', 'entry-1', 3, '8400', 0, 10)`).run();
    db.prepare(`INSERT INTO account_mappings_hgb
      (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES ('balance-1200', 'default', 'SKR03', '1200', 'hgb-bilanz', 'assets.current.cash', 'Bank', 'asset', '2026-03-01T00:00:00.000Z'),
             ('guv-8400', 'default', 'SKR03', '8400', 'hgb-guv', 'revenue', 'Umsatz', NULL, '2026-03-01T00:00:00.000Z')`).run();

    expect(getReportMappingHealth(db, createProTenantScope('default'), { statement: 'hgb-guv' }).unmappedAccounts).toEqual(['9999']);
    expect(getReportMappingHealth(db, createProTenantScope('default'), { statement: 'hgb-bilanz' }).unmappedAccounts).toEqual(['9999']);
    expect(getReportMappingHealth(db, createProTenantScope('default'), { statement: 'management-guv' }).unmappedAccounts).toEqual(['8400', '9999']);
  });

  it('resolves double-entry fiscal years from the canonical settings profile at the boundary', () => {
    const db = createDb();
    const settings = structuredClone(MOCK_SETTINGS);
    settings.businessReportingProfile = {
      jurisdiction: 'DE',
      legalForm: 'gmbh',
      profitDetermination: 'double_entry',
      hgbSizeClass: 'small',
      fiscalYearStart: '04-15',
      chart: 'SKR03',
      vatMethod: 'soll',
    };
    db.prepare(`INSERT INTO settings (id, settings_json) VALUES (1, ?)`)
      .run(JSON.stringify(settings));

    expect(fiscalYearForPostingDate(db, '2026-04-14')).toBe(2025);
    expect(fiscalYearForPostingDate(db, '2026-04-15')).toBe(2026);
  });

  it('freezes immutable snapshot payloads and scopes reads to the tenant', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const payload = { kind: 'bwa01', rows: [{ position: 'revenue', amount: 12 }] };
    const saved = saveReportSnapshot(db, {
      reportType: 'bwa01',
      args: { from: '2026-01-01', to: '2026-03-31' },
      payload,
      reason: 'Report review',
      id: 'snapshot-1',
    }, scope);
    payload.rows[0]!.amount = 99;

    expect(getReportSnapshot(db, saved.id, scope)?.payload).toEqual({
      kind: 'bwa01', rows: [{ position: 'revenue', amount: 12 }],
    });
    expect(saved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(getReportSnapshot(db, saved.id, scope)?.sourceHash).toBe(saved.sourceHash);
    expect(listReportSnapshots(db, createProTenantScope('other-tenant'), 'bwa01')).toEqual([]);
    expect(() => saveReportSnapshot(db, {
      reportType: 'bwa01', args: {}, payload: {}, reason: 'Duplicate', id: saved.id,
    }, scope)).toThrow();
  });

  it('requires report-specific mapping catalog keys for overrides', () => {
    const db = createDb();
    expect(() => upsertReportMappingOverride(db, {
      chart: 'SKR03', accountNumber: '8400', statement: 'guv', position: 'revenue',
    }, createProTenantScope('default'))).toThrow('REPORT_MAPPING_STATEMENT_REQUIRED');
    expect(() => upsertReportMappingOverride(db, {
      chart: 'SKR03', accountNumber: '8400', statement: 'bwa01', position: 'revenue',
    }, createProTenantScope('default'))).toThrow('REPORT_MAPPING_REASON_REQUIRED');
    expect(() => upsertReportMappingOverride(db, {
      chart: 'SKR03', accountNumber: '8400', statement: 'bwa01', position: 'arbitrary', reason: 'Kontenabstimmung',
    }, createProTenantScope('default'))).toThrow('REPORT_MAPPING_POSITION_NOT_ALLOWED');
    expect(upsertReportMappingOverride(db, {
      chart: 'SKR03', accountNumber: '8400', statement: 'bwa01', position: 'revenue', reason: 'Kontenabstimmung',
    }, createProTenantScope('default'))).toMatchObject({ statement: 'bwa01', position: 'revenue' });
    expect(db.prepare(`SELECT reason FROM audit_log WHERE entity_type = 'report_mapping' AND action = 'override'`).get()).toMatchObject({ reason: 'Kontenabstimmung' });
  });
});
