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

test('Pro web client refuses outgoing posting without a finalized reservation id', async () => {
  const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
  assert.throws(() => client.postOutgoingInvoice('invoice-1', 'test', ''), /reservationId is required/);
});

test('Pro web client sends one allocation event id for a payment action', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    await client.allocateOpenItemPayment(
      { paymentId: 'payment-1', bankAccountNumber: '1200', allocations: [] },
      'Zahlung zuordnen',
    );
    const payment = requestBody?.payment as Record<string, unknown>;
    assert.equal(typeof payment.allocationEventId, 'string');
    assert.ok(String(payment.allocationEventId).length > 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client requires and preserves a remaining allocation event id across retries', async () => {
  const previousFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    assert.throws(() => client.allocateRemainingOpenItemPayment('payment-1', [], 'Restzahlung', ''), /allocationEventId is required/);
    await client.allocateRemainingOpenItemPayment('payment-1', [], 'Restzahlung', 'allocation-event-1');
    await client.allocateRemainingOpenItemPayment('payment-1', [], 'Restzahlung', 'allocation-event-1');
    assert.deepEqual(
      bodies.map((body) => body.allocationEventId),
      ['allocation-event-1', 'allocation-event-1'],
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
