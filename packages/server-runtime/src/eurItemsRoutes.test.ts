import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

test('EÜR item route honors search and pagination instead of silently dropping query filters', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-eur-items-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const token = 'embedded-eur-items-token';
  const tenantId = 'embedded-eur-items-tenant';
  const now = new Date().toISOString();
  const settings = {
    legal: { smallBusinessRule: true },
    businessReportingProfile: {
      jurisdiction: 'DE',
      legalForm: 'sole_proprietor',
      profitDetermination: 'eur',
      fiscalYearStart: '01-01',
    },
  };
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-eur-items-session-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'embedded-eur-items-user',
      email: 'eur-items@example.com',
      fullName: 'EÜR Items',
    },
  });

  try {
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4)`,
      [tenantId, tenantId, 'EÜR Items', now],
    );
    await database.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [tenantId, JSON.stringify(settings), now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'EÜR Bank', 'DE00000000000000000000', 0, '1200', 'bank', '#000000')`,
      ['eur-items-account', tenantId],
    );
    await database.query(
      `INSERT INTO bank_transactions
        (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at)
       VALUES
        ('eur-item-match', $1, 'eur-items-account', '2025-03-02', 10, 'income', 'Needle Customer', 'Unrelated', NULL, 'booked', NULL, $2, $2),
        ('eur-item-other', $1, 'eur-items-account', '2025-03-01', 20, 'income', 'Needle Other Customer', 'Other', NULL, 'booked', NULL, $2, $2)`,
      [tenantId, now],
    );
    await database.query(
      `INSERT INTO eur_cash_facts
        (id, tenant_id, source_type, source_id, tax_year, kind, amount_net, flow_type, splits_json, reason, actor_id, provenance_json, created_at, updated_at)
       VALUES ('eur-item-fact', $1, 'transaction', 'eur-item-other', 2025, 'income', 20, 'income', NULL, 'EÜR test fact', 'eur-items-user', '{}', $2, $2)`,
      [tenantId, now],
    );
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/accounting/reports/eur/items?taxYear=2025&onlyUnclassified=true&status=classified&sourceType=transaction&flowType=income&accountId=eur-items-account&search=NEEDLE&limit=1&offset=0',
      headers: { 'x-billme-local-token': token },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().map((item: { sourceId: string }) => item.sourceId), ['eur-item-match']);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
