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

test('Pro web client accepts correction open items from the server', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    id: 'correction-open-item:c1', tenantId: 'tenant-1', partyType: 'creditor', partyId: 'vendor-1',
    sourceType: 'correction', sourceId: 'c1', documentNumber: 'Korrektur ER-1', documentDate: '2026-11-20', dueDate: '2026-11-20',
    originalAmount: 11.9, allocatedAmount: 0, residualAmount: 11.9, status: 'open', journalEntryId: 'journal-c1',
    createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
  }]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const items = await client.listOpenItems();
    assert.equal(items[0]?.sourceType, 'correction');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client sends inclusive SuSa date bounds', async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ asOfDate: '2026-12-31', rows: [], totals: { debit: 0, credit: 0, balance: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    await client.getSusaReport({ from: '2026-12-01', to: '2026-12-31' });
    assert.match(requestUrl, /reports\/susa\?from=2026-12-01&to=2026-12-31$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client reads native 2025 EÜR rows without a ledger reconciliation DTO', async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({
      taxYear: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      rows: [{ id: 'E2025_KZ112', kennziffer: '112', providerPath: 'income', label: 'Einnahmen', kind: 'income', exportable: true, sortOrder: 1, total: 100 }],
      summary: { incomeTotal: 100, expenseTotal: 0, surplus: 100 },
      unclassifiedCount: 0,
      warnings: [],
      catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'a'.repeat(64), delivery: 'print-form-only', elsterReady: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const report = await client.getEurReport({ from: '2025-01-01', to: '2025-12-31' });
    assert.equal(report.rows[0]?.kennziffer, '112');
    assert.equal(report.rows[0]?.providerPath, 'income');
    assert.match(requestUrl, /reports\/eur\?from=2025-01-01&to=2025-12-31$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client lists EÜR cash sources and persists tenant classifications', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify([{
        sourceType: 'transaction', sourceId: 'bank-1', date: '2025-02-01', amountGross: 119, amountNet: 100,
        flowType: 'expense', counterparty: 'Lieferant', purpose: 'Beleg',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'classification-1', sourceType: 'transaction', sourceId: 'bank-1', taxYear: 2025, eurLineId: 'E2025_KZ123', excluded: false, vatMode: 'default', vatRate: 19, updatedAt: '2025-02-01T12:00:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const items = await client.listEurCashItems({ from: '2025-01-01', to: '2025-12-31' });
    assert.equal(items[0]?.sourceId, 'bank-1');
    await client.upsertEurClassification({ sourceType: 'transaction', sourceId: 'bank-1', taxYear: 2025, eurLineId: 'E2025_KZ123', vatMode: 'default', vatRate: 19, reason: 'Beleg geprüft' });
    assert.match(calls[0]?.input ?? '', /reports\/eur\/items\?from=2025-01-01&to=2025-12-31$/);
    assert.match(calls[1]?.input ?? '', /reports\/eur\/classifications$/);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      sourceType: 'transaction', sourceId: 'bank-1', taxYear: 2025, eurLineId: 'E2025_KZ123', vatMode: 'default', vatRate: 19, reason: 'Beleg geprüft',
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client preserves EÜR facts and sends typed closing commands', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify([{
        sourceType: 'transaction', sourceId: 'bank-1', date: '2025-02-01', amountGross: 119, amountNet: 100,
        flowType: 'expense', counterparty: 'Lieferant', purpose: 'Beleg', kind: 'expense',
        splits: [{ amountNet: 60, deductibility: 'deductible', lineId: 'E2025_KZ123', reason: 'betrieblich' }, { amountNet: 40, deductibility: 'non-deductible', reason: 'privat' }],
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ run: { id: 'run-1', sourceType: 'fiscal_close', sourceId: 'close-1', sourceRevision: '1', status: 'posted', createdAt: '2025-12-31T00:00:00.000Z' }, result: {}, replayed: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const items = await client.listEurCashItems({ taxYear: 2025 });
    assert.equal(items[0]?.kind, 'expense');
    assert.deepEqual(items[0]?.splits, [
      { amountNet: 60, deductibility: 'deductible', lineId: 'E2025_KZ123', reason: 'betrieblich' },
      { amountNet: 40, deductibility: 'non-deductible', reason: 'privat' },
    ]);
    await client.postAccountingCommand({
      kind: 'fiscal_close',
      source: { sourceId: 'close-1', sourceRevision: '1', bookingText: 'Abschluss' },
      domainFacts: { closingDate: '2025-12-31', sourceId: 'close-1', sourceRevision: '1' },
      reason: 'Abschluss geprüft',
    });
    const body = JSON.parse(String(calls[1]?.init?.body));
    assert.equal(body.command, 'fiscal_close');
    assert.equal(body.input.closingDate, '2025-12-31');
    assert.equal(body.input.sourceId, 'close-1');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client maps correction and settlement workflows to their domain commands', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ run: { id: `run-${calls.length}`, sourceType: 'standalone_source', sourceId: 'source-1', sourceRevision: '1', status: 'posted', createdAt: '2025-12-31T00:00:00.000Z' }, result: {}, replayed: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const source = { sourceId: 'source-1', sourceRevision: '1', effectiveDate: '2025-12-31' };
    await client.postAccountingCommand({ kind: 'correction', source, domainFacts: { id: 'correction-1', original: {}, deltas: [] }, reason: 'Korrektur geprüft' });
    await client.postAccountingCommand({ kind: 'skonto', source, domainFacts: { taxBreakdown: [], skontoAmount: 1 }, reason: 'Skonto geprüft' });
    await client.postAccountingCommand({ kind: 'bad_debt', source, domainFacts: { taxBreakdown: [], writeOffGrossAmount: 1, facts: {} }, reason: 'Ausfall geprüft' });
    await client.postAccountingCommand({ kind: 'advance_settlement', source, domainFacts: { finalInvoice: { taxBreakdown: [] } }, reason: 'Vorauszahlung geprüft' });
    assert.match(calls[0]?.input ?? '', /\/api\/v1\/pro\/accounting\/corrections$/);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { id: 'correction-1', idempotencyKey: 'source:source-1', correctionDate: '2025-12-31', original: {}, deltas: [], reason: 'Korrektur geprüft' });
    for (const [index, kind] of ['skonto', 'bad_debt', 'advance_settlement'].entries()) {
      assert.match(calls[index + 1]?.input ?? '', /\/api\/v1\/pro\/accounting\/closing$/);
      assert.equal(JSON.parse(String(calls[index + 1]?.init?.body)).commandType, kind);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client rejects missing or malformed domain facts before fetch', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    const source = { sourceId: 'close-1', sourceRevision: '1' };
    await assert.rejects(() => client.postAccountingCommand({ kind: 'fiscal_close', source, reason: 'Fehlerprüfung' }), /Domain-Fakten/);
    await assert.rejects(() => client.postAccountingCommand({ kind: 'fiscal_close', source, domainFacts: [] as unknown as Record<string, unknown>, reason: 'Fehlerprüfung' }), /Domain-Fakten/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client scopes mapping health and overrides to canonical report types', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    await client.getAccountMappingHealth('SKR04', 'hgb-bilanz', '2025-12-31');
    await client.saveAccountMappingOverride({
      chart: 'SKR04',
      asOfDate: '2026-03-31',
      accountNumber: '1200',
      statementType: 'hgb-bilanz',
      positionKey: 'assets.current.cash',
      positionLabel: 'Bank',
      balanceSide: 'asset',
      reason: 'Kontenplan geprüft',
    });
    assert.match(calls[0]?.input ?? '', /mappings\/health\?chart=SKR04&reportType=hgb-bilanz&asOfDate=2025-12-31$/);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      chart: 'SKR04',
      asOfDate: '2026-03-31',
      accountNumber: '1200',
      statementType: 'hgb-bilanz',
      positionKey: 'assets.current.cash',
      positionLabel: 'Bank',
      balanceSide: 'asset',
      reason: 'Kontenplan geprüft',
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pro web client sends the explicit mapping catalog date', async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createProWebClient({ baseUrl: 'https://api.example.test', getToken: () => 'token' });
    await client.listReportMappingPositions('hgb-bilanz', '2026-03-31');
    assert.match(requestUrl, /mappings\/positions\?reportType=hgb-bilanz&asOfDate=2026-03-31$/);
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
    const exported = await client.exportDatevCsv({
      from: '2026-08-01',
      to: '2026-08-31',
      consultantNumber: '1001',
      clientNumber: '7',
      fiscalYearStart: '2026-01-01',
      accountLength: 5,
      encoding: 'utf8-bom',
      reason: 'Export geprüft',
    });
    assert.equal(exported.exportId, 'datev-1');
    assert.equal(exported.recordCount, 1);
    const history = await client.listDatevExports(20);
    assert.equal(history[0]?.id, 'datev-1');
    assert.match(calls[0] ?? '', /datev\/export\.csv\?from=2026-08-01&to=2026-08-31&consultantNumber=1001&clientNumber=7&fiscalYearStart=2026-01-01&accountLength=5&encoding=utf8-bom&reason=Export\+gepr%C3%BCft$/);
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
