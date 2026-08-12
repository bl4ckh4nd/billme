import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';

describe('Lite EÜR catalog bootstrap and migration', () => {
  it('seeds duplicate Kennziffern by provider path and preserves signed terms', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    runMigrations(db);

    const duplicateKz = db.prepare(`
      SELECT provider_path AS providerPath
      FROM eur_lines
      WHERE tax_year = 2025 AND kennziffer = '120'
      ORDER BY provider_path
    `).all() as Array<{ providerPath: string }>;
    const terms = db.prepare(`
      SELECT computed_terms_json AS computedTermsJson
      FROM eur_lines
      WHERE id = 'E2025_KZ290'
    `).get() as { computedTermsJson: string };

    expect(duplicateKz).toEqual([
      { providerPath: 'general' },
      { providerPath: 'main' },
      { providerPath: 'supplementary-reserves-release' },
    ]);
    expect(JSON.parse(terms.computedTermsJson)).toContainEqual({ id: 'E2025_KZ199', sign: -1 });

    db.prepare("DELETE FROM eur_lines WHERE provider_path <> 'main'").run();
    db.exec('DROP INDEX idx_eur_lines_year_provider_kennziffer');
    db.exec(`CREATE UNIQUE INDEX idx_eur_lines_year_kennziffer
      ON eur_lines(tax_year, kennziffer)
      WHERE kennziffer IS NOT NULL AND TRIM(kennziffer) <> ''`);
    runMigrations(db);
    const indexSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_eur_lines_year_provider_kennziffer'
    `).get() as { sql: string };
    expect(indexSql.sql).toContain('provider_path');
    expect((db.prepare(`SELECT COUNT(*) AS count FROM eur_lines WHERE tax_year = 2025 AND kennziffer = '120'`).get() as { count: number }).count).toBe(3);
    db.close();
  });
});
