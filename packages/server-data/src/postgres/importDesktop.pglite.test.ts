import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { PgliteServerDatabase } from '../pglite/database.js';
import { importDesktopSqliteToServerDatabase } from './importDesktop.js';
import { sha256Hex, stableStringify } from './audit.js';

test('SQLite import supports a real PGlite target and persists data, audit, and run status', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'billme-import-pglite-'));
  const sqlitePath = join(tempDir, 'source.sqlite');
  const pgliteDir = join(tempDir, 'pglite');
  const tenantId = 'pglite-import-tenant';
  const occurredAt = '2026-08-21T12:00:00.000Z';
  const auditPayload = {
    sequence: 1,
    ts: occurredAt,
    entityType: 'client',
    entityId: 'pglite-client-1',
    action: 'create',
    reason: 'Imported history',
    before: null,
    after: { company: 'PGlite Customer' },
    prevHash: null,
    actor: 'local',
  };
  const auditHash = sha256Hex(`:${stableStringify(auditPayload)}`);
  const sqlite = new Database(sqlitePath);

  try {
    sqlite.exec(`
      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        customer_number TEXT,
        company TEXT NOT NULL,
        contact_person TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        status TEXT NOT NULL,
        avatar TEXT,
        tags_json TEXT NOT NULL,
        notes TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        sequence INTEGER,
        ts TEXT,
        entity_type TEXT,
        entity_id TEXT,
        action TEXT,
        reason TEXT,
        before_json TEXT,
        after_json TEXT,
        prev_hash TEXT,
        hash TEXT,
        actor TEXT
      );
    `);
    sqlite.prepare('INSERT INTO clients VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'pglite-client-1',
      'C-100',
      'PGlite Customer',
      'Ada Example',
      'ada@example.test',
      '+49 30 123',
      'Teststraße 1, 10115 Berlin',
      'active',
      null,
      '[]',
      'Imported from SQLite',
    );
    sqlite.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      1,
      occurredAt,
      'client',
      'pglite-client-1',
      'create',
      'Imported history',
      null,
      JSON.stringify({ company: 'PGlite Customer' }),
      null,
      auditHash,
      'local',
    );
    sqlite.close();

    const database = await PgliteServerDatabase.open(pgliteDir);
    try {
      const result = await importDesktopSqliteToServerDatabase({
        database,
        sqlitePath,
        product: 'lite',
        tenant: { id: tenantId, slug: tenantId, displayName: 'PGlite Import' },
      });

      assert.equal(result.counts.clients, 1);
      assert.equal(result.counts.auditLog, 1);
      assert.equal(result.unsupportedTables.length, 0);
      const clientRows = await database.query<{ id: string; tenant_id: string; company: string; notes: string }>(
        'SELECT id, tenant_id, company, notes FROM clients WHERE id = $1',
        ['pglite-client-1'],
      );
      assert.deepEqual(clientRows.rows, [{
        id: 'pglite-client-1',
        tenant_id: tenantId,
        company: 'PGlite Customer',
        notes: 'Imported from SQLite',
      }]);
      const auditRows = await database.query<{ sequence: number; hash: string; tenant_id: string }>(
        'SELECT sequence, hash, tenant_id FROM audit_log WHERE tenant_id = $1',
        [tenantId],
      );
      assert.deepEqual(auditRows.rows, [{ sequence: 1, hash: auditHash, tenant_id: tenantId }]);
      const runRows = await database.query<{ status: string; details_json: string }>(
        'SELECT status, details_json FROM sqlite_import_runs WHERE id = $1',
        [result.importRunId],
      );
      assert.equal(runRows.rows[0]?.status, 'completed');
      assert.match(runRows.rows[0]?.details_json ?? '', /"clients":1/);
    } finally {
      await database.close();
    }
  } finally {
    if (sqlite.open) sqlite.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
