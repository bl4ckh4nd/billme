import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readServerHarnessState } from '../harness.mjs';
import {
  createOwnerCredentials,
  ensureHarnessSession,
  openProShell,
  requestJson,
  seedHarnessProTenant,
} from './helpers.mjs';

const owner = createOwnerCredentials('pro');
const screenshotDirectory = fileURLToPath(
  new URL('../../../../docs/audit/screenshots/2026-09-04-acceptance/', import.meta.url),
);

const attachScreenshot = async (page, testInfo, name, target) => {
  if (target) await target.scrollIntoViewIfNeeded();
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = `${screenshotDirectory}/${name}.png`;
  const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
  if (testInfo?.attach) {
    await testInfo.attach(name, {
      body: screenshot,
      contentType: 'image/png',
    });
  }
};

const configureIncomingPosting = async (state, session, suffix) => {
  const accountMapping = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/mappings',
    undefined,
    {
      method: 'POST',
      body: {
        reason: `Incoming UI E2E ${suffix} Kreditorenkonto`,
        chart: 'SKR03',
        role: 'accounts_payable',
        accountNumber: '1600',
      },
    },
  );
  expect(accountMapping).toMatchObject({ chart: 'SKR03', role: 'accounts_payable', accountNumber: '1600' });

  for (const taxCaseKey of ['DE_STD_19', 'DE_STD_7']) {
    const taxMapping = await requestJson(
      state,
      session,
      '/api/v1/pro/accounting/tax-case-account-mappings',
      undefined,
      {
        method: 'POST',
        body: {
          id: `incoming-ui-${suffix}-${taxCaseKey.toLowerCase()}-input-tax`,
          reason: `Incoming UI E2E ${suffix} Vorsteuerkonto`,
          chart: 'SKR03',
          taxCaseKey,
          role: 'input_tax',
          accountNumber: '1576',
        },
      },
    );
    expect(taxMapping).toMatchObject({ chart: 'SKR03', taxCaseKey, role: 'input_tax', accountNumber: '1576' });
  }

  const vendorId = `incoming-ui-vendor-${suffix}`;
  const vendor = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/vendors',
    undefined,
    {
      method: 'POST',
      body: {
        reason: `Incoming UI E2E ${suffix} Kreditor anlegen`,
        vendor: {
          id: vendorId,
          vendorNumber: `V-${suffix}`,
          name: `Incoming UI Vendor ${suffix}`,
          email: `incoming-ui-${suffix}@billme-e2e.local`,
          defaultExpenseAccount: '3125',
        },
      },
    },
  );
  expect(vendor).toMatchObject({ id: vendorId, name: `Incoming UI Vendor ${suffix}` });
  return { vendorId };
};

export const runProIncomingInvoiceUiScenario = async (page, testInfo = { workerIndex: 0 }) => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, { product: 'pro', ...owner });
  const suffix = `${Date.now()}-${testInfo.workerIndex}`;
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace: `incoming-ui-${suffix}` });
  const { vendorId } = await configureIncomingPosting(state, session, suffix);
  const invoiceNumber = `ER-UI-${suffix}`;

  await openProShell(page, state, { route: 'accounting', session });
  await page.waitForTimeout(1_000);
  const accountingError = await page.getByRole('alert').textContent().catch(() => null);
  if (accountingError) throw new Error(`Shared Pro accounting failed to load: ${accountingError}`);
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await page.getByRole('button', { name: 'OPOS' }).click();
  const incomingHeading = page.getByRole('heading', { name: 'Eingangsrechnungen' });
  await expect(incomingHeading).toBeVisible();
  const incomingSection = page.locator('section[aria-labelledby="incoming-heading"]');

  await attachScreenshot(page, testInfo, 'incoming-01-empty-editor', incomingHeading);

  await incomingSection.getByLabel('Rechnungsnummer').fill(invoiceNumber);
  await incomingSection.locator('select').first().selectOption(vendorId);
  const positions = incomingSection.getByLabel('Position');
  await positions.nth(0).fill('Managed hosting');
  await incomingSection.getByLabel('Menge').nth(0).fill('1');
  await incomingSection.getByLabel('Einzelpreis').nth(0).fill('100');
  await incomingSection.getByLabel('Steuersatz').nth(0).fill('19');
  await incomingSection.getByLabel('Konto', { exact: true }).nth(0).fill('3125');
  await incomingSection.getByRole('button', { name: 'Position hinzufügen' }).click();
  await page.getByLabel('Position').nth(1).fill('Hardware asset');
  await incomingSection.getByLabel('Menge').nth(1).fill('1');
  await incomingSection.getByLabel('Einzelpreis').nth(1).fill('100');
  await incomingSection.getByLabel('Steuersatz').nth(1).fill('7');
  await incomingSection.getByLabel('Konto', { exact: true }).nth(1).fill('3125');
  await incomingSection.getByLabel('Anlagekonto').nth(1).fill('0480');

  await attachScreenshot(page, testInfo, 'incoming-02-populated-multi-line', incomingHeading);

  await page.getByLabel('Begründung').nth(1).fill(`Incoming UI E2E ${suffix} geprüft`);
  await page.getByRole('button', { name: 'Position hinzufügen' }).click();
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByText('Bitte prüfe die markierten Felder.Beschreibung ist erforderlich.', { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'incoming-03-validation-error', incomingHeading);
  await page.getByRole('button', { name: 'Entfernen' }).last().click();

  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByRole('status')).toContainText('als Entwurf gespeichert');
  await expect(incomingSection.getByTestId('incoming-invoice-summary')).toContainText('2 Positionen gespeichert');

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/#\/accounting$/);
  await page.getByRole('button', { name: 'OPOS' }).click();
  await expect(incomingHeading).toBeVisible();
  const storedInvoice = page.getByRole('combobox', { name: 'Gespeicherten Beleg wählen' });
  await expect(storedInvoice.locator('option').filter({ hasText: invoiceNumber })).toHaveCount(1);
  const storedInvoiceId = await storedInvoice.locator('option').filter({ hasText: invoiceNumber }).getAttribute('value');
  expect(storedInvoiceId).toBeTruthy();
  await storedInvoice.selectOption(storedInvoiceId);
  await expect(page.getByTestId('incoming-invoice-summary')).toContainText('2 Positionen gespeichert');
  await expect(page.getByTestId('incoming-invoice-summary')).toContainText('7% 7,00');
  await expect(page.getByTestId('incoming-invoice-summary')).toContainText('19% 19,00');
  await page.getByRole('button', { name: 'Vorschau' }).click();
  await expect(page.getByText('Vorschau: bereit')).toBeVisible();
  await attachScreenshot(page, testInfo, 'incoming-04-saved-refetched', incomingHeading);

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  await page.getByLabel('Datei archivieren').setInputFiles({
    name: `${invoiceNumber}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await page.getByLabel('Begründung').nth(1).fill(`Incoming UI E2E ${suffix} Original geprüft`);
  await page.getByRole('button', { name: 'Original archivieren' }).click();
  await expect(page.getByText(`${invoiceNumber}.pdf`)).toBeVisible();
  await page.getByRole('button', { name: 'Als geprüft markieren' }).click();
  await expect(page.getByText('Geprüft', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Für Buchung freigeben' }).click();
  await expect(page.getByRole('status')).toContainText('zur Buchung freigegeben');
  await page.getByRole('button', { name: 'Buchen' }).click();
  await expect(page.getByText('Eingangsrechnung gebucht.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Journal /)).toBeVisible();
  await expect(page.getByText('Geprüft', { exact: true })).toBeVisible();
  const openItemsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Offene Posten' }) });
  await expect(openItemsSection.getByRole('button', { name: invoiceNumber })).toBeVisible();
  await attachScreenshot(page, testInfo, 'incoming-05-posted-reviewed', incomingSection);

  const persistedInvoices = await requestJson(state, session, '/api/v1/pro/accounting/incoming-invoices');
  const persisted = persistedInvoices.find((invoice) => invoice.number === invoiceNumber);
  expect(persisted).toMatchObject({
    vendorId,
    netAmount: 200,
    taxAmount: 26,
    grossAmount: 226,
    accountingStatus: 'posted',
  });
  expect(persisted?.lines).toEqual([
    expect.objectContaining({ description: 'Managed hosting', netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '3125' }),
    expect.objectContaining({ description: 'Hardware asset', netAmount: 100, taxRate: 7, taxAmount: 7, grossAmount: 107, accountNumber: '3125', assetAccountNumber: '0480' }),
  ]);

  const journal = (await requestJson(state, session, '/api/v1/pro/accounting/journal'))
    .find((entry) => entry.sourceType === 'incoming_invoice' && entry.sourceKey === `incoming-invoice:${persisted.id}`);
  expect(journal).toMatchObject({ status: 'posted', sourceType: 'incoming_invoice' });
  expect(journal?.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountNumber: '3125', debitAmount: 100 }),
    expect.objectContaining({ accountNumber: '0480', debitAmount: 100 }),
    expect.objectContaining({ accountNumber: '1576', debitAmount: 19 }),
    expect.objectContaining({ accountNumber: '1576', debitAmount: 7 }),
    expect.objectContaining({ accountNumber: '1600', creditAmount: 226 }),
  ]));

  const openItem = (await requestJson(state, session, '/api/v1/pro/accounting/open-items'))
    .find((item) => item.sourceType === 'incoming_invoice' && item.sourceId === persisted.id);
  expect(openItem).toMatchObject({ documentNumber: invoiceNumber, originalAmount: 226, status: 'open', journalEntryId: journal?.id });
};

if (process.env.E2E_SCENARIO_IMPORT !== '1') {
  test('creates, validates, persists, reviews, and posts a multi-line incoming invoice in Pro Web', async ({ page }, testInfo) => {
    await runProIncomingInvoiceUiScenario(page, testInfo);
  });
}
