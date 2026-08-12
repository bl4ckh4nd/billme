import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteConnection } from '@billme/desktop-data/connection';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
  getDraftByTransactionId,
  insertDatevExport,
  listJournalEntries,
  postDraft,
  reverseJournalEntry,
  saveDraft,
  getVatSummary,
  buildDatevRows,
} from './proAccountingRepo';
import { ensureTaxCaseSeedData } from './taxCasesRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  ensureTaxCaseSeedData(db);
  db.exec("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('test-1200', 'SKR03', '1200', 'Bank', 'test', datetime('now'), datetime('now')), ('test-6000', 'SKR03', '6000', 'Aufwand', 'test', datetime('now'), datetime('now'))");
  return db;
};

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const seedBankTransaction = (db: Database.Database, id: string, date: string, amount = -120): void => {
  db.prepare(
    `
      INSERT INTO bank_transactions (
        id,
        tenant_id,
        account_id,
        date,
        amount,
        type,
        counterparty,
        purpose,
        linked_invoice_id,
        status,
        source_transaction_id,
        created_at,
        updated_at
      ) VALUES (?, 'default', 'bank-1', ?, ?, 'expense', 'Lieferant GmbH', 'Eingangsrechnung', NULL, 'pending', ?, ?, ?)
    `,
  ).run(id, date, amount, id, `${date}T09:00:00.000Z`, `${date}T09:00:00.000Z`);
};

describe.skipIf(!canRunNativeSqlite)('proAccountingRepo compliance controls', () => {
  it('keeps canonical Drizzle DATEV manifest migration immutable on a fresh schema', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE datev_exports (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, file_path TEXT NOT NULL,
      record_count INTEGER NOT NULL, from_date TEXT, to_date TEXT, created_at TEXT NOT NULL
    ); CREATE TABLE journal_lines (id TEXT PRIMARY KEY);`);
    const migrationPath = path.resolve(process.cwd(), 'drizzle/0002_datev_manifest.sql');
    const migration = fs.readFileSync(fs.existsSync(migrationPath) ? migrationPath : path.resolve(process.cwd(), 'apps/pro-desktop/drizzle/0002_datev_manifest.sql'), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) db.exec(statement);
    db.exec(fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0003_datev_evidence.sql'), 'utf8'));
    expect((db.prepare('PRAGMA table_info(journal_lines)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('datev_sachverhalt_ll');
    db.prepare(`INSERT INTO datev_exports (id, tenant_id, file_path, record_count, created_at) VALUES ('fresh', 'default', '/tmp/fresh.csv', 1, '2026-03-01T00:00:00.000Z')`).run();
    expect(() => db.prepare("UPDATE datev_exports SET file_path = '/tmp/tampered.csv' WHERE id = 'fresh'").run()).toThrow(/immutable/i);
    expect(() => db.prepare("DELETE FROM datev_exports WHERE id = 'fresh'").run()).toThrow(/immutable/i);
  });

  const validDraft = (db: Database.Database, id: string, date = '2026-03-01') => {
    const scope = createProTenantScope('default');
    seedBankTransaction(db, id, date);
    const draft = getDraftByTransactionId(db, id, scope);
    expect(draft).toBeTruthy();
    return saveDraft(db, {
      ...draft!,
      postingDate: date,
      documentDate: date,
      period: date.slice(0, 7),
      fiscalYear: Number(date.slice(0, 4)),
      workflowStatus: 'approved',
      lines: [
        { ...draft!.lines[0]!, id: `${id}-debit`, accountNumber: '6000', debitAmount: 119, creditAmount: 0, taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
        { ...draft!.lines[1]!, id: `${id}-credit`, accountNumber: '1200', debitAmount: 0, creditAmount: 119, taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
      ],
    }, scope);
  };

  it('blocks posting in closed period', () => {
    const db = createDb();
    const scope = createProTenantScope('default');

    seedBankTransaction(db, 'tx-closed-1', '2026-02-15');
    const draft = getDraftByTransactionId(db, 'tx-closed-1', scope);
    expect(draft).toBeTruthy();

    db.prepare("UPDATE accounting_periods SET status = 'closed' WHERE tenant_id = ? AND period = '2026-02'").run(scope.tenantId);

    const result = postDraft(db, draft!.id, { postingDate: '2026-02-15' }, scope);
    expect(result.issues.some((issue) => issue.code === 'POSTING_DATE_IN_CLOSED_PERIOD')).toBe(true);

    const postedCount = (db.prepare('SELECT COUNT(*) as c FROM journal_entries').get() as { c: number }).c;
    expect(postedCount).toBe(0);
  });

  it('upgrades a legacy journal during the real bootstrap then migration order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'billme-ledger-upgrade-'));
    const dbPath = path.join(root, 'legacy.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE journal_entries (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', entry_number INTEGER NOT NULL,
      posting_date TEXT NOT NULL, document_date TEXT, booking_text TEXT NOT NULL, reference TEXT,
      period TEXT NOT NULL, fiscal_year INTEGER NOT NULL, status TEXT NOT NULL,
      source_draft_id TEXT, reversed_entry_id TEXT, created_at TEXT NOT NULL
    );`);
    const insertLegacy = legacy.prepare(`
      INSERT INTO journal_entries
        (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, reversed_entry_id, created_at)
      VALUES (?, 'default', ?, '2026-03-01', '2026-03-01', ?, ?, '2026-03', 2026, 'posted', ?, NULL, ?)
    `);
    insertLegacy.run('legacy-canonical', 1, 'Legacy canonical', 'legacy-1', 'legacy-draft-1', '2026-03-01T08:00:00.000Z');
    insertLegacy.run('legacy-duplicate', 2, 'Legacy duplicate', 'legacy-2', 'legacy-draft-1', '2026-03-01T09:00:00.000Z');
    legacy.close();

    const connection = createSqliteConnection({ bootstrapSql, runMigrations, defaultFileName: 'legacy.sqlite' });
    const db = connection.initDb(root);
    const columns = db.prepare('PRAGMA table_info(journal_entries)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['source_type', 'source_key']));
    expect(() => db.prepare("SELECT source_type, source_key FROM journal_entries").get()).not.toThrow();
    const repaired = db.prepare(`
      SELECT id, source_draft_id, source_type, source_key
      FROM journal_entries
      ORDER BY entry_number
    `).all() as Array<{ id: string; source_draft_id: string | null; source_type: string; source_key: string | null }>;
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toMatchObject({ id: 'legacy-canonical', source_draft_id: 'legacy-draft-1', source_type: 'booking_draft', source_key: null });
    expect(repaired[1]).toMatchObject({ id: 'legacy-duplicate', source_draft_id: null, source_type: 'manual' });
    expect(repaired[1]!.source_key).toMatch(/^legacy-source-draft:legacy-draft-1:legacy-duplicate/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM migration_log WHERE migration_name = 'journal_source_draft_repair' AND status = 'completed'").get()).toMatchObject({ c: 1 });
    connection.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enforces immutable journals and datev export records', () => {
    const db = createDb();
    const scope = createProTenantScope('default');

    const draft = validDraft(db, 'tx-immut-1', '2026-03-01');

    const post = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(post.issues.length).toBe(0);
    expect(post.entry.id).toBeTruthy();

    expect(() =>
      db.prepare("UPDATE journal_entries SET booking_text = 'manipulated' WHERE id = ?").run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM journal_entries WHERE id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('UPDATE journal_lines SET debit_amount = debit_amount + 1 WHERE entry_id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    const datev = insertDatevExport(db, {
      filePath: '/tmp/datev-test.csv',
      recordCount: 1,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    }, scope);

    expect(() =>
      db.prepare("UPDATE datev_exports SET file_path = '/tmp/tampered.csv' WHERE id = ?").run(datev.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM datev_exports WHERE id = ?').run(datev.id),
    ).toThrow(/immutable/i);
  });

  it('filters journal entries by account before pagination', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-filter-1', '2026-03-02');
    const posted = postDraft(db, draft.id, { postingDate: '2026-03-02' }, scope);
    const accountNumber = posted.entry.lines[0].accountNumber;

    expect(listJournalEntries(db, { accountNumbers: [accountNumber], limit: 1 }, scope))
      .toHaveLength(1);
    expect(listJournalEntries(db, { accountNumbers: ['does-not-exist'] }, scope))
      .toEqual([]);
  });

  it('allocates one journal entry for repeated posting', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-idempotent-1');
    const first = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const second = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(second.entry.id).toBe(first.entry.id);
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c).toBe(1);
  });

  it('returns the idempotent entry directly after the journal exceeds the list page cap', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-idempotent-large-1', '2026-03-01');
    const first = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const insert = db.prepare(`
      INSERT INTO journal_entries
        (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
      VALUES (?, 'default', ?, '2027-01-01', '2027-01-01', 'Filler', NULL, '2027-01', 2027, 'posted', NULL, 'manual', NULL, NULL, ?)
    `);
    for (let index = 0; index < 5_001; index += 1) {
      insert.run(`filler-${index}`, first.entry.entryNumber + index + 1, new Date(2027, 0, 1, 0, 0, index).toISOString());
    }
    const replay = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.issues).toEqual([]);
  });

  it('detects DATEV overflow after the 5,000-entry listing page without creating an export manifest', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const entryInsert = db.prepare(`
      INSERT INTO journal_entries
        (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
      VALUES (?, 'default', ?, '2026-03-01', '2026-03-01', 'Overflow', ?, '2026-03', 2026, 'posted', NULL, 'manual', NULL, NULL, ?)
    `);
    const lineInsert = db.prepare(`
      INSERT INTO journal_lines
        (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo)
      VALUES (?, 'default', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    `);
    db.transaction(() => {
      for (let entryNo = 1; entryNo <= 5_001; entryNo += 1) {
        const entryId = `datev-overflow-entry-${entryNo}`;
        entryInsert.run(entryId, entryNo, `overflow-${entryNo}`, `2026-03-01T00:00:${String(entryNo % 60).padStart(2, '0')}.000Z`);
        for (let pairNo = 1; pairNo <= 20; pairNo += 1) {
          lineInsert.run(`${entryId}-debit-${pairNo}`, entryId, pairNo * 2 - 1, '6000', 1, 0);
          lineInsert.run(`${entryId}-credit-${pairNo}`, entryId, pairNo * 2, '1200', 0, 1);
        }
      }
    })();

    expect(() => buildDatevRows(db, { from: '2026-03-01', to: '2026-03-31' }, scope)).toThrow(/99999/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM datev_exports').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_posting_pairs').get() as { c: number }).c).toBe(100_020);
  }, 30_000);

  it('accepts decimal cent values without floating-point false positives', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    for (const amount of [0.07, 1.10, 19.99]) {
      const draft = validDraft(db, `tx-decimal-${String(amount).replace('.', '-')}`);
      const saved = saveDraft(db, {
        ...draft,
        lines: [
          { ...draft.lines[0]!, debitAmount: amount, creditAmount: 0 },
          { ...draft.lines[1]!, debitAmount: 0, creditAmount: amount },
        ],
      }, scope);
      expect(saved.validationIssues.map((issue) => issue.code)).not.toEqual(expect.arrayContaining(['INVALID_LINE_AMOUNT', 'UNBALANCED_ENTRY']));
    }
  });

  it('blocks posting when the persisted active chart has no accounts', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    runMigrations(db);
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-empty-chart-1', '2026-03-01');
    const draft = getDraftByTransactionId(db, 'tx-empty-chart-1', scope)!;
    saveDraft(db, { ...draft, workflowStatus: 'approved' }, scope);
    const result = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CHART_UNAVAILABLE', blocking: true })]));
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c).toBe(0);
  });

  it('requires persisted approval and persists posted status atomically', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-approval-1', '2026-03-01');
    const imported = getDraftByTransactionId(db, 'tx-approval-1', scope)!;
    const blocked = postDraft(db, imported.id, { postingDate: '2026-03-01' }, scope);
    expect(blocked.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DRAFT_NOT_APPROVED' })]));
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c).toBe(0);
    const approved = validDraft(db, 'tx-approval-2');
    db.prepare("UPDATE booking_drafts SET workflow_status = 'imported' WHERE id = ?").run(approved.id);
    const mismatched = postDraft(db, approved.id, { postingDate: '2026-03-01' }, scope);
    expect(mismatched.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DRAFT_NOT_APPROVED' })]));
    db.prepare("UPDATE booking_drafts SET workflow_status = 'approved' WHERE id = ?").run(approved.id);
    const posted = postDraft(db, approved.id, { postingDate: '2026-03-01' }, scope);
    const persisted = db.prepare('SELECT workflow_status, draft_json FROM booking_drafts WHERE id = ?').get(approved.id) as { workflow_status: string; draft_json: string };
    expect(persisted.workflow_status).toBe('posted');
    expect(JSON.parse(persisted.draft_json).workflowStatus).toBe('posted');
    expect(posted.entry.id).toBeTruthy();
  });

  it('requires a reasoned override for soft-locked periods', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-soft-lock-1');
    db.prepare("UPDATE accounting_periods SET status = 'soft_locked' WHERE tenant_id = ? AND period = '2026-03'").run(scope.tenantId);

    const blocked = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(blocked.issues.some((issue) => issue.code === 'SOFT_LOCK_OVERRIDE_REQUIRED')).toBe(true);
    const allowed = postDraft(db, draft.id, { postingDate: '2026-03-01', softLockOverride: true, overrideReason: 'Korrektur nach Belegprüfung' }, scope);
    expect(allowed.entry.id).toBeTruthy();
  });

  it('rejects invalid lines and unknown accounts', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-invalid-lines-1');
    const invalid = saveDraft(db, {
      ...draft,
      lines: [
        { ...draft.lines[0]!, accountNumber: '9999', debitAmount: 1, creditAmount: 1 },
        { ...draft.lines[1]!, debitAmount: 0, creditAmount: 0 },
      ],
    }, scope);
    expect(invalid.validationIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['UNKNOWN_ACCOUNT', 'INVALID_LINE_SIDE']));
  });

  it('reverses on the requested date and nets every VAT-bearing cent', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-reversal-1');
    const posted = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const reversal = reverseJournalEntry(db, posted.entry.id, 'Beleg storniert', scope, { postingDate: '2026-04-15' });
    const entries = listJournalEntries(db, {}, scope);
    const original = entries.find((entry) => entry.id === posted.entry.id)!;
    const reversed = entries.find((entry) => entry.id === reversal.reversalEntryId)!;
    expect(original.status).toBe('reversed');
    expect(reversed).toMatchObject({ postingDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, sourceType: 'reversal' });
    expect(() => reverseJournalEntry(db, reversal.reversalEntryId, 'Storno des Stornos', scope, { postingDate: '2026-04-16' })).toThrow(/cannot be reversed/i);

    const balances = db.prepare('SELECT account_number, ROUND(SUM(debit_amount - credit_amount), 2) AS net FROM journal_lines GROUP BY account_number').all() as Array<{ account_number: string; net: number }>;
    expect(balances.every((row) => Number(row.net) === 0)).toBe(true);
    const vat = getVatSummary(db, {}, scope).rows;
    expect(vat).toHaveLength(1);
    expect(vat[0]).toMatchObject({ taxCaseKey: 'DE_STD_19', lineCount: 4 });
    expect(vat.reduce((total, row) => total + row.taxAmount, 0)).toBe(0);
    expect(vat.reduce((total, row) => total + row.netAmount, 0)).toBe(0);
    expect(vat.reduce((total, row) => total + row.grossAmount, 0)).toBe(0);
  });

  it('persists reversal posting pairs for a VAT booking', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    expect(db.prepare("SELECT datev_bu_key FROM tax_case_account_mappings WHERE chart = 'SKR03' AND tax_case_key = 'DE_STD_19' AND role = 'datev_bu'").get()).toMatchObject({ datev_bu_key: '1' });
    const draft = validDraft(db, 'tx-vat-pairs-1');
    const posted = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const originalPairs = db.prepare('SELECT debit_line_id, credit_line_id, tax_case_key, datev_bu_key FROM journal_posting_pairs WHERE entry_id = ?').all(posted.entry.id) as Array<{ debit_line_id: string; credit_line_id: string; tax_case_key: string | null; datev_bu_key: string | null }>;
    expect(originalPairs.length).toBeGreaterThan(0);
    expect(originalPairs).toEqual(expect.arrayContaining([expect.objectContaining({ tax_case_key: 'DE_STD_19', datev_bu_key: '1' })]));
    const reversal = reverseJournalEntry(db, posted.entry.id, 'VAT Storno', scope, { postingDate: '2026-04-01' });
    const reversalPairs = db.prepare('SELECT debit_line_id, credit_line_id, tax_case_key, datev_bu_key FROM journal_posting_pairs WHERE entry_id = ?').all(reversal.reversalEntryId) as Array<{ debit_line_id: string; credit_line_id: string; tax_case_key: string | null; datev_bu_key: string | null }>;
    const reversalLineIds = new Set((db.prepare('SELECT id FROM journal_lines WHERE entry_id = ?').all(reversal.reversalEntryId) as Array<{ id: string }>).map((line) => line.id));
    expect(reversalPairs.length).toBeGreaterThan(0);
    expect(reversalPairs.every((pair) => reversalLineIds.has(pair.debit_line_id) && reversalLineIds.has(pair.credit_line_id))).toBe(true);
    expect(reversalPairs).toEqual(expect.arrayContaining([expect.objectContaining({ tax_case_key: 'DE_STD_19', datev_bu_key: '1' })]));
  });
});
