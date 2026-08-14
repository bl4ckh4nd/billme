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
  getJournalEntryById,
  insertDatevExport,
  listJournalEntries,
  postDraft,
  reverseJournalEntry,
  saveDraft,
  getVatSummary,
  buildDatevRows,
  dispatchDraftAction,
  validateTaxCompliance,
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

  it('rejects edits to a posted draft but accepts an exact replay', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-posted-draft-1', '2026-03-01');

    postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const posted = getDraftByTransactionId(db, 'tx-posted-draft-1', scope);
    expect(posted?.workflowStatus).toBe('posted');
    expect(posted?.isVirtualProjection).not.toBe(true);

    expect(saveDraft(db, { ...posted!, updatedAt: 'different-replay-timestamp' }, scope)).toEqual(posted);
    expect(() => saveDraft(db, { ...posted!, bookingText: 'Manipulierte Buchung' }, scope))
      .toThrow('POSTED_DRAFT_IMMUTABLE');

    expect(dispatchDraftAction(db, { transactionId: 'tx-posted-draft-1', action: 'reverse' }, scope).workflowStatus)
      .toBe('reversed');
  });

  it('keeps OPOS-booked bank transactions read-only even without a booking journal source', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-opos-booked-1', '2026-03-01');
    db.prepare("UPDATE bank_transactions SET status = 'booked' WHERE id = ?").run('tx-opos-booked-1');

    const projected = getDraftByTransactionId(db, 'tx-opos-booked-1', scope);
    expect(projected?.workflowStatus).toBe('posted');
    expect(() => saveDraft(db, { ...projected!, bookingText: 'Payment-Manipulation' }, scope))
      .toThrow('POSTED_DRAFT_IMMUTABLE');
  });

  it('applies the shared DATEV evidence rule to require an OSS destination rate', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-oss-evidence-1', '2026-03-01');
    const draft = getDraftByTransactionId(db, 'tx-oss-evidence-1', scope)!;

    const saved = saveDraft(db, {
      ...draft,
      postingDate: '2026-03-01',
      documentDate: '2026-03-01',
      period: '2026-03',
      fiscalYear: 2026,
      workflowStatus: 'approved',
      lines: [
        {
          ...draft.lines[0]!,
          accountNumber: '6000',
          debitAmount: 120,
          creditAmount: 0,
          taxCaseKey: 'EU_B2C_OSS',
          taxRate: 20,
          netAmount: 100,
          taxAmount: 20,
          grossAmount: 120,
          countryCode: 'AT',
          evidenceType: 'invoice',
          evidenceReference: 'oss-proof-1',
        },
        {
          ...draft.lines[1]!,
          accountNumber: '1200',
          debitAmount: 0,
          creditAmount: 120,
        },
      ],
    }, scope);

    const validation = validateTaxCompliance(db, { draftId: saved.id }, scope);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_DESTINATION_VAT_RATE', blocking: true }),
    ]));
  });

  it('allows a virtual booked projection to validate and replay without writing, but never reverses it as a draft', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-opos-virtual-1', '2026-03-01');
    db.prepare("UPDATE bank_transactions SET status = 'booked' WHERE id = ?").run('tx-opos-virtual-1');

    const projected = getDraftByTransactionId(db, 'tx-opos-virtual-1', scope)!;
    expect(projected.isVirtualProjection).toBe(true);
    const beforeDrafts = (db.prepare('SELECT COUNT(*) AS c FROM booking_drafts').get() as { c: number }).c;
    const beforeJournals = (db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c;

    // Keep the chart active through the bank account while removing the
    // projected expense account, so pure validation must report the drift.
    db.prepare("DELETE FROM ledger_accounts WHERE chart = 'SKR03' AND account_number = '6000'").run();
    const validation = validateTaxCompliance(db, { transactionId: 'tx-opos-virtual-1' }, scope);
    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_ACCOUNT' })]));
    const drifted = {
      ...projected,
      lines: projected.lines.map((line, index) => index === 0
        ? { ...line, accountNumber: '9999', taxCaseKey: 'DE_STD_19' as const }
        : line),
    };
    expect(() => saveDraft(db, drifted, scope)).toThrow('POSTED_DRAFT_IMMUTABLE');
    expect(saveDraft(db, { ...projected, updatedAt: 'replay-only' }, scope)).toMatchObject({
      id: projected.id,
      transactionId: projected.transactionId,
      workflowStatus: 'posted',
    });
    expect(() => dispatchDraftAction(db, { transactionId: 'tx-opos-virtual-1', action: 'reverse' }, scope))
      .toThrow('PAYMENT_REVERSAL_REQUIRED');

    expect((db.prepare('SELECT COUNT(*) AS c FROM booking_drafts').get() as { c: number }).c).toBe(beforeDrafts);
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c).toBe(beforeJournals);
    expect((db.prepare('SELECT status FROM bank_transactions WHERE id = ?').get('tx-opos-virtual-1') as { status: string }).status).toBe('booked');
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

  it('loads a journal entry directly within its tenant scope', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-direct-journal-1', '2026-03-02');
    const posted = postDraft(db, draft.id, { postingDate: '2026-03-02' }, scope);

    expect(getJournalEntryById(db, posted.entry.id, scope)).toMatchObject({ id: posted.entry.id });
    expect(getJournalEntryById(db, 'missing-journal', scope)).toBeNull();
    expect(getJournalEntryById(db, posted.entry.id, createProTenantScope('other-tenant'))).toBeNull();
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

  it('does not let manual evidence labels bypass tax validation', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    db.exec("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('test-4830', 'SKR03', '4830', 'AfA', 'test', datetime('now'), datetime('now')), ('test-0440', 'SKR03', '0440', 'Anlage', 'test', datetime('now'), datetime('now'))");
    db.prepare(`
      INSERT INTO assets (
        id, tenant_id, asset_number, name, asset_class, status, activation_date,
        acquisition_cost, useful_life_years, depreciation_method, cost_center, location,
        asset_account_number, created_at, updated_at
      ) VALUES ('trusted-asset', 'default', 'TRUSTED-1', 'Trusted asset', 'IT-Hardware',
        'aktiv', '2026-01-01', 100, 1, 'linear', 'IT', 'Berlin', '0440', datetime('now'), datetime('now'))
    `).run();
    const draft = (id: string) => ({
      id,
      tenantId: 'default',
      transactionId: id,
      workflowStatus: 'approved' as const,
      postingDate: '2026-03-01',
      documentDate: '2026-03-01',
      bookingText: 'AfA',
      period: '2026-03',
      fiscalYear: 2026,
      lines: [
        { id: `${id}-debit`, accountNumber: '4830', debitAmount: 10, creditAmount: 0, evidenceType: 'asset_depreciation' },
        { id: `${id}-credit`, accountNumber: '0440', debitAmount: 0, creditAmount: 10 },
      ],
      validationIssues: [],
      updatedAt: new Date().toISOString(),
    });
    const manual = saveDraft(db, draft('manual-evidence'), scope);
    expect(manual.validationIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_TAX_CASE' })]));
    const trusted = saveDraft(db, draft('asset-depreciation:trusted-asset:2026'), scope, { trustedSourceType: 'asset_depreciation' });
    expect(trusted.validationIssues.some((issue) => issue.code === 'MISSING_TAX_CASE')).toBe(false);
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

  it('reports reverse-charge VAT from the single tax-basis line', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-rc-vat-summary-1', '2026-03-01', -119);
    const draft = getDraftByTransactionId(db, 'tx-rc-vat-summary-1', scope)!;
    const saved = saveDraft(db, {
      ...draft,
      postingDate: '2026-03-01',
      documentDate: '2026-03-01',
      period: '2026-03',
      fiscalYear: 2026,
      workflowStatus: 'approved',
      lines: [
        {
          ...draft.lines[0]!,
          id: 'tx-rc-vat-summary-1-debit',
          accountNumber: '6000',
          debitAmount: 119,
          creditAmount: 0,
          taxCaseKey: 'EU_B2B_SERVICE_RC',
          taxRate: 19,
          netAmount: 100,
          taxAmount: 19,
          grossAmount: 119,
          countryCode: 'FR',
          counterpartyVatId: 'FR12345678901',
          evidenceType: 'Invoice',
          evidenceReference: '13',
        },
        {
          ...draft.lines[1]!,
          id: 'tx-rc-vat-summary-1-credit',
          accountNumber: '1200',
          debitAmount: 0,
          creditAmount: 119,
        },
      ],
    }, scope);
    expect(saved.validationIssues.filter((issue) => issue.blocking)).toEqual([]);

    const posted = postDraft(db, saved.id, { postingDate: '2026-03-01' }, scope);
    expect(posted.issues.filter((issue) => issue.blocking)).toEqual([]);
    const summary = getVatSummary(db, {}, scope).rows;
    expect(summary).toEqual([{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100, taxAmount: 19, grossAmount: 119, lineCount: 1 }]);

    const controls = db.prepare(`
      SELECT account_number, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount
      FROM journal_lines
      WHERE entry_id = ? AND memo LIKE 'RC %'
      ORDER BY account_number
    `).all(posted.entry.id) as Array<Record<string, unknown>>;
    expect(controls).toEqual([
      { account_number: '1574', tax_case_key: null, tax_rate: null, net_amount: null, tax_amount: null, gross_amount: null },
      { account_number: '1774', tax_case_key: null, tax_rate: null, net_amount: null, tax_amount: null, gross_amount: null },
    ]);
    const taxPairs = db.prepare('SELECT tax_case_key, datev_bu_key FROM journal_posting_pairs WHERE entry_id = ? AND tax_case_key IS NOT NULL').all(posted.entry.id) as Array<{ tax_case_key: string; datev_bu_key: string | null }>;
    expect(taxPairs.length).toBeGreaterThan(0);
    expect(taxPairs.every((pair) => pair.tax_case_key === 'EU_B2B_SERVICE_RC' && pair.datev_bu_key === '94')).toBe(true);
    expect(db.prepare('SELECT tax_case_key, evidence_reference FROM vat_evidence WHERE entry_id = ?').all(posted.entry.id)).toEqual([{ tax_case_key: 'EU_B2B_SERVICE_RC', evidence_reference: '13' }]);
  });

  it('rejects generic reversal of asset-owned journals', () => {
    const db = createDb();
    const entryId = 'asset-owned-journal';
    db.prepare(`INSERT INTO journal_entries
      (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
      VALUES (?, 'default', 1, '2026-03-01', '2026-03-01', 'Aktivierung', NULL, '2026-03', 2026, 'posted', NULL, 'asset_activation', 'asset_activation:asset-1', NULL, datetime('now'))`).run(entryId);
    expect(() => reverseJournalEntry(db, entryId, 'generic asset reversal', createProTenantScope('default'))).toThrow('ASSET_REVERSAL_REQUIRED');
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE id = ? AND status = \'posted\'').get(entryId) as { c: number }).c).toBe(1);
  });
});
