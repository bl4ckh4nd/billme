import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryOfferStore } from './memory';

test('memory store keeps stable document id across upserts for same offer token', async () => {
  const store = createMemoryOfferStore();
  const tokenHash = 'tok_hash_offer_1';

  await store.upsertOffer({
    tokenHash,
    publishedAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'ANG-1' },
  });

  const firstDoc = await store.getDocumentByTokenHash(tokenHash);
  assert.ok(firstDoc?.documentId);

  await store.upsertOffer({
    tokenHash,
    publishedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'ANG-1-UPDATED' },
  });

  const secondDoc = await store.getDocumentByTokenHash(tokenHash);
  assert.equal(secondDoc?.documentId, firstDoc?.documentId);
});

test('memory store cleans reverse index when explicit document id changes', async () => {
  const store = createMemoryOfferStore();
  const tokenHash = 'tok_hash_offer_2';

  await store.upsertOffer({
    tokenHash,
    documentId: 'd-old',
    publishedAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'ANG-2' },
  });

  await store.upsertOffer({
    tokenHash,
    documentId: 'd-new',
    publishedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'ANG-2-UPDATED' },
  });

  const oldDoc = await store.getDocumentById('d-old');
  const newDoc = await store.getDocumentById('d-new');

  assert.equal(oldDoc, null);
  assert.equal(newDoc?.documentId, 'd-new');
});

test('memory store keeps stable document id across upserts for same invoice token', async () => {
  const store = createMemoryOfferStore();
  const tokenHash = 'tok_hash_invoice_1';

  await store.upsertInvoice({
    tokenHash,
    customerRef: 'client:demo',
    publishedAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'RE-1' },
  });

  const firstDoc = await store.getDocumentByTokenHash(tokenHash);
  assert.ok(firstDoc?.documentId);

  await store.upsertInvoice({
    tokenHash,
    customerRef: 'client:demo',
    publishedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    snapshotJson: { number: 'RE-1-UPDATED' },
  });

  const secondDoc = await store.getDocumentByTokenHash(tokenHash);
  assert.equal(secondDoc?.documentId, firstDoc?.documentId);
});
