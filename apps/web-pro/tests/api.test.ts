import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingDraftEntitySchema } from '@billme/desktop-contracts-pro/schemas';
import { createProWebClient } from '../src/api.js';

test('Pro web client reads canonical accounting transactions', async () => {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify([
        {
          id: 'tx-1',
          date: '2026-08-12',
          amount: 100,
          type: 'income',
          counterparty: 'Example GmbH',
          purpose: 'Leistung',
          status: 'pending',
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const rows = await client.listAccountingTransactions();
    assert.equal(rows[0]?.id, 'tx-1');
    assert.match(calls[0] ?? '', /\/api\/v1\/pro\/accounting\/transactions$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client rethrows canonical accounting mutation failures', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'posting rejected' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const draft = bookingDraftEntitySchema.parse({
      id: 'draft-1',
      tenantId: 'tenant-1',
      transactionId: 'tx-1',
      workflowStatus: 'ready_for_review',
      postingDate: '2026-08-12',
      documentDate: '2026-08-12',
      bookingText: 'Test',
      period: '2026-08',
      fiscalYear: 2026,
      lines: [],
      validationIssues: [],
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    await assert.rejects(() => client.saveAccountingDraft(draft, 'test'), /posting rejected/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
