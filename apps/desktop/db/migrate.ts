import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

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

    // Projects: code + archive metadata
  tryAddColumn(db, 'client_projects', 'code', 'TEXT');
  tryAddColumn(db, 'client_projects', 'archived_at', 'TEXT');
  tryAddColumn(db, 'client_projects', 'created_at', 'TEXT');
  tryAddColumn(db, 'client_projects', 'updated_at', 'TEXT');

  // Invoices: structured address snapshots
  addColumnIfMissing(db, 'invoices', 'billing_address_json', 'TEXT');
  addColumnIfMissing(db, 'invoices', 'shipping_address_json', 'TEXT');

  // Offers: structured address snapshots
  addColumnIfMissing(db, 'offers', 'billing_address_json', 'TEXT');
  addColumnIfMissing(db, 'offers', 'shipping_address_json', 'TEXT');

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
  addColumnIfMissing(db, 'offer_items', 'article_id', 'TEXT');
  addColumnIfMissing(db, 'offer_items', 'category', 'TEXT');

  // Finance: transaction import support (non-audit-locked)
  tryAddColumn(db, 'transactions', 'dedup_hash', 'TEXT');
  tryAddColumn(db, 'transactions', 'import_batch_id', 'TEXT');
  tryAddColumn(db, 'transactions', 'deleted_at', 'TEXT');

  const transactionCols = getColumns(db, 'transactions');
  if (transactionCols.has('dedup_hash')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedup
        ON transactions(account_id, dedup_hash)
        WHERE dedup_hash IS NOT NULL;
    `);
  }

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
