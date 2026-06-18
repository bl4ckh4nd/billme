import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Offer } from '@billme/server-core';
import { createPostgresOfferRepository } from './billing.js';
import type { PostgresQueryable } from './connection.js';

const scope = createSingleTenantScope('tenant-1', 'pro');

test('createPostgresOfferRepository persists and hydrates offer line items', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let storedRow: Record<string, unknown> | null = null;
  const db = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params: params ?? [] });

      if (/INSERT INTO offers/.test(sql)) {
        storedRow = {
          id: params?.[0],
          tenant_id: params?.[1],
          client_id: params?.[2],
          client_number: params?.[3],
          project_id: params?.[4],
          number: params?.[5],
          client: params?.[6],
          client_email: params?.[7],
          client_address: params?.[8],
          billing_address_json: params?.[9],
          shipping_address_json: params?.[10],
          date: params?.[11],
          valid_until: params?.[12],
          amount: params?.[13],
          status: params?.[14],
          items_json: params?.[15],
          share_json: params?.[16],
          history_json: params?.[17],
          created_at: params?.[18],
          updated_at: params?.[19],
        };
        return { rows: [] };
      }

      if (/SELECT \* FROM offers/.test(sql)) {
        return { rows: storedRow ? [storedRow] : [] };
      }

      return { rows: [] };
    },
  } as unknown as PostgresQueryable;

  const repository = createPostgresOfferRepository(db);
  const offer: Offer = {
    id: 'offer-1',
    tenantId: scope.tenantId,
    kind: 'offer',
    number: 'A-100',
    client: 'Debug GmbH',
    clientEmail: 'debug@example.com',
    clientAddress: 'Debug Strasse 1',
    taxMode: 'standard_vat',
    date: '2026-06-18',
    validUntil: '2026-07-18',
    amount: 119,
    status: 'draft',
    items: [{ description: 'Visible offer line item', quantity: 1, price: 100, total: 100 }],
    history: [{ date: '2026-06-18', action: 'offer.create' }],
  };

  await repository.save(scope, offer);
  const reloaded = await repository.getById(scope, offer.id);

  assert.match(queries[0]?.sql ?? '', /items_json/);
  assert.deepEqual(JSON.parse(String(queries[0]?.params[15])), offer.items);
  assert.deepEqual(reloaded?.items, offer.items);
});
