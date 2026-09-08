import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

test('Pro incoming document route accepts a payload above Fastify default bodyLimit and reviews it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-incoming-document-route-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'incoming-document-route-test-secret-32-chars',
    localAuth: {
      accessToken: 'incoming-document-route-token',
      tenantId: 'incoming-document-route-tenant',
      userId: 'incoming-document-route-user',
      email: 'owner@example.test',
      fullName: 'Owner',
    },
  });
  try {
    const now = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1, $1, 'Route test', 'pro', 'single-tenant', 'active', $2, $2)`, ['incoming-document-route-tenant', now]);
    await database.query(`INSERT INTO vendors (id, tenant_id, name, created_at, updated_at) VALUES ('incoming-document-route-vendor', 'incoming-document-route-tenant', 'Route vendor', $1, $1)`, [now]);
    await database.query(`INSERT INTO incoming_invoices (id, tenant_id, vendor_id, number, invoice_date, due_date, net_amount, tax_amount, gross_amount, status, tax_rate, accounting_status, created_at, updated_at) VALUES ('incoming-document-route-invoice', 'incoming-document-route-tenant', 'incoming-document-route-vendor', 'ER-ROUTE-1', '2026-09-01', '2026-09-30', 100, 19, 119, 'open', 19, 'unposted', $1, $1)`, [now]);
    await app.ready();
    const headers = { 'x-billme-local-token': 'incoming-document-route-token' };
    const content = Buffer.alloc(1_100_000, 0x20);
    Buffer.from('%PDF-1.7\n', 'utf8').copy(content);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/incoming-invoices/incoming-document-route-invoice/documents',
      headers,
      payload: {
        originalFilename: 'large-route-test.pdf',
        mimeType: 'application/pdf',
        data: content.toString('base64'),
        reason: 'Großen Originalbeleg prüfen',
      },
    });
    assert.equal(upload.statusCode, 200, upload.body);
    const saved = upload.json() as { id: string; byteLength: number; reviewStatus: string };
    assert.equal(saved.byteLength, content.byteLength);
    assert.equal(saved.reviewStatus, 'pending');

    const review = await app.inject({
      method: 'POST',
      url: `/api/v1/pro/accounting/incoming-invoice-documents/${saved.id}/review`,
      headers,
      payload: { reviewStatus: 'accepted', reason: 'Original geprüft' },
    });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(review.json().reviewStatus, 'accepted');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
