import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { createLegacySqliteReadBridge } from './legacySqliteReadBridge';
import {
  countLedgerAccounts,
  getLedgerAccountStats,
  type LedgerAccountStats,
  type LedgerChart,
  type UpsertLedgerAccount,
  upsertLedgerAccounts,
} from '../db/ledgerAccountsRepo';

type ImportSource = 'auto' | 'sqlite' | 'csv';

export interface ImportSkrArgs {
  preferredSource?: ImportSource;
  sqlitePath?: string;
  sourceDir?: string;
  strictOnly?: boolean;
}

export interface ImportSkrResult {
  source: 'sqlite' | 'csv' | 'none';
  sourceDetails: string[];
  inserted: number;
  updated: number;
  total: number;
  skipped: number;
  warnings: string[];
  stats: LedgerAccountStats;
}

export interface EnsureSkrImportResult {
  performed: boolean;
  reason: 'already-present' | 'imported' | 'missing-source' | 'empty-import';
  result?: ImportSkrResult;
}

const ACCOUNT_KEY_CANDIDATES = [
  'konto',
  'account',
  'account_number',
  'accountnumber',
  'number',
] as const;
const NAME_KEY_CANDIDATES = [
  'bezeichnung',
  'name',
  'account_name',
  'accountname',
  'description',
] as const;
const CHART_KEY_CANDIDATES = [
  'chart',
  'kontenrahmen',
  'skr',
  'skr_typ',
  'skr_type',
] as const;

const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

const CSV_FILE_CANDIDATES: Record<LedgerChart, string[]> = {
  SKR03: ['skr03_konten_strikt.csv', 'skr03_konten.csv'],
  SKR04: ['skr04_konten_strikt.csv', 'skr04_konten.csv'],
};
const SQLITE_FILE_CANDIDATES = ['skr-kontenrahmen.sqlite', 'skr_accounts.sqlite'] as const;

const normalizeHeader = (header: string): string => header.replace(/^\uFEFF/, '').trim().toLowerCase();

const normalizeText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const normalizeAccountNumber = (value: unknown): string => String(value ?? '').replace(/\s+/g, '').trim();

const isValidAccountNumber = (value: string): boolean => /^[0-9]{3,8}$/.test(value);

const chartFromUnknown = (value: unknown): LedgerChart | undefined => {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('skr03') || normalized === '03' || normalized.endsWith('03')) return 'SKR03';
  if (normalized.includes('skr04') || normalized === '04' || normalized.endsWith('04')) return 'SKR04';
  return undefined;
};

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const readField = (
  row: Record<string, unknown>,
  candidates: readonly string[],
): string => {
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const normalized = normalizeHeader(rawKey);
    if (candidates.includes(normalized as (typeof candidates)[number])) {
      return normalizeText(rawValue);
    }
  }
  return '';
};

const uniqueRows = (rows: UpsertLedgerAccount[]): UpsertLedgerAccount[] => {
  const byKey = new Map<string, UpsertLedgerAccount>();
  for (const row of rows) {
    const key = `${row.chart}:${row.accountNumber}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }

    if (prev.name.length >= row.name.length) {
      continue;
    }
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
};

const getElectronResourcesPath = (): string | undefined => {
  const resourcesPath = (process as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    return undefined;
  }
  return resourcesPath;
};

const resolveSkrDataDir = (providedSourceDir?: string): string | undefined => {
  const candidates: string[] = [];
  if (providedSourceDir) candidates.push(path.resolve(providedSourceDir));

  const cwd = process.cwd();
  candidates.push(path.resolve(cwd, 'doppelteBuchhaltung'));
  candidates.push(path.resolve(cwd, '..', 'doppelteBuchhaltung'));
  candidates.push(path.resolve(cwd, '..', '..', 'doppelteBuchhaltung'));

  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) {
    candidates.push(path.resolve(resourcesPath, 'doppelteBuchhaltung'));
    candidates.push(path.resolve(resourcesPath, 'skr'));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fs.existsSync(candidate)) continue;
    if (!fs.statSync(candidate).isDirectory()) continue;
    return candidate;
  }

  return undefined;
};

const findSqliteFiles = (dir: string, maxDepth = 2): string[] => {
  const out: string[] = [];

  const visit = (current: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) visit(abs, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SQLITE_EXTENSIONS.has(ext)) {
        out.push(abs);
      }
    }
  };

  visit(dir, 0);
  return out.sort((a, b) => a.localeCompare(b));
};

const resolveSqlitePath = (providedPath: string | undefined, sourceDir: string | undefined): string | undefined => {
  if (providedPath) {
    const resolved = path.resolve(providedPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
    return undefined;
  }

  const candidates: string[] = [];

  if (sourceDir) {
    for (const fileName of SQLITE_FILE_CANDIDATES) {
      candidates.push(path.join(sourceDir, fileName));
    }
    candidates.push(...findSqliteFiles(sourceDir, 2));
  }

  const cwd = process.cwd();
  candidates.push(path.resolve(cwd, 'doppelteBuchhaltung', 'skr-kontenrahmen.sqlite'));
  candidates.push(path.resolve(cwd, '..', 'doppelteBuchhaltung', 'skr-kontenrahmen.sqlite'));
  candidates.push(path.resolve(cwd, '..', '..', 'doppelteBuchhaltung', 'skr-kontenrahmen.sqlite'));

  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) {
    candidates.push(path.resolve(resourcesPath, 'doppelteBuchhaltung', 'skr-kontenrahmen.sqlite'));
    candidates.push(path.resolve(resourcesPath, 'skr', 'skr-kontenrahmen.sqlite'));
    candidates.push(path.resolve(resourcesPath, 'skr-kontenrahmen.sqlite'));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!fs.existsSync(resolved)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    return resolved;
  }

  return undefined;
};

const resolveCsvFiles = (
  sourceDir: string,
  strictOnly: boolean,
): Partial<Record<LedgerChart, string>> => {
  const out: Partial<Record<LedgerChart, string>> = {};
  for (const chart of Object.keys(CSV_FILE_CANDIDATES) as LedgerChart[]) {
    const names = strictOnly
      ? [CSV_FILE_CANDIDATES[chart][0]!]
      : CSV_FILE_CANDIDATES[chart];
    for (const fileName of names) {
      const abs = path.join(sourceDir, fileName);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        out[chart] = abs;
        break;
      }
    }
  }
  return out;
};

const parseCsvFile = (
  chart: LedgerChart,
  csvPath: string,
): { rows: UpsertLedgerAccount[]; skipped: number; warnings: string[] } => {
  const warnings: string[] = [];
  const content = fs.readFileSync(csvPath, 'utf8');
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
  });

  for (const error of parsed.errors) {
    warnings.push(`CSV parse warning (${path.basename(csvPath)}): ${error.message}`);
  }

  const rows: UpsertLedgerAccount[] = [];
  let skipped = 0;

  for (const row of parsed.data) {
    const accountNumber = normalizeAccountNumber(readField(row as Record<string, unknown>, ACCOUNT_KEY_CANDIDATES));
    const name = normalizeText(readField(row as Record<string, unknown>, NAME_KEY_CANDIDATES));
    if (!accountNumber || !name) {
      skipped += 1;
      continue;
    }
    if (!isValidAccountNumber(accountNumber)) {
      skipped += 1;
      continue;
    }
    rows.push({
      chart,
      accountNumber,
      name,
      source: `csv:${path.basename(csvPath)}`,
    });
  }

  return { rows, skipped, warnings };
};

const parseSqlite = (
  sqlitePath: string,
): { rows: UpsertLedgerAccount[]; skipped: number; warnings: string[] } => {
  const sourceDb = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const sourceDrizzle = createLegacySqliteReadBridge(sourceDb);
  const warnings: string[] = [];
  let skipped = 0;
  const rows: UpsertLedgerAccount[] = [];

  try {
    const tableRows = sourceDrizzle.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );

    for (const tableRow of tableRows) {
      const tableName = tableRow.name;
      const columns = sourceDrizzle.all<{ name: string }>(
        `PRAGMA table_info(${quoteIdent(tableName)})`,
      );

      const normalizedCols = columns.map((col) => ({
        raw: col.name,
        normalized: normalizeHeader(col.name),
      }));

      const accountCol = normalizedCols.find((col) => ACCOUNT_KEY_CANDIDATES.includes(col.normalized as (typeof ACCOUNT_KEY_CANDIDATES)[number]))?.raw;
      const nameCol = normalizedCols.find((col) => NAME_KEY_CANDIDATES.includes(col.normalized as (typeof NAME_KEY_CANDIDATES)[number]))?.raw;
      if (!accountCol || !nameCol) continue;

      const chartCol = normalizedCols.find((col) => CHART_KEY_CANDIDATES.includes(col.normalized as (typeof CHART_KEY_CANDIDATES)[number]))?.raw;
      const inferredChart = chartFromUnknown(tableName) ?? chartFromUnknown(path.basename(sqlitePath));

      const querySql = chartCol
        ? `SELECT ${quoteIdent(accountCol)} as account_number, ${quoteIdent(nameCol)} as account_name, ${quoteIdent(chartCol)} as chart_value FROM ${quoteIdent(tableName)}`
        : `SELECT ${quoteIdent(accountCol)} as account_number, ${quoteIdent(nameCol)} as account_name FROM ${quoteIdent(tableName)}`;

      const rawRows = sourceDrizzle.all(querySql).map((row) => row as {
        account_number: unknown;
        account_name: unknown;
        chart_value?: unknown;
      });

      for (const rawRow of rawRows) {
        const chart = chartFromUnknown(rawRow.chart_value) ?? inferredChart;
        const accountNumber = normalizeAccountNumber(rawRow.account_number);
        const name = normalizeText(rawRow.account_name);

        if (!chart || !accountNumber || !name || !isValidAccountNumber(accountNumber)) {
          skipped += 1;
          continue;
        }

        rows.push({
          chart,
          accountNumber,
          name,
          source: `sqlite:${path.basename(sqlitePath)}`,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`SQLite import failed (${sqlitePath}): ${message}`);
  } finally {
    sourceDb.close();
  }

  if (rows.length === 0) {
    warnings.push(`SQLite source had no importable SKR rows: ${sqlitePath}`);
  }

  return { rows, skipped, warnings };
};

export const importSkrCharts = (
  db: Database.Database,
  args: ImportSkrArgs = {},
): ImportSkrResult => {
  const warnings: string[] = [];
  const sourceDetails: string[] = [];
  const preferredSource = args.preferredSource ?? 'auto';
  const strictOnly = args.strictOnly ?? false;
  const sourceDir = resolveSkrDataDir(args.sourceDir);
  const sqlitePath = resolveSqlitePath(args.sqlitePath, sourceDir);

  let rows: UpsertLedgerAccount[] = [];
  let skipped = 0;
  let source: 'sqlite' | 'csv' | 'none' = 'none';

  const canTrySqlite = preferredSource === 'auto' || preferredSource === 'sqlite';
  if (canTrySqlite && sqlitePath) {
    const sqliteImport = parseSqlite(sqlitePath);
    rows = sqliteImport.rows;
    skipped += sqliteImport.skipped;
    warnings.push(...sqliteImport.warnings);
    if (rows.length > 0) {
      source = 'sqlite';
      sourceDetails.push(sqlitePath);
    }
  } else if (preferredSource === 'sqlite') {
    warnings.push('Preferred source "sqlite" selected but no SQLite file was found.');
  }

  const canTryCsv = preferredSource === 'auto' || preferredSource === 'csv' || source === 'none';
  if (canTryCsv && rows.length === 0) {
    if (!sourceDir) {
      warnings.push('No source directory with SKR CSV files found (expected: doppelteBuchhaltung/).');
    } else {
      const csvFiles = resolveCsvFiles(sourceDir, strictOnly);
      for (const chart of ['SKR03', 'SKR04'] as LedgerChart[]) {
        const csvPath = csvFiles[chart];
        if (!csvPath) {
          warnings.push(`Missing CSV source for ${chart} in ${sourceDir}`);
          continue;
        }
        const parsed = parseCsvFile(chart, csvPath);
        rows.push(...parsed.rows);
        skipped += parsed.skipped;
        warnings.push(...parsed.warnings);
        sourceDetails.push(csvPath);
      }
      if (rows.length > 0) {
        source = 'csv';
      }
    }
  }

  const dedupedRows = uniqueRows(rows);
  const skippedByDuplicates = rows.length - dedupedRows.length;
  skipped += skippedByDuplicates;

  const result = upsertLedgerAccounts(db, dedupedRows);
  const stats = getLedgerAccountStats(db);

  return {
    source,
    sourceDetails,
    inserted: result.inserted,
    updated: result.updated,
    total: result.total,
    skipped,
    warnings,
    stats,
  };
};

export const ensureSkrChartsImported = (
  db: Database.Database,
  args: ImportSkrArgs = {},
): EnsureSkrImportResult => {
  const existingCount = countLedgerAccounts(db);
  if (existingCount > 0) {
    return {
      performed: false,
      reason: 'already-present',
    };
  }

  try {
    const result = importSkrCharts(db, args);
    if (result.source === 'none' && result.total === 0) {
      return {
        performed: false,
        reason: 'missing-source',
        result,
      };
    }
    if (result.total === 0) {
      return {
        performed: true,
        reason: 'empty-import',
        result,
      };
    }
    return {
      performed: true,
      reason: 'imported',
      result,
    };
  } catch (error) {
    return {
      performed: false,
      reason: 'empty-import',
      result: {
        source: 'none',
        sourceDetails: [],
        inserted: 0,
        updated: 0,
        total: 0,
        skipped: 0,
        warnings: [`Automatic SKR import failed: ${String(error)}`],
        stats: getLedgerAccountStats(db),
      },
    };
  }
};
