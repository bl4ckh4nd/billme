#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'doppelteBuchhaltung');
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(sourceDir, 'skr-kontenrahmen.sqlite');
const canonicalSourcePath = path.join(repoRoot, 'packages/server-data/src/postgres/canonicalLedgerCatalog.ts');
const trackedSourceDbPath = path.join(repoRoot, 'doppelteBuchhaltung/skr-kontenrahmen.sqlite');

const CSV_FILES = [
  { chart: 'SKR03', file: 'skr03_konten_strikt.csv' },
  { chart: 'SKR04', file: 'skr04_konten_strikt.csv' },
];
const GENERATED_AT = '1970-01-01T00:00:00.000Z';

const normalizeAccountNumber = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const normalizeName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const readCsv = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(content, { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      console.warn(`[warn] ${path.basename(filePath)}: ${error.message}`);
    }
  }
  return parsed.data;
};

const readCsvSources = () => {
  const sourceRows = [];
  for (const entry of CSV_FILES) {
    const filePath = path.join(sourceDir, entry.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing CSV source: ${filePath}`);
    }
    for (const row of readCsv(filePath)) {
      const accountNumber = normalizeAccountNumber(row.konto);
      const name = normalizeName(row.bezeichnung);
      if (!/^\d{3,8}$/.test(accountNumber) || !name) continue;
      sourceRows.push({
        chart: entry.chart,
        accountNumber,
        name,
        marker: row.marker ? String(row.marker).trim() : null,
        sourceFile: entry.file,
      });
    }
  }
  return sourceRows;
};

const readTrackedDatabase = () => {
  if (!fs.existsSync(trackedSourceDbPath)) {
    throw new Error(`Missing tracked SQLite source: ${trackedSourceDbPath}`);
  }
  const db = new Database(trackedSourceDbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT chart, account_number AS accountNumber, name, marker, source_file AS sourceFile
      FROM skr_accounts
      ORDER BY chart, account_number
    `).all();
    if (rows.length === 0) throw new Error(`Tracked SQLite source is empty: ${trackedSourceDbPath}`);
    return rows.map((row) => ({
      chart: String(row.chart),
      accountNumber: normalizeAccountNumber(row.accountNumber),
      name: normalizeName(row.name),
      marker: row.marker == null ? null : String(row.marker).trim(),
      sourceFile: String(row.sourceFile),
    }));
  } finally {
    db.close();
  }
};

const readSources = () => process.argv[2] ? readCsvSources() : readTrackedDatabase();

const sourceRows = readSources();

const readCanonicalRows = () => {
  const source = fs.readFileSync(canonicalSourcePath, 'utf8');
  const rows = [...source.matchAll(/^  \{ chart: '([^']+)', accountNumber: ("(?:\\\\.|[^"\\\\])*")\, name: ("(?:\\\\.|[^"\\\\])*") \},$/gm)]
    .map(([, chart, accountNumber, name]) => ({ chart, accountNumber: JSON.parse(accountNumber), name: JSON.parse(name) }));
  if (rows.length === 0) throw new Error(`Canonical ledger catalog is empty: ${canonicalSourcePath}`);
  return rows;
};

const assertMatchesCanonical = (rows) => {
  const actual = new Map(rows.map((row) => [`${row.chart}:${row.accountNumber}`, row.name]));
  const expected = new Map(readCanonicalRows().map((row) => [`${row.chart}:${row.accountNumber}`, row.name]));
  if (actual.size !== expected.size || [...expected].some(([key, name]) => actual.get(key) !== name)) {
    throw new Error(`Tracked SQLite source does not match immutable canonical catalog: ${trackedSourceDbPath}`);
  }
};

if (!process.argv[2]) assertMatchesCanonical(sourceRows);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
// Remove sidecars left by older WAL-mode builds before creating the deterministic file.
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${outputPath}${suffix}`, { force: true });

const db = new Database(outputPath);
db.pragma('journal_mode = DELETE');
db.exec(`
  CREATE TABLE skr_accounts (
    id TEXT PRIMARY KEY,
    chart TEXT NOT NULL CHECK (chart IN ('SKR03','SKR04')),
    account_number TEXT NOT NULL,
    name TEXT NOT NULL,
    marker TEXT,
    source_file TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_skr_accounts_chart_number ON skr_accounts(chart, account_number);
  CREATE INDEX idx_skr_accounts_name ON skr_accounts(name);
`);

const insert = db.prepare(`
  INSERT INTO skr_accounts (id, chart, account_number, name, marker, source_file, created_at)
  VALUES (@id, @chart, @accountNumber, @name, @marker, @sourceFile, @createdAt)
  ON CONFLICT(chart, account_number) DO UPDATE SET
    name = excluded.name,
    marker = excluded.marker,
    source_file = excluded.source_file
`);

let inserted = 0;
const tx = db.transaction(() => {
  for (const row of sourceRows) {
    const canonicalKey = `${row.chart}:${row.accountNumber}`;
    insert.run({ ...row, id: canonicalKey, createdAt: GENERATED_AT });
    inserted += 1;
  }
});
tx();
db.close();

console.log(`Created ${outputPath}`);
console.log(`Inserted rows: ${inserted}`);
