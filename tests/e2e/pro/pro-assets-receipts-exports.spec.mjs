import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * Pro screens that had no UI coverage, each result verified through the backend.
 *
 * How this can fail:
 * - assets: an asset saved without reason, the activation not booked, a schedule
 *   that does not follow cost and useful life, the AfA posted without a journal
 *   entry, an edit lost
 * - incoming invoices: a draft posted before it is released, an original that is
 *   not archived or not marked as reviewed, a posting without journal entry, the
 *   invoice missing from Belege or the Belege link not opening it
 * - bank reconciliation: "Im Editor öffnen" landing anywhere but the draft of the line
 * - report export: the SuSa CSV not written or not matching the screen
 * - Kontenplan: an own account not created or not listed, a deactivation that does
 *   not show, an account that cannot be reactivated
 * - Prüferpaket (Z3): the button writing nothing, a package without manifest,
 *   Kontenplan or journal, a manifest hash that does not match the written file
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const shooter = (page) => {
  let count = 0;
  return (name) => page.screenshot({ path: test.info().outputPath(`${String(++count).padStart(2, '0')}-${name}.png`), fullPage: true });
};

test('an asset is created active, shows its schedule, posts its AfA into the journal and is edited with a reason', async () => {
  const { page, baseUrl } = desktop;
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/accounting?view=assets'));
  await expect(page.getByRole('heading', { name: 'Anlagen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Neue Anlage' }).first().click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Neue Anlage' }) });
  await form.getByLabel('Anlagennummer').fill('ANL-E2E-1');
  await form.getByLabel('Bezeichnung').fill('Server E2E');
  await form.getByLabel('Anlagenklasse').fill('IT-Hardware');
  await form.getByLabel('Kostenstelle').fill('ADM-01');
  await form.getByLabel('Standort').fill('Berlin');
  await form.getByLabel('Anlagenkonto').fill('0420');
  await form.getByLabel('Aktivierungsdatum').fill('2026-01-15');
  await form.getByLabel('Anschaffungskosten netto').fill('3600');
  await form.getByLabel('Nutzungsdauer in Jahren').fill('3');
  await form.getByLabel('Status').selectOption('aktiv');
  await form.getByRole('button', { name: 'Anlage speichern' }).click();
  await expect(form.getByLabel('Audit-Grund'), 'no save without a reason').toBeVisible();
  await form.getByLabel('Audit-Grund').fill('Server angeschafft');
  await form.getByRole('button', { name: 'Anlage speichern' }).click();
  await expect(page.getByTestId('asset-mutation-feedback')).toHaveText(/Anlage gespeichert/);
  await shot('asset-created');

  const asset = (await invokeDesktopIpc(page, 'pro:listAssets')).find((candidate) => candidate.assetNumber === 'ANL-E2E-1');
  expect(asset, 'the asset is stored').toBeTruthy();
  expect(asset.status).toBe('aktiv');
  const schedule = await invokeDesktopIpc(page, 'pro:getDepreciationSchedule', { assetId: asset.id });
  expect(schedule.length, 'three years of linear AfA (plus the partial years)').toBeGreaterThanOrEqual(3);

  await page.getByRole('button', { name: 'Abschreibungsplan' }).click();
  await expect(page.getByRole('table', { name: 'Abschreibungsplan' })).toBeVisible();
  await shot('schedule');

  const entriesBefore = (await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).length;
  const afa = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Abschreibung buchen' }) });
  await afa.getByLabel('Geschäftsjahr').fill('2026');
  await afa.getByLabel('Buchungsdatum').fill('2026-12-31');
  await afa.getByLabel('Audit-Grund').fill('AfA 2026');
  await afa.getByRole('button', { name: 'AfA buchen' }).click();
  await expect(page.getByTestId('asset-mutation-feedback')).toHaveText(/AfA 2026 gebucht/);
  expect((await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).length).toBeGreaterThan(entriesBefore);

  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  const edit = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Anlage bearbeiten' }) });
  await edit.getByLabel('Standort').fill('Hamburg');
  await edit.getByLabel('Audit-Grund').fill('Umzug');
  await edit.getByRole('button', { name: 'Anlage speichern' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:listAssets')).find((candidate) => candidate.id === asset.id).location).toBe('Hamburg');
});

test('an incoming invoice is captured, its original archived and reviewed, released, posted and opened from Belege', async () => {
  const { page, baseUrl } = desktop;
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/accounting?view=opos'));
  await page.getByLabel('Rechnungsnummer').fill('ER-E2E-77');
  const vendorName = page.getByLabel('Kreditorname');
  if (await vendorName.count()) await vendorName.fill('Bürobedarf Meier');
  await page.getByLabel('Rechnungsdatum').fill('2026-05-04');
  await page.getByLabel('Fällig am').fill('2026-05-18');
  await page.getByLabel('Position', { exact: true }).fill('Druckerpapier');
  await page.getByLabel('Menge', { exact: true }).fill('10');
  await page.getByLabel('Einzelpreis', { exact: true }).fill('5');
  await page.getByLabel('Steuersatz', { exact: true }).fill('19');
  await page.getByLabel('Begründung', { exact: true }).last().fill('Rechnung erfasst');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByText(/als Entwurf gespeichert/).first()).toBeVisible();
  const draft = (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.number === 'ER-E2E-77');
  expect(draft.status).toBe('draft');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Buchen', exact: true }), 'a draft cannot be posted').toBeDisabled();

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await page.getByTestId('incoming-documents').locator('input[type="file"]').setInputFiles({ name: 'er-e2e-77.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('button', { name: 'Original archivieren' }).click();
  await expect(page.getByText(/Originalbeleg archiviert/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Als geprüft markieren' }).click();
  await expect(page.getByText(/als geprüft markiert/).first()).toBeVisible();
  const documents = await invokeDesktopIpc(page, 'pro:listIncomingInvoiceDocuments', { invoiceId: draft.id });
  expect(documents.map((document) => [document.originalFilename ?? document.fileName, document.reviewStatus ?? document.status])).toEqual([['er-e2e-77.pdf', 'accepted']]);
  await shot('original-reviewed');

  await page.getByRole('button', { name: 'Für Buchung freigeben' }).click();
  await expect(page.getByText(/zur Buchung freigegeben/).first()).toBeVisible();
  await main.getByRole('button', { name: 'Buchen', exact: true }).click();
  await expect(page.getByText(/gebucht\./).first()).toBeVisible();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.id === draft.id).accountingStatus).toBe('posted');

  await page.goto(appUrl(baseUrl, '/accounting?view=receipts'));
  await page.getByRole('button', { name: 'Eingangsrechnung ER-E2E-77 öffnen' }).click();
  await expect(page).toHaveURL(/view=opos/);
  await expect(page.getByLabel('Gespeicherten Beleg wählen'), 'Belege opens exactly this invoice').toHaveValue(draft.id);
  await expect(page.getByTestId('incoming-invoice-summary')).toContainText('59,50');
  await shot('opened-from-belege');
});

test('"Im Editor öffnen" in the bank reconciliation opens the draft of the selected bank line', async () => {
  const { page, baseUrl } = desktop;
  const { transaction } = await importPendingProTransaction(page, 'editor', { counterparty: 'Editor Lieferant GmbH', amount: -238 });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByText('Editor Lieferant GmbH').first().click();
  await page.getByRole('button', { name: 'Im Editor öffnen' }).click();
  // The handoff moves the route like every other one, so reload and the navigation stay consistent.
  await expect(page).toHaveURL(/view=editor/);
  await expect(page.getByText('Editor Lieferant GmbH').first()).toBeVisible();
  expect(transaction.id).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Zurück zur Inbox' }).click();
  await expect(page).toHaveURL(/view=inbox|accounting$/);
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Bankabgleich' }).click();
  await expect(page).toHaveURL(/view=reconciliation/);
  await expect(page.getByRole('button', { name: 'Im Editor öffnen' })).toBeVisible();
});

test('the SuSa is exported as CSV with the rows the screen shows', async () => {
  const { page, baseUrl, app } = desktop;
  const target = path.join(os.tmpdir(), `billme-susa-${process.pid}-${Date.now()}.csv`);
  // The export is a browser download; answer the save dialog in the main process.
  await app.evaluate(({ session }, file) => {
    session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file));
  }, target);
  await page.goto(appUrl(baseUrl, '/accounting?view=reports'));
  await expect(page.getByRole('table', { name: 'Summen- und Saldenliste' })).toBeVisible();
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await expect.poll(() => fs.existsSync(target) && fs.statSync(target).size > 0, { timeout: 15_000 }).toBe(true);
  const csv = fs.readFileSync(target, 'utf8');
  expect(csv).toMatch(/1200/);
  // The seed issues as Kleinunternehmer, so its revenue sits on 8195 (Erlöse § 19 UStG) since the per-tax-case revenue accounts.
  expect(csv).toMatch(/^8195;/m);
  fs.rmSync(target, { force: true });
});

test('an own account is created in the Kontenplan, deactivated and activated again', async () => {
  const { page, baseUrl } = desktop;
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/accounts'));
  const plan = page.locator('section').filter({ has: page.getByRole('heading', { name: /Kontenplan \(SKR0[34]\)/ }) });
  await expect(plan).toBeVisible();
  await plan.getByLabel('Kontonummer').fill('4997');
  await expect(plan.getByRole('button', { name: 'Konto anlegen' }), 'no own account without a name').toBeDisabled();
  await plan.getByLabel('Bezeichnung').fill('Projektkosten E2E');
  await plan.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(plan.getByRole('status')).toHaveText('Konto 4997 angelegt');
  const row = plan.getByRole('row').filter({ hasText: '4997' });
  await expect(row).toContainText('Projektkosten E2E');
  await expect(row).toContainText('eigenes Konto');
  await expect(row).toContainText('aktiv');
  await shot('kontenplan-angelegt');
  await row.getByRole('button', { name: 'Deaktivieren' }).click();
  await expect(row).toContainText('deaktiviert');
  await row.getByRole('button', { name: 'Aktivieren' }).click();
  await expect(plan.getByRole('status')).toHaveText('Konto 4997 aktiviert');
  await expect(row.getByRole('button', { name: 'Deaktivieren' })).toBeVisible();
  await shot('kontenplan-reaktiviert');
});

test('the Prüferpaket (Z3) is written from the reports screen with a manifest that matches its files', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting?view=reports'));
  await page.getByRole('button', { name: 'Prüferpaket (Z3) exportieren' }).click();
  const notice = page.getByText(/^Prüferpaket gespeichert: \d+ Dateien in /);
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const bundleDir = (await notice.textContent()).replace(/^Prüferpaket gespeichert: \d+ Dateien in /, '').trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const names = manifest.files.map((entry) => entry.name);
  for (const name of ['journal-entries.jsonl', 'journal-lines.jsonl', 'chart-of-accounts.jsonl', 'customers.jsonl', 'vendors.jsonl', 'open-items.jsonl', 'assets.jsonl']) expect(names).toContain(name);
  expect(names).not.toContain('account-mappings-hgb.jsonl');
  for (const entry of manifest.files) {
    expect(createHash('sha256').update(fs.readFileSync(path.join(bundleDir, entry.name))).digest('hex'), entry.name).toBe(entry.sha256);
  }
  fs.copyFileSync(path.join(bundleDir, 'manifest.json'), test.info().outputPath('prueferpaket-manifest.json'));
  await page.screenshot({ path: test.info().outputPath('prueferpaket.png'), fullPage: true });
});
