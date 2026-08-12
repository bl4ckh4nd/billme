import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingLineItemSchema,
  getBillingLineAmount,
  resolveBillingDocumentLines,
} from './billing-lines';

test('billing document lines normalize legacy rows to billable item rows', () => {
    const line = billingLineItemSchema.parse({ description: 'Alt', quantity: 2, price: 10, total: 20 });
    assert.equal(line.kind, 'item');
    assert.equal(getBillingLineAmount(line), 20);
});

test('billing document lines keep sections and exclude non-billable rows from totals', () => {
    const resolved = resolveBillingDocumentLines([
      { kind: 'group', description: 'Bauabschnitt 1', quantity: 0, price: 0, total: 0 },
      { kind: 'item', description: 'A', quantity: 2, price: 50, total: 100, unit: 'm²' },
      { kind: 'optional', description: 'Option', quantity: 1, price: 25, total: 25, optionNote: 'nicht beauftragt' },
      { kind: 'summary', description: 'Zwischensumme', quantity: 0, price: 0, total: 0, summaryScope: 'group', summaryMetric: 'amount' },
      { kind: 'text', description: 'Hinweis', quantity: 0, price: 0, total: 0 },
      { kind: 'time', description: 'Montage', quantity: 1.5, price: 80, total: 120, unit: 'Std.' },
      { kind: 'summary', description: 'Laufende Summe', quantity: 0, price: 0, total: 0, summaryScope: 'running', summaryMetric: 'amount' },
      { kind: 'item', description: 'Nachtrag', quantity: 1, price: 10, total: 10, unit: 'Stk.' },
      { kind: 'summary', description: 'Laufende Summe 2', quantity: 0, price: 0, total: 0, summaryScope: 'running', summaryMetric: 'amount' },
    ]);

    assert.equal(resolved.netAmount, 230);
    assert.equal(resolved.optionalLines.length, 1);
    assert.deepEqual(resolved.structuralLines.map((line) => line.kind), ['group', 'summary', 'text', 'summary', 'summary']);
    assert.deepEqual(resolved.groups[0], { id: 'group-1', label: 'Bauabschnitt 1', amount: 230, quantities: { 'm²': 2, 'Std.': 1.5, 'Stk.': 1 } });
    assert.deepEqual(resolved.runningSubtotals.map(({ scope, amount, quantities }) => ({ scope, amount, quantities })), [
      { scope: 'group', amount: 100, quantities: { 'm²': 2 } },
      { scope: 'running', amount: 220, quantities: { 'm²': 2, 'Std.': 1.5 } },
      { scope: 'running', amount: 10, quantities: { 'Stk.': 1 } },
    ]);
    assert.deepEqual(resolved.quantitiesByUnit, { 'm²': 2, 'Std.': 1.5, 'Stk.': 1 });
});
