import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import { bootstrapSql } from './bootstrap';
import {
  fiscalYearForPostingDate,
  getGuvReport,
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

describe('Pro reporting repository invariants', () => {
  it('does not create guessed report mappings while reading a report', () => {
    const db = createDb();
    insertPostedEntry(db);
    const scope = createProTenantScope('default');

    const report = getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope);

    expect(report.blocking).toBe(true);
    expect(report.unmappedAccounts).toEqual([{ accountNumber: '1200', amount: 10 }, { accountNumber: '9999', amount: -10 }]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM account_mappings_hgb WHERE tenant_id = 'default'`).get()).toEqual({ count: 0 });
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
    expect(upsertReportMappingOverride(db, {
      chart: 'SKR03', accountNumber: '8400', statement: 'bwa01', position: 'revenue',
    }, createProTenantScope('default'))).toMatchObject({ statement: 'bwa01', position: 'revenue' });
  });
});
