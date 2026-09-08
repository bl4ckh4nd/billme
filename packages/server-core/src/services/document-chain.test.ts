import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Invoice, type Offer, type TenantScope } from '../domain/foundations.js';
import {
  createCancellationInvoice,
  createCancellationInvoiceAsync,
  createCreditNoteAsync,
  createCreditNote,
  createDeliveryNoteFromOrder,
  createFinalInvoice,
  createInvoiceRevision,
  createOrderConfirmationFromOffer,
  createPartialInvoice,
  listDocumentChain,
} from './document-chain.js';

const scope: TenantScope = createSingleTenantScope('tenant-1', 'lite');
const line = { kind: 'item' as const, description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 };

const makeInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  kind: 'invoice',
  tenantId: 'tenant-1',
  id: 'invoice-1',
  number: 'RE-1',
  client: 'Acme GmbH',
  clientEmail: 'billing@acme.example',
  taxMode: 'standard_vat',
  date: '2026-09-04',
  dueDate: '2026-09-18',
  amount: 100,
  status: 'open',
  items: [line],
  payments: [],
  history: [],
  ...overrides,
});

const makeOffer = (overrides: Partial<Offer> = {}): Offer => ({
  kind: 'offer',
  tenantId: 'tenant-1',
  id: 'offer-1',
  number: 'ANG-1',
  client: 'Acme GmbH',
  clientEmail: 'billing@acme.example',
  taxMode: 'standard_vat',
  date: '2026-09-04',
  validUntil: '2026-09-30',
  amount: 100,
  status: 'accepted',
  items: [line],
  history: [],
  ...overrides,
});

const setup = (offer = makeOffer()) => {
  const invoices = new Map<string, Invoice>();
  const audits: unknown[] = [];
  return {
    invoices,
    audits,
    dependencies: {
      offerRepo: {
        getById: (_scope: TenantScope, id: string) => id === offer.id ? offer : null,
        list: (_scope: TenantScope) => [offer],
        save: (_scope: TenantScope, next: Offer) => next,
        remove: (_scope: TenantScope, _id: string) => undefined,
      },
      invoiceRepo: {
        getById: (_scope: TenantScope, id: string) => invoices.get(id) ?? null,
        list: (_scope: TenantScope) => [...invoices.values()],
        save: (_scope: TenantScope, invoice: Invoice) => {
          invoices.set(invoice.id, invoice);
          return invoice;
        },
        remove: (_scope: TenantScope, id: string) => { invoices.delete(id); },
      },
      auditLog: {
        append: (_scope: TenantScope, entry: unknown) => { audits.push(entry); return entry as never; },
        listBySubject: (_scope: TenantScope, _subject: unknown) => [],
      },
    },
  };
};

test('creates an accepted-offer order chain and enforces remaining settlement', () => {
  const { dependencies, invoices, audits } = setup(makeOffer({ amount: 120, items: [{ ...line, total: 120, price: 120 }] }));
  const order = createOrderConfirmationFromOffer(scope, dependencies, {
    id: 'order-1', number: 'AB-1', date: '2026-09-04', reason: 'Auftrag angenommen', offerId: 'offer-1',
  });
  assert.equal(order.documentKind, 'order_confirmation');
  assert.equal(order.sourceDocumentId, 'offer-1');
  assert.equal(order.rootDocumentId, 'order-1');

  const delivery = createDeliveryNoteFromOrder(scope, dependencies, {
    id: 'delivery-1', number: 'LS-1', date: '2026-09-04', reason: 'Versand', orderId: order.id,
  });
  assert.equal(delivery.documentKind, 'delivery_note');
  assert.equal(delivery.amount, 0);
  assert.equal(delivery.rootDocumentId, order.id);

  const partial = createPartialInvoice(scope, dependencies, {
    id: 'partial-1', number: 'RE-1', date: '2026-09-04', reason: 'Teilzahlung', orderId: order.id, amount: 20,
  });
  assert.equal(partial.documentKind, 'partial_invoice');
  assert.equal(partial.rootDocumentId, order.id);
  assert.throws(() => createFinalInvoice(scope, dependencies, {
    id: 'final-bad', number: 'RE-2', date: '2026-09-04', reason: 'Falschbetrag', orderId: order.id, amount: 99,
  }), /remaining order amount \(100\.00\)/);
  const final = createFinalInvoice(scope, dependencies, {
    id: 'final-1', number: 'RE-2', date: '2026-09-04', reason: 'Schlussrechnung', orderId: order.id, amount: 100,
  });
  assert.equal(final.documentKind, 'final_invoice');
  assert.equal(invoices.size, 4);
  assert.equal(listDocumentChain(scope, dependencies, order.id).length, 4);
  assert.equal(audits.length, 4);
});

test('creates linked corrections and immutable revisions only from finalized billing documents', () => {
  const setupResult = setup();
  const { dependencies } = setupResult;
  const source = makeInvoice({ id: 'invoice-final', rootDocumentId: 'order-1', amount: 100 });
  setupResult.invoices.set(source.id, source);
  const credit = createCreditNote(scope, dependencies, {
    id: 'credit-1', number: 'GS-1', date: '2026-09-04', reason: 'Preisnachlass', invoiceId: source.id, amount: 20,
  });
  assert.equal(credit.documentKind, 'credit_note');
  assert.equal(credit.sourceDocumentId, source.id);
  assert.equal(credit.rootDocumentId, source.rootDocumentId);

  const secondCredit = createCreditNote(scope, dependencies, {
    id: 'credit-2', number: 'GS-2', date: '2026-09-04', reason: 'Weitere Gutschrift', invoiceId: source.id, amount: 80,
  });
  assert.equal(secondCredit.amount, 80);
  assert.throws(() => createCreditNote(scope, dependencies, {
    id: 'credit-over', number: 'GS-3', date: '2026-09-04', reason: 'Zu viel', invoiceId: source.id, amount: 1,
  }), /Correction total exceeds original/);

  const revision = createInvoiceRevision(scope, dependencies, {
    id: 'revision-1', number: 'RE-1-R1', date: '2026-09-04', reason: 'Adresse korrigiert', invoiceId: source.id,
  });
  assert.equal(revision.revisionOfId, source.id);
  assert.equal(revision.revisionNumber, 1);
  assert.deepEqual(revision.items, source.items);

  assert.throws(() => createCancellationInvoice(scope, dependencies, {
    id: 'cancel-bad', number: 'ST-1', date: '2026-09-04', reason: 'Unvollständig', invoiceId: source.id, amount: 20,
  }), /complete original invoice/);
  assert.throws(() => createCancellationInvoice(scope, dependencies, {
    id: 'cancel-after-credit', number: 'ST-1', date: '2026-09-04', reason: 'Nach Gutschrift', invoiceId: source.id,
  }), /cannot follow an existing correction/);

  const cancellationSource = makeInvoice({ id: 'invoice-cancel', amount: 100 });
  setupResult.invoices.set(cancellationSource.id, cancellationSource);
  const cancellation = createCancellationInvoice(scope, dependencies, {
    id: 'cancel-1', number: 'ST-1', date: '2026-09-04', reason: 'Vollständige Stornierung', invoiceId: cancellationSource.id,
  });
  assert.equal(cancellation.documentKind, 'cancellation_invoice');
  assert.equal(cancellation.amount, cancellationSource.amount);
  assert.throws(() => createCreditNote(scope, dependencies, {
    id: 'credit-after-cancel', number: 'GS-4', date: '2026-09-04', reason: 'Nach Storno', invoiceId: cancellationSource.id, amount: 1,
  }), /cannot follow a cancellation invoice/);
});

test('async corrections enforce cumulative caps and mutually exclusive cancellation', async () => {
  const setupResult = setup();
  const { dependencies, invoices } = setupResult;
  const source = makeInvoice({ id: 'invoice-async', amount: 100 });
  invoices.set(source.id, source);

  await createCreditNoteAsync(scope, dependencies, {
    id: 'credit-async-1', number: 'GS-A1', date: '2026-09-04', reason: 'Teilkorrektur 1', invoiceId: source.id, amount: 60,
  });
  await createCreditNoteAsync(scope, dependencies, {
    id: 'credit-async-2', number: 'GS-A2', date: '2026-09-04', reason: 'Teilkorrektur 2', invoiceId: source.id, amount: 40,
  });
  await assert.rejects(() => createCreditNoteAsync(scope, dependencies, {
    id: 'credit-async-over', number: 'GS-A3', date: '2026-09-04', reason: 'Über der Grenze', invoiceId: source.id, amount: 0.01,
  }), /Correction total exceeds original/);
  await assert.rejects(() => createCancellationInvoiceAsync(scope, dependencies, {
    id: 'cancel-async-after-credit', number: 'ST-A1', date: '2026-09-04', reason: 'Nach Teilkorrekturen', invoiceId: source.id,
  }), /cannot follow an existing correction/);

  const cancellationSource = makeInvoice({ id: 'invoice-async-cancel', amount: 100 });
  invoices.set(cancellationSource.id, cancellationSource);
  await createCancellationInvoiceAsync(scope, dependencies, {
    id: 'cancel-async', number: 'ST-A2', date: '2026-09-04', reason: 'Vollständiges Storno', invoiceId: cancellationSource.id,
  });
  await assert.rejects(() => createCreditNoteAsync(scope, dependencies, {
    id: 'credit-async-after-cancel', number: 'GS-A4', date: '2026-09-04', reason: 'Nach Storno', invoiceId: cancellationSource.id, amount: 1,
  }), /cannot follow a cancellation invoice/);
});

test('never turns non-billing order documents into corrections', () => {
  const { dependencies, invoices } = setup();
  invoices.set('order-1', makeInvoice({ id: 'order-1', documentKind: 'order_confirmation', amount: 100 }));
  assert.throws(() => createCreditNote(scope, dependencies, {
    id: 'credit-order', number: 'GS-2', date: '2026-09-04', reason: 'Nicht zulässig', invoiceId: 'order-1',
  }), /Non-billing documents/);
});
