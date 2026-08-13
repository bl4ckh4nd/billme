import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { seedEurCatalog } from './eurCatalogRepo';
import { ensureTaxCaseSeedData } from './taxCasesRepo';
import { appendAuditLog } from './audit';

const getColumns = (db: Database.Database, table: string): Set<string> => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

const addColumnIfMissing = (
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void => {
  const cols = getColumns(db, table);
  if (cols.has(column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
};

const tryAddColumn = (
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void => {
  try {
    addColumnIfMissing(db, table, column, definition);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate column name')) return;
    if (msg.includes('no such table')) return;
    throw e;
  }
};

const logMigration = (db: Database.Database, migrationName: string, status: 'started' | 'completed' | 'failed', error?: string): void => {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO migration_log (id, migration_name, status, error_message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), migrationName, status, error ?? null, timestamp);
};

const repairDuplicateJournalSourceDrafts = (db: Database.Database): number => {
  const groups = db.prepare(`
    SELECT tenant_id, source_draft_id
    FROM journal_entries
    WHERE source_draft_id IS NOT NULL
    GROUP BY tenant_id, source_draft_id
    HAVING COUNT(*) > 1
  `).all() as Array<{ tenant_id: string; source_draft_id: string }>;

  let repaired = 0;
  const findSourceKey = db.prepare(`
    SELECT 1
    FROM journal_entries
    WHERE tenant_id = ? AND source_type = ? AND source_key = ?
    LIMIT 1
  `);
  const updateDuplicate = db.prepare(`
    UPDATE journal_entries
    SET source_draft_id = NULL, source_type = 'manual', source_key = ?
    WHERE tenant_id = ? AND id = ?
  `);

  for (const group of groups) {
    const rows = db.prepare(`
      SELECT id
      FROM journal_entries
      WHERE tenant_id = ? AND source_draft_id = ?
      ORDER BY created_at ASC, entry_number ASC, id ASC
    `).all(group.tenant_id, group.source_draft_id) as Array<{ id: string }>;

    // Keep the earliest immutable journal as the canonical source association.
    for (const duplicate of rows.slice(1)) {
      let sourceKey = `legacy-source-draft:${group.source_draft_id}:${duplicate.id}`;
      let suffix = 0;
      while (findSourceKey.get(group.tenant_id, 'manual', sourceKey)) {
        suffix += 1;
        sourceKey = `legacy-source-draft:${group.source_draft_id}:${duplicate.id}:${suffix}`;
      }
      updateDuplicate.run(sourceKey, group.tenant_id, duplicate.id);
      repaired += 1;
    }
  }

  return repaired;
};

/** Expand legacy HGB mappings to the explicit report catalog namespaces. */
const ensureReportMappingStatementSchema = (db: Database.Database): void => {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_mappings_hgb'").get() as { sql?: string } | undefined;
  if (table?.sql && !table.sql.includes("'bwa01'")) db.exec(`
    BEGIN;
    DROP INDEX IF EXISTS idx_account_mappings_unique;
    ALTER TABLE account_mappings_hgb RENAME TO account_mappings_hgb_legacy;
    CREATE TABLE account_mappings_hgb (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chart TEXT NOT NULL,
      account_number TEXT NOT NULL,
      statement_type TEXT NOT NULL CHECK (statement_type IN ('bwa01', 'management-guv', 'hgb-guv', 'hgb-gkv', 'hgb-bilanz', 'hgb-balance', 'eur', 'guv', 'bilanz')),
      position_key TEXT NOT NULL,
      position_label TEXT NOT NULL,
      balance_side TEXT CHECK (balance_side IN ('asset', 'liability')),
      valid_from TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO account_mappings_hgb (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, valid_from, updated_at)
      SELECT id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, NULL, updated_at
      FROM account_mappings_hgb_legacy;
    DROP TABLE account_mappings_hgb_legacy;
    CREATE UNIQUE INDEX idx_account_mappings_unique
      ON account_mappings_hgb(tenant_id, chart, account_number, statement_type, valid_from);
    COMMIT;
  `);
  if (!table?.sql) return;

  tryAddColumn(db, 'account_mappings_hgb', 'valid_from', 'TEXT');
  db.exec(`
    DROP INDEX IF EXISTS idx_account_mappings_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_mappings_unique
      ON account_mappings_hgb(tenant_id, chart, account_number, statement_type, valid_from);
  `);
};

export const runMigrations = (db: Database.Database): void => {
  // Create migration log table first
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_log (
      id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_migration_log_name ON migration_log(migration_name, created_at DESC);
  `);

    // Log migration start
    const migrationVersion = new Date().toISOString().split('T')[0]!.replace(/-/g, '');
  try {
    logMigration(db, `migration_run_${migrationVersion}`, 'started');

    // Add columns before the idempotent indexes below so upgrades from the
    // original journal schema can run the same bootstrap block safely.
    tryAddColumn(db, 'journal_entries', 'source_type', "TEXT NOT NULL DEFAULT 'booking_draft'");
    tryAddColumn(db, 'journal_entries', 'source_key', 'TEXT');
    tryAddColumn(db, 'invoices', 'accounting_status', "TEXT NOT NULL DEFAULT 'unposted'");
    tryAddColumn(db, 'invoices', 'accounting_snapshot_json', 'TEXT');
    tryAddColumn(db, 'invoices', 'accounting_journal_entry_id', 'TEXT');
    tryAddColumn(db, 'invoices', 'accounting_posted_at', 'TEXT');
    tryAddColumn(db, 'accounting_policies', 'vat_method', "TEXT NOT NULL DEFAULT 'soll'");
    // DATEV manifests were added after the original desktop schema. Keep all
    // columns nullable so existing export history remains readable.
    tryAddColumn(db, 'datev_exports', 'sha256', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'byte_size', 'INTEGER');
    tryAddColumn(db, 'datev_exports', 'encoding', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'header_version', 'INTEGER');
    tryAddColumn(db, 'datev_exports', 'format_version', 'INTEGER');
    tryAddColumn(db, 'datev_exports', 'chart', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'source_snapshot_hash', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'manifest_json', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'status', 'TEXT');
    tryAddColumn(db, 'datev_exports', 'validation_json', 'TEXT');
    tryAddColumn(db, 'report_snapshots', 'source_hash', 'TEXT');

    // Documents: project assignment
    tryAddColumn(db, 'invoices', 'project_id', 'TEXT');
    tryAddColumn(db, 'offers', 'project_id', 'TEXT');
    tryAddColumn(db, 'invoices', 'client_number', 'TEXT');
    tryAddColumn(db, 'offers', 'client_number', 'TEXT');
    tryAddColumn(db, 'clients', 'customer_number', 'TEXT');
    tryAddColumn(db, 'clients', 'tax_profile_json', 'TEXT');

    // Projects: code + archive metadata
  tryAddColumn(db, 'client_projects', 'code', 'TEXT');
  tryAddColumn(db, 'client_projects', 'archived_at', 'TEXT');
  tryAddColumn(db, 'client_projects', 'created_at', 'TEXT');
  tryAddColumn(db, 'client_projects', 'updated_at', 'TEXT');

  // Invoices: structured address snapshots
  addColumnIfMissing(db, 'invoices', 'billing_address_json', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'shipping_address_json', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'tax_mode', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'tax_meta_json', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'tax_snapshot_json', 'TEXT');

  // Offers: structured address snapshots
  addColumnIfMissing(db, 'offers', 'billing_address_json', 'TEXT');
  addColumnIfMissing(db, 'offers', 'shipping_address_json', 'TEXT');
  addColumnIfMissing(db, 'offers', 'tax_mode', 'TEXT');
  addColumnIfMissing(db, 'offers', 'tax_meta_json', 'TEXT');
  addColumnIfMissing(db, 'offers', 'tax_snapshot_json', 'TEXT');

  // Recurring profiles: preserve the confirmed tax rule.
  addColumnIfMissing(db, 'recurring_profiles', 'tax_mode', 'TEXT');
  addColumnIfMissing(db, 'recurring_profiles', 'tax_meta_json', 'TEXT');

  // Offers: portal publication + decision fields
  addColumnIfMissing(db, 'offers', 'share_token', 'TEXT');
  addColumnIfMissing(db, 'offers', 'share_published_at', 'TEXT');
  addColumnIfMissing(db, 'offers', 'accepted_at', 'TEXT');
  addColumnIfMissing(db, 'offers', 'accepted_by', 'TEXT');
  addColumnIfMissing(db, 'offers', 'accepted_email', 'TEXT');
  addColumnIfMissing(db, 'offers', 'accepted_user_agent', 'TEXT');
  addColumnIfMissing(db, 'offers', 'decision', 'TEXT');
  addColumnIfMissing(db, 'offers', 'decision_text_version', 'TEXT');

  // Invoice/Offer items: structured article linkage + category snapshot
  addColumnIfMissing(db, 'invoice_items', 'article_id', 'TEXT');
  addColumnIfMissing(db, 'invoice_items', 'category', 'TEXT');
  addColumnIfMissing(db, 'invoice_items', 'unit', 'TEXT');
  addColumnIfMissing(db, 'invoice_items', 'discount_percent', 'REAL');
  addColumnIfMissing(db, 'invoice_items', 'tax_rate', 'REAL');
  addColumnIfMissing(db, 'invoice_items', 'line_meta_json', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'article_id', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'category', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'unit', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'discount_percent', 'REAL');
  addColumnIfMissing(db, 'offer_items', 'tax_rate', 'REAL');
  addColumnIfMissing(db, 'offer_items', 'line_meta_json', 'TEXT');

  // Finance: transaction import support (non-audit-locked)
  tryAddColumn(db, 'accounts', 'default_skr_account_number', "TEXT NOT NULL DEFAULT '1200'");
  tryAddColumn(db, 'transactions', 'dedup_hash', 'TEXT');
  tryAddColumn(db, 'transactions', 'import_batch_id', 'TEXT');
  tryAddColumn(db, 'transactions', 'linked_payment_id', 'TEXT');
  tryAddColumn(db, 'transactions', 'deleted_at', 'TEXT');
  tryAddColumn(db, 'booking_draft_lines', 'tax_case_key', 'TEXT');
  tryAddColumn(db, 'booking_draft_lines', 'tax_rate', 'REAL');
  tryAddColumn(db, 'booking_draft_lines', 'net_amount', 'REAL');
  tryAddColumn(db, 'booking_draft_lines', 'tax_amount', 'REAL');
  tryAddColumn(db, 'booking_draft_lines', 'gross_amount', 'REAL');
  tryAddColumn(db, 'booking_draft_lines', 'country_code', 'TEXT');
  tryAddColumn(db, 'booking_draft_lines', 'counterparty_vat_id', 'TEXT');
  tryAddColumn(db, 'booking_draft_lines', 'evidence_type', 'TEXT');
  tryAddColumn(db, 'booking_draft_lines', 'evidence_reference', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'tax_case_key', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'tax_rate', 'REAL');
  tryAddColumn(db, 'journal_lines', 'net_amount', 'REAL');
  tryAddColumn(db, 'journal_lines', 'tax_amount', 'REAL');
  tryAddColumn(db, 'journal_lines', 'gross_amount', 'REAL');
  tryAddColumn(db, 'journal_lines', 'datev_sachverhalt_ll', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'country_code', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'counterparty_vat_id', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'evidence_type', 'TEXT');
  tryAddColumn(db, 'journal_lines', 'evidence_reference', 'TEXT');
  db.exec(`
    UPDATE accounts
    SET default_skr_account_number = '1200'
    WHERE default_skr_account_number IS NULL OR TRIM(default_skr_account_number) = '';
  `);

  const transactionCols = getColumns(db, 'transactions');
  if (transactionCols.has('dedup_hash')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedup
        ON transactions(account_id, dedup_hash)
        WHERE dedup_hash IS NOT NULL;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
      account_number TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_chart_number
      ON ledger_accounts(chart, account_number);
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_chart
      ON ledger_accounts(chart);
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_name
      ON ledger_accounts(name);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pro_workflow_entries (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      transaction_id TEXT NOT NULL,
      transaction_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, transaction_id)
    );

  `);

  const workflowColumns = getColumns(db, 'pro_workflow_entries');
  if (workflowColumns.size > 0 && !workflowColumns.has('tenant_id')) {
    db.exec(`
      ALTER TABLE pro_workflow_entries RENAME TO pro_workflow_entries_legacy;

      CREATE TABLE pro_workflow_entries (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        transaction_id TEXT NOT NULL,
        transaction_json TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, transaction_id)
      );

      INSERT INTO pro_workflow_entries (tenant_id, transaction_id, transaction_json, draft_json, updated_at)
      SELECT 'default', transaction_id, transaction_json, draft_json, updated_at
      FROM pro_workflow_entries_legacy;

      DROP TABLE pro_workflow_entries_legacy;

      CREATE INDEX IF NOT EXISTS idx_pro_workflow_entries_updated
        ON pro_workflow_entries(tenant_id, updated_at DESC);
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pro_workflow_entries_updated
      ON pro_workflow_entries(tenant_id, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      counterparty TEXT NOT NULL,
      purpose TEXT NOT NULL,
      linked_invoice_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'booked')),
      source_transaction_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_date
      ON bank_transactions(tenant_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_bank_transactions_status
      ON bank_transactions(tenant_id, status);

    CREATE TABLE IF NOT EXISTS booking_drafts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      transaction_id TEXT NOT NULL,
      workflow_status TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_drafts_tenant_transaction
      ON booking_drafts(tenant_id, transaction_id);
    CREATE INDEX IF NOT EXISTS idx_booking_drafts_updated
      ON booking_drafts(tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS booking_draft_lines (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      debit_amount REAL NOT NULL DEFAULT 0,
      credit_amount REAL NOT NULL DEFAULT 0,
      tax_code TEXT,
      tax_case_key TEXT,
      tax_rate REAL,
      net_amount REAL,
      tax_amount REAL,
      gross_amount REAL,
      country_code TEXT,
      counterparty_vat_id TEXT,
      evidence_type TEXT,
      evidence_reference TEXT,
      cost_center TEXT,
      memo TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_booking_draft_lines_draft
      ON booking_draft_lines(draft_id, line_no);

    CREATE TABLE IF NOT EXISTS draft_validation_issues (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      draft_id TEXT NOT NULL REFERENCES booking_drafts(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      field_path TEXT,
      blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0,1)),
      source TEXT NOT NULL,
      issue_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_draft_validation_issues_draft
      ON draft_validation_issues(draft_id);

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      period TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'soft_locked', 'closed')),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_periods_tenant_period
      ON accounting_periods(tenant_id, period);

    CREATE TABLE IF NOT EXISTS accounting_policies (
      tenant_id TEXT PRIMARY KEY,
      active_chart TEXT NOT NULL DEFAULT 'SKR03' CHECK (active_chart IN ('SKR03', 'SKR04')),
      period_policy TEXT NOT NULL DEFAULT 'calendar_month' CHECK (period_policy IN ('calendar_month')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      entry_number INTEGER NOT NULL,
      posting_date TEXT NOT NULL,
      document_date TEXT,
      booking_text TEXT NOT NULL,
      reference TEXT,
      period TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('posted', 'reversed')),
      source_draft_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'booking_draft',
      source_key TEXT,
      reversed_entry_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_entry_number
      ON journal_entries(tenant_id, entry_number);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_posting_date
      ON journal_entries(tenant_id, posting_date DESC);

    /* One append-only provenance seam for all non-document accounting sources. */
    CREATE TABLE IF NOT EXISTS accounting_source_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fact_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('posted', 'rejected', 'noop')),
      journal_entry_id TEXT,
      effective_date TEXT NOT NULL,
      posting_date TEXT NOT NULL,
      period TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      currency TEXT NOT NULL,
      booking_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_source_runs_revision
      ON accounting_source_runs(tenant_id, source_type, source_id, source_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_source_runs_idempotency
      ON accounting_source_runs(tenant_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_accounting_source_runs_created
      ON accounting_source_runs(tenant_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS accounting_source_runs_no_update
    BEFORE UPDATE ON accounting_source_runs
    BEGIN
      SELECT RAISE(ABORT, 'accounting_source_runs are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS accounting_source_runs_no_delete
    BEFORE DELETE ON accounting_source_runs
    BEGIN
      SELECT RAISE(ABORT, 'accounting_source_runs are immutable');
    END;

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      debit_amount REAL NOT NULL DEFAULT 0,
      credit_amount REAL NOT NULL DEFAULT 0,
      tax_code TEXT,
      tax_case_key TEXT,
      tax_rate REAL,
      net_amount REAL,
      tax_amount REAL,
      gross_amount REAL,
      country_code TEXT,
      counterparty_vat_id TEXT,
      evidence_type TEXT,
      evidence_reference TEXT,
      cost_center TEXT,
      memo TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_journal_lines_entry
      ON journal_lines(entry_id, line_no);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account
      ON journal_lines(tenant_id, account_number);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      asset_number TEXT NOT NULL,
      name TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      status TEXT NOT NULL,
      activation_date TEXT NOT NULL,
      acquisition_cost REAL NOT NULL,
      useful_life_years INTEGER,
      depreciation_method TEXT NOT NULL,
      cost_center TEXT NOT NULL,
      location TEXT NOT NULL,
      receipt_linked INTEGER NOT NULL DEFAULT 0 CHECK (receipt_linked IN (0,1)),
      supplier TEXT,
      invoice_ref TEXT,
      asset_account_number TEXT NOT NULL,
      disposal_date TEXT,
      disposal_proceeds REAL,
      acquisition_offset_account_number TEXT,
      source_incoming_invoice_id TEXT,
      activation_journal_entry_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_tenant_number
      ON assets(tenant_id, asset_number);

    CREATE TABLE IF NOT EXISTS asset_depreciation_schedule (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      amount REAL NOT NULL,
      months INTEGER NOT NULL,
      status TEXT NOT NULL,
      journal_entry_id TEXT,
      source_type TEXT,
      source_key TEXT,
      posted_at TEXT,
      CHECK (status <> 'posted' OR (journal_entry_id IS NOT NULL AND source_type IS NOT NULL AND source_key IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_schedule_tenant_asset_year
      ON asset_depreciation_schedule(tenant_id, asset_id, year);

    CREATE TABLE IF NOT EXISTS asset_movements (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      movement_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      proceeds REAL,
      gain_loss REAL,
      journal_entry_id TEXT,
      source_type TEXT,
      source_key TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (type NOT IN ('activation', 'depreciation', 'disposal') OR (journal_entry_id IS NOT NULL AND source_type IS NOT NULL AND source_key IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_asset_movements_tenant_asset_date
      ON asset_movements(tenant_id, asset_id, movement_date);

    CREATE TRIGGER IF NOT EXISTS journal_entries_protect_core_fields
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW
    WHEN
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.entry_number != OLD.entry_number OR
      NEW.posting_date != OLD.posting_date OR
      COALESCE(NEW.document_date, '') != COALESCE(OLD.document_date, '') OR
      NEW.booking_text != OLD.booking_text OR
      COALESCE(NEW.reference, '') != COALESCE(OLD.reference, '') OR
      NEW.period != OLD.period OR
      NEW.fiscal_year != OLD.fiscal_year OR
      COALESCE(NEW.source_draft_id, '') != COALESCE(OLD.source_draft_id, '') OR
      NEW.source_type != OLD.source_type OR
      COALESCE(NEW.source_key, '') != COALESCE(OLD.source_key, '') OR
      NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'journal_entries core fields are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
    BEFORE DELETE ON journal_entries
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'journal_entries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
    BEFORE UPDATE ON journal_lines
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'journal_lines are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
    BEFORE DELETE ON journal_lines
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'journal_lines are immutable');
    END;

    CREATE TABLE IF NOT EXISTS account_mappings_hgb (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chart TEXT NOT NULL,
      account_number TEXT NOT NULL,
      statement_type TEXT NOT NULL CHECK (statement_type IN ('guv', 'bilanz')),
      position_key TEXT NOT NULL,
      position_label TEXT NOT NULL,
      balance_side TEXT CHECK (balance_side IN ('asset', 'liability')),
      valid_from TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_mappings_unique
      ON account_mappings_hgb(tenant_id, chart, account_number, statement_type, valid_from);

    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      report_type TEXT NOT NULL,
      args_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type
      ON report_snapshots(tenant_id, report_type, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS report_snapshots_no_update
    BEFORE UPDATE ON report_snapshots
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'report_snapshots are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS report_snapshots_no_delete
    BEFORE DELETE ON report_snapshots
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'report_snapshots are immutable');
    END;

    CREATE TABLE IF NOT EXISTS datev_exports (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      file_path TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      from_date TEXT,
      to_date TEXT,
      created_at TEXT NOT NULL,
      meta_json TEXT NOT NULL,
      sha256 TEXT,
      byte_size INTEGER,
      encoding TEXT,
      header_version INTEGER,
      format_version INTEGER,
      chart TEXT,
      source_snapshot_hash TEXT,
      manifest_json TEXT,
      status TEXT,
      validation_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_datev_exports_tenant_created
      ON datev_exports(tenant_id, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS datev_exports_no_update
    BEFORE UPDATE ON datev_exports
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'datev_exports are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS datev_exports_no_delete
    BEFORE DELETE ON datev_exports
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'datev_exports are immutable');
    END;
  `);

  // Pro import identity/rollback metadata. Normalize legacy rows to the same
  // source identity used by imports (`dedup_hash` when available). Existing
  // mismatches are repaired only when the identity is unambiguous; conflicts
  // get a deterministic quarantine identity and an audit entry.
  tryAddColumn(db, 'bank_transactions', 'deleted_at', 'TEXT');
  tryAddColumn(db, 'bank_transactions', 'rollback_reason', 'TEXT');
  const bankRows = db.prepare(`
    SELECT tenant_id, id, account_id, source_transaction_id
    FROM bank_transactions ORDER BY tenant_id, created_at, id
  `).all() as Array<{ tenant_id: string; id: string; account_id: string; source_transaction_id: string | null }>;
  const hasIdentityAudit = (entityId: string, action: string): boolean => Boolean(db.prepare(
    'SELECT 1 FROM audit_log WHERE entity_type = ? AND entity_id = ? AND action = ? LIMIT 1',
  ).get('bank_transaction', entityId, action));
  const auditIdentity = (
    bank: { id: string; source_transaction_id: string | null },
    action: 'source_identity_repair' | 'source_identity_conflict',
    reason: string,
    after: string,
  ): void => {
    if (hasIdentityAudit(bank.id, action)) return;
    appendAuditLog(db, {
      entityType: 'bank_transaction', entityId: bank.id, action, reason,
      before: { sourceTransactionId: bank.source_transaction_id },
      after: { sourceTransactionId: after }, actor: 'migration',
    });
  };

  type BankIdentityPlan = {
    bank: (typeof bankRows)[number];
    txById?: { id: string; dedup_hash: string | null };
    txBySource?: { id: string; dedup_hash: string | null };
    normalized: string;
    resolvedSource: string;
    blocked: boolean;
  };

  // Read every current owner before changing a single row.  In particular,
  // do not let iteration order turn `a -> c` into a unique-index failure when
  // another legacy row already owns `c`.
  const currentOwners = new Map<string, string>();
  for (const bank of bankRows) {
    const source = bank.source_transaction_id?.trim();
    if (source && !currentOwners.has(`${bank.tenant_id}:${source}`)) {
      currentOwners.set(`${bank.tenant_id}:${source}`, bank.id);
    }
  }

  const plans: BankIdentityPlan[] = bankRows.map((bank) => {
    const txById = db.prepare(
      'SELECT id, dedup_hash FROM transactions WHERE id = ? AND account_id = ? LIMIT 1',
    ).get(bank.id, bank.account_id) as { id: string; dedup_hash: string | null } | undefined;
    const txBySource = bank.source_transaction_id
      ? db.prepare(
        'SELECT id, dedup_hash FROM transactions WHERE account_id = ? AND dedup_hash = ? LIMIT 1',
      ).get(bank.account_id, bank.source_transaction_id.trim()) as { id: string; dedup_hash: string | null } | undefined
      : undefined;
    const normalized = (txById?.dedup_hash?.trim() || txBySource?.dedup_hash?.trim() || bank.source_transaction_id?.trim() || bank.id);
    return { bank, txById, txBySource, normalized, resolvedSource: normalized, blocked: false };
  });

  // A planned target may also collide with another row whose current source
  // was read above.  Quarantine duplicate legacy sources, but preserve the
  // original source for a mismatched row that points at an existing owner:
  // that row is intentionally left in a reconciliation-required state.
  const plannedOwners = new Map<string, string>();
  const blockedBankIds = new Set<string>();
  for (const plan of plans) {
    const { bank, normalized } = plan;
    const targetKey = `${bank.tenant_id}:${normalized}`;
    const currentSource = bank.source_transaction_id?.trim() || null;
    const currentOwner = currentOwners.get(targetKey);
    const plannedOwner = plannedOwners.get(targetKey);

    if (currentOwner && currentOwner !== bank.id) {
      if (currentSource === normalized) {
        // Two rows already claim the same source. Keep one canonical owner
        // and give the other a stable quarantine identity.
        plan.resolvedSource = `legacy-conflict:${normalized}:${bank.id}`;
        while (currentOwners.has(`${bank.tenant_id}:${plan.resolvedSource}`)
          || plannedOwners.has(`${bank.tenant_id}:${plan.resolvedSource}`)) {
          plan.resolvedSource += '-1';
        }
        auditIdentity(bank, 'source_identity_conflict', 'Legacy duplicate source identity quarantined without overwrite', plan.resolvedSource);
      } else {
        // Never rewrite a source to an identity owned by another bank row.
        // Audit + unchanged source is the explicit reconciliation-required
        // state consumed by import details/rollback preflight.
        plan.resolvedSource = currentSource || bank.id;
        plan.blocked = true;
        blockedBankIds.add(bank.id);
        auditIdentity(bank, 'source_identity_conflict', 'Legacy source identity is owned by another bank row; reconciliation required', normalized);
      }
    } else if (plannedOwner && plannedOwner !== bank.id) {
      plan.resolvedSource = `legacy-conflict:${normalized}:${bank.id}`;
      while (currentOwners.has(`${bank.tenant_id}:${plan.resolvedSource}`)
        || plannedOwners.has(`${bank.tenant_id}:${plan.resolvedSource}`)) {
        plan.resolvedSource += '-1';
      }
      auditIdentity(bank, 'source_identity_conflict', 'Legacy duplicate planned source identity quarantined without overwrite', plan.resolvedSource);
    }

    if (!plan.blocked) plannedOwners.set(`${bank.tenant_id}:${plan.resolvedSource}`, bank.id);
  }

  for (const plan of plans) {
    const { bank, normalized, resolvedSource } = plan;
    if (plan.blocked) continue;
    if (bank.source_transaction_id !== resolvedSource) {
      db.prepare('UPDATE bank_transactions SET source_transaction_id = ? WHERE tenant_id = ? AND id = ?')
        .run(resolvedSource, bank.tenant_id, bank.id);
      if (resolvedSource === normalized) {
        auditIdentity(bank, 'source_identity_repair', 'Legacy bank source normalized to transaction dedup identity', resolvedSource);
      }
    }

    // A legacy transaction can have the bank row id but a durable dedup hash.
    // Fill only a missing hash; never overwrite another transaction's hash.
    if (plan.txById && (!plan.txById.dedup_hash || !plan.txById.dedup_hash.trim()) && resolvedSource === normalized) {
      const owner = db.prepare(
        'SELECT id FROM transactions WHERE account_id = ? AND dedup_hash = ? AND id <> ? LIMIT 1',
      ).get(bank.account_id, resolvedSource, plan.txById.id) as { id: string } | undefined;
      if (!owner) db.prepare('UPDATE transactions SET dedup_hash = ? WHERE id = ?').run(resolvedSource, plan.txById.id);
      else auditIdentity(bank, 'source_identity_conflict', 'Legacy transaction dedup identity already belongs to another row', resolvedSource);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_tenant_source
      ON bank_transactions(tenant_id, source_transaction_id)
      WHERE source_transaction_id IS NOT NULL;
  `);

  // Legacy Pro installs can contain a bank row without its Lite compatibility
  // mirror. Recreate only missing rows; never overwrite an existing transaction.
  const normalizedBanks = db.prepare(`
    SELECT tenant_id, id, account_id, date, amount, type, counterparty, purpose,
      linked_invoice_id, status, source_transaction_id, deleted_at
    FROM bank_transactions WHERE source_transaction_id IS NOT NULL
  `).all() as Array<{
    tenant_id: string; id: string; account_id: string; date: string; amount: number; type: string;
    counterparty: string; purpose: string; linked_invoice_id: string | null; status: string;
    source_transaction_id: string; deleted_at: string | null;
  }>;
  const insertLegacyMirror = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  for (const bank of normalizedBanks) {
    if (blockedBankIds.has(bank.id)) continue;
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ? LIMIT 1').get(bank.account_id)) continue;
    const existing = db.prepare(
      'SELECT id FROM transactions WHERE account_id = ? AND dedup_hash = ? LIMIT 1',
    ).get(bank.account_id, bank.source_transaction_id) as { id: string } | undefined;
    if (!existing) {
      const result = insertLegacyMirror.run(
        bank.source_transaction_id, bank.account_id, bank.date, bank.amount, bank.type,
        bank.counterparty, bank.purpose, bank.linked_invoice_id, bank.status,
        bank.source_transaction_id, bank.deleted_at,
      );
      if (result.changes === 0 && !hasIdentityAudit(bank.id, 'source_identity_conflict')) {
        appendAuditLog(db, {
          entityType: 'bank_transaction', entityId: bank.id, action: 'source_identity_conflict',
          reason: 'Legacy mirror could not be backfilled without overwriting an existing transaction',
          before: { sourceTransactionId: bank.source_transaction_id }, after: null, actor: 'migration',
        });
      }
    }
  }
  tryAddColumn(db, 'assets', 'disposal_date', 'TEXT');
  tryAddColumn(db, 'assets', 'disposal_proceeds', 'REAL');
  tryAddColumn(db, 'assets', 'acquisition_offset_account_number', 'TEXT');
  tryAddColumn(db, 'assets', 'source_incoming_invoice_id', 'TEXT');
  tryAddColumn(db, 'assets', 'activation_journal_entry_id', 'TEXT');
  tryAddColumn(db, 'assets', 'accounting_repair_required', 'INTEGER NOT NULL DEFAULT 0');
  tryAddColumn(db, 'assets', 'accounting_repair_reason', 'TEXT');
  tryAddColumn(db, 'asset_depreciation_schedule', 'source_type', 'TEXT');
  tryAddColumn(db, 'asset_depreciation_schedule', 'source_key', 'TEXT');
  tryAddColumn(db, 'asset_movements', 'journal_entry_id', 'TEXT');
  tryAddColumn(db, 'asset_movements', 'source_type', 'TEXT');
  tryAddColumn(db, 'asset_movements', 'source_key', 'TEXT');

  // Legacy Pro databases may contain an activation movement without the
  // immutable source projection introduced later. Reuse the posted journal's
  // source identity when it is unambiguous; otherwise leave the asset in an
  // explicit repair state instead of allowing AfA to strand it.
  db.exec(`
    DROP TRIGGER IF EXISTS assets_protect_accounting_fields;
    DROP TRIGGER IF EXISTS asset_movements_no_update;
    UPDATE asset_movements
    SET source_type = (
      SELECT j.source_type FROM journal_entries j
      WHERE j.tenant_id = asset_movements.tenant_id
        AND j.id = asset_movements.journal_entry_id
        AND j.source_type IN ('asset_activation', 'incoming_invoice')
        AND j.source_key IS NOT NULL
    ),
    source_key = (
      SELECT j.source_key FROM journal_entries j
      WHERE j.tenant_id = asset_movements.tenant_id
        AND j.id = asset_movements.journal_entry_id
        AND j.source_type IN ('asset_activation', 'incoming_invoice')
        AND j.source_key IS NOT NULL
    )
    WHERE asset_movements.type = 'activation'
      AND asset_movements.journal_entry_id IS NOT NULL
      AND (asset_movements.source_type IS NULL OR asset_movements.source_key IS NULL)
      AND EXISTS (
        SELECT 1 FROM journal_entries j
        WHERE j.tenant_id = asset_movements.tenant_id
          AND j.id = asset_movements.journal_entry_id
          AND j.source_type IN ('asset_activation', 'incoming_invoice')
          AND j.source_key IS NOT NULL
      );
    UPDATE assets
    SET activation_journal_entry_id = (
      SELECT m.journal_entry_id FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
        AND m.type = 'activation' AND m.journal_entry_id IS NOT NULL
        AND m.source_type IN ('asset_activation', 'incoming_invoice')
        AND m.source_key IS NOT NULL
        AND j.source_type = m.source_type AND j.source_key = m.source_key
      ORDER BY m.created_at ASC, m.id ASC LIMIT 1
    )
    WHERE assets.status IN ('aktiv', 'voll_abgeschrieben')
      AND assets.activation_journal_entry_id IS NULL
      AND EXISTS (
        SELECT 1 FROM asset_movements m
        JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
        WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
          AND m.type = 'activation' AND m.journal_entry_id IS NOT NULL
          AND m.source_type IN ('asset_activation', 'incoming_invoice')
          AND m.source_key IS NOT NULL
          AND j.source_type = m.source_type AND j.source_key = m.source_key
      );
    UPDATE assets
    SET source_incoming_invoice_id = (
      SELECT substr(m.source_key, 18) FROM asset_movements m
      WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
        AND m.type = 'activation' AND m.source_type = 'incoming_invoice'
        AND m.source_key LIKE 'incoming-invoice:%'
      ORDER BY m.created_at ASC, m.id ASC LIMIT 1
    )
    WHERE assets.source_incoming_invoice_id IS NULL
      AND EXISTS (
        SELECT 1 FROM asset_movements m
        WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
          AND m.type = 'activation' AND m.source_type = 'incoming_invoice'
          AND m.source_key LIKE 'incoming-invoice:%'
      );
    UPDATE assets
    SET accounting_repair_required = CASE WHEN EXISTS (
      SELECT 1 FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
        AND m.type = 'activation' AND m.journal_entry_id IS NOT NULL
        AND m.source_type IN ('asset_activation', 'incoming_invoice')
        AND m.source_key IS NOT NULL
        AND j.source_type = m.source_type AND j.source_key = m.source_key
    ) THEN 0 ELSE 1 END,
    accounting_repair_reason = CASE WHEN EXISTS (
      SELECT 1 FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.tenant_id = assets.tenant_id AND m.asset_id = assets.id
        AND m.type = 'activation' AND m.journal_entry_id IS NOT NULL
        AND m.source_type IN ('asset_activation', 'incoming_invoice')
        AND m.source_key IS NOT NULL
        AND j.source_type = m.source_type AND j.source_key = m.source_key
    ) THEN NULL ELSE 'LEGACY_ACTIVATION_LINK_REQUIRED' END
    WHERE assets.status IN ('aktiv', 'voll_abgeschrieben');
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_asset_movements_tenant_asset_date
      ON asset_movements(tenant_id, asset_id, movement_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_movements_tenant_source
      ON asset_movements(tenant_id, source_type, source_key)
      WHERE source_type IS NOT NULL AND source_key IS NOT NULL;
    DROP TRIGGER IF EXISTS assets_protect_accounting_fields;
    DROP TRIGGER IF EXISTS asset_movements_require_source;
    CREATE TRIGGER assets_protect_accounting_fields
    BEFORE UPDATE ON assets FOR EACH ROW
    WHEN (EXISTS (SELECT 1 FROM asset_movements m WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id)
      OR EXISTS (SELECT 1 FROM asset_depreciation_schedule s WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'posted')
      OR COALESCE(OLD.accounting_repair_required, 0) = 1)
      AND (
        NEW.asset_number != OLD.asset_number OR NEW.asset_class != OLD.asset_class OR
        NEW.activation_date != OLD.activation_date OR NEW.acquisition_cost != OLD.acquisition_cost OR
        COALESCE(NEW.useful_life_years, -1) != COALESCE(OLD.useful_life_years, -1) OR
        NEW.depreciation_method != OLD.depreciation_method OR NEW.asset_account_number != OLD.asset_account_number OR
        COALESCE(NEW.acquisition_offset_account_number, '') != COALESCE(OLD.acquisition_offset_account_number, '') OR
        COALESCE(NEW.source_incoming_invoice_id, '') != COALESCE(OLD.source_incoming_invoice_id, '') OR
        COALESCE(NEW.activation_journal_entry_id, '') != COALESCE(OLD.activation_journal_entry_id, '') OR
        COALESCE(NEW.accounting_repair_required, 0) != COALESCE(OLD.accounting_repair_required, 0) OR
        COALESCE(NEW.accounting_repair_reason, '') != COALESCE(OLD.accounting_repair_reason, '') OR
        COALESCE(NEW.status, '') != COALESCE(OLD.status, '') OR
        COALESCE(NEW.disposal_date, '') != COALESCE(OLD.disposal_date, '') OR
        COALESCE(NEW.disposal_proceeds, -1) != COALESCE(OLD.disposal_proceeds, -1)
      )
      AND NOT (
        OLD.status = 'aktiv' AND NEW.status = 'voll_abgeschrieben' AND
        NEW.disposal_date IS NULL AND OLD.disposal_date IS NULL AND
        NOT EXISTS (SELECT 1 FROM asset_depreciation_schedule s
                    WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'planned') AND
        COALESCE((SELECT SUM(s.amount) FROM asset_depreciation_schedule s
                  WHERE s.asset_id = OLD.id AND s.tenant_id = OLD.tenant_id AND s.status = 'posted'), 0) >= OLD.acquisition_cost AND
        EXISTS (SELECT 1 FROM asset_movements m
                WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id
                  AND m.type = 'depreciation' AND m.source_type = 'asset_depreciation'
                  AND m.journal_entry_id IS NOT NULL)
      )
      AND NOT (
        OLD.accounting_repair_required = 1 AND NEW.accounting_repair_required = 0 AND
        NEW.status = OLD.status AND COALESCE(NEW.disposal_date, '') = COALESCE(OLD.disposal_date, '') AND
        COALESCE(NEW.disposal_proceeds, -1) = COALESCE(OLD.disposal_proceeds, -1) AND
        NEW.asset_number = OLD.asset_number AND NEW.asset_class = OLD.asset_class AND
        NEW.activation_date = OLD.activation_date AND NEW.acquisition_cost = OLD.acquisition_cost AND
        COALESCE(NEW.useful_life_years, -1) = COALESCE(OLD.useful_life_years, -1) AND
        NEW.depreciation_method = OLD.depreciation_method AND NEW.asset_account_number = OLD.asset_account_number AND
        COALESCE(NEW.acquisition_offset_account_number, '') = COALESCE(OLD.acquisition_offset_account_number, '') AND
        NEW.activation_journal_entry_id IS NOT NULL AND NEW.source_incoming_invoice_id IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM asset_movements m
          JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
          WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id AND m.type = 'activation'
            AND m.journal_entry_id = NEW.activation_journal_entry_id AND m.source_type = 'incoming_invoice'
            AND m.source_key = 'incoming-invoice:' || NEW.source_incoming_invoice_id
            AND j.source_type = m.source_type AND j.source_key = m.source_key
        )
      )
      AND NOT (
        OLD.status IN ('aktiv', 'voll_abgeschrieben') AND OLD.disposal_date IS NULL AND
        NEW.status IN ('verkauft', 'stillgelegt') AND NEW.disposal_date IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM asset_movements m
          JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
          WHERE m.asset_id = OLD.id AND m.tenant_id = OLD.tenant_id
            AND m.type = 'disposal' AND m.source_type = 'asset_disposal'
            AND m.source_key = 'asset_disposal:' || OLD.id AND m.journal_entry_id IS NOT NULL
            AND m.movement_date = NEW.disposal_date
            AND COALESCE(m.proceeds, -1) = COALESCE(NEW.disposal_proceeds, -1)
            AND ((m.proceeds > 0 AND NEW.status = 'verkauft') OR
                 (COALESCE(m.proceeds, 0) = 0 AND NEW.status = 'stillgelegt'))
            AND j.source_type = m.source_type AND j.source_key = m.source_key
        )
      )
    BEGIN SELECT RAISE(ABORT, 'accounting-affecting asset fields are immutable'); END;
    CREATE TRIGGER asset_movements_require_source
    BEFORE INSERT ON asset_movements FOR EACH ROW
    WHEN NEW.type IN ('activation', 'depreciation', 'disposal') AND (
      NEW.journal_entry_id IS NULL OR NEW.source_type IS NULL OR NEW.source_key IS NULL OR
      (NEW.type = 'activation' AND NEW.source_type NOT IN ('asset_activation', 'incoming_invoice')) OR
      (NEW.type = 'depreciation' AND NEW.source_type != 'asset_depreciation') OR
      (NEW.type = 'disposal' AND NEW.source_type != 'asset_disposal') OR
      NOT EXISTS (SELECT 1 FROM journal_entries j
                  WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id
                    AND j.source_type = NEW.source_type AND j.source_key = NEW.source_key)
    )
    BEGIN SELECT RAISE(ABORT, 'asset movement requires a valid journal source'); END;
    DROP TRIGGER IF EXISTS asset_movements_no_update;
    CREATE TRIGGER asset_movements_no_update BEFORE UPDATE ON asset_movements FOR EACH ROW
    WHEN NOT (
      EXISTS (
        SELECT 1 FROM assets a
        JOIN journal_entries j ON j.tenant_id = a.tenant_id AND j.id = NEW.journal_entry_id
        WHERE a.id = OLD.asset_id AND a.tenant_id = OLD.tenant_id
          AND a.accounting_repair_required = 1
          AND NEW.id = OLD.id AND NEW.asset_id = OLD.asset_id AND NEW.type = OLD.type
          AND NEW.movement_date = OLD.movement_date AND NEW.amount = OLD.amount
          AND COALESCE(NEW.proceeds, -1) = COALESCE(OLD.proceeds, -1)
          AND COALESCE(NEW.gain_loss, -1) = COALESCE(OLD.gain_loss, -1)
          AND NEW.reason = OLD.reason AND NEW.created_at = OLD.created_at
          AND NEW.type = 'activation' AND NEW.journal_entry_id IS NOT NULL
          AND OLD.journal_entry_id IS NULL AND OLD.source_type IS NULL AND OLD.source_key IS NULL
          AND NEW.source_type = 'incoming_invoice'
          AND NEW.source_key IS NOT NULL
          AND j.source_type = NEW.source_type AND j.source_key = NEW.source_key
      )
    )
    BEGIN SELECT RAISE(ABORT, 'asset movements are immutable'); END;
    DROP TRIGGER IF EXISTS asset_movements_no_delete;
    CREATE TRIGGER asset_movements_no_delete BEFORE DELETE ON asset_movements FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'asset movements are immutable'); END;
    DROP TRIGGER IF EXISTS asset_schedule_posted_no_update;
    CREATE TRIGGER asset_schedule_posted_no_update BEFORE UPDATE ON asset_depreciation_schedule FOR EACH ROW
    WHEN OLD.status = 'posted'
    BEGIN SELECT RAISE(ABORT, 'posted depreciation schedules are immutable'); END;
    DROP TRIGGER IF EXISTS asset_schedule_posted_no_delete;
    CREATE TRIGGER asset_schedule_posted_no_delete BEFORE DELETE ON asset_depreciation_schedule FOR EACH ROW
    WHEN OLD.status = 'posted'
    BEGIN SELECT RAISE(ABORT, 'posted depreciation schedules are immutable'); END;
    DROP TRIGGER IF EXISTS asset_delete_with_movements;
    CREATE TRIGGER asset_delete_with_movements BEFORE DELETE ON assets FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM asset_movements WHERE asset_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'accounting asset cannot be deleted'); END;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
    CREATE INDEX IF NOT EXISTS idx_offers_project ON offers(project_id);
    CREATE INDEX IF NOT EXISTS idx_client_projects_client ON client_projects(client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_customer_number_unique
      ON clients(customer_number)
      WHERE customer_number IS NOT NULL AND customer_number <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_projects_code_unique
      ON client_projects(code)
      WHERE code IS NOT NULL AND code <> '';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_cases (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      mechanism TEXT NOT NULL CHECK (mechanism IN ('standard_vat', 'reverse_charge', 'zero_rate', 'exempt')),
      default_rate REAL NOT NULL DEFAULT 0,
      requires_counterparty_vat_id INTEGER NOT NULL DEFAULT 0 CHECK (requires_counterparty_vat_id IN (0, 1)),
      requires_country INTEGER NOT NULL DEFAULT 0 CHECK (requires_country IN (0, 1)),
      requires_evidence INTEGER NOT NULL DEFAULT 0 CHECK (requires_evidence IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tax_cases_active
      ON tax_cases(active, key);

    CREATE TABLE IF NOT EXISTS tax_case_account_mappings (
      id TEXT PRIMARY KEY,
      chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
      tax_case_key TEXT NOT NULL REFERENCES tax_cases(key) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('output_tax', 'input_tax', 'datev_bu')),
      account_number TEXT NOT NULL,
      datev_bu_key TEXT,
      valid_from TEXT,
      valid_to TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_case_account_mappings_unique
      ON tax_case_account_mappings(chart, tax_case_key, role);
    CREATE INDEX IF NOT EXISTS idx_tax_case_account_mappings_chart_case
      ON tax_case_account_mappings(chart, tax_case_key);

    CREATE TABLE IF NOT EXISTS vat_evidence (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      draft_id TEXT,
      entry_id TEXT,
      line_id TEXT,
      tax_case_key TEXT NOT NULL,
      evidence_type TEXT,
      evidence_reference TEXT,
      country_code TEXT,
      counterparty_vat_id TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vat_evidence_entry
      ON vat_evidence(tenant_id, entry_id);
    CREATE INDEX IF NOT EXISTS idx_vat_evidence_draft
      ON vat_evidence(tenant_id, draft_id);

    CREATE TABLE IF NOT EXISTS journal_posting_pairs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      debit_line_id TEXT NOT NULL,
      credit_line_id TEXT NOT NULL,
      amount REAL NOT NULL,
      tax_case_key TEXT,
      datev_bu_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_journal_posting_pairs_entry
      ON journal_posting_pairs(tenant_id, entry_id);

    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      vendor_number TEXT,
      name TEXT NOT NULL,
      email TEXT,
      address TEXT,
      vat_id TEXT,
      iban TEXT,
      default_expense_account TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_tenant_number ON vendors(tenant_id, vendor_number);
    CREATE INDEX IF NOT EXISTS idx_vendors_tenant_name ON vendors(tenant_id, name);

    CREATE TABLE IF NOT EXISTS incoming_invoices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
      number TEXT NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      service_period TEXT,
      net_amount REAL NOT NULL,
      tax_amount REAL NOT NULL,
      gross_amount REAL NOT NULL,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_case_key TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      accounting_status TEXT NOT NULL DEFAULT 'unposted',
      accounting_snapshot_json TEXT,
      accounting_journal_entry_id TEXT,
      accounting_posted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_invoices_tenant_number ON incoming_invoices(tenant_id, number);
    CREATE INDEX IF NOT EXISTS idx_incoming_invoices_tenant_due_date ON incoming_invoices(tenant_id, due_date);

    CREATE TABLE IF NOT EXISTS incoming_invoice_lines (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      incoming_invoice_id TEXT NOT NULL REFERENCES incoming_invoices(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      net_amount REAL NOT NULL,
      tax_rate REAL NOT NULL,
      tax_amount REAL NOT NULL,
      gross_amount REAL NOT NULL,
      account_number TEXT,
      asset_account_number TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incoming_invoice_lines_invoice ON incoming_invoice_lines(incoming_invoice_id, position);

    CREATE TABLE IF NOT EXISTS accounting_account_mappings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
      role TEXT NOT NULL,
      account_number TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_account_mappings_tenant_chart_role ON accounting_account_mappings(tenant_id, chart, role);

    CREATE TABLE IF NOT EXISTS open_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      party_type TEXT NOT NULL CHECK (party_type IN ('debtor', 'creditor')),
      party_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      document_number TEXT NOT NULL,
      document_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      original_amount REAL NOT NULL,
      allocated_amount REAL NOT NULL DEFAULT 0,
      residual_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      journal_entry_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_items_tenant_source ON open_items(tenant_id, source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_open_items_tenant_status_due_date ON open_items(tenant_id, status, due_date);

    CREATE TABLE IF NOT EXISTS open_item_payments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      party_type TEXT NOT NULL CHECK (party_type IN ('debtor', 'creditor')),
      party_id TEXT,
      payment_date TEXT NOT NULL,
      amount REAL NOT NULL,
      bank_account_number TEXT NOT NULL,
      method TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      allocated_amount REAL NOT NULL DEFAULT 0,
      residual_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      journal_entry_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_item_payments_tenant_source ON open_item_payments(tenant_id, source_type, source_id);

    CREATE TABLE IF NOT EXISTS open_item_allocations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      payment_id TEXT NOT NULL REFERENCES open_item_payments(id) ON DELETE CASCADE,
      open_item_id TEXT NOT NULL REFERENCES open_items(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_open_item_allocations_payment ON open_item_allocations(tenant_id, payment_id);
    CREATE INDEX IF NOT EXISTS idx_open_item_allocations_open_item ON open_item_allocations(tenant_id, open_item_id);

    CREATE TABLE IF NOT EXISTS accounting_backfill_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      confirmation_hash TEXT NOT NULL,
      result_json TEXT,
      confirmed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_backfill_runs_tenant_status ON accounting_backfill_runs(tenant_id, status);
  `);

  // These columns were added after the first OPOS migration.  Keep old local
  // databases compatible without rebuilding the tables (which would risk
  // losing user data).
  tryAddColumn(db, 'open_item_payments', 'status', "TEXT NOT NULL DEFAULT 'open'");
  tryAddColumn(db, 'open_item_payments', 'journal_entry_id', 'TEXT');
  tryAddColumn(db, 'accounting_backfill_runs', 'result_json', 'TEXT');
  db.exec(`
    DROP TRIGGER IF EXISTS invoices_protect_posted_accounting;
    CREATE TRIGGER invoices_protect_posted_accounting
    BEFORE UPDATE ON invoices
    FOR EACH ROW WHEN OLD.accounting_status IN ('posted', 'reversed') AND (
      NEW.accounting_status != OLD.accounting_status AND NOT (NEW.accounting_status = 'reversed' AND EXISTS (SELECT 1 FROM journal_entries WHERE id = OLD.accounting_journal_entry_id AND tenant_id = 'default' AND status = 'reversed')) OR
      COALESCE(NEW.client_id, '') != COALESCE(OLD.client_id, '') OR COALESCE(NEW.client, '') != COALESCE(OLD.client, '') OR COALESCE(NEW.client_email, '') != COALESCE(OLD.client_email, '') OR
      COALESCE(NEW.client_address, '') != COALESCE(OLD.client_address, '') OR COALESCE(NEW.billing_address_json, '') != COALESCE(OLD.billing_address_json, '') OR
      COALESCE(NEW.shipping_address_json, '') != COALESCE(OLD.shipping_address_json, '') OR COALESCE(NEW.tax_mode, '') != COALESCE(OLD.tax_mode, '') OR
      COALESCE(NEW.tax_meta_json, '') != COALESCE(OLD.tax_meta_json, '') OR NEW.number != OLD.number OR NEW.date != OLD.date OR NEW.due_date != OLD.due_date OR
      COALESCE(NEW.service_period, '') != COALESCE(OLD.service_period, '') OR NEW.amount != OLD.amount OR COALESCE(NEW.tax_snapshot_json, '') != COALESCE(OLD.tax_snapshot_json, '') OR
      COALESCE(NEW.accounting_snapshot_json, '') != COALESCE(OLD.accounting_snapshot_json, '') OR
      COALESCE(NEW.accounting_journal_entry_id, '') != COALESCE(OLD.accounting_journal_entry_id, '') OR
      COALESCE(NEW.accounting_posted_at, '') != COALESCE(OLD.accounting_posted_at, '')
    ) BEGIN SELECT RAISE(ABORT, 'posted invoice accounting fields are immutable'); END;
    DROP TRIGGER IF EXISTS invoices_protect_posted_delete;
    CREATE TRIGGER invoices_protect_posted_delete
    BEFORE DELETE ON invoices FOR EACH ROW WHEN OLD.accounting_status IN ('posted', 'reversed')
    BEGIN SELECT RAISE(ABORT, 'posted invoice cannot be deleted'); END;
    DROP TRIGGER IF EXISTS invoice_items_protect_posted;
    DROP TRIGGER IF EXISTS invoice_items_insert_posted;
    CREATE TRIGGER invoice_items_insert_posted
    BEFORE INSERT ON invoice_items FOR EACH ROW WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted invoice lines are immutable'); END;
    CREATE TRIGGER invoice_items_protect_posted
    BEFORE UPDATE ON invoice_items FOR EACH ROW WHEN EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted invoice lines are immutable'); END;
    DROP TRIGGER IF EXISTS invoice_items_delete_posted;
    CREATE TRIGGER invoice_items_delete_posted
    BEFORE DELETE ON invoice_items FOR EACH ROW WHEN EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted invoice lines cannot be deleted'); END;
    DROP TRIGGER IF EXISTS incoming_invoices_protect_posted_accounting;
    CREATE TRIGGER incoming_invoices_protect_posted_accounting
    BEFORE UPDATE ON incoming_invoices
    FOR EACH ROW WHEN OLD.accounting_status IN ('posted', 'reversed') AND (
      (NEW.accounting_status != OLD.accounting_status AND NOT (NEW.accounting_status = 'reversed' AND EXISTS (SELECT 1 FROM journal_entries WHERE id = OLD.accounting_journal_entry_id AND tenant_id = OLD.tenant_id AND status = 'reversed'))) OR
      NEW.vendor_id != OLD.vendor_id OR NEW.number != OLD.number OR NEW.invoice_date != OLD.invoice_date OR
      NEW.due_date != OLD.due_date OR NEW.net_amount != OLD.net_amount OR NEW.tax_amount != OLD.tax_amount OR
      NEW.gross_amount != OLD.gross_amount OR NEW.tax_rate != OLD.tax_rate OR COALESCE(NEW.tax_case_key, '') != COALESCE(OLD.tax_case_key, '') OR COALESCE(NEW.service_period, '') != COALESCE(OLD.service_period, '') OR
      COALESCE(NEW.accounting_snapshot_json, '') != COALESCE(OLD.accounting_snapshot_json, '') OR
      COALESCE(NEW.accounting_journal_entry_id, '') != COALESCE(OLD.accounting_journal_entry_id, '') OR
      COALESCE(NEW.accounting_posted_at, '') != COALESCE(OLD.accounting_posted_at, '')
    ) BEGIN SELECT RAISE(ABORT, 'posted incoming invoice accounting fields are immutable'); END;
    DROP TRIGGER IF EXISTS incoming_invoices_protect_posted_delete;
    CREATE TRIGGER incoming_invoices_protect_posted_delete
    BEFORE DELETE ON incoming_invoices FOR EACH ROW WHEN OLD.accounting_status IN ('posted', 'reversed')
    BEGIN SELECT RAISE(ABORT, 'posted incoming invoice cannot be deleted'); END;
    DROP TRIGGER IF EXISTS incoming_invoice_lines_protect_posted;
    DROP TRIGGER IF EXISTS incoming_invoice_lines_insert_posted;
    CREATE TRIGGER incoming_invoice_lines_insert_posted
    BEFORE INSERT ON incoming_invoice_lines FOR EACH ROW WHEN EXISTS (SELECT 1 FROM incoming_invoices WHERE id = NEW.incoming_invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted incoming invoice lines are immutable'); END;
    CREATE TRIGGER incoming_invoice_lines_protect_posted
    BEFORE UPDATE ON incoming_invoice_lines FOR EACH ROW WHEN EXISTS (SELECT 1 FROM incoming_invoices WHERE id = OLD.incoming_invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted incoming invoice lines are immutable'); END;
    DROP TRIGGER IF EXISTS incoming_invoice_lines_delete_posted;
    CREATE TRIGGER incoming_invoice_lines_delete_posted
    BEFORE DELETE ON incoming_invoice_lines FOR EACH ROW WHEN EXISTS (SELECT 1 FROM incoming_invoices WHERE id = OLD.incoming_invoice_id AND accounting_status IN ('posted', 'reversed'))
    BEGIN SELECT RAISE(ABORT, 'posted incoming invoice lines cannot be deleted'); END;
  `);

  // Conservative defaults cover both German charts. Posting still validates
  // every configured account against the selected chart before writing.
  const mappingDefaults: Record<'SKR03' | 'SKR04', Record<string, string>> = {
    SKR03: {
      accounts_receivable: '1400', accounts_payable: '1600', bank: '1200',
      revenue: '8400', expense: '4900', asset: '0480', output_vat: '1776', output_vat_deferred: '1780', input_vat: '1576',
    },
    SKR04: {
      accounts_receivable: '1200', accounts_payable: '3300', bank: '1800',
      revenue: '4400', expense: '6300', asset: '0670', output_vat: '3806', output_vat_deferred: '3810', input_vat: '1406',
    },
  };
  const insertMapping = db.prepare(`
    INSERT OR IGNORE INTO accounting_account_mappings
      (id, tenant_id, chart, role, account_number, updated_at)
    VALUES (?, 'default', ?, ?, ?, ?)
  `);
  const mappingNow = new Date().toISOString();
  for (const [chart, roles] of Object.entries(mappingDefaults) as Array<['SKR03' | 'SKR04', Record<string, string>]>) {
    for (const [role, accountNumber] of Object.entries(roles)) {
      insertMapping.run(`default-${chart}-${role}`, chart, role, accountNumber, mappingNow);
    }
  }

  db.exec(`
    INSERT OR IGNORE INTO bank_transactions (
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
    )
    SELECT
      t.id,
      'default',
      t.account_id,
      t.date,
      t.amount,
      CASE WHEN t.amount >= 0 THEN 'income' ELSE 'expense' END,
      t.counterparty,
      t.purpose,
      t.linked_invoice_id,
      CASE WHEN t.status = 'booked' THEN 'booked' ELSE 'pending' END,
      t.id,
      COALESCE(t.date || 'T00:00:00.000Z', datetime('now')),
      datetime('now')
    FROM transactions t;
  `);

  // Journal source identity and accounting policy were added after the initial
  // Pro schema. Keep existing installs idempotent and preserve immutable rows.
  tryAddColumn(db, 'journal_entries', 'source_type', "TEXT NOT NULL DEFAULT 'booking_draft'");
  tryAddColumn(db, 'journal_entries', 'source_key', 'TEXT');
  // Existing installs may contain duplicate source_draft_id values from before
  // source idempotency was enforced. Repair associations without deleting any
  // journal: the earliest row remains canonical and later rows become uniquely
  // identified legacy/manual sources.
  db.exec(`
    DROP INDEX IF EXISTS idx_journal_entries_tenant_source;
    DROP INDEX IF EXISTS idx_journal_entries_tenant_source_draft;
    DROP TRIGGER IF EXISTS journal_entries_protect_core_fields;
  `);
  const repairedJournalSources = repairDuplicateJournalSourceDrafts(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_policies (
      tenant_id TEXT PRIMARY KEY,
      active_chart TEXT NOT NULL DEFAULT 'SKR03' CHECK (active_chart IN ('SKR03', 'SKR04')),
      period_policy TEXT NOT NULL DEFAULT 'calendar_month' CHECK (period_policy IN ('calendar_month')),
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_source
      ON journal_entries(tenant_id, source_type, source_key)
      WHERE source_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_source_draft
      ON journal_entries(tenant_id, source_draft_id)
      WHERE source_draft_id IS NOT NULL;
    CREATE TRIGGER journal_entries_protect_core_fields
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW
    WHEN
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.entry_number != OLD.entry_number OR
      NEW.posting_date != OLD.posting_date OR
      COALESCE(NEW.document_date, '') != COALESCE(OLD.document_date, '') OR
      NEW.booking_text != OLD.booking_text OR
      COALESCE(NEW.reference, '') != COALESCE(OLD.reference, '') OR
      NEW.period != OLD.period OR
      NEW.fiscal_year != OLD.fiscal_year OR
      COALESCE(NEW.source_draft_id, '') != COALESCE(OLD.source_draft_id, '') OR
      NEW.source_type != OLD.source_type OR
      COALESCE(NEW.source_key, '') != COALESCE(OLD.source_key, '') OR
      NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'journal_entries core fields are immutable');
    END;
    DROP TRIGGER IF EXISTS journal_entries_require_reversal_link;
    CREATE TRIGGER journal_entries_require_reversal_link
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW WHEN NEW.status = 'reversed' AND (
      NEW.reversed_entry_id IS NULL OR
      NOT EXISTS (SELECT 1 FROM journal_entries reversal
        WHERE reversal.id = NEW.reversed_entry_id
          AND reversal.source_type = 'reversal'
          AND reversal.reversed_entry_id = OLD.id)
    )
    BEGIN SELECT RAISE(ABORT, 'journal reversal requires linked reversal entry'); END;
  `);
  if (repairedJournalSources > 0) {
    logMigration(db, 'journal_source_draft_repair', 'completed', JSON.stringify({ repaired: repairedJournalSources }));
  }
  db.prepare(`
    INSERT OR IGNORE INTO accounting_policies (tenant_id, active_chart, period_policy, updated_at)
    VALUES ('default', 'SKR03', 'calendar_month', ?)
  `).run(new Date().toISOString());

  // Best-effort backfill for projects + document->project assignment.
  const now = new Date().toISOString();
  const nowDate = now.split('T')[0] ?? now;

  const existingCodeRows = db
    .prepare(`SELECT code FROM client_projects WHERE code IS NOT NULL AND code <> ''`)
    .all() as Array<{ code: string }>;
  const maxSeqByYear = new Map<string, number>();
  for (const r of existingCodeRows) {
    const m = /^PRJ-(\d{4})-(\d+)$/.exec(r.code);
    if (!m) continue;
    const year = m[1]!;
    const seq = Number(m[2]!);
    if (!Number.isFinite(seq)) continue;
    maxSeqByYear.set(year, Math.max(maxSeqByYear.get(year) ?? 0, seq));
  }

  const nextCodeForYear = (year: string): string => {
    const next = (maxSeqByYear.get(year) ?? 0) + 1;
    maxSeqByYear.set(year, next);
    return `PRJ-${year}-${String(next).padStart(3, '0')}`;
  };

  // Ensure "Allgemein" project exists for each client.
  const clientIds = db.prepare(`SELECT id FROM clients`).all() as Array<{ id: string }>;
  const findDefaultProject = db.prepare(`
    SELECT id FROM client_projects
    WHERE client_id = ? AND name = 'Allgemein' AND archived_at IS NULL
    ORDER BY start_date DESC
    LIMIT 1
  `);
  const insertProject = db.prepare(`
    INSERT INTO client_projects (
      id, client_id, code, name, status, budget, start_date, end_date, description, archived_at, created_at, updated_at
    ) VALUES (
      @id, @clientId, @code, @name, @status, @budget, @startDate, @endDate, @description, @archivedAt, @createdAt, @updatedAt
    )
  `);

  for (const c of clientIds) {
    const existing = findDefaultProject.get(c.id) as { id: string } | undefined;
    if (existing?.id) continue;
    const year = String(new Date(now).getFullYear());
    insertProject.run({
      id: randomUUID(),
      clientId: c.id,
      code: nextCodeForYear(year),
      name: 'Allgemein',
      status: 'active',
      budget: 0,
      startDate: nowDate,
      endDate: null,
      description: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Backfill missing codes/timestamps for existing projects.
  const missingProjects = db
    .prepare(`SELECT id, start_date, code, created_at, updated_at FROM client_projects`)
    .all() as Array<{
    id: string;
    start_date: string;
    code: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>;
  const updateProjectMeta = db.prepare(`
    UPDATE client_projects
      SET code = COALESCE(NULLIF(code, ''), @code),
          created_at = COALESCE(created_at, @createdAt),
          updated_at = COALESCE(updated_at, @updatedAt)
    WHERE id = @id
  `);
  for (const p of missingProjects) {
    const year = (p.start_date?.slice(0, 4) || String(new Date(now).getFullYear())).padStart(4, '0');
    const code = p.code && p.code !== '' ? p.code : nextCodeForYear(year);
    updateProjectMeta.run({
      id: p.id,
      code,
      createdAt: p.created_at ?? now,
      updatedAt: p.updated_at ?? now,
    });
  }

  // Backfill documents to default project (best-effort).
  db.exec(`
    UPDATE invoices
      SET project_id = (
        SELECT id FROM client_projects
        WHERE client_projects.client_id = invoices.client_id
          AND client_projects.name = 'Allgemein'
          AND client_projects.archived_at IS NULL
        ORDER BY client_projects.start_date DESC
        LIMIT 1
      )
    WHERE (project_id IS NULL OR project_id = '')
      AND client_id IS NOT NULL
      AND client_id <> '';

    UPDATE offers
      SET project_id = (
        SELECT id FROM client_projects
        WHERE client_projects.client_id = offers.client_id
          AND client_projects.name = 'Allgemein'
          AND client_projects.archived_at IS NULL
        ORDER BY client_projects.start_date DESC
        LIMIT 1
      )
    WHERE (project_id IS NULL OR project_id = '')
      AND client_id IS NOT NULL
      AND client_id <> '';
  `);

  // Backfill customer numbers for legacy clients.
  const settingsRow = db
    .prepare('SELECT settings_json FROM settings WHERE id = 1')
    .get() as { settings_json: string } | undefined;
  let settingsJson: any = {};
  if (settingsRow?.settings_json) {
    try {
      settingsJson = JSON.parse(settingsRow.settings_json);
    } catch {
      settingsJson = {};
    }
  }
  settingsJson = settingsJson && typeof settingsJson === 'object' ? settingsJson : {};
  settingsJson.numbers = settingsJson.numbers && typeof settingsJson.numbers === 'object'
    ? settingsJson.numbers
    : {};
  const isSmallBusiness = Boolean(settingsJson?.legal?.smallBusinessRule);
  const defaultVatRate = Number(settingsJson?.legal?.defaultVatRate) || 0;
  const defaultTaxMode = isSmallBusiness ? 'small_business_19_ustg' : 'standard_vat';

  const invoiceTaxRows = db.prepare(`
    SELECT id, tax_mode, tax_snapshot_json, (
      SELECT COALESCE(SUM(total), 0) FROM invoice_items WHERE invoice_id = invoices.id
    ) AS net_total
    FROM invoices
  `).all() as Array<{
    id: string;
    tax_mode: string | null;
    tax_snapshot_json: string | null;
    net_total: number | null;
  }>;
  const updateInvoiceTax = db.prepare(`
    UPDATE invoices
       SET tax_mode = COALESCE(NULLIF(tax_mode, ''), @taxMode),
           tax_snapshot_json = COALESCE(tax_snapshot_json, @taxSnapshotJson)
     WHERE id = @id
  `);
  for (const row of invoiceTaxRows) {
    const netAmount = Number(row.net_total) || 0;
    const vatAmount = isSmallBusiness ? 0 : netAmount * (defaultVatRate / 100);
    updateInvoiceTax.run({
      id: row.id,
      taxMode: row.tax_mode ?? defaultTaxMode,
      taxSnapshotJson:
        row.tax_snapshot_json ??
        JSON.stringify({
          vatRateApplied: isSmallBusiness ? 0 : defaultVatRate,
          vatAmount,
          netAmount,
          grossAmount: netAmount + vatAmount,
          label: isSmallBusiness ? 'Kleinunternehmer (§19 UStG)' : `MwSt. ${defaultVatRate}%`,
          einvoiceCategoryCode: isSmallBusiness ? 'E' : 'S',
        }),
    });
  }

  const offerTaxRows = db.prepare(`
    SELECT id, tax_mode, tax_snapshot_json, (
      SELECT COALESCE(SUM(total), 0) FROM offer_items WHERE offer_id = offers.id
    ) AS net_total
    FROM offers
  `).all() as Array<{
    id: string;
    tax_mode: string | null;
    tax_snapshot_json: string | null;
    net_total: number | null;
  }>;
  const updateOfferTax = db.prepare(`
    UPDATE offers
       SET tax_mode = COALESCE(NULLIF(tax_mode, ''), @taxMode),
           tax_snapshot_json = COALESCE(tax_snapshot_json, @taxSnapshotJson)
     WHERE id = @id
  `);
  for (const row of offerTaxRows) {
    const netAmount = Number(row.net_total) || 0;
    const vatAmount = isSmallBusiness ? 0 : netAmount * (defaultVatRate / 100);
    updateOfferTax.run({
      id: row.id,
      taxMode: row.tax_mode ?? defaultTaxMode,
      taxSnapshotJson:
        row.tax_snapshot_json ??
        JSON.stringify({
          vatRateApplied: isSmallBusiness ? 0 : defaultVatRate,
          vatAmount,
          netAmount,
          grossAmount: netAmount + vatAmount,
          label: isSmallBusiness ? 'Kleinunternehmer (§19 UStG)' : `MwSt. ${defaultVatRate}%`,
          einvoiceCategoryCode: isSmallBusiness ? 'E' : 'S',
        }),
    });
  }

  // The backfill above deliberately never rewrites `amount`: a sent or exported
  // document is an accounting artifact and must keep the figure it was issued
  // with. Pro used to compute that figure without the per-document tax mode, so
  // some legacy rows can disagree with the freshly derived snapshot. Surface
  // those instead of silently "correcting" them — the decision is the operator's.
  const reportTaxDrift = (table: 'invoices' | 'offers', itemsTable: string, idColumn: string) => {
    const drifted = db
      .prepare(
        `SELECT id, amount, (
           SELECT COALESCE(SUM(total), 0) FROM ${itemsTable} WHERE ${idColumn} = ${table}.id
         ) AS net_total
         FROM ${table}`,
      )
      .all() as Array<{ id: string; amount: number | null; net_total: number | null }>;

    const mismatches = drifted.filter((row) => {
      const net = Number(row.net_total) || 0;
      const expected = net + (isSmallBusiness ? 0 : net * (defaultVatRate / 100));
      const stored = Number(row.amount) || 0;
      return Math.abs(expected - stored) > 0.01;
    });

    if (mismatches.length > 0) {
      console.warn(
        `[Migration] ${mismatches.length} ${table} have a stored amount that does not match the ` +
          `recomputed tax total. Amounts were left untouched. Affected ids: ` +
          mismatches.slice(0, 20).map((row) => row.id).join(', ') +
          (mismatches.length > 20 ? ` (+${mismatches.length - 20} more)` : ''),
      );
    }
  };

  reportTaxDrift('invoices', 'invoice_items', 'invoice_id');
  reportTaxDrift('offers', 'offer_items', 'offer_id');

  const nowYear = String(new Date().getFullYear());
  const customerPrefixTemplate =
    typeof settingsJson.numbers.customerPrefix === 'string'
      ? settingsJson.numbers.customerPrefix
      : 'KD-';
  const customerPrefix = customerPrefixTemplate.replace(/%Y/g, nowYear);
  const customerNumberLength = Math.max(
    1,
    Number.isFinite(settingsJson.numbers.customerNumberLength)
      ? Math.floor(settingsJson.numbers.customerNumberLength)
      : 4,
  );
  let nextCustomerNumber = Math.max(
    1,
    Number.isFinite(settingsJson.numbers.nextCustomerNumber)
      ? Math.floor(settingsJson.numbers.nextCustomerNumber)
      : 1,
  );

  const formatCustomerNumber = (n: number): string =>
    `${customerPrefix}${String(n).padStart(customerNumberLength, '0')}`;

  const usedCustomerNumbers = new Set(
    (
      db
        .prepare(`SELECT customer_number FROM clients WHERE customer_number IS NOT NULL AND customer_number <> ''`)
        .all() as Array<{ customer_number: string }>
    )
      .map((r) => r.customer_number)
      .filter(Boolean),
  );

  const missingCustomerRows = db
    .prepare(
      `SELECT id FROM clients
       WHERE customer_number IS NULL OR TRIM(customer_number) = ''
       ORDER BY rowid ASC`,
    )
    .all() as Array<{ id: string }>;
  const setCustomerNumber = db.prepare(
    'UPDATE clients SET customer_number = ? WHERE id = ?',
  );

  for (const row of missingCustomerRows) {
    let candidate = formatCustomerNumber(nextCustomerNumber);
    while (usedCustomerNumbers.has(candidate)) {
      nextCustomerNumber += 1;
      candidate = formatCustomerNumber(nextCustomerNumber);
    }
    setCustomerNumber.run(candidate, row.id);
    usedCustomerNumbers.add(candidate);
    nextCustomerNumber += 1;
  }

  while (usedCustomerNumbers.has(formatCustomerNumber(nextCustomerNumber))) {
    nextCustomerNumber += 1;
  }

  settingsJson.numbers.customerPrefix = customerPrefixTemplate;
  settingsJson.numbers.customerNumberLength = customerNumberLength;
  settingsJson.numbers.nextCustomerNumber = nextCustomerNumber;
  settingsJson.eInvoice = settingsJson.eInvoice && typeof settingsJson.eInvoice === 'object'
    ? settingsJson.eInvoice
    : {};
  if (typeof settingsJson.eInvoice.enabled !== 'boolean') settingsJson.eInvoice.enabled = false;
  if (settingsJson.eInvoice.standard !== 'zugferd-en16931') settingsJson.eInvoice.standard = 'zugferd-en16931';
  if (settingsJson.eInvoice.profile !== 'EN16931') settingsJson.eInvoice.profile = 'EN16931';
  if (settingsJson.eInvoice.version !== '2.3') settingsJson.eInvoice.version = '2.3';
  db.prepare('UPDATE settings SET settings_json = ? WHERE id = 1').run(JSON.stringify(settingsJson));

  // Backfill document-side customer number snapshots.
  db.exec(`
    UPDATE invoices
      SET client_number = (
        SELECT customer_number FROM clients WHERE clients.id = invoices.client_id
      )
    WHERE (client_number IS NULL OR TRIM(client_number) = '')
      AND client_id IS NOT NULL
      AND client_id <> '';

    UPDATE offers
      SET client_number = (
        SELECT customer_number FROM clients WHERE clients.id = offers.client_id
      )
    WHERE (client_number IS NULL OR TRIM(client_number) = '')
      AND client_id IS NOT NULL
      AND client_id <> '';
  `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        mapping_json TEXT NOT NULL,
        imported_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_import_batches_account ON import_batches(account_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS email_log (
        id TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_number TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_log_document ON email_log(document_type, document_id);

      CREATE TABLE IF NOT EXISTS dunning_history (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        invoice_number TEXT NOT NULL,
        dunning_level INTEGER NOT NULL,
        days_overdue INTEGER NOT NULL,
        fee_applied REAL NOT NULL,
        email_sent INTEGER NOT NULL DEFAULT 0,
        email_log_id TEXT,
        processed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dunning_history_invoice ON dunning_history(invoice_id, dunning_level);
    `);

  // Import batches: rollback support
  ensureReportMappingStatementSchema(db);
  tryAddColumn(db, 'import_batches', 'rolled_back_at', 'TEXT');
  tryAddColumn(db, 'import_batches', 'rollback_reason', 'TEXT');
  tryAddColumn(db, 'eur_classifications', 'vat_rate', 'REAL');
  tryAddColumn(db, 'eur_lines', 'provider_path', "TEXT NOT NULL DEFAULT 'main'");
  tryAddColumn(db, 'eur_lines', 'computed_terms_json', 'TEXT');

  db.exec(`
      CREATE TABLE IF NOT EXISTS eur_lines (
        id TEXT PRIMARY KEY,
        tax_year INTEGER NOT NULL,
        provider_path TEXT NOT NULL DEFAULT 'main',
        kennziffer TEXT,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'computed')),
        exportable INTEGER NOT NULL DEFAULT 1 CHECK (exportable IN (0, 1)),
        sort_order INTEGER NOT NULL,
        computed_from_json TEXT,
        computed_terms_json TEXT,
        source_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eur_lines_year_sort
        ON eur_lines(tax_year, sort_order);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_lines_year_provider_kennziffer
        ON eur_lines(tax_year, provider_path, kennziffer)
        WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> '';

      CREATE TABLE IF NOT EXISTS eur_classifications (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK (source_type IN ('transaction', 'invoice')),
        source_id TEXT NOT NULL,
        tax_year INTEGER NOT NULL,
        eur_line_id TEXT REFERENCES eur_lines(id) ON DELETE SET NULL,
        excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        vat_mode TEXT NOT NULL DEFAULT 'none' CHECK (vat_mode IN ('none', 'default')),
        vat_rate REAL,
        note TEXT,
        updated_at TEXT NOT NULL,
        CHECK (NOT (excluded = 1 AND eur_line_id IS NOT NULL))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_classifications_source_year
        ON eur_classifications(source_type, source_id, tax_year);

      CREATE INDEX IF NOT EXISTS idx_eur_classifications_year
        ON eur_classifications(tax_year);
    `);

  db.exec(`
      DROP INDEX IF EXISTS idx_eur_lines_year_kennziffer;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_lines_year_provider_kennziffer
        ON eur_lines(tax_year, provider_path, kennziffer)
        WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> '';
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS eur_rules (
        id TEXT PRIMARY KEY,
        tax_year INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'purpose', 'any')),
        operator TEXT NOT NULL CHECK (operator IN ('contains', 'equals', 'startsWith')),
        value TEXT NOT NULL,
        target_eur_line_id TEXT NOT NULL REFERENCES eur_lines(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eur_rules_year_priority
        ON eur_rules(tax_year, priority);
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS account_keywords (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
        account_number TEXT NOT NULL,
        keyword TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('name', 'curated', 'user', 'import')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_account
        ON account_keywords(tenant_id, chart, account_number);
      CREATE INDEX IF NOT EXISTS idx_account_keywords_tenant_chart_keyword
        ON account_keywords(tenant_id, chart, keyword);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_account_keywords_unique
        ON account_keywords(tenant_id, chart, account_number, keyword);

      CREATE TABLE IF NOT EXISTS account_suggestion_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        chart TEXT NOT NULL CHECK (chart IN ('SKR03', 'SKR04')),
        priority INTEGER NOT NULL,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'purpose', 'any')),
        operator TEXT NOT NULL CHECK (operator IN ('contains', 'equals', 'startsWith')),
        value TEXT NOT NULL,
        target_account_number TEXT NOT NULL,
        flow_type TEXT NOT NULL DEFAULT 'any' CHECK (flow_type IN ('income', 'expense', 'any')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_account_suggestion_rules_tenant_chart_priority
        ON account_suggestion_rules(tenant_id, chart, priority);
  `);
  ensureTaxCaseSeedData(db);

  seedEurCatalog(db, 2025);
  seedEurCatalog(db, 2026);

  db.exec(`
      CREATE TABLE IF NOT EXISTS number_reservations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        number TEXT NOT NULL,
        counter_value INTEGER NOT NULL,
        status TEXT NOT NULL,
        document_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_number_reservations_status_kind
        ON number_reservations(status, kind);
    `);

    // Log migration completion
    logMigration(db, `migration_run_${migrationVersion}`, 'completed');
  } catch (error) {
    // Log migration failure
    const errorMessage = error instanceof Error ? error.message : String(error);
    logMigration(db, `migration_run_${migrationVersion}`, 'failed', errorMessage);
    console.error('[Migration] Failed:', errorMessage);
    throw error;
  }
};
