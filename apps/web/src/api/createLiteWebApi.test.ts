import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiteWebBillmeApi } from './createLiteWebApi.js';

const reportPayload = {
  taxYear: 2025,
  from: '2025-01-01',
  to: '2025-12-31',
  rows: [
    { id: 'income', kennziffer: '111', providerPath: 'income', label: 'Betriebseinnahmen', kind: 'income', exportable: true, sortOrder: 1, total: 119 },
    { id: 'surplus', kennziffer: '290', providerPath: 'result', label: 'Überschuss', kind: 'computed', exportable: true, sortOrder: 2, computedTerms: [{ id: 'income', sign: 1 }], total: 119 },
  ],
  summary: { incomeTotal: 119, expenseTotal: 0, surplus: 119 },
  unclassifiedCount: 1,
  warnings: [],
  catalog: { id: 'anlage-euer-2025', version: 'BMF-2025', sourceHash: 'b69b5cf0a982d28cbce20644e67677a36be0bc494bed4fae2310dc08230a1599', delivery: 'print-form-only', elsterReady: false },
};

const itemPayload = [{
  sourceType: 'invoice', sourceId: 'invoice-1', date: '2025-03-01', amountGross: 119, amountNet: 100, flowType: 'income', counterparty: 'Kunde', purpose: 'Rechnung RE-1',
  classification: { id: 'classification-1', sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, excluded: false, vatMode: 'default', vatRate: 19, updatedAt: '2025-03-01T00:00:00.000Z' },
}];

test('Lite web API maps native EÜR report/items, persists reasoned classification, and exports existing CSV semantics', async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/reports/eur/items')) return { ok: true, status: 200, json: async () => itemPayload } as Response;
    if (url.includes('/reports/eur/classifications')) return { ok: true, status: 200, json: async () => ({ ...itemPayload[0]!.classification }) } as Response;
    return { ok: true, status: 200, json: async () => reportPayload } as Response;
  }) as typeof fetch;
  try {
    const api = createLiteWebBillmeApi({ baseUrl: 'https://example.test', token: 'token' });
    const report = await api.eur.getReport({ taxYear: 2025 });
    assert.equal(report.rows[0]?.lineId, 'income');
    assert.equal((await api.eur.listItems({ taxYear: 2025 }))[0]?.sourceId, 'invoice-1');
    await api.eur.upsertClassification({ sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, reason: 'Beleg geprüft', eurLineId: 'income' });
    const csv = await api.eur.exportCsv({ taxYear: 2025 });
    assert.match(csv, /^\uFEFFKennziffer;Bezeichnung;Betrag/);
    assert.equal((requests.find((request) => request.url.includes('/classifications'))?.body as { reason: string }).reason, 'Beleg geprüft');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
