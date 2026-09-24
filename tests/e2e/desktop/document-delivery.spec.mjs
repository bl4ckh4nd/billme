import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setDesktopSettings } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const openDocument = async (page, baseUrl, number, kind = 'invoice') => {
  await page.goto(appUrl(baseUrl, '/documents'));
  if (kind === 'offer') await page.getByRole('radio', { name: 'Angebote' }).click();
  await page.getByText(number, { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: number })).toBeVisible();
};

test('exports an invoice PDF from the hidden print window', async () => {
  const { page } = desktop;
  const [invoice] = await invokeDesktopIpc(page, 'invoices:list', {});
  const result = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: invoice.id });
  expect(fs.statSync(result.path).size).toBeGreaterThan(10_000);
  expect(fs.readFileSync(result.path).subarray(0, 5).toString()).toBe('%PDF-');

  await expect(invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: 'missing-invoice' }))
    .rejects.toThrow(/Dokument nicht gefunden/);
});

test('refuses to report mail as sent without a mail provider', async () => {
  const { page } = desktop;
  const [invoice] = await invokeDesktopIpc(page, 'invoices:list', {});
  const result = await invokeDesktopIpc(page, 'email:send', {
    documentType: 'invoice',
    documentId: invoice.id,
    recipientEmail: 'kunde@example.com',
    recipientName: 'Kunde',
    subject: `Rechnung ${invoice.number}`,
    bodyText: 'Anbei die Rechnung.',
  });
  expect(result).toEqual({ success: false, error: expect.stringContaining('Kein E-Mail-Anbieter eingerichtet') });
});

test('marks an invoice paid once recorded payments cover it', async () => {
  const { page, baseUrl } = desktop;
  const invoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.status === 'open');
  await openDocument(page, baseUrl, invoice.number);

  await page.getByRole('button', { name: 'Zahlung', exact: true }).click();
  const amount = page.getByLabel('Betrag (EUR)');
  await expect(amount).not.toHaveValue('');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(async () => (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.id === invoice.id)?.status).toBe('paid');
  await page.reload();
  await openDocument(page, baseUrl, invoice.number);
  await expect(page.getByText(/^Bezahlt am /)).toBeVisible();
});

test('assigns the next customer number to a client created in the UI', async () => {
  const { page, baseUrl } = desktop;
  const settings = await getDesktopSettings(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: 'Neuer Kunde' }).click();
  await page.getByLabel('Firma').fill('Nummernkreis GmbH');
  await page.getByLabel('E-Mail-Adresse').fill('nk@example.com');
  await page.getByLabel('Straße').fill('Testweg 1');
  await page.getByLabel('PLZ').fill('10115');
  await page.getByLabel('Stadt').fill('Berlin');
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(async () => (await invokeDesktopIpc(page, 'clients:list', {})).find((row) => row.company === 'Nummernkreis GmbH')?.customerNumber ?? null)
    .toMatch(new RegExp(`^${settings.numbers.customerPrefix}`));
});

test('records a phone acceptance and converts the offer into an invoice', async () => {
  const { page, baseUrl } = desktop;
  const [seeded] = await invokeDesktopIpc(page, 'offers:list', {});
  const {
    shareDecision: _decision, acceptedAt: _acceptedAt, acceptedBy: _acceptedBy,
    acceptedEmail: _acceptedEmail, acceptedUserAgent: _acceptedUserAgent, ...undecided
  } = seeded;
  const offer = await invokeDesktopIpc(page, 'offers:upsert', {
    reason: 'E2E undecided offer',
    offer: { ...undecided, id: 'offer-phone-1', number: 'ANG-2026-090' },
  });
  await page.reload();
  await openDocument(page, baseUrl, offer.number, 'offer');
  await expect(page.getByText('Noch keine Entscheidung')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Zahlungslink kopieren' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Angenommen' }).click();
  await expect(page.getByRole('button', { name: 'In Rechnung umwandeln' })).toBeVisible();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'offers:list', {})).find((row) => row.id === offer.id)?.shareDecision).toBe('accepted');
});

test('prints the configured payment term instead of a fixed 14 days', async () => {
  const { page, baseUrl } = desktop;
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, legal: { ...settings.legal, paymentTermsDays: 21 } });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: 'Neue Rechnung' }).click();
  await expect(page.getByText(/innerhalb von 14 Tagen/)).toHaveCount(0);
  await expect(page.getByText(/bis spätestens \d{2}\.\d{2}\.\d{4}/).first()).toBeVisible();

  // An untouched draft is not "unsaved changes".
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('Ungespeicherte Änderungen verwerfen?')).toHaveCount(0);
});

test('opens a new invoice again after a discarded draft released its number', async () => {
  const { page, baseUrl } = desktop;
  const openNewInvoice = async () => {
    await page.goto(appUrl(baseUrl, '/documents'));
    await page.getByRole('button', { name: 'Neue Rechnung' }).click();
    await expect(page.getByRole('heading', { name: 'Rechnung erstellen' })).toBeVisible();
  };
  await openNewInvoice();
  await page.getByRole('button', { name: 'Position hinzufügen' }).click();
  await page.getByRole('button', { name: 'Zurück' }).click();
  await page.getByRole('button', { name: 'Änderungen verwerfen' }).click();
  await expect(page.getByRole('heading', { name: 'Dokumente' })).toBeVisible();

  await openNewInvoice();
});

test('runs due recurring profiles in the background without a server worker', async () => {
  const { page } = desktop;
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, {
    ...settings,
    automation: { ...settings.automation, recurringEnabled: true, recurringRunTime: '00:00', lastRecurringRun: undefined },
  });
  const invoicesBefore = (await invokeDesktopIpc(page, 'invoices:list', {})).length;

  // The main-process ticker fires 15 s after start and then every minute.
  await expect.poll(async () => (await getDesktopSettings(page)).automation?.lastRecurringRun ?? null, { timeout: 90_000 })
    .not.toBeNull();
  expect((await invokeDesktopIpc(page, 'invoices:list', {})).length).toBeGreaterThan(invoicesBefore);
});
