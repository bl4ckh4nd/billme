import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

let createNodeSqliteOfferStore: typeof import('./nodeSqlite').createNodeSqliteOfferStore;
let canRunNativeSqlite = true;
try {
  const betterSqlite = await import('better-sqlite3');
  const probe = new betterSqlite.default(':memory:');
  probe.close();
  ({ createNodeSqliteOfferStore } = await import('./nodeSqlite'));
} catch {
  canRunNativeSqlite = false;
}

test('node sqlite store persists portal snapshots through Drizzle', { skip: !canRunNativeSqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billme-portal-'));
  try {
    const store = createNodeSqliteOfferStore(join(dir, 'portal.sqlite'));
    await store.upsertOffer({
      tokenHash: 'hash-1',
      publishedAt: '2026-08-07T10:00:00.000Z',
      expiresAt: '2026-09-07T10:00:00.000Z',
      snapshotJson: { number: 'ANG-1', items: [{ description: 'Service', quantity: 1 }] },
      customerRef: 'customer-1',
      customerLabel: 'Acme',
      pdfKey: 'hash-1.pdf',
    });
    assert.deepEqual((await store.getDocumentByTokenHash('hash-1'))?.snapshotJson, {
      number: 'ANG-1',
      items: [{ description: 'Service', quantity: 1 }],
    });
    assert.equal((await store.listDocumentsByCustomerRef({ customerRef: 'customer-1', limit: 10 })).items.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
