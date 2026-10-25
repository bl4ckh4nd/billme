import crypto from 'node:crypto';
import type { PostgresQueryable } from './connection.js';
import type { ServerQueryField } from '../database.js';
import { GDPDU_DTD, GDPDU_DTD_FILE } from './gdpduDtd.js';
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
  // Which customer or vendor stands behind a Personenkonto of the DATEV stacks.
  { name: 'datev-party-accounts.jsonl', table: 'datev_party_accounts', orderBy: 'party_type ASC, ordinal ASC' },
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
): Promise<{ rows: unknown[]; fields?: readonly ServerQueryField[] }> => {
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
  return { rows: result.rows, fields: result.fields };
};

// GDPdU (Beschreibungsstandard): every dataset again as CSV, described in index.xml, so audit software (IDEA) reads it.
type GdpduColumn = { name: string; type: 'numeric' | 'integer' | 'date' | 'text'; accuracy?: number };
const NUMERIC_TYPES = new Set([1700, 700, 701]);
const INTEGER_TYPES = new Set([20, 21, 23]);
const BYTEA = 17;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const gdpduColumns = (rows: Array<Record<string, unknown>>, fields: readonly ServerQueryField[] | undefined): GdpduColumn[] =>
  (fields?.length ? fields : Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeID: undefined }))).filter((field) => field.dataTypeID !== BYTEA).map((field) => {
    const values = rows.map((row) => row[field.name]).filter((value) => value !== null && value !== undefined);
    if (field.dataTypeID !== undefined && INTEGER_TYPES.has(field.dataTypeID)) return { name: field.name, type: 'integer' };
    if (field.dataTypeID !== undefined && NUMERIC_TYPES.has(field.dataTypeID)) {
      const decimals = Math.max(2, ...values.map((value) => String(value).split('.')[1]?.length ?? 0));
      return { name: field.name, type: 'numeric', accuracy: decimals };
    }
    if (values.length && values.every((value) => typeof value === 'string' && ISO_DAY.test(value))) return { name: field.name, type: 'date' };
    return { name: field.name, type: 'text' };
  });
const gdpduValue = (value: unknown, column: GdpduColumn): string => {
  if (value === null || value === undefined) return '';
  if (column.type === 'numeric') return Number(value).toFixed(column.accuracy).replace('.', ',');
  if (column.type === 'integer' || column.type === 'date') return String(value);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // One record per line: line breaks inside a text become spaces (the JSONL keeps the original).
  return `"${text.replace(/\r?\n|\r/g, ' ').replaceAll('"', '""')}"`;
};
const gdpduCsv = (rows: Array<Record<string, unknown>>, columns: GdpduColumn[]): string =>
  [columns.map((column) => `"${column.name}"`).join(';'), ...rows.map((row) => columns.map((column) => gdpduValue(row[column.name], column)).join(';'))].map((line) => `${line}\r\n`).join('');
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const gdpduTable = (url: string, name: string, columns: GdpduColumn[]): string => `    <Table>
      <URL>${xml(url)}</URL>
      <Name>${xml(name)}</Name>
      <UTF8/>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <Range>
        <From>2</From>
      </Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
${columns.map((column) => `        <VariableColumn>
          <Name>${xml(column.name)}</Name>
          ${column.type === 'numeric' ? `<Numeric>\n            <Accuracy>${column.accuracy}</Accuracy>\n          </Numeric>` : column.type === 'integer' ? '<Numeric/>' : column.type === 'date' ? '<Date>\n            <Format>YYYY-MM-DD</Format>\n          </Date>' : '<AlphaNumeric/>'}
        </VariableColumn>`).join('\n')}
      </VariableLength>
    </Table>`;

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

  const gdpdu: Array<{ url: string; name: string; rows: Array<Record<string, unknown>>; fields?: readonly ServerQueryField[] }> = [];
  const selectedDatasets = args.includeDocuments ? [...datasets, ...documentDatasets] : datasets;
  for (const dataset of selectedDatasets) {
    const { rows, fields } = await queryRows(target, dataset, tenantId, args);
    files.push(file(dataset.name, jsonl(rows), rows.length));
    gdpdu.push({ url: dataset.name.replace(/\.jsonl$/, '.csv'), name: dataset.table, rows: rows as Array<Record<string, unknown>>, fields });
  }

  // Kontenplan: the DATEV catalogue of the active chart plus the tenant's own and deactivated accounts.
  const chart = String((await target.query(`SELECT active_chart FROM accounting_policies WHERE tenant_id = $1`, [tenantId])).rows[0]?.active_chart ?? 'SKR03');
  const accountsResult = (await target.query(
    `SELECT COALESCE(t.chart, g.chart) AS chart, COALESCE(t.account_number, g.account_number) AS account_number, COALESCE(t.name, g.name) AS name,
       COALESCE(t.active, TRUE) AS active, CASE WHEN g.account_number IS NULL THEN 'tenant' ELSE 'datev' END AS source
     FROM (SELECT * FROM ledger_accounts WHERE chart = $2) g
     FULL OUTER JOIN (SELECT * FROM tenant_ledger_accounts WHERE tenant_id = $1 AND chart = $2) t ON t.account_number = g.account_number
     ORDER BY 2`,
    [tenantId, chart],
  ));
  const accounts = accountsResult.rows;
  files.push(file('chart-of-accounts.jsonl', jsonl(accounts), accounts.length));
  gdpdu.push({ url: 'chart-of-accounts.csv', name: 'chart_of_accounts', rows: accounts as Array<Record<string, unknown>>, fields: accountsResult.fields });
  const tables: string[] = [];
  for (const table of gdpdu) {
    const columns = gdpduColumns(table.rows, table.fields);
    files.push(file(table.url, gdpduCsv(table.rows, columns), table.rows.length));
    tables.push(gdpduTable(table.url, table.name, columns));
  }
  const settingsJson = (await target.query(`SELECT settings_json FROM server_settings WHERE tenant_id = $1 LIMIT 1`, [tenantId])).rows[0]?.settings_json;
  const company = (() => { try { return String(JSON.parse(String(settingsJson ?? 'null'))?.company?.name ?? ''); } catch { return ''; } })();
  files.push(file('index.xml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "${GDPDU_DTD_FILE}">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name>${xml(company || 'billme Pro')}</Name>
    <Location></Location>
    <Comment>Datenträgerüberlassung (Z3) aus billme Pro, Zeitraum ${xml(args.from ?? 'Beginn')} bis ${xml(args.to ?? 'heute')}</Comment>
  </DataSupplier>
  <Media>
    <Name>Prüferpaket</Name>
${tables.join('\n')}
  </Media>
</DataSet>
`));
  files.push(file(GDPDU_DTD_FILE, GDPDU_DTD));

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
