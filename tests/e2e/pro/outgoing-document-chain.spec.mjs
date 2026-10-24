import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  appUrl,
  getDesktopSettings,
  invokeDesktopIpc,
  launchDesktopApp,
  seedDesktopData,
  setDesktopSettings,
} from '../support.mjs';

const SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  'docs/audit/screenshots/2026-09-04-acceptance/outgoing-desktop',
);

let desktop;
const directRunner = process.env.BILLME_DESKTOP_CHAIN_DIRECT_RUNNER === '1';

// The Playwright spec leaves its screenshots in the test output; only the direct runner (outgoing-document-chain.mjs) writes into docs/audit.
const screenshot = async (page, name) => {
  const dir = directRunner ? SCREENSHOT_DIR : test.info().outputPath('chain');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: true,
  });
};

const listInvoices = (page) => invokeDesktopIpc(page, 'invoices:list');

/** The seed issues Kleinunternehmer invoices (Erlöse § 19 UStG), so it runs under KU; the chain then charges 19 % VAT. */
export const seedUnderRegularVat = async (page) => {
  await seedDesktopData(page, { app: 'pro' });
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, legal: { ...settings.legal, smallBusinessRule: false, defaultVatRate: 19 } });
};

export const configureOutgoingPosting = async (page) => {
  const policy = await invokeDesktopIpc(page, 'pro:getAccountingPolicy');
  const ledger = await invokeDesktopIpc(page, 'pro:listLedgerAccounts', { chart: policy.activeChart, limit: 3000, offset: 0 });
  const account = (preferred, predicate = () => true) =>
    ledger.find((entry) => entry.accountNumber === preferred)?.accountNumber
    ?? ledger.find(predicate)?.accountNumber;
  const receivable = account(policy.activeChart === 'SKR03' ? '1400' : '1200');
  const revenue = account(policy.activeChart === 'SKR03' ? '8400' : '4400', (entry) => /erlös|ertrag/i.test(entry.name));
  const outputVat = account(policy.activeChart === 'SKR03' ? '1776' : '3806', (entry) => /umsatzsteuer/i.test(entry.name));
  for (const [label, value] of Object.entries({ receivable, revenue, outputVat })) expect(value, `${label} account`).toBeTruthy();
  for (const [role, accountNumber] of [
    ['accounts_receivable', receivable],
    ['revenue', revenue],
    ['output_vat', outputVat],
    ['output_vat_deferred', outputVat],
  ]) {
    await invokeDesktopIpc(page, 'pro:upsertAccountingAccountMapping', { chart: policy.activeChart, role, accountNumber });
  }
};

const waitForNewInvoiceDocument = async (page, documentKind, knownIds = []) => {
  let candidate;
  await expect
    .poll(
      async () => {
        const invoices = await listInvoices(page);
        candidate = invoices.find(
          (document) => document.documentKind === documentKind && !knownIds.includes(document.id),
        );
        return candidate?.id ?? '';
      },
      { timeout: 20_000, intervals: [100, 250, 500, 1_000] },
    )
    .not.toBe('');
  return candidate;
};

const waitForNewChainDocument = async (page, rootDocumentId, documentKind, knownIds = []) => {
  let candidate;
  await expect
    .poll(
      async () => {
        const chain = await invokeDesktopIpc(page, 'documents:chainList', { rootDocumentId });
        candidate = chain.find(
          (document) => document.documentKind === documentKind && !knownIds.includes(document.id),
        );
        return candidate?.id ?? '';
      },
      { timeout: 20_000, intervals: [100, 250, 500, 1_000] },
    )
    .not.toBe('');
  return candidate;
};

const selectChainDocument = async (page, document) => {
  const chainItem = page.getByTestId(`document-chain-item-${document.id}`);
  await expect(chainItem).toBeVisible({ timeout: 20_000 });
  await chainItem.click();
  await expect(page.getByRole('heading', { name: document.number, exact: true })).toBeVisible();
};

const completeChainAction = async ({ page, rootDocumentId, action, kind, amount, knownIds = [] }) => {
  const chainBefore = await invokeDesktopIpc(page, 'documents:chainList', { rootDocumentId });
  await page.getByRole('button', { name: action, exact: true }).click();
  if (amount !== undefined) {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Betrag (EUR)').fill(String(amount));
    await screenshot(page, `dialog-${kind}`);
    await dialog.getByRole('button', { name: / erstellen$/, exact: false }).click();
  }
  let immediateResult = '';
  await expect.poll(async () => {
    const chain = await invokeDesktopIpc(page, 'documents:chainList', { rootDocumentId });
    const candidate = chain.find(
      (document) => document.documentKind === kind && !knownIds.includes(document.id),
    );
    if (candidate) return candidate.id;
    const visibleText = await page.locator('body').innerText();
    const failure = visibleText.match(/Dokument konnte nicht erstellt werden:[^\n]*/)?.[0];
    return failure ? `ERROR:${failure}` : '';
  }, { timeout: 7_000, intervals: [100, 250, 500] }).not.toBe('');
  immediateResult = await (async () => {
    const visibleText = await page.locator('body').innerText();
    return visibleText.match(/Dokument konnte nicht erstellt werden:[^\n]*/)?.[0] ?? '';
  })();
  if (immediateResult) throw new Error(immediateResult);
  let created;
  try {
    created = await waitForNewChainDocument(page, rootDocumentId, kind, knownIds);
  } catch (error) {
    const visibleText = await page.locator('body').innerText();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nVisible UI:\n${visibleText.slice(-2_000)}`);
  }
  // Each chain action must issue exactly one document.
  const chainAfter = await invokeDesktopIpc(page, 'documents:chainList', { rootDocumentId });
  expect(chainAfter).toHaveLength(chainBefore.length + 1);
  const createdHeading = page.getByRole('heading', { name: created.number, exact: true });
  if (!await createdHeading.isVisible().catch(() => false)) {
    await page.reload();
    await page.getByText(created.number, { exact: true }).click();
  }
  await expect(createdHeading).toBeVisible({ timeout: 20_000 });
  return created;
};

export const runProDesktopOutgoingDocumentChainScenario = async (page, baseUrl) => {

  // The accepted offer is a prerequisite seeded through the typed IPC bridge;
  // every outgoing-chain mutation below is performed by the visible UI.
  const seeded = (await invokeDesktopIpc(page, 'offers:list')).find((entry) => entry.id === 'offer-open-1');
  // Accepted offers are immutable, so the chain starts from its own offer:
  // positions are set while it is a draft, then the customer accepts it.
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'offer' });
  const draft = await invokeDesktopIpc(page, 'offers:upsert', {
    reason: 'E2E outgoing chain setup',
    offer: {
      ...seeded,
      id: 'offer-chain-1',
      // The seeded offer has no address; the invoices of the chain copy it and §14 UStG requires one.
      clientAddress: 'Torstrasse 5\n10119 Berlin',
      number: reservation.number,
      numberReservationId: reservation.reservationId,
      status: 'draft',
      shareDecision: null,
      acceptedAt: null,
      acceptedBy: null,
      acceptedEmail: null,
      acceptedUserAgent: null,
      taxMode: 'standard_vat',
      // Gross: 120 € net plus 19 % USt. The chain copies it and refuses a total its lines cannot reach to the cent.
      amount: 142.8,
      items: [
        { kind: 'item', description: 'Konzeption', quantity: 1, price: 80, total: 80, taxRate: 19 },
        { kind: 'item', description: 'Umsetzung', quantity: 1, price: 40, total: 40, taxRate: 19 },
      ],
    },
  });
  const offer = await invokeDesktopIpc(page, 'offers:upsert', {
    reason: 'Angebot telefonisch angenommen',
    offer: { ...draft, shareDecision: 'accepted', acceptedAt: new Date().toISOString(), acceptedBy: seeded.client },
  });
  expect(offer.shareDecision).toBe('accepted');
  await page.reload();

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('radio', { name: 'Angebote', exact: true }).click();
  await page.getByText(offer.number, { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auftragsbestätigung', exact: true })).toBeVisible();
  await screenshot(page, '01-accepted-offer');

  await page.getByRole('button', { name: 'Auftragsbestätigung', exact: true }).click();
  const order = await waitForNewInvoiceDocument(page, 'order_confirmation');
  await expect(page.getByRole('heading', { name: order.number, exact: true })).toBeVisible({ timeout: 20_000 });
  const rootDocumentId = order.rootDocumentId ?? order.id;
  expect(order.sourceDocumentId).toBe(offer.id);
  await screenshot(page, '02-order-confirmation');

  const delivery = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Lieferschein',
    kind: 'delivery_note',
  });
  expect(delivery.sourceDocumentId).toBe(order.id);
  await screenshot(page, '03-delivery-note');

  await selectChainDocument(page, order);
  const advance = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Abschlag',
    kind: 'advance_invoice',
    amount: 40,
  });
  await screenshot(page, '04-advance-invoice');

  await selectChainDocument(page, order);
  const partial = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Teilrechnung',
    kind: 'partial_invoice',
    amount: 30,
  });
  await screenshot(page, '05-partial-invoice');

  await selectChainDocument(page, order);
  const finalInvoice = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Schlussrechnung',
    kind: 'final_invoice',
    amount: 72.8,
  });
  await screenshot(page, '06-final-invoice');

  // While the Schlussrechnung settles the Abschlag, the Abschlag is not corrected on its own:
  // the Schlussrechnung is cancelled first.
  await selectChainDocument(page, advance);
  await expect(page.getByRole('button', { name: 'Gutschrift', exact: true })).toHaveCount(0);

  await selectChainDocument(page, finalInvoice);
  const cancellation = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Storno',
    kind: 'cancellation_invoice',
    amount: 72.8,
  });
  expect(cancellation.sourceDocumentId).toBe(finalInvoice.id);
  await screenshot(page, '07-cancellation-invoice');

  await selectChainDocument(page, advance);
  const creditNote = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Gutschrift',
    kind: 'credit_note',
    amount: 40,
  });
  expect(creditNote.sourceDocumentId).toBe(advance.id);
  await screenshot(page, '08-credit-note');

  // A cancelled invoice gets no revision; the unpaid Teilrechnung does, now that no Schlussrechnung settles it.
  await selectChainDocument(page, partial);
  const revision = await completeChainAction({
    page,
    rootDocumentId,
    action: 'Revision',
    kind: 'partial_invoice',
    knownIds: [partial.id],
  });
  expect(revision.sourceDocumentId).toBe(partial.id);
  expect(revision.revisionOfId).toBe(partial.id);
  expect(revision.revisionNumber).toBe(1);
  await screenshot(page, '09-revision');

  // Refetch through the typed desktop contract after a full renderer reload.
  await page.reload();
  await page.getByText(revision.number, { exact: true }).click();
  await expect(page.getByRole('heading', { name: revision.number, exact: true })).toBeVisible();
  await expect(page.getByTestId('document-chain-panel')).toBeVisible();
  await screenshot(page, '10-chain-persisted-after-reload');

  const persistedChain = await invokeDesktopIpc(page, 'documents:chainList', { rootDocumentId });
  expect(persistedChain).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: order.id, documentKind: 'order_confirmation', status: 'open' }),
      expect.objectContaining({ id: delivery.id, documentKind: 'delivery_note', status: 'open' }),
      // Fully credited: nothing is owed any more, so it is no longer open (and no longer dunned).
      expect.objectContaining({ id: advance.id, documentKind: 'advance_invoice', amount: 40, status: 'paid' }),
      expect.objectContaining({ id: partial.id, documentKind: 'partial_invoice', amount: 30, status: 'open' }),
      // Replaced by its Stornorechnung.
      expect.objectContaining({ id: finalInvoice.id, documentKind: 'final_invoice', amount: 72.8, status: 'cancelled' }),
      expect.objectContaining({ id: creditNote.id, documentKind: 'credit_note', sourceDocumentId: advance.id, status: 'open' }),
      expect.objectContaining({ id: cancellation.id, documentKind: 'cancellation_invoice', sourceDocumentId: finalInvoice.id, status: 'open' }),
      // A revision starts as a draft: it is edited before it replaces the issued document.
      expect.objectContaining({ id: revision.id, revisionOfId: partial.id, revisionNumber: 1, status: 'draft' }),
    ]),
  );

  const journalEntries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
  const outgoingEntries = journalEntries.filter((entry) =>
    persistedChain.some((document) => document.id === entry.sourceKey?.replace('outgoing-invoice:', '').replace('outgoing-correction:', '')),
  );
  expect(outgoingEntries.length).toBeGreaterThanOrEqual(5);
  expect(outgoingEntries.some((entry) => entry.bookingText.includes('Gutschrift'))).toBeTruthy();
  expect(outgoingEntries.some((entry) => entry.bookingText.includes('Stornorechnung'))).toBeTruthy();
  expect(outgoingEntries.every((entry) => entry.status === 'posted')).toBeTruthy();

  const openItems = await invokeDesktopIpc(page, 'pro:listOpenItems');
  expect(openItems.find((item) => item.sourceId === advance.id)).toMatchObject({
    residualAmount: 0,
    status: 'paid',
  });
  expect(openItems.find((item) => item.sourceId === finalInvoice.id)).toMatchObject({
    residualAmount: 0,
    status: 'paid',
  });
  expect(openItems.some((item) => [order.id, delivery.id].includes(item.sourceId))).toBe(false);

  const audit = await invokeDesktopIpc(page, 'audit:verify');
  if (!audit.ok) console.error('AUDIT_VERIFY', JSON.stringify(audit));
  expect(audit, JSON.stringify(audit)).toMatchObject({ ok: true });
  expect(audit.count).toBeGreaterThan(0);
};

if (!directRunner) {
  test.beforeEach(async () => {
    desktop = await launchDesktopApp({ app: 'pro' });
    await seedUnderRegularVat(desktop.page);
    await configureOutgoingPosting(desktop.page);
    await desktop.page.reload();
    await desktop.page.waitForFunction(() => Boolean(window.billmeApi));
  });

  test.afterEach(async () => {
    if (desktop) {
      await desktop.close();
      desktop = undefined;
    }
  });

  test('creates and persists an outgoing document chain through the Pro UI', async () => {
    await runProDesktopOutgoingDocumentChainScenario(desktop.page, desktop.baseUrl);
  });
}
