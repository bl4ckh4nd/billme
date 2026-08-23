import assert from 'node:assert/strict';
import test from 'node:test';
import { filterEurListItems, type EurListFilterItem } from './eurItemFilters.js';

const item = (overrides: Partial<EurListFilterItem> = {}): EurListFilterItem => ({
  sourceType: 'transaction',
  sourceId: 'item-1',
  date: '2025-03-01',
  amountGross: 10,
  flowType: 'expense',
  counterparty: 'Counterparty',
  purpose: 'Purpose',
  ...overrides,
});

test('onlyUnclassified treats cash facts and splits as classified and wins over status', () => {
  const result = filterEurListItems([
    item({ sourceId: 'plain', date: '2025-03-01' }),
    item({ sourceId: 'kind', date: '2025-03-02', kind: 'expense' }),
    item({ sourceId: 'split', date: '2025-03-03', splits: [{ amountNet: 1 }] }),
    item({ sourceId: 'line', date: '2025-03-04', classification: { eurLineId: 'E2025_KZ280', excluded: false } }),
    item({ sourceId: 'excluded', date: '2025-03-05', classification: { excluded: true } }),
  ], { onlyUnclassified: true, status: 'classified' });

  assert.deepEqual(result.map((entry) => entry.sourceId), ['plain']);
});

test('filters source, flow, account, and search before applying desktop ordering and pagination', () => {
  const result = filterEurListItems([
    item({ sourceId: 'matching-early', date: '2025-03-01', accountId: 'bank-1', counterparty: 'Needle customer', flowType: 'expense' }),
    item({ sourceId: 'matching-late', date: '2025-03-03', accountId: 'bank-1', counterparty: 'Needle supplier', flowType: 'expense' }),
    item({ sourceId: 'wrong-account', date: '2025-03-04', accountId: 'bank-2', counterparty: 'Needle other', flowType: 'expense' }),
    item({ sourceType: 'invoice', sourceId: 'wrong-source', date: '2025-03-05', accountId: 'bank-1', counterparty: 'Needle invoice', flowType: 'expense' }),
    item({ sourceId: 'wrong-flow', date: '2025-03-06', accountId: 'bank-1', counterparty: 'Needle income', flowType: 'income' }),
  ], { sourceType: 'transaction', flowType: 'expense', accountId: 'bank-1', search: 'NEEDLE', offset: 1, limit: 1 });

  assert.deepEqual(result.map((entry) => entry.sourceId), ['matching-early']);
});
