import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { readServerHarnessState } from '../harness.mjs';
import {
  createHarnessProTenant,
  ensureHarnessSession,
  openProShell,
  requestJson,
  seedHarnessProTenant,
} from './helpers.mjs';

const captureDirectory = async () => {
  const directory = process.env.E2E_SCREENSHOT_DIR?.trim()
    || path.join(process.cwd(), 'test-results', 'server-mode', 'pro-outgoing-document-chain');
  await fs.mkdir(directory, { recursive: true });
  return directory;
};

const capture = async (page, directory, name) => {
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
};

const isoNow = () => new Date().toISOString();

const createAcceptedOffer = async (state, session) => {
  const offers = await requestJson(state, session, '/api/v1/pro/offers');
  const source = offers.find((offer) => offer.status === 'open');
  if (!source) throw new Error('Seeded Pro offer was not persisted.');
  const accepted = {
    ...source,
    amount: 120,
    status: 'accepted',
    items: [
      { kind: 'item', description: 'Beratung 19%', quantity: 1, price: 100, total: 100, taxRate: 19 },
      { kind: 'item', description: 'Service 7%', quantity: 1, price: 20, total: 20, taxRate: 7 },
    ],
    share: {
      ...(source.share ?? {}),
      decision: 'accepted',
      acceptedAt: isoNow(),
      acceptedBy: 'outgoing-document-chain-e2e',
    },
  };
  const saved = await requestJson(state, session, '/api/v1/pro/offers', undefined, {
    method: 'POST',
    body: { reason: 'E2E: angenommenes Angebot für Auftragskette', offer: accepted },
  });
  expect(saved).toMatchObject({ id: source.id, status: 'accepted', amount: 120 });
  return saved;
};

const configureOutgoingPosting = async (state, session) => {
  for (const [role, accountNumber] of [
    ['accounts_receivable', '1200'],
    ['revenue', '8400'],
    ['output_vat', '1776'],
  ]) {
    await requestJson(state, session, '/api/v1/pro/accounting/mappings', undefined, {
      method: 'POST',
      body: {
        reason: `E2E: Mapping ${role} für Auftragskette`,
        chart: 'SKR03',
        role,
        accountNumber,
      },
    });
  }
};

const createNumberedDocument = async (state, session, endpoint, fields, expectedKind) => {
  const reservation = await requestJson(state, session, '/api/v1/pro/numbers/reserve', undefined, {
    method: 'POST',
    body: { kind: 'invoice' },
  });
  const created = await requestJson(state, session, `/api/v1/pro/document-chain/${endpoint}`, undefined, {
    method: 'POST',
    body: {
      id: fields.id,
      number: reservation.number,
      date: '2026-09-04',
      dueDate: '2026-09-18',
      reason: fields.reason,
      ...fields,
    },
  });
  expect(created).toMatchObject({ id: fields.id, documentKind: expectedKind, status: 'draft' });
  await requestJson(state, session, '/api/v1/pro/numbers/finalize', undefined, {
    method: 'POST',
    body: { reservationId: reservation.reservationId, documentId: fields.id },
  });
  const saved = await requestJson(state, session, '/api/v1/pro/invoices', undefined, {
    method: 'POST',
    body: {
      reason: `${fields.reason}: Nummer finalisiert`,
      invoice: { ...created, number: reservation.number, status: 'open' },
    },
  });
  expect(saved).toMatchObject({ id: fields.id, number: reservation.number, status: 'open' });
  return { document: saved, reservation };
};

export const runProOutgoingDocumentChainScenario = async (page) => {
  const state = await readServerHarnessState();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const credentials = {
    email: `pro-outgoing-chain-${suffix}@billme-e2e.local`,
    fullName: 'Billme Pro Outgoing Chain E2E',
    password: 'billme-server-123',
  };
  const tenant = await createHarnessProTenant(state, credentials);
  const session = await ensureHarnessSession(state, { product: 'pro', ...credentials });
  expect(session.tenantId).toBe(tenant.tenantId);
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace: `outgoing-chain-${suffix}` });
  await configureOutgoingPosting(state, session);

  const offer = await createAcceptedOffer(state, session);
  const order = await createNumberedDocument(state, session, 'order-confirmations', {
    id: `outgoing-chain-order-${suffix}`,
    offerId: offer.id,
    reason: 'E2E: Auftragsbestätigung aus Angebot',
  }, 'order_confirmation');
  const delivery = await createNumberedDocument(state, session, 'delivery-notes', {
    id: `outgoing-chain-delivery-${suffix}`,
    orderId: order.document.id,
    reason: 'E2E: Lieferschein aus Auftrag',
  }, 'delivery_note');
  const advance = await createNumberedDocument(state, session, 'settlement-invoices', {
    id: `outgoing-chain-advance-${suffix}`,
    orderId: order.document.id,
    kind: 'advance_invoice',
    amount: 40,
    reason: 'E2E: Abschlagsrechnung',
  }, 'advance_invoice');
  const partial = await createNumberedDocument(state, session, 'settlement-invoices', {
    id: `outgoing-chain-partial-${suffix}`,
    orderId: order.document.id,
    kind: 'partial_invoice',
    amount: 30,
    reason: 'E2E: Teilrechnung',
  }, 'partial_invoice');
  const final = await createNumberedDocument(state, session, 'settlement-invoices', {
    id: `outgoing-chain-final-${suffix}`,
    orderId: order.document.id,
    kind: 'final_invoice',
    amount: 50,
    reason: 'E2E: Schlussrechnung',
  }, 'final_invoice');
  const credit = await createNumberedDocument(state, session, 'corrections', {
    id: `outgoing-chain-credit-${suffix}`,
    invoiceId: final.document.id,
    kind: 'credit_note',
    amount: 20,
    reason: 'E2E: Teilgutschrift',
  }, 'credit_note');
  const revision = await createNumberedDocument(state, session, 'revisions', {
    id: `outgoing-chain-revision-${suffix}`,
    invoiceId: final.document.id,
    reason: 'E2E: Revision mit korrigiertem Dokumentstand',
  }, 'final_invoice');

  const chain = await requestJson(state, session, `/api/v1/pro/document-chain/${encodeURIComponent(order.document.id)}`);
  expect(chain).toHaveLength(7);
  expect(chain.map((document) => document.id)).toEqual(expect.arrayContaining([
    order.document.id,
    delivery.document.id,
    advance.document.id,
    partial.document.id,
    final.document.id,
    credit.document.id,
    revision.document.id,
  ]));
  const revisions = await requestJson(state, session, `/api/v1/pro/document-chain/${encodeURIComponent(final.document.id)}/revisions`);
  expect(revisions).toEqual([expect.objectContaining({ id: revision.document.id, revisionOfId: final.document.id, revisionNumber: 1 })]);

  // A fresh list proves the chain and its immutable relation fields survived
  // the save/refetch boundary rather than only existing in the POST response.
  const refetchedInvoices = await requestJson(state, session, '/api/v1/pro/invoices');
  expect(refetchedInvoices).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: order.document.id, documentKind: 'order_confirmation', rootDocumentId: order.document.id }),
    expect.objectContaining({ id: delivery.document.id, documentKind: 'delivery_note', rootDocumentId: order.document.id }),
    expect.objectContaining({ id: credit.document.id, documentKind: 'credit_note', sourceDocumentId: final.document.id, rootDocumentId: order.document.id }),
    expect.objectContaining({ id: revision.document.id, revisionOfId: final.document.id, revisionNumber: 1 }),
  ]));

  const journal = await requestJson(state, session, '/api/v1/pro/accounting/journal');
  expect(journal.filter((entry) => entry.sourceKey === `outgoing-invoice:${order.document.id}`)).toHaveLength(0);
  expect(journal.filter((entry) => entry.sourceKey === `outgoing-invoice:${delivery.document.id}`)).toHaveLength(0);
  const finalEntry = journal.find((entry) => entry.sourceKey === `outgoing-invoice:${final.document.id}`);
  const creditEntry = journal.find((entry) => entry.sourceKey === `outgoing-correction:${credit.document.id}`);
  expect(finalEntry).toBeTruthy();
  expect(creditEntry).toBeTruthy();
  const finalReceivable = finalEntry?.lines.find((line) => line.accountNumber === '1200');
  const creditReceivable = creditEntry?.lines.find((line) => line.accountNumber === '1200');
  expect(finalReceivable?.debitAmount).toBeGreaterThan(0);
  expect(creditReceivable?.creditAmount).toBeGreaterThan(0);

  const openItems = await requestJson(state, session, '/api/v1/pro/accounting/open-items');
  const finalItem = openItems.find((item) => item.sourceId === final.document.id);
  expect(finalItem).toMatchObject({ sourceId: final.document.id, allocatedAmount: 20, residualAmount: 30, status: 'partially_paid' });
  expect(openItems.some((item) => item.sourceId === credit.document.id)).toBe(false);

  // Retrying the explicit posting command exercises the persisted source-key
  // idempotency after the browser-style invoice save already posted it.
  const journalCountBeforeRetry = journal.length;
  const retry = await requestJson(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, {
    method: 'POST',
    body: {
      reason: 'E2E: idempotenter Korrektur-Buchungsretry',
      invoiceId: credit.document.id,
      reservationId: credit.reservation.reservationId,
    },
  });
  expect(retry).toMatchObject({ sourceId: credit.document.id, status: 'ready' });
  expect((await requestJson(state, session, '/api/v1/pro/accounting/journal')).length).toBe(journalCountBeforeRetry);
  const creditAfterPost = await requestJson(state, session, `/api/v1/pro/invoices/${encodeURIComponent(credit.document.id)}`);
  expect(creditAfterPost.history.some((entry) => entry.action.includes('accounting_post'))).toBe(true);

  const directory = await captureDirectory();
  await openProShell(page, state, { route: 'documents', session });
  await expect(page.getByText('Rechnungen', { exact: true }).first()).toBeVisible();
  await page.getByText(final.document.number, { exact: true }).click();
  const chainPanel = page.getByTestId('document-chain-panel');
  await expect(chainPanel).toContainText('Auftragsbestätigung');
  await expect(chainPanel).toContainText('Lieferschein');
  await expect(chainPanel).toContainText('Gutschrift');
  await expect(chainPanel).toContainText('Revision');
  await capture(page, directory, '01-chain-and-revision');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText(final.document.number, { exact: true }).click();
  await expect(page.getByTestId('document-chain-panel')).toContainText('Schlussrechnung');
  await expect(page.getByTestId('document-chain-panel')).toContainText('Gutschrift');
  await capture(page, directory, '02-chain-after-reload');
};
