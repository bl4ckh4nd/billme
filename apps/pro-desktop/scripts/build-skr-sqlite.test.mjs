#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '../../..');
const scriptPath = path.join(scriptsDir, 'build-skr-sqlite.mjs');
const trackedDbPath = path.join(repoRoot, 'doppelteBuchhaltung/skr-kontenrahmen.sqlite');
const canonicalPath = path.join(repoRoot, 'packages/server-data/src/postgres/canonicalLedgerCatalog.ts');
const migrationPath = path.join(repoRoot, 'packages/server-data/drizzle/0018_server_data_canonical_catalog.sql');

const sortRows = (rows) => rows.map((row) => ({ chart: row.chart, accountNumber: row.accountNumber, name: row.name }))
  .sort((a, b) => `${a.chart}:${a.accountNumber}`.localeCompare(`${b.chart}:${b.accountNumber}`));
const canonicalRows = [...fs.readFileSync(canonicalPath, 'utf8').matchAll(/^  \{ chart: '([^']+)', accountNumber: ("(?:\\\\.|[^"\\\\])*")\, name: ("(?:\\\\.|[^"\\\\])*") \},$/gm)]
  .map(([, chart, accountNumber, name]) => ({ chart, accountNumber: JSON.parse(accountNumber), name: JSON.parse(name) }));
const migrationRows = fs.readFileSync(migrationPath, 'utf8').split('\n').flatMap((line) => {
  const match = line.match(/^  \('server-catalog:([^']+):([^']+)', '([^']+)', '([^']+)', '((?:''|[^'])*)', 'server-catalog',/);
  return match ? [{ chart: match[3], accountNumber: match[4], name: match[5].replaceAll("''", "'") }] : [];
});
assert.equal(canonicalRows.length, 2427);
assert.equal(migrationRows.length, 2427);
assert.deepEqual(sortRows(canonicalRows), sortRows(migrationRows));

const generatedRows = () => {
  const db = new Database(trackedDbPath, { readonly: true });
  try {
    return db.prepare('SELECT chart, account_number AS accountNumber, name FROM skr_accounts').all();
  } finally {
    db.close();
  }
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-skr-sqlite-'));
const sourceDir = path.join(tempDir, 'source');
const outputPath = path.join(tempDir, 'output.sqlite');
fs.mkdirSync(sourceDir);

try {
  fs.writeFileSync(path.join(sourceDir, 'skr03_konten_strikt.csv'), 'konto,bezeichnung,marker\n1000,Kasse,\n1000,Kasse erweitert,SB\n');
  fs.writeFileSync(outputPath, 'must survive validation failure');
  assert.throws(() => execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' }), /Missing CSV source/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'must survive validation failure');

  fs.writeFileSync(path.join(sourceDir, 'skr04_konten_strikt.csv'), 'konto,bezeichnung,marker\n2000,Bank,\n');
  execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' });
  const firstOutput = fs.readFileSync(outputPath);
  execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' });
  assert.deepEqual(fs.readFileSync(outputPath), firstOutput);

  const databaseBefore = fs.readFileSync(trackedDbPath);
  const canonicalBefore = fs.readFileSync(canonicalPath);
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' });
    const firstDatabase = fs.readFileSync(trackedDbPath);
    const firstCanonical = fs.readFileSync(canonicalPath);
    execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(trackedDbPath), firstDatabase);
    assert.deepEqual(fs.readFileSync(canonicalPath), firstCanonical);
    assert.deepEqual(sortRows(generatedRows()), sortRows(migrationRows));
    assert.deepEqual(firstCanonical, canonicalBefore);
  } finally {
    fs.writeFileSync(trackedDbPath, databaseBefore);
    fs.writeFileSync(canonicalPath, canonicalBefore);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('build-skr-sqlite regression passed');
