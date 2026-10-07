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

test('a document picks its own template and intro text, and prints with them', async () => {
  const { page, baseUrl } = desktop;
  const artifactDir = process.env.PRINT_ARTIFACT_DIR ?? test.info().outputPath('editor');
  fs.mkdirSync(artifactDir, { recursive: true });

  const [defaultBody] = [(await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: 'inv-open-1' })).template.body];
  const red = await invokeDesktopIpc(page, 'documentTemplates:upsert', {
    template: { kind: 'invoice', name: 'Rot Klassisch', body: { ...defaultBody, presetId: 'klassisch', font: 'serif', accentColor: '#b3261e' } },
  });

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: 'Neue Rechnung' }).first().click();
  await expect(page.getByRole('combobox', { name: 'Kunde auswählen' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Kunde auswählen' }).fill('Musterfirma');
  await page.getByRole('option').filter({ hasText: 'Musterfirma GmbH' }).click();
  await page.getByRole('button', { name: 'Position hinzufügen' }).click();
  const description = page.getByRole('combobox', { name: 'Beschreibung Position 1', exact: true }).or(page.getByRole('textbox', { name: 'Beschreibung 1', exact: true }));
  await description.fill('Beratung Vorlagen-Umstellung');
  await page.getByRole('textbox', { name: 'Einzelpreis 1' }).or(page.getByRole('spinbutton', { name: 'Einzelpreis 1' })).fill('480');

  await page.getByRole('combobox', { name: 'Vorlage' }).selectOption({ label: 'Rot Klassisch' });
  const intro = page.getByRole('textbox', { name: 'Einleitung' });
  await intro.click();
  await intro.fill('Hallo {{client.company}},\n\nwie vereinbart berechnen wir:');
  await intro.blur();
  await expect(intro).toHaveValue('Hallo Musterfirma GmbH,\n\nwie vereinbart berechnen wir:');
  await page.screenshot({ path: path.join(artifactDir, '01-editor.png') });

  await page.getByRole('button', { name: 'Vorschau' }).click();
  const preview = page.getByTestId('document-preview');
  await expect(preview.locator('.bf-page').first()).toBeVisible();
  await expect(preview.locator('.bf-page').getByText('Hallo Musterfirma GmbH,')).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, '02-preview.png') });
  await page.getByRole('button', { name: 'Bearbeiten' }).click();

  await page.locator('button').filter({ hasText: 'Speichern' }).click();
  await expect(page).toHaveURL(/#\/documents(?:\?|$)/);
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  const saved = invoices.find((candidate) => candidate.items.some((item) => item.description === 'Beratung Vorlagen-Umstellung'));
  expect(saved.layout).toEqual({ templateId: red.id, texts: { intro: 'Hallo {{client.company}},\n\nwie vereinbart berechnen wir:' } });

  const context = await invokeDesktopIpc(page, 'documents:renderContext', { kind: 'invoice', id: saved.id });
  expect(context.template.id).toBe(red.id);
  const exported = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: saved.id });
  const text = execFileSync('pdftotext', ['-layout', exported.path, '-'], { encoding: 'utf8' });
  expect(text).toContain('Hallo Musterfirma GmbH,');
  expect(text).toContain('wie vereinbart berechnen wir:');
  expect(text).toContain('ENTWURF');
  fs.copyFileSync(exported.path, path.join(artifactDir, 'invoice-own-template.pdf'));
});
