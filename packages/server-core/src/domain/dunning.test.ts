import assert from 'node:assert/strict';
import test from 'node:test';
import { isInvoiceOverdue, withEffectiveInvoiceStatus } from './dunning.js';

const now = new Date(2026, 8, 12, 10, 0, 0);

test('an open invoice becomes overdue the day after its due date', () => {
  assert.equal(isInvoiceOverdue({ status: 'open', dueDate: '2026-09-11' }, now), true);
  assert.equal(isInvoiceOverdue({ status: 'open', dueDate: '2026-09-12' }, now), false);
});

test('a stored overdue status is re-derived from the due date', () => {
  assert.equal(withEffectiveInvoiceStatus({ status: 'overdue', dueDate: '2026-10-01' }, now).status, 'open');
  assert.equal(withEffectiveInvoiceStatus({ status: 'open', dueDate: '2026-02-15' }, now).status, 'overdue');
});

test('paid, draft and non-receivable documents never fall overdue', () => {
  assert.equal(isInvoiceOverdue({ status: 'paid', dueDate: '2026-01-01' }, now), false);
  assert.equal(isInvoiceOverdue({ status: 'draft', dueDate: '2026-01-01' }, now), false);
  assert.equal(isInvoiceOverdue({ status: 'open', dueDate: '2026-01-01', documentKind: 'delivery_note' }, now), false);
  assert.equal(isInvoiceOverdue({ status: 'open', dueDate: '2026-01-01', documentKind: 'credit_note' }, now), false);
  assert.equal(isInvoiceOverdue({ status: 'open', dueDate: '2026-01-01', documentKind: 'final_invoice' }, now), true);
});
