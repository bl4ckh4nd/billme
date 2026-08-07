import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { and, asc, gte, lte } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import { exportAuditCsv, verifyAuditChain } from '../db/audit';

export interface TaxAuditExportPackageArgs {
  from?: string;
  to?: string;
  includeDocuments?: boolean;
}

export interface TaxAuditExportBundleFile {
  name: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  rowCount?: number;
}

export interface TaxAuditExportPackageResult {
  bundleDir: string;
  manifestPath: string;
  createdAt: string;
  fileCount: number;
  files: TaxAuditExportBundleFile[];
}

const sha256File = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const writeJsonl = (filePath: string, rows: unknown[]): { sizeBytes: number; rowCount: number } => {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  const stat = fs.statSync(filePath);
  return { sizeBytes: stat.size, rowCount: rows.length };
};

const queryRows = (
  db: Database.Database,
  table: string,
  orderBy: string,
  args: TaxAuditExportPackageArgs,
): unknown[] => {
  const drizzleDb = createDrizzle(db);
  const configs: Record<string, { table: any; dateColumn?: any; orderBy: any[] }> = {
    journal_entries: { table: schema.journalEntries, dateColumn: schema.journalEntries.postingDate, orderBy: [asc(schema.journalEntries.postingDate), asc(schema.journalEntries.entryNumber)] },
    journal_lines: { table: schema.journalLines, orderBy: [asc(schema.journalLines.entryId), asc(schema.journalLines.lineNo)] },
    accounting_periods: { table: schema.accountingPeriods, dateColumn: schema.accountingPeriods.startsAt, orderBy: [asc(schema.accountingPeriods.period)] },
    account_mappings_hgb: { table: schema.accountMappingsHgb, orderBy: [asc(schema.accountMappingsHgb.statementType), asc(schema.accountMappingsHgb.accountNumber)] },
    bank_transactions: { table: schema.bankTransactions, dateColumn: schema.bankTransactions.date, orderBy: [asc(schema.bankTransactions.date), asc(schema.bankTransactions.id)] },
    datev_exports: { table: schema.datevExports, dateColumn: schema.datevExports.createdAt, orderBy: [asc(schema.datevExports.createdAt), asc(schema.datevExports.id)] },
    booking_drafts: { table: schema.bookingDrafts, dateColumn: schema.bookingDrafts.updatedAt, orderBy: [asc(schema.bookingDrafts.updatedAt), asc(schema.bookingDrafts.id)] },
    draft_validation_issues: { table: schema.draftValidationIssues, dateColumn: schema.draftValidationIssues.createdAt, orderBy: [asc(schema.draftValidationIssues.createdAt), asc(schema.draftValidationIssues.id)] },
    invoices: { table: schema.invoices, dateColumn: schema.invoices.date, orderBy: [asc(schema.invoices.date), asc(schema.invoices.id)] },
    offers: { table: schema.offers, dateColumn: schema.offers.date, orderBy: [asc(schema.offers.date), asc(schema.offers.id)] },
    transactions: { table: schema.transactions, dateColumn: schema.transactions.date, orderBy: [asc(schema.transactions.date), asc(schema.transactions.id)] },
  };
  const config = configs[table];
  if (!config) throw new Error(`Unsupported tax audit export table: ${table}`);
  const predicates = [];
  if (args.from && config.dateColumn) predicates.push(gte(config.dateColumn, args.from));
  if (args.to && config.dateColumn) predicates.push(lte(config.dateColumn, args.to));
  const query = drizzleDb.select().from(config.table);
  if (predicates.length) query.where(and(...predicates));
  return query.orderBy(...config.orderBy).all() as unknown[];
};

export const buildTaxAuditExportPackage = (
  db: Database.Database,
  userDataPath: string,
  args: TaxAuditExportPackageArgs = {},
): TaxAuditExportPackageResult => {
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const bundleDir = path.join(userDataPath, 'exports', 'tax-audit-packages', `tax-audit-${stamp}`);
  fs.mkdirSync(bundleDir, { recursive: true });

  const files: TaxAuditExportBundleFile[] = [];

  const writeBundleFile = (name: string, contents: string, rowCount?: number): void => {
    const target = path.join(bundleDir, name);
    fs.writeFileSync(target, contents, 'utf8');
    const stat = fs.statSync(target);
    files.push({
      name,
      path: target,
      sha256: sha256File(target),
      sizeBytes: stat.size,
      rowCount,
    });
  };

  const writeBundleJsonl = (name: string, rows: unknown[]): void => {
    const target = path.join(bundleDir, name);
    const info = writeJsonl(target, rows);
    files.push({
      name,
      path: target,
      sha256: sha256File(target),
      sizeBytes: info.sizeBytes,
      rowCount: info.rowCount,
    });
  };

  const auditCsv = exportAuditCsv(db);
  writeBundleFile('audit-log.csv', auditCsv, (auditCsv.match(/\n/g)?.length ?? 0));

  const datasets: Array<{ name: string; table: string; orderBy: string }> = [
    { name: 'journal-entries.jsonl', table: 'journal_entries', orderBy: 'posting_date ASC, entry_number ASC' },
    { name: 'journal-lines.jsonl', table: 'journal_lines', orderBy: 'entry_id ASC, line_no ASC' },
    { name: 'accounting-periods.jsonl', table: 'accounting_periods', orderBy: 'period ASC' },
    { name: 'account-mappings-hgb.jsonl', table: 'account_mappings_hgb', orderBy: 'statement_type ASC, account_number ASC' },
    { name: 'bank-transactions.jsonl', table: 'bank_transactions', orderBy: 'date ASC, id ASC' },
    { name: 'datev-exports.jsonl', table: 'datev_exports', orderBy: 'created_at ASC, id ASC' },
    { name: 'booking-drafts.jsonl', table: 'booking_drafts', orderBy: 'updated_at ASC, id ASC' },
    { name: 'draft-validation-issues.jsonl', table: 'draft_validation_issues', orderBy: 'created_at ASC, id ASC' },
  ];

  if (args.includeDocuments) {
    datasets.push({ name: 'invoices.jsonl', table: 'invoices', orderBy: 'date ASC, id ASC' });
    datasets.push({ name: 'offers.jsonl', table: 'offers', orderBy: 'date ASC, id ASC' });
    datasets.push({ name: 'transactions-legacy.jsonl', table: 'transactions', orderBy: 'date ASC, id ASC' });
  }

  for (const dataset of datasets) {
    const rows = queryRows(db, dataset.table, dataset.orderBy, args);
    writeBundleJsonl(dataset.name, rows);
  }

  const chain = verifyAuditChain(db);
  writeBundleFile('audit-chain-verification.json', JSON.stringify(chain, null, 2));

  const manifest = {
    schemaVersion: 1,
    createdAt,
    from: args.from ?? null,
    to: args.to ?? null,
    includeDocuments: Boolean(args.includeDocuments),
    fileCount: files.length,
    files,
  };
  const manifestPath = path.join(bundleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    bundleDir,
    manifestPath,
    createdAt,
    fileCount: files.length,
    files,
  };
};
