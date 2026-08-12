import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';

const rootUrl = new URL('../../../../', import.meta.url);
const catalogUrl = new URL('packages/desktop-services/src/eur/lines-2025.json', rootUrl);
const migrationUrl = new URL('../../drizzle/0017_server_data_eur_catalog.sql', import.meta.url);
const sourceVersion = 'BMF-2025-2025-08-29';

type SourceLine = {
  year: number;
  id: string;
  kennziffer?: string;
  label: string;
  kind: string;
  exportable: boolean;
  computedFromIds?: string[];
  computedTerms?: Array<{ id: string; sign: 1 | -1 }>;
  providerPath?: string;
};

const sqlString = (value: string | null): string => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
const canonicalRows = (lines: SourceLine[]) => lines.map((line, sortOrder) => ({
  id: line.id,
  tax_year: line.year,
  provider_path: line.providerPath ?? 'main',
  kennziffer: line.kennziffer?.trim() || null,
  label: line.label,
  kind: line.kind,
  exportable: line.exportable,
  sort_order: sortOrder,
  computed_from_json: JSON.stringify(line.computedFromIds ?? []),
  computed_terms_json: JSON.stringify(line.computedTerms ?? []),
  source_version: sourceVersion,
}));
const metadataHash = (rows: ReturnType<typeof canonicalRows>): string => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('EÜR catalog migration contains the complete canonical immutable seed', async () => {
  const lines = JSON.parse(await readFile(catalogUrl, 'utf8')) as SourceLine[];
  const migration = await readFile(migrationUrl, 'utf8');
  const rows = canonicalRows(lines);

  assert.equal(rows.length, 107);
  assert.match(migration, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(migration, /computed_terms_json = EXCLUDED\.computed_terms_json/);
  assert.match(migration, /updated_at = EXCLUDED\.updated_at;/);
  for (const row of rows) {
    const values = `(${sqlString(row.id)}, ${row.tax_year}, ${sqlString(row.provider_path)}, ${sqlString(row.kennziffer)}, ${sqlString(row.label)}, ${sqlString(row.kind)}, ${row.exportable ? 'TRUE' : 'FALSE'}, ${row.sort_order}, ${sqlString(row.computed_from_json)}, ${sqlString(row.computed_terms_json)}, ${sqlString(row.source_version)}, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)`;
    assert.ok(migration.includes(values), `missing canonical EÜR row ${row.id}`);
  }
});

test('fresh Postgres EÜR migration has the canonical catalog hash and no duplicate provider Kennziffern', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `eur-catalog-${randomUUID()}`;
  try {
    await runDrizzleMigrations(pool);
    const lines = JSON.parse(await readFile(catalogUrl, 'utf8')) as SourceLine[];
    const expected = canonicalRows(lines);
    const ids = expected.map((row) => row.id);
    const result = await pool.query(`SELECT id,tax_year,provider_path,kennziffer,label,kind,exportable,sort_order,computed_from_json,computed_terms_json,source_version FROM eur_lines WHERE id = ANY($1::text[]) ORDER BY sort_order,id`, [ids]);
    const actual = result.rows.map((row) => ({
      id: row.id,
      tax_year: Number(row.tax_year),
      provider_path: row.provider_path,
      kennziffer: row.kennziffer,
      label: row.label,
      kind: row.kind,
      exportable: Boolean(row.exportable),
      sort_order: Number(row.sort_order),
      computed_from_json: row.computed_from_json,
      computed_terms_json: row.computed_terms_json,
      source_version: row.source_version,
    }));
    assert.equal(actual.length, expected.length);
    assert.equal(metadataHash(actual), metadataHash(expected));
    const duplicates = await pool.query(`SELECT provider_path,kennziffer,COUNT(*)::int AS count FROM eur_lines WHERE id = ANY($1::text[]) AND kennziffer IS NOT NULL AND kennziffer <> '' GROUP BY provider_path,kennziffer HAVING COUNT(*) > 1`, [ids]);
    assert.deepEqual(duplicates.rows, []);
    await runDrizzleMigrations(pool);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM eur_lines WHERE id = ANY($1::text[])', [ids])).rows[0].count), expected.length);

    const legacyId = 'E2025_GENERAL_001';
    await pool.query(`UPDATE eur_lines SET provider_path='main', computed_terms_json=NULL WHERE id=$1`, [legacyId]);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const upgraded = (await pool.query('SELECT provider_path,computed_terms_json FROM eur_lines WHERE id=$1', [legacyId])).rows[0];
    assert.deepEqual(upgraded, { provider_path: 'general', computed_terms_json: '[]' });
  } finally {
    await pool.end();
  }
});
