import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

// Ways this can go wrong: a booking counted for every matching rule instead of the first;
// an overridden suggestion (posted elsewhere) counted as a hit; drafts that were never
// posted counted; the response schema stripping the derived fields.
test('rule list derives hit count and last hit from posted bank bookings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-rule-hits-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const tenant = 'rule-hits-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'rule-hits-route-test-secret-32-characters',
    localAuth: { accessToken: 'rule-hits-token', tenantId: tenant, userId: 'rule-hits-user', email: 'owner@example.test', fullName: 'Owner' },
  });
  try {
    const now = '2026-09-01T00:00:00.000Z';
    const run = (text: string, values: unknown[] = []) => database.query(text, values);
    await run(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1, $1, 'Hits', 'pro', 'single-tenant', 'active', $2, $2)`, [tenant, now]);
    await run(`INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color) VALUES ('acc', $1, 'Giro', 'DE00', 0, '1200', 'bank', '#000')`, [tenant]);
    const rule = (id: string, priority: number, value: string, target: string) =>
      run(`INSERT INTO account_suggestion_rules (id, tenant_id, chart, priority, field, operator, value, target_account_number, flow_type, active, created_at, updated_at) VALUES ($1, $2, 'SKR03', $3, 'counterparty', 'contains', $4, $5, 'expense', true, $6, $6)`, [id, tenant, priority, value, target, now]);
    await rule('telekom', 1, 'telekom', '4920');
    await rule('broad', 2, 'tele', '4900'); // also matches Telekom, but loses on priority
    let entryNo = 0;
    const booking = async (id: string, counterparty: string, account: string, date: string, posted = true) => {
      await run(`INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, created_at, updated_at) VALUES ($1, $2, 'acc', $3, -50, 'expense', $4, 'Rechnung', 'open', $5, $5)`, [`tx-${id}`, tenant, date, counterparty, now]);
      await run(`INSERT INTO booking_drafts (id, tenant_id, transaction_id, workflow_status, draft_json, updated_at) VALUES ($1, $2, $3, $4, '{}', $5)`, [`draft-${id}`, tenant, `tx-${id}`, posted ? 'posted' : 'approved', now]);
      if (!posted) return;
      entryNo += 1;
      await run(`INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, booking_text, period, fiscal_year, status, created_at, source_draft_id) VALUES ($1, $2, $3, $4, 'Bank', $5, 2026, 'posted', $6, $7)`, [`je-${id}`, tenant, entryNo, date, date.slice(0, 7), now, `draft-${id}`]);
      await run(`INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, 1, $4, 50, 0), ($5, $2, $3, 2, '1200', 0, 50)`, [`jl-${id}-1`, tenant, `je-${id}`, account, `jl-${id}-2`]);
    };
    await booking('a', 'Telekom GmbH', '4920', '2026-03-10');
    await booking('b', 'Telekom GmbH', '4920', '2026-05-02');
    await booking('c', 'Telekom GmbH', '4980', '2026-06-01'); // suggestion overridden: no hit
    await booking('d', 'Telekom GmbH', '4920', '2026-07-01', false); // not posted: no hit

    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/account-suggestion-rules?chart=SKR03', headers: { 'x-billme-local-token': 'rule-hits-token' } });
    assert.equal(response.statusCode, 200, response.body);
    const byId = new Map((response.json() as Array<{ id: string; hitCount?: number; lastHitAt?: string }>).map((r) => [r.id, r]));
    assert.equal(byId.get('telekom')?.hitCount, 2);
    assert.equal(byId.get('telekom')?.lastHitAt, '2026-05-02');
    assert.equal(byId.get('broad')?.hitCount, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
