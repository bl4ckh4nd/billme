import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, readEmbeddedFacturX, seedDesktopData, setDesktopSettings } from '../support.mjs';

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
    .rejects.toThrow(/Beleg nicht gefunden/);
});

const pdfPageCount = (bytes) => (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

test('prints every document kind in the flow layout, paginates 40 positions and embeds ZUGFeRD', async () => {
  const { page, baseUrl } = desktop;
  const artifactDir = process.env.PRINT_ARTIFACT_DIR ?? test.info().outputPath('print');
  fs.mkdirSync(artifactDir, { recursive: true });
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, eInvoice: { ...settings.eInvoice, enabled: true } });

  const base = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.id === 'inv-open-1');
  const items = Array.from({ length: 40 }, (_, index) => {
    const quantity = 1 + (index % 3);
    const price = 12.5 + index;
    return { kind: 'item', description: `Position ${index + 1}: Leistenmaterial Eiche 18×40 mm`, quantity, price, total: quantity * price, taxRate: 19, unit: 'Stk.' };
  });
  const net = items.reduce((sum, item) => sum + item.total, 0);
  const documents = [
    { documentKind: 'invoice', number: 'RE-FLOW-40', zugferd: true },
    { documentKind: 'order_confirmation', number: 'AB-FLOW-40', zugferd: false },
    { documentKind: 'delivery_note', number: 'LS-FLOW-40', zugferd: false },
    { documentKind: 'credit_note', number: 'GS-FLOW-40', zugferd: true, sourceDocumentId: base.id },
  ];
  const summary = [];
  for (const entry of documents) {
    const id = `flow-${entry.documentKind}`;
    await invokeDesktopIpc(page, 'invoices:upsert', {
      reason: 'E2E Fluss-Layout',
      invoice: {
        ...base, id, number: entry.number, documentKind: entry.documentKind, sourceDocumentId: entry.sourceDocumentId,
        items, amount: Math.round(net * 119) / 100, status: 'open', payments: [], history: [],
      },
    });
    const result = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id });
    const bytes = fs.readFileSync(result.path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(path.basename(result.path)).toContain(entry.number);
    const pdfPages = pdfPageCount(bytes);
    expect(pdfPages).toBeGreaterThanOrEqual(2);
    const facturX = await readEmbeddedFacturX(bytes);
    if (entry.zugferd) {
      expect(facturX).toContain('CrossIndustryInvoice');
      expect(facturX).toContain(`<ram:ID>${entry.number}</ram:ID>`);
      expect(facturX).toContain(`<ram:TypeCode>${entry.documentKind === 'credit_note' ? '381' : '380'}</ram:TypeCode>`);
      fs.writeFileSync(path.join(artifactDir, `${entry.documentKind}.factur-x.xml`), facturX);
    } else {
      expect(facturX).toBeNull();
    }

    // The same print route in the main window: DOM page frames must match the PDF pages.
    await page.goto(`${baseUrl}/?__print=1&kind=invoice&id=${id}`);
    await page.waitForFunction(() => globalThis.__PDF_READY__ === true);
    const domPages = await page.evaluate(() => globalThis.__PDF_PAGES__);
    expect(domPages).toBe(pdfPages);
    await expect(page.getByText(`Seite ${pdfPages} von ${pdfPages}`)).toBeVisible();
    // Closing text and totals never end up alone: the last page still carries table rows.
    const lastPage = page.locator('.bf-page').last();
    await expect(lastPage.locator('.bf-row').first()).toBeVisible();
    if (entry.documentKind !== 'delivery_note') await expect(lastPage.locator('.bf-totals')).toBeVisible();
    await page.screenshot({ path: path.join(artifactDir, `${entry.documentKind}.png`), fullPage: true });
    fs.copyFileSync(result.path, path.join(artifactDir, `${entry.documentKind}.pdf`));
    summary.push({ ...entry, pdfPages, domPages, file: path.basename(result.path) });
  }

  const offerResult = await invokeDesktopIpc(page, 'pdf:export', { kind: 'offer', id: 'offer-open-1' });
  const offerBytes = fs.readFileSync(offerResult.path);
  expect(pdfPageCount(offerBytes)).toBeGreaterThanOrEqual(1);
  expect(await readEmbeddedFacturX(offerBytes)).toBeNull();
  fs.copyFileSync(offerResult.path, path.join(artifactDir, 'offer.pdf'));
  summary.push({ documentKind: 'offer', pdfPages: pdfPageCount(offerBytes), file: path.basename(offerResult.path) });
  fs.writeFileSync(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2));
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
  const due = new Date();
  due.setDate(due.getDate() + 21);
  const dueLabel = due.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await expect(page.getByRole('textbox', { name: 'Schlusstext' })).toHaveValue(new RegExp(`bis zum ${dueLabel.replaceAll('.', '\\.')}`));

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

test('reprints an issued invoice unchanged after template and company changes, and prints dunning letters', async () => {
  const { page } = desktop;
  const artifactDir = process.env.PRINT_ARTIFACT_DIR ?? test.info().outputPath('snapshot');
  fs.mkdirSync(artifactDir, { recursive: true });
  const text = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });

  // Seeded as open, so the layout was frozen when it was saved.
  const issued = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.id === 'inv-open-1');
  expect(issued.layout.snapshot).toMatchObject({ templateVersion: 1, sender: { company: { name: 'Billme E2E GmbH' } } });
  const before = await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-open-1' });
  const first = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: 'inv-open-1' });
  fs.copyFileSync(first.path, path.join(artifactDir, 'issued-before.pdf'));

  const body = { ...before.template.body, accentColor: '#b3261e', texts: { ...before.template.body.texts, closing: 'Neuer Schlusstext der geänderten Vorlage.' } };
  const changed = await invokeDesktopIpc(page, 'documentTemplates:upsert', { template: { kind: 'invoice', name: 'Geändert', body } });
  await invokeDesktopIpc(page, 'documentTemplates:setDefault', { kind: 'invoice', templateId: changed.id });
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, company: { ...settings.company, name: 'Umbenannt AG' } });

  const after = await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-open-1' });
  expect(after.template).toEqual(before.template);
  expect(after.settings.company).toEqual(before.settings.company);
  const reprint = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: 'inv-open-1' });
  const reprintText = text(reprint.path);
  expect(reprintText).toContain('Billme E2E GmbH');
  expect(reprintText).not.toContain('Umbenannt AG');
  expect(reprintText).not.toContain('Neuer Schlusstext');
  fs.copyFileSync(reprint.path, path.join(artifactDir, 'issued-reprint.pdf'));

  // A new invoice issued now uses the changed template and company.
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E Snapshot', invoice: { ...issued, id: 'inv-after-change', number: 'RE-2026-900', layout: undefined } });
  const fresh = text((await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: 'inv-after-change' })).path);
  expect(fresh).toContain('Umbenannt AG');
  expect(fresh).toContain('Neuer Schlusstext der geänderten Vorlage.');

  // Dunning letter for the open invoice at level 2.
  const letter = await invokeDesktopIpc(page, 'pdf:export', { kind: 'dunning', id: 'inv-open-1', level: 2 });
  expect(path.basename(letter.path)).toMatch(/^1\. Mahnung-RE-2026-002-/);
  const letterText = text(letter.path);
  expect(letterText).toContain('1. Mahnung');
  expect(letterText).toContain('Dies ist die erste Mahnung zur Rechnung RE-2026-002.');
  expect(letterText).toContain('Mahngebühr');
  expect(letterText).toContain('Offener Betrag');
  expect(await readEmbeddedFacturX(fs.readFileSync(letter.path))).toBeNull();
  fs.copyFileSync(letter.path, path.join(artifactDir, 'dunning-level-2.pdf'));
});
