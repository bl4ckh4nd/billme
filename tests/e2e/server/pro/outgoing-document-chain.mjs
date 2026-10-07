import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export const createAcceptedOffer = async (state, session) => {
  const offers = await requestJson(state, session, '/api/v1/pro/offers');
  const source = offers.find((offer) => offer.status === 'open');
  if (!source) throw new Error('Seeded Pro offer was not persisted.');
  const accepted = {
    ...source,
    id: randomUUID(),
    number: `CHAIN-${randomUUID()}`,
    layout: undefined,
    amount: 140.4,
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
  expect(saved).toMatchObject({ id: accepted.id, status: 'accepted', amount: 140.4 });
  return saved;
};

export const configureOutgoingPosting = async (state, session) => {
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

export const createChainDocument = async (state, session, operation, fields, expectedKind) => {
  const created = await requestJson(state, session, '/api/v1/pro/document-chain/issue', undefined, {
    method: 'POST',
    body: {
      operation,
      id: fields.id,
      date: '2026-09-04',
      dueDate: '2026-09-18',
      reason: fields.reason,
      ...fields,
    },
  });
  expect(created).toMatchObject({ id: fields.id, documentKind: expectedKind, status: operation === 'revision' ? 'draft' : 'open' });
  expect(created.number).toBeTruthy();
  return { document: created };
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
  const order = await createChainDocument(state, session, 'order_confirmation', {
    id: `outgoing-chain-order-${suffix}`,
    offerId: offer.id,
    reason: 'E2E: Auftragsbestätigung aus Angebot',
  }, 'order_confirmation');
  const delivery = await createChainDocument(state, session, 'delivery_note', {
    id: `outgoing-chain-delivery-${suffix}`,
    orderId: order.document.id,
    reason: 'E2E: Lieferschein aus Auftrag',
  }, 'delivery_note');
  const advance = await createChainDocument(state, session, 'settlement_invoice', {
    id: `outgoing-chain-advance-${suffix}`,
    orderId: order.document.id,
    kind: 'advance_invoice',
    amount: 40,
    reason: 'E2E: Abschlagsrechnung',
  }, 'advance_invoice');
  const partial = await createChainDocument(state, session, 'settlement_invoice', {
    id: `outgoing-chain-partial-${suffix}`,
    orderId: order.document.id,
    kind: 'partial_invoice',
    amount: 30,
    reason: 'E2E: Teilrechnung',
  }, 'partial_invoice');
  const final = await createChainDocument(state, session, 'settlement_invoice', {
    id: `outgoing-chain-final-${suffix}`,
    orderId: order.document.id,
    kind: 'final_invoice',
    amount: 70.4,
    reason: 'E2E: Schlussrechnung',
  }, 'final_invoice');
  const credit = await createChainDocument(state, session, 'correction', {
    id: `outgoing-chain-credit-${suffix}`,
    invoiceId: final.document.id,
    kind: 'credit_note',
    amount: 20,
    reason: 'E2E: Teilgutschrift',
  }, 'credit_note');
  const revision = await createChainDocument(state, session, 'revision', {
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
    expect.objectContaining({ id: revision.document.id, revisionOfId: final.document.id, revisionNumber: 1, status: 'draft' }),
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
  expect(finalItem).toMatchObject({ sourceId: final.document.id, allocatedAmount: 20, residualAmount: 50.4, status: 'partially_paid' });
  expect(openItems.some((item) => item.sourceId === credit.document.id)).toBe(false);

  // Retrying the explicit posting command exercises the persisted source-key
  // idempotency after the browser-style invoice save already posted it.
  const journalCountBeforeRetry = journal.length;
  const retry = await requestJson(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, {
    method: 'POST',
    body: {
      reason: 'E2E: idempotenter Korrektur-Buchungsretry',
      invoiceId: credit.document.id,
      reservationId: credit.document.numberReservationId,
    },
  });
  expect(retry).toMatchObject({ sourceId: credit.document.id, status: 'ready' });
  expect((await requestJson(state, session, '/api/v1/pro/accounting/journal')).length).toBe(journalCountBeforeRetry);
  const creditAfterPost = await requestJson(state, session, `/api/v1/pro/invoices/${encodeURIComponent(credit.document.id)}`);
  expect(creditAfterPost.history.some((entry) => entry.action.includes('accounting_post'))).toBe(true);

  const directory = await captureDirectory();
  const pdfResponse = await fetch(`${state.urls.api}/api/v1/pro/documents/invoice/${encodeURIComponent(credit.document.id)}/pdf`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  expect(pdfResponse.status).toBe(200);
  const creditPdf = path.join(directory, 'credit-note.pdf');
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await fs.writeFile(creditPdf, pdf);
  const { stdout: text } = await promisify(execFile)('pdftotext', ['-layout', creditPdf, '-']);
  expect(text).toContain('20,00');
  expect(text).toContain('0,1424');
  expect(text).toContain('14,24');
  await fs.writeFile(path.join(directory, 'credit-note.txt'), text);
  await promisify(execFile)('pdftoppm', ['-png', '-singlefile', '-scale-to', '1600', creditPdf, path.join(directory, 'credit-note')]);
  await openProShell(page, state, { route: 'documents', session });
  await expect(page.getByRole('heading', { name: 'Rechnungen & Angebote', level: 1 })).toBeVisible();
  await page.getByRole('row', { name: `Schlussrechnung ${final.document.number} öffnen`, exact: true }).dblclick();
  const chainOverview = page.getByTestId('document-chain-panel');
  await expect(chainOverview).toContainText('Auftragsbestätigung');
  await expect(chainOverview).toContainText('Lieferschein');
  await expect(chainOverview).toContainText('Gutschrift');
  await expect(chainOverview).toContainText('Revision');
  await capture(page, directory, '01-chain-and-revision');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('row', { name: `Schlussrechnung ${final.document.number} öffnen`, exact: true }).dblclick();
  await expect(chainOverview).toContainText('Schlussrechnung');
  await expect(chainOverview).toContainText('Gutschrift');
  await capture(page, directory, '02-chain-after-reload');
};
