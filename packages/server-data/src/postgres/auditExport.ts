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
  orderBy: string;
};

const datasets: Dataset[] = [
  { name: 'journal-entries.jsonl', table: 'journal_entries', dateColumn: 'posting_date', orderBy: 'posting_date ASC, entry_number ASC' },
  { name: 'journal-lines.jsonl', table: 'journal_lines', orderBy: 'entry_id ASC, line_no ASC' },
  { name: 'journal-posting-pairs.jsonl', table: 'journal_posting_pairs', orderBy: 'entry_id ASC, id ASC' },
  { name: 'accounting-periods.jsonl', table: 'accounting_periods', dateColumn: 'starts_at', orderBy: 'period ASC' },
  { name: 'account-mappings-hgb.jsonl', table: 'account_mappings_hgb', orderBy: 'statement_type ASC, account_number ASC' },
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
  const result = await target.query(
    `SELECT * FROM ${dataset.table} WHERE ${predicates.join(' AND ')} ORDER BY ${dataset.orderBy}`,
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
