import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });

test('designs an invoice template, makes it the default, prints with it and carries the design to every kind', async () => {
  const { page, baseUrl } = desktop;
  const artifactDir = process.env.PRINT_ARTIFACT_DIR ?? test.info().outputPath('templates');
  fs.mkdirSync(artifactDir, { recursive: true });

  await page.goto(appUrl(baseUrl, '/templates'));
  await expect(page.getByRole('heading', { name: 'Vorlagen', level: 1 })).toBeVisible();
  const invoiceCards = page.getByRole('region', { name: 'Vorlagen für Rechnung' });
  await expect(invoiceCards.getByText('Mitgeliefert')).toBeVisible();
  await expect(invoiceCards.getByText('Standard', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, '01-list.png') });

  await page.getByRole('button', { name: 'Neue Vorlage' }).click();
  await expect(page.getByRole('textbox', { name: 'Name der Vorlage' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name der Vorlage' }).fill('Holzwerk Rot');
  await page.getByRole('radio', { name: /Klassisch/ }).click();
  await page.getByLabel('Akzentfarbe').fill('#b3261e');
  const intro = page.getByRole('textbox', { name: 'Einleitung' });
  await intro.fill('Guten Tag,\n\nwie besprochen berechnen wir: ');
  await intro.press('End');
  await page.getByLabel('Platzhalter einfügen').selectOption('client.company');
  await expect(intro).toHaveValue('Guten Tag,\n\nwie besprochen berechnen wir: {{client.company}}');
  await page.getByRole('switch', { name: 'Standard für Rechnung' }).click();
  await expect(page.getByTestId('template-preview').locator('.bf-page').first()).toBeVisible();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText(/„Holzwerk Rot“ gespeichert \(Version 1\)/)).toBeVisible();
  await expect(page).toHaveURL(/\/templates\/(?!new)[^/?]+/);
  await expect(page.getByRole('switch', { name: 'Standard für Rechnung' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Ungespeichert')).toHaveCount(0);
  await page.screenshot({ path: path.join(artifactDir, '02-editor.png') });

  const templates = await invokeDesktopIpc(page, 'documentTemplates:list', {});
  const saved = templates.find((entry) => entry.name === 'Holzwerk Rot');
  expect(saved.body).toMatchObject({ presetId: 'klassisch', accentColor: '#b3261e', font: 'serif' });
  expect(await invokeDesktopIpc(page, 'documentTemplates:getDefaults')).toEqual({ invoice: saved.id });

  // Issued documents keep the layout they were issued with; drafts follow the default.
  const issued = await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-open-1' });
  expect(issued.template.id).toMatch(/^preset-/);
  const openInvoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.id === 'inv-open-1');
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E Vorlage', invoice: { ...openInvoice, id: 'inv-draft-template', number: 'RE-2026-950', status: 'draft', payments: [], layout: undefined } });
  const context = await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-draft-template' });
  expect(context.template.id).toBe(saved.id);
  const exported = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: 'inv-draft-template' });
  const text = pdfText(exported.path);
  expect(text).toContain('wie besprochen berechnen wir: StartUp Berlin AG');
  fs.copyFileSync(exported.path, path.join(artifactDir, 'invoice-with-template.pdf'));

  await page.getByRole('button', { name: 'Auf alle Arten übertragen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Übertragen' }).click();
  await expect(page.getByText('Design auf alle Belegarten übertragen.')).toBeVisible();
  const defaults = await invokeDesktopIpc(page, 'documentTemplates:getDefaults');
  expect(Object.keys(defaults).sort()).toEqual(['credit_note', 'delivery_note', 'dunning', 'invoice', 'offer', 'order_confirmation']);
  const all = await invokeDesktopIpc(page, 'documentTemplates:list', {});
  for (const template of all) expect(template.body).toMatchObject({ presetId: 'klassisch', accentColor: '#b3261e' });

  const offerPdf = await invokeDesktopIpc(page, 'pdf:export', { kind: 'offer', id: 'offer-open-1' });
  expect(pdfText(offerPdf.path)).toContain('Angebot');
  fs.copyFileSync(offerPdf.path, path.join(artifactDir, 'offer-after-transfer.pdf'));

  await page.getByRole('button', { name: 'Vorlagen', exact: true }).first().click();
  await expect(page).toHaveURL(/\/templates$/);
  await page.getByRole('radio', { name: 'Angebot' }).click();
  await expect(page.getByRole('region', { name: 'Vorlagen für Angebot' }).getByText('Standard', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, '03-offers-after-transfer.png') });

  // Deleting the invoice default falls back to the shipped template.
  await page.getByRole('radio', { name: 'Rechnung' }).click();
  await page.getByRole('button', { name: 'Aktionen für Holzwerk Rot' }).click();
  await page.getByRole('menuitem', { name: 'Löschen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Vorlage löschen' }).click();
  await expect(page.getByText('„Holzwerk Rot“ gelöscht.')).toBeVisible();
  expect((await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-draft-template' })).template.id).toBeUndefined();
});
