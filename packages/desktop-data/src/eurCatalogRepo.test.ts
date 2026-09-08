import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { listEurLines, seedEurCatalog } from './eurCatalogRepo';

const databases: Database.Database[] = [];

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE eur_lines (
      id TEXT PRIMARY KEY,
      tax_year INTEGER NOT NULL,
      provider_path TEXT NOT NULL DEFAULT 'main',
      kennziffer TEXT,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      exportable INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL,
      computed_from_json TEXT,
      computed_terms_json TEXT,
      source_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  databases.push(db);
  return db;
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('eurCatalogRepo persistence', () => {
  it('seeds provider paths and signed computed terms without losing duplicate Kennziffern', () => {
    const db = createDb();

    expect(seedEurCatalog(db, 2025)).toBe(107);
    expect(seedEurCatalog(db, 2025)).toBe(107);

    const lines = listEurLines(db, 2025);
    const supplementary = lines.find((line) => line.id === 'E2025_SUPP_104');
    const correctedProfit = lines.find((line) => line.id === 'E2025_KZ290');

    expect(lines).toHaveLength(107);
    expect(supplementary?.providerPath).toBe('supplementary-reserves-release');
    expect(lines.filter((line) => line.kennziffer === '120')).toHaveLength(3);
    expect(correctedProfit?.computedTerms).toContainEqual({ id: 'E2025_KZ199', sign: -1 });
  });
});
