import crypto from 'node:crypto';
import type { PostgresQueryable } from './connection.js';
import { exportPostgresAuditCsv, verifyPostgresAuditChain } from './audit.js';

export type TaxAuditExportPackageArgs = {
  from?: string;
  to?: string;
  includeDocuments?: boolean;
};

export type TaxAuditExportArtifactFile = {
  name: string;
  content: string;
  /** 'base64' for binary receipts (Belegdateien); sha256 and sizeBytes are over the decoded bytes. */
  encoding?: 'base64';
  sha256: string;
  sizeBytes: number;
  rowCount?: number;
};

export type TaxAuditExportArtifact = {
  schemaVersion: 1;
  createdAt: string;
  from: string | null;
  to: string | null;
  includeDocuments: boolean;
  files: TaxAuditExportArtifactFile[];
};

type Dataset = {
  name: string;
  table: string;
  dateColumn?: string;
  /** Rows that belong to a parent row with the date: `<fk column>:<parent table>:<parent date column>`. */
  dateVia?: string;
  columns?: string;
  orderBy: string;
};

// What a Betriebsprüfer asks for under § 147 AO / GoBD (Z3 Datenträgerüberlassung): journal, chart of
// accounts, master data, receipts, open items, asset register and the mappings behind the reports.
// The retired account_mappings_hgb table is not exported; report mappings live in report_account_mappings.
const datasets: Dataset[] = [
  { name: 'journal-entries.jsonl', table: 'journal_entries', dateColumn: 'posting_date', orderBy: 'posting_date ASC, entry_number ASC' },
  { name: 'journal-lines.jsonl', table: 'journal_lines', dateVia: 'entry_id:journal_entries:posting_date', orderBy: 'entry_id ASC, line_no ASC' },
  { name: 'journal-posting-pairs.jsonl', table: 'journal_posting_pairs', dateVia: 'entry_id:journal_entries:posting_date', orderBy: 'entry_id ASC, id ASC' },
  { name: 'accounting-periods.jsonl', table: 'accounting_periods', dateColumn: 'starts_at', orderBy: 'period ASC' },
  { name: 'customers.jsonl', table: 'clients', orderBy: 'id ASC' },
  { name: 'vendors.jsonl', table: 'vendors', orderBy: 'id ASC' },
  { name: 'incoming-invoices.jsonl', table: 'incoming_invoices', dateColumn: 'invoice_date', orderBy: 'invoice_date ASC, id ASC' },
  { name: 'incoming-invoice-lines.jsonl', table: 'incoming_invoice_lines', dateVia: 'incoming_invoice_id:incoming_invoices:invoice_date', orderBy: 'incoming_invoice_id ASC, position ASC' },
  { name: 'incoming-invoice-documents.jsonl', table: 'incoming_invoice_documents', dateVia: 'incoming_invoice_id:incoming_invoices:invoice_date', columns: 'id,tenant_id,incoming_invoice_id,original_filename,mime_type,byte_length,sha256,review_status,created_at,updated_at', orderBy: 'incoming_invoice_id ASC, created_at ASC, id ASC' },
  { name: 'open-items.jsonl', table: 'open_items', dateColumn: 'document_date', orderBy: 'document_date ASC, id ASC' },
  { name: 'open-item-payments.jsonl', table: 'open_item_payments', dateColumn: 'payment_date', orderBy: 'payment_date ASC, id ASC' },
  { name: 'open-item-allocations.jsonl', table: 'open_item_allocations', dateVia: 'payment_id:open_item_payments:payment_date', orderBy: 'payment_id ASC, id ASC' },
  // The asset register is exported whole: the book values of the period depend on every earlier year.
  { name: 'assets.jsonl', table: 'assets', orderBy: 'asset_number ASC, id ASC' },
  { name: 'asset-depreciation-schedule.jsonl', table: 'asset_depreciation_schedule', orderBy: 'asset_id ASC, year ASC' },
  { name: 'asset-movements.jsonl', table: 'asset_movements', orderBy: 'movement_date ASC, id ASC' },
  { name: 'accounting-account-mappings.jsonl', table: 'accounting_account_mappings', orderBy: 'chart ASC, role ASC' },
  { name: 'tax-case-account-mappings.jsonl', table: 'tax_case_account_mappings', orderBy: 'chart ASC, tax_case_key ASC, role ASC, id ASC' },
  { name: 'report-account-mappings.jsonl', table: 'report_account_mappings', orderBy: 'report_type ASC, account_number ASC, version ASC' },
  { name: 'bank-transactions.jsonl', table: 'bank_transactions', dateColumn: 'date', orderBy: 'date ASC, id ASC' },
  { name: 'datev-exports.jsonl', table: 'datev_exports', dateColumn: 'created_at', orderBy: 'created_at ASC, id ASC' },
  { name: 'booking-drafts.jsonl', table: 'booking_drafts', dateColumn: 'updated_at', orderBy: 'updated_at ASC, id ASC' },
  { name: 'draft-validation-issues.jsonl', table: 'draft_validation_issues', dateColumn: 'created_at', orderBy: 'created_at ASC, id ASC' },
];

const documentDatasets: Dataset[] = [
  { name: 'invoices.jsonl', table: 'invoices', dateColumn: 'date', orderBy: 'date ASC, id ASC' },
  { name: 'offers.jsonl', table: 'offers', dateColumn: 'date', orderBy: 'date ASC, id ASC' },
  { name: 'transactions-legacy.jsonl', table: 'transactions', dateColumn: 'date', orderBy: 'date ASC, id ASC' },
];

const queryRows = async (
  target: PostgresQueryable,
  dataset: Dataset,
  tenantId: string,
  args: TaxAuditExportPackageArgs,
): Promise<unknown[]> => {
  const values: unknown[] = [tenantId];
  const predicates = ['tenant_id = $1'];
  if (args.from && dataset.dateColumn) {
    values.push(args.from);
    predicates.push(`${dataset.dateColumn} >= $${values.length}`);
  }
  if (args.to && dataset.dateColumn) {
    values.push(args.to);
    predicates.push(`${dataset.dateColumn} <= $${values.length}`);
  }
  if (dataset.dateVia && (args.from || args.to)) {
    const [column, parent, parentDate] = dataset.dateVia.split(':');
    const range: string[] = [];
    if (args.from) { values.push(args.from); range.push(`${parentDate} >= $${values.length}`); }
    if (args.to) { values.push(args.to); range.push(`${parentDate} <= $${values.length}`); }
    predicates.push(`${column} IN (SELECT id FROM ${parent} WHERE tenant_id = $1 AND ${range.join(' AND ')})`);
  }
  const result = await target.query(
    `SELECT ${dataset.columns ?? '*'} FROM ${dataset.table} WHERE ${predicates.join(' AND ')} ORDER BY ${dataset.orderBy}`,
    values,
  );
  return result.rows;
};

const jsonl = (rows: unknown[]): string => rows
  .map((row) => JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value))
  .join('\n');

const file = (name: string, content: string, rowCount?: number): TaxAuditExportArtifactFile => ({
  name,
  content,
  sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
  sizeBytes: Buffer.byteLength(content, 'utf8'),
  ...(rowCount === undefined ? {} : { rowCount }),
});

/**
 * Build the tax audit package contents from the tenant-scoped Postgres/PGlite
 * database. Filesystem persistence intentionally belongs to the Electron
 * native boundary, not this server/data service.
 */
export const buildPostgresTaxAuditExportArtifact = async (
  target: PostgresQueryable,
  tenantId: string,
  args: TaxAuditExportPackageArgs = {},
): Promise<TaxAuditExportArtifact> => {
  const createdAt = new Date().toISOString();
  const files: TaxAuditExportArtifactFile[] = [];
  const auditCsv = await exportPostgresAuditCsv(target, tenantId);
  files.push(file('audit-log.csv', auditCsv, auditCsv.split('\n').length - 1));

  const selectedDatasets = args.includeDocuments ? [...datasets, ...documentDatasets] : datasets;
  for (const dataset of selectedDatasets) {
    const rows = await queryRows(target, dataset, tenantId, args);
    files.push(file(dataset.name, jsonl(rows), rows.length));
  }

  // Kontenplan: the DATEV catalogue of the active chart plus the tenant's own and deactivated accounts.
  const chart = String((await target.query(`SELECT active_chart FROM accounting_policies WHERE tenant_id = $1`, [tenantId])).rows[0]?.active_chart ?? 'SKR03');
  const accounts = (await target.query(
    `SELECT COALESCE(t.chart, g.chart) AS chart, COALESCE(t.account_number, g.account_number) AS account_number, COALESCE(t.name, g.name) AS name,
       COALESCE(t.active, TRUE) AS active, CASE WHEN g.account_number IS NULL THEN 'tenant' ELSE 'datev' END AS source
     FROM (SELECT * FROM ledger_accounts WHERE chart = $2) g
     FULL OUTER JOIN (SELECT * FROM tenant_ledger_accounts WHERE tenant_id = $1 AND chart = $2) t ON t.account_number = g.account_number
     ORDER BY 2`,
    [tenantId, chart],
  )).rows;
  files.push(file('chart-of-accounts.jsonl', jsonl(accounts), accounts.length));

  // The receipts themselves (bytes as stored, hash checked against the archive) when documents are requested.
  if (args.includeDocuments) {
    const receipts = (await target.query(
      `SELECT d.id, d.original_filename, d.sha256, d.content_bytes FROM incoming_invoice_documents d
       JOIN incoming_invoices i ON i.tenant_id = d.tenant_id AND i.id = d.incoming_invoice_id
       WHERE d.tenant_id = $1${args.from ? ' AND i.invoice_date >= $2' : ''}${args.to ? ` AND i.invoice_date <= $${args.from ? 3 : 2}` : ''}
       ORDER BY d.incoming_invoice_id, d.created_at, d.id`,
      [tenantId, ...(args.from ? [args.from] : []), ...(args.to ? [args.to] : [])],
    )).rows as Array<{ id: string; original_filename: string; sha256: string; content_bytes: Uint8Array }>;
    for (const receipt of receipts) {
      const bytes = Buffer.from(receipt.content_bytes);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== receipt.sha256.toLowerCase()) throw new Error(`INCOMING_INVOICE_DOCUMENT_HASH_MISMATCH:${receipt.id}`);
      const extension = (/\.([A-Za-z0-9]{1,5})$/.exec(receipt.original_filename)?.[1] ?? 'bin').toLowerCase();
      files.push({ name: `beleg-${receipt.id.replace(/[^A-Za-z0-9_-]/g, '-')}.${extension}`, content: bytes.toString('base64'), encoding: 'base64', sha256, sizeBytes: bytes.byteLength });
    }
  }

  files.push(file(
    'audit-chain-verification.json',
    JSON.stringify(await verifyPostgresAuditChain(target, tenantId), null, 2),
  ));

  return {
    schemaVersion: 1,
    createdAt,
    from: args.from ?? null,
    to: args.to ?? null,
    includeDocuments: Boolean(args.includeDocuments),
    files,
  };
};
