import { expect } from '@playwright/test';
import { readServerHarnessState } from '../harness.mjs';
import { createHarnessProTenant, ensureHarnessSession, openProShell, requestJson, seedHarnessProTenant } from './helpers.mjs';
import { configureOutgoingPosting, createAcceptedOffer, createChainDocument } from './outgoing-document-chain.mjs';

const euro = (value) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

/**
 * The Pro dashboard's Soll VAT estimate for this month counts what is owed: an order
 * confirmation and a delivery note bill nothing, an unpaid advance invoice is taxed
 * only when paid (Mindest-Ist), and a credit note reduces the VAT instead of adding to it.
 */
export const runProVatEstimateScenario = async (page) => {
  const state = await readServerHarnessState();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const credentials = { email: `pro-vat-estimate-${suffix}@billme-e2e.local`, fullName: 'Billme Pro VAT Estimate E2E', password: 'billme-server-123' };
  const tenant = await createHarnessProTenant(state, credentials);
  const session = await ensureHarnessSession(state, { product: 'pro', ...credentials });
  expect(session.tenantId).toBe(tenant.tenantId);
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace: `vat-estimate-${suffix}` });
  await configureOutgoingPosting(state, session);

  const today = new Date().toLocaleDateString('sv-SE'); // local calendar day, like the dashboard month
  const issue = (operation, fields, kind) => createChainDocument(state, session, operation, { date: today, dueDate: today, ...fields }, kind);
  const offer = await createAcceptedOffer(state, session);
  const order = (await issue('order_confirmation', { id: `vat-order-${suffix}`, offerId: offer.id, reason: 'E2E: AB' }, 'order_confirmation')).document;
  await issue('delivery_note', { id: `vat-delivery-${suffix}`, orderId: order.id, reason: 'E2E: LS' }, 'delivery_note');
  await issue('settlement_invoice', { id: `vat-advance-${suffix}`, orderId: order.id, kind: 'advance_invoice', amount: 40, reason: 'E2E: Abschlag' }, 'advance_invoice');
  const partial = (await issue('settlement_invoice', { id: `vat-partial-${suffix}`, orderId: order.id, kind: 'partial_invoice', amount: 30, reason: 'E2E: Teil' }, 'partial_invoice')).document;
  const final = (await issue('settlement_invoice', { id: `vat-final-${suffix}`, orderId: order.id, kind: 'final_invoice', amount: 70.4, reason: 'E2E: Schluss' }, 'final_invoice')).document;
  const credit = (await issue('correction', { id: `vat-credit-${suffix}`, invoiceId: final.id, kind: 'credit_note', amount: 20, reason: 'E2E: Gutschrift' }, 'credit_note')).document;

  const settings = await requestJson(state, session, '/api/v1/pro/settings');
  expect(settings.legal.taxAccountingMethod ?? 'soll').toBe('soll');
  const vatOf = (document) => Math.abs(document.taxSnapshot.vatAmount);
  const expected = Math.round((vatOf(partial) + vatOf(final) - vatOf(credit)) * 100) / 100;
  expect(expected).toBeGreaterThan(0);

  await openProShell(page, state, { route: 'overview', session });
  const tile = page.locator('section[aria-labelledby="dashboard-tax"]');
  await expect(tile).toContainText('Soll-Versteuerung');
  await expect(tile).toContainText(euro(expected));
  if (process.env.E2E_SCREENSHOT_DIR) await tile.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/pro-vat-estimate.png` });
};
