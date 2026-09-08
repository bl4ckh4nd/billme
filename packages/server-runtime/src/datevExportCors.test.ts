import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const tenantId = 'datev-cors-tenant';
const localToken = 'datev-cors-local-token';
const browserOrigin = 'https://pro.example.test';
const receiptHeaderNames = [
  'x-billme-datev-export-id',
  'x-billme-datev-content-sha256',
  'x-billme-datev-record-count',
] as const;

const readHeader = (response: { headers: Record<string, unknown> }, name: string): string | undefined => {
  const value = response.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(',');
  return value === undefined || value === null ? undefined : String(value);
};

const assertDatevReceiptCors = (response: { headers: Record<string, unknown> }) => {
  assert.equal(readHeader(response, 'access-control-allow-origin'), browserOrigin);
  assert.deepEqual(
    readHeader(response, 'access-control-expose-headers')
      ?.split(',')
      .map((header) => header.trim().toLowerCase())
      .sort(),
    [...receiptHeaderNames].sort(),
  );
  for (const headerName of receiptHeaderNames) {
    assert.ok(readHeader(response, headerName), `${headerName} must be present`);
  }
};

test('embedded Pro DATEV export exposes every receipt header to browser origins', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-datev-cors-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'datev-cors-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: localToken,
      tenantId,
      userId: 'datev-cors-user',
      email: 'datev-cors@example.test',
      fullName: 'DATEV CORS Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4)`,
      [tenantId, 'datev-cors', 'DATEV CORS', now],
    );
    await app.ready();

    const headers = {
      origin: browserOrigin,
      'x-billme-local-token': localToken,
    };
    const exportResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/accounting/datev/export.csv?from=2026-03-01&to=2026-03-31&consultantNumber=1234&clientNumber=42&fiscalYearStart=2026-01-01&accountLength=4',
      headers,
    });
    assert.equal(exportResponse.statusCode, 200, exportResponse.body);
    assertDatevReceiptCors(exportResponse);

    const exportId = readHeader(exportResponse, 'x-billme-datev-export-id');
    assert.ok(exportId);
    const downloadResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pro/accounting/datev/exports/${encodeURIComponent(exportId)}`,
      headers,
    });
    assert.equal(downloadResponse.statusCode, 200, downloadResponse.body);
    assertDatevReceiptCors(downloadResponse);
    assert.equal(readHeader(downloadResponse, 'x-billme-datev-export-id'), exportId);
    assert.equal(
      readHeader(downloadResponse, 'x-billme-datev-content-sha256'),
      readHeader(exportResponse, 'x-billme-datev-content-sha256'),
    );
    assert.equal(
      readHeader(downloadResponse, 'x-billme-datev-record-count'),
      readHeader(exportResponse, 'x-billme-datev-record-count'),
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
