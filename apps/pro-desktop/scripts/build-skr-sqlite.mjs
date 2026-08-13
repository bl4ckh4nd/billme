#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
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
const canonicalOutputPath = path.join(repoRoot, 'packages/server-data/src/postgres/canonicalLedgerCatalog.ts');

const CSV_FILES = [
  { chart: 'SKR03', file: 'skr03_konten_strikt.csv' },
  { chart: 'SKR04', file: 'skr04_konten_strikt.csv' },
];

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

const normalizeAccountNumber = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const normalizeName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

const db = new Database(outputPath);
db.pragma('journal_mode = WAL');
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

const now = new Date().toISOString();
let inserted = 0;
const canonicalRows = new Map();

const tx = db.transaction(() => {
  for (const entry of CSV_FILES) {
    const filePath = path.join(sourceDir, entry.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing CSV source: ${filePath}`);
    }
    const rows = readCsv(filePath);
    for (const row of rows) {
      const accountNumber = normalizeAccountNumber(row.konto);
      const name = normalizeName(row.bezeichnung);
      if (!/^\d{3,8}$/.test(accountNumber) || !name) continue;
      const canonicalKey = `${entry.chart}:${accountNumber}`;
      const existingCanonical = canonicalRows.get(canonicalKey);
      if (!existingCanonical || existingCanonical.name.length < name.length) {
        canonicalRows.set(canonicalKey, { chart: entry.chart, accountNumber, name });
      }
      insert.run({
        id: `${entry.chart}:${accountNumber}`,
        chart: entry.chart,
        accountNumber,
        name,
        marker: row.marker ? String(row.marker).trim() : null,
        sourceFile: entry.file,
        createdAt: now,
      });
      inserted += 1;
    }
  }
});

tx();
db.close();

if (!process.argv[2]) {
  const sourceHash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(sourceDir, 'skr03_konten_strikt.csv')))
    .update(fs.readFileSync(path.join(sourceDir, 'skr04_konten_strikt.csv')))
    .digest('hex');
  fs.writeFileSync(canonicalOutputPath, [
    `// Generated from shipped doppelteBuchhaltung/*_konten_strikt.csv assets; source hash ${sourceHash}.`,
    'export const CANONICAL_LEDGER_ACCOUNTS = [',
    ...[...canonicalRows.values()].map((row) => `  { chart: '${row.chart}', accountNumber: ${JSON.stringify(row.accountNumber)}, name: ${JSON.stringify(row.name)} },`),
    '] as const;',
    '',
  ].join('\n'));
}

console.log(`Created ${outputPath}`);
console.log(`Inserted rows: ${inserted}`);
