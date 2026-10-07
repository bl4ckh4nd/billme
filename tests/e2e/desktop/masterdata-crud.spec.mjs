import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

/**
 * Master data through the Lite UI, each change verified through the backend.
 *
 * How this can fail:
 * - clients: a second e-mail or address lost on save, an edit creating a duplicate,
 *   a delete that cannot be undone or that is never committed, search showing others
 * - articles: VAT rate or price lost, the gross toggle showing the net price,
 *   delete/undo as above
 * - projects: an edit without reason saved, an edit lost, archived projects listed
 *   without "Archivierte anzeigen"
 * - recurring: pausing not persisted, an edit lost, delete/undo as above
 */

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

const clients = (page) => invokeDesktopIpc(page, 'clients:list', {});
const articles = (page) => invokeDesktopIpc(page, 'articles:list', {});
const profiles = (page) => invokeDesktopIpc(page, 'recurring:list', {});
/** The deferred delete commits after 8 s unless undone. */
const COMMIT_WAIT = { timeout: 15_000 };

test('a client with two e-mails and two addresses is created, edited in place, searched, and deleted with undo', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: 'Neuer Kunde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuer Kunde' });
  await dialog.getByRole('textbox', { name: 'Firma', exact: true }).fill('Zweiadress GmbH');
  await dialog.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true }).first().fill('rechnung@zweiadress.example');
  await dialog.getByRole('button', { name: /E-Mail/ }).filter({ hasText: '+' }).click();
  await dialog.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true }).last().fill('einkauf@zweiadress.example');
  await dialog.getByRole('textbox', { name: 'Straße', exact: true }).first().fill('Rechnungsweg 1');
  await dialog.getByRole('textbox', { name: 'PLZ', exact: true }).first().fill('10115');
  await dialog.getByRole('textbox', { name: 'Stadt', exact: true }).first().fill('Berlin');
  await dialog.getByRole('button', { name: /Adresse/ }).filter({ hasText: '+' }).click();
  await dialog.getByRole('textbox', { name: 'Straße', exact: true }).last().fill('Lieferhof 9');
  await dialog.getByRole('textbox', { name: 'PLZ', exact: true }).last().fill('20095');
  await dialog.getByRole('textbox', { name: 'Stadt', exact: true }).last().fill('Hamburg');
  await shot('client-two-addresses');
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(async () => {
    const created = (await clients(page)).find((client) => client.company === 'Zweiadress GmbH');
    return created ? [created.emails?.length, created.addresses?.length] : null;
  }).toEqual([2, 2]);
  const created = (await clients(page)).find((client) => client.company === 'Zweiadress GmbH');
  expect(created.addresses.map((address) => address.city).sort()).toEqual(['Berlin', 'Hamburg']);

  // Edit in place: same id, new company name, still two addresses.
  await expect(page.getByRole('heading', { name: 'Zweiadress GmbH', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Kunde bearbeiten' }).click();
  const edit = page.getByRole('dialog', { name: 'Kunde bearbeiten' });
  await edit.getByRole('textbox', { name: 'Firma', exact: true }).fill('Zweiadress Handel GmbH');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await clients(page)).filter((client) => client.id === created.id).map((client) => [client.company, client.addresses.length]))
    .toEqual([['Zweiadress Handel GmbH', 2]]);
  expect((await clients(page)).filter((client) => client.company.startsWith('Zweiadress')).length, 'no duplicate').toBe(1);

  // Search narrows the list.
  await page.getByRole('button', { name: 'Zurück zur Kundenübersicht' }).click();
  await page.getByLabel('Kunden durchsuchen').fill('Zweiadress');
  await expect(page.getByText('Zweiadress Handel GmbH').first()).toBeVisible();
  await expect(page.getByText('Musterfirma GmbH')).toHaveCount(0);
  await shot('client-search');

  // Delete, undo: still there. Delete again and let it commit: gone.
  await page.getByText('Zweiadress Handel GmbH').first().click();
  await page.getByRole('button', { name: 'Kunde löschen' }).click();
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await page.waitForTimeout(9_000);
  expect((await clients(page)).some((client) => client.id === created.id), 'undo keeps the client').toBe(true);
  await page.getByText('Zweiadress Handel GmbH').first().click();
  await page.getByRole('button', { name: 'Kunde löschen' }).click();
  await expect.poll(async () => (await clients(page)).some((client) => client.id === created.id), COMMIT_WAIT).toBe(false);
  await shot('client-deleted');
});

test('an article keeps its VAT rate and price, shows the gross price on demand, and is deleted with undo', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/articles'));
  await page.getByRole('button', { name: 'Neuer Artikel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuer Artikel' });
  await dialog.getByLabel('Bezeichnung', { exact: true }).fill('Fachbuch Steuerrecht');
  await dialog.getByLabel('Preis (Netto)', { exact: true }).fill('50');
  await dialog.getByRole('button', { name: '7%', exact: true }).click();
  await shot('article-form');
  await dialog.getByRole('button', { name: 'Erstellen' }).click();
  await expect.poll(async () => (await articles(page)).find((article) => article.title === 'Fachbuch Steuerrecht')?.taxRate ?? null).toBe(7);
  const article = (await articles(page)).find((candidate) => candidate.title === 'Fachbuch Steuerrecht');
  expect(article.price).toBe(50);

  await page.getByRole('button', { name: 'Fachbuch Steuerrecht bearbeiten' }).first().click();
  const edit = page.getByRole('dialog', { name: 'Artikel bearbeiten' });
  await edit.getByLabel('Preis (Netto)', { exact: true }).fill('60');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await articles(page)).filter((candidate) => candidate.id === article.id).map((candidate) => candidate.price)).toEqual([60]);

  await page.getByLabel('Artikel durchsuchen').fill('Steuerrecht');
  await expect(page.getByText('Senior Entwicklung')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Brutto' }).click();
  await expect(page.getByText(/64,20\s*€/).first(), '60 € net + 7 % = 64,20 € gross').toBeVisible();
  await shot('article-gross');

  await page.getByRole('button', { name: 'Fachbuch Steuerrecht löschen' }).first().click();
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await page.waitForTimeout(9_000);
  expect((await articles(page)).some((candidate) => candidate.id === article.id), 'undo keeps the article').toBe(true);
  await page.getByRole('button', { name: 'Fachbuch Steuerrecht löschen' }).first().click();
  await expect.poll(async () => (await articles(page)).some((candidate) => candidate.id === article.id), COMMIT_WAIT).toBe(false);
});

test('a project is edited with a reason, and an archived one only shows with "Archivierte anzeigen"', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const project = { id: `proj-${Date.now()}`, clientId: 'c1', code: 'P-EDIT', name: 'Relaunch Website', status: 'active', budget: 5000, startDate: '2026-01-01', description: '' };
  await invokeDesktopIpc(page, 'projects:upsert', { project, reason: 'E2E Seed' });
  await page.goto(appUrl(baseUrl, '/projects'));
  await page.getByRole('button', { name: /Aktionen für.*Relaunch Website/ }).click();
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  const dialog = page.getByRole('dialog', { name: 'Projekt bearbeiten' });
  await dialog.getByLabel('Projektname (Pflicht)').fill('Relaunch Website 2026');
  await dialog.getByLabel('Budget').fill('7500');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByLabel('Grund (Pflicht)'), 'no save without a reason').toBeVisible();
  await dialog.getByLabel('Grund (Pflicht)').fill('Budget erhöht');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => {
    const stored = (await invokeDesktopIpc(page, 'projects:list', { includeArchived: true })).find((candidate) => candidate.id === project.id);
    return stored ? [stored.name, stored.budget] : null;
  }).toEqual(['Relaunch Website 2026', 7500]);

  await page.getByRole('button', { name: /Aktionen für.*Relaunch Website 2026/ }).click();
  await page.getByRole('menuitem', { name: 'Archivieren' }).click();
  const archive = page.getByRole('dialog', { name: 'Projekt archivieren' });
  await archive.getByLabel('Grund (Pflicht)').fill('Projekt abgeschlossen');
  await archive.getByRole('button', { name: 'Archivieren' }).click();
  await expect(page.getByText('Relaunch Website 2026')).toHaveCount(0);
  await page.getByLabel('Archivierte anzeigen').check();
  await expect(page.getByText('Relaunch Website 2026').first()).toBeVisible();
  await page.getByLabel('Projekte durchsuchen').fill('gibt es nicht');
  await expect(page.getByText('Relaunch Website 2026')).toHaveCount(0);
  await shot('projects-archived-filter');
});

test('a recurring profile is edited, paused and resumed, and deleted with undo', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/recurring'));
  await page.getByRole('button', { name: 'Abo Wartungsvertrag Basis bearbeiten' }).click();
  const dialog = page.getByRole('dialog', { name: 'Abo bearbeiten' });
  await dialog.getByLabel('Interne Bezeichnung').fill('Wartungsvertrag Premium');
  await dialog.getByLabel('Intervall').selectOption('quarterly');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await profiles(page)).filter((profile) => profile.id === 'rec-seed-1').map((profile) => [profile.name, profile.interval]))
    .toEqual([['Wartungsvertrag Premium', 'quarterly']]);

  const toggle = page.getByRole('button', { name: 'Aktiv', exact: true });
  await toggle.click();
  await expect.poll(async () => (await profiles(page)).find((profile) => profile.id === 'rec-seed-1').active).toBe(false);
  await expect(page.getByRole('button', { name: 'Pausiert', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await page.getByRole('button', { name: 'Pausiert', exact: true }).click();
  await expect.poll(async () => (await profiles(page)).find((profile) => profile.id === 'rec-seed-1').active).toBe(true);
  await shot('recurring-active-again');

  await page.getByRole('button', { name: 'Abo Wartungsvertrag Premium löschen' }).click();
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await page.waitForTimeout(9_000);
  expect((await profiles(page)).some((profile) => profile.id === 'rec-seed-1'), 'undo keeps the profile').toBe(true);
  await page.getByRole('button', { name: 'Abo Wartungsvertrag Premium löschen' }).click();
  await expect.poll(async () => (await profiles(page)).some((profile) => profile.id === 'rec-seed-1'), COMMIT_WAIT).toBe(false);
});
