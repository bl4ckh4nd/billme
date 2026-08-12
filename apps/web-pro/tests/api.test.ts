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
      {
        paymentId: 'payment-1',
        sourceType: 'manual',
        sourceId: 'source-1',
        partyType: 'debtor',
        paymentDate: '2026-08-12',
        amount: 10,
        bankAccountNumber: '1200',
        allocations: [],
        allocationEventId: 'allocation-event-1',
      },
      'Zahlung zuordnen',
    );
    const payment = requestBody?.payment as Record<string, unknown>;
    assert.equal(payment.allocationEventId, 'allocation-event-1');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client rejects a payment action without an allocation event id', async () => {
  const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
  assert.throws(
    () => client.allocateOpenItemPayment({ sourceType: 'manual', sourceId: 'source-1', partyType: 'debtor', paymentDate: '2026-08-12', amount: 10, bankAccountNumber: '1200', allocations: [] } as never, 'Zahlung zuordnen'),
    /allocationEventId is required/,
  );
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

test('Pro web client exposes DATEV export receipt metadata and history', async () => {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) {
      return new Response('date;csv\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'x-billme-datev-export-id': 'datev-1',
          'x-billme-datev-content-sha256': 'a'.repeat(64),
          'x-billme-datev-record-count': '1',
        },
      });
    }
    return new Response(JSON.stringify([{
      id: 'datev-1',
      filePath: 'datev-export/a',
      recordCount: 1,
      createdAt: '2026-08-12T00:00:00.000Z',
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const exported = await client.exportDatevCsv({ from: '2026-08-01', to: '2026-08-31', reason: 'Export geprüft' });
    assert.equal(exported.exportId, 'datev-1');
    assert.equal(exported.recordCount, 1);
    const history = await client.listDatevExports(20);
    assert.equal(history[0]?.id, 'datev-1');
    assert.match(calls[0] ?? '', /datev\/export\.csv\?from=2026-08-01&to=2026-08-31&reason=Export\+gepr%C3%BCft$/);
    assert.match(calls[1] ?? '', /datev\/exports$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client maps fixed-asset routes, payloads, and typed results', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const asset = {
    id: 'asset-1',
    assetNumber: 'ANL-2026-001',
    name: 'Notebook',
    assetClass: 'IT-Hardware',
    status: 'aktiv',
    activationDate: '2026-01-01',
    acquisitionCost: 1200,
    residualValue: 900,
    annualDepreciation: 300,
    usefulLifeYears: 4,
    depreciationMethod: 'linear',
    costCenter: 'IT',
    location: 'Berlin',
    nextDepreciation: '2026-12-31',
    receiptLinked: true,
    assetAccountNumber: '0480',
  };
  const assetInput = {
    id: asset.id,
    assetNumber: asset.assetNumber,
    name: asset.name,
    assetClass: asset.assetClass,
    status: asset.status,
    activationDate: asset.activationDate,
    acquisitionCost: asset.acquisitionCost,
    usefulLifeYears: asset.usefulLifeYears,
    depreciationMethod: asset.depreciationMethod,
    costCenter: asset.costCenter,
    location: asset.location,
    receiptLinked: asset.receiptLinked,
    assetAccountNumber: asset.assetAccountNumber,
  };
  const scheduleEntry = {
    id: 'schedule-1',
    assetId: asset.id,
    year: 2026,
    amount: 300,
    months: 12,
    status: 'posted',
    journalEntryId: 'journal-1',
  };
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    const response = calls.length === 1
      ? [asset]
      : calls.length === 2
        ? asset
        : calls.length === 3
          ? [scheduleEntry]
          : calls.length === 4
            ? { asset, scheduleEntry, journalEntryId: 'journal-1' }
            : { asset: { ...asset, status: 'verkauft', disposalDate: '2026-08-12', disposalProceeds: 500 }, residualBookValue: 900, gainLoss: -400, journalEntryId: 'journal-2' };
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    assert.deepEqual(await client.listAssets(), [asset]);
    assert.deepEqual(await client.upsertAsset(assetInput, 'Anlage geprüft'), asset);
    assert.deepEqual(await client.getDepreciationSchedule(asset.id), [scheduleEntry]);
    assert.equal((await client.runDepreciation({ assetId: asset.id, year: 2026, postingDate: '2026-12-31', reason: 'AfA geprüft' })).journalEntryId, 'journal-1');
    assert.equal((await client.disposeAsset({ assetId: asset.id, disposalDate: '2026-08-12', proceeds: 500, taxRate: 19, proceedsAccountNumber: '8800', reason: 'Verkauf geprüft' })).gainLoss, -400);

    assert.match(calls[0]?.input ?? '', /\/api\/v1\/pro\/accounting\/assets$/);
    assert.match(calls[1]?.input ?? '', /\/api\/v1\/pro\/accounting\/assets$/);
    assert.match(calls[2]?.input ?? '', /\/api\/v1\/pro\/accounting\/assets\/asset-1\/schedule$/);
    assert.match(calls[3]?.input ?? '', /\/api\/v1\/pro\/accounting\/assets\/asset-1\/depreciation$/);
    assert.match(calls[4]?.input ?? '', /\/api\/v1\/pro\/accounting\/assets\/asset-1\/dispose$/);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { asset: assetInput, reason: 'Anlage geprüft' });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
      assetId: asset.id,
      year: 2026,
      postingDate: '2026-12-31',
      reason: 'AfA geprüft',
    });
    assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), {
      assetId: asset.id,
      disposalDate: '2026-08-12',
      proceeds: 500,
      taxRate: 19,
      proceedsAccountNumber: '8800',
      reason: 'Verkauf geprüft',
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
