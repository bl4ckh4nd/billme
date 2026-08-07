import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { seedEurCatalog } from './eurCatalogRepo';

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
  addColumnIfMissing(db, 'offer_items', 'article_id', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'category', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'unit', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'discount_percent', 'REAL');
  addColumnIfMissing(db, 'offer_items', 'tax_rate', 'REAL');

  // Finance: transaction import support (non-audit-locked)
  tryAddColumn(db, 'accounts', 'default_skr_account_number', "TEXT NOT NULL DEFAULT '1200'");
  tryAddColumn(db, 'transactions', 'dedup_hash', 'TEXT');
  tryAddColumn(db, 'transactions', 'import_batch_id', 'TEXT');
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
      reversed_entry_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_entry_number
      ON journal_entries(tenant_id, entry_number);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_posting_date
      ON journal_entries(tenant_id, posting_date DESC);

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
      posted_at TEXT
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
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_mappings_unique
      ON account_mappings_hgb(tenant_id, chart, account_number, statement_type);

    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      report_type TEXT NOT NULL,
      args_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type
      ON report_snapshots(tenant_id, report_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS datev_exports (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      file_path TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      from_date TEXT,
      to_date TEXT,
      created_at TEXT NOT NULL,
      meta_json TEXT NOT NULL
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

  tryAddColumn(db, 'assets', 'disposal_date', 'TEXT');
  tryAddColumn(db, 'assets', 'disposal_proceeds', 'REAL');

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
  `);

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
  tryAddColumn(db, 'import_batches', 'rolled_back_at', 'TEXT');
  tryAddColumn(db, 'import_batches', 'rollback_reason', 'TEXT');

  db.exec(`
      CREATE TABLE IF NOT EXISTS eur_lines (
        id TEXT PRIMARY KEY,
        tax_year INTEGER NOT NULL,
        kennziffer TEXT,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'computed')),
        exportable INTEGER NOT NULL DEFAULT 1 CHECK (exportable IN (0, 1)),
        sort_order INTEGER NOT NULL,
        computed_from_json TEXT,
        source_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eur_lines_year_sort
        ON eur_lines(tax_year, sort_order);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_lines_year_kennziffer
        ON eur_lines(tax_year, kennziffer)
        WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> '';

      CREATE TABLE IF NOT EXISTS eur_classifications (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK (source_type IN ('transaction', 'invoice')),
        source_id TEXT NOT NULL,
        tax_year INTEGER NOT NULL,
        eur_line_id TEXT REFERENCES eur_lines(id) ON DELETE SET NULL,
        excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        vat_mode TEXT NOT NULL DEFAULT 'none' CHECK (vat_mode IN ('none', 'default')),
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

  seedEurCatalog(db, 2025);

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
