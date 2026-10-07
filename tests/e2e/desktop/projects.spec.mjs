import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

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

test('creates and archives a project with an audit reason', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const projectName = `Browser Test Projekt ${Date.now()}`;
  await page.goto(appUrl(baseUrl, '/projects'));

  await expect(page.getByRole('banner').getByRole('heading', { name: 'Projekte', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Neues Projekt' }).click();

  const dialog = page.getByRole('dialog', { name: 'Neues Projekt' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Kunde (Pflicht)' }).selectOption('c2');
  await dialog.getByRole('textbox', { name: 'Projektname (Pflicht)' }).fill(projectName);
  await dialog.getByRole('textbox', { name: 'Grund (Pflicht)' }).fill('Testprojekt fuer E2E-Suite');
  await shot('project-dialog');
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  await expect(page.getByText(projectName)).toBeVisible();
  await shot('project-created');

  const projects = await invokeDesktopIpc(page, 'projects:list', { includeArchived: false });
  const created = projects.find((project) => project.name === projectName);
  expect(created).toBeTruthy();
  expect(created.clientId).toBe('c2');
  expect(created.archivedAt).toBeFalsy();

  const createdRow = page.getByRole('row').filter({ hasText: projectName }).first();
  await createdRow.getByRole('button', { name: `Aktionen für ${projectName}` }).click();
  await page.getByRole('menuitem', { name: 'Archivieren' }).click();

  const archiveDialog = page.getByRole('dialog', { name: 'Projekt archivieren' });
  await expect(archiveDialog).toBeVisible();
  await archiveDialog.getByRole('textbox', { name: 'Grund (Pflicht)' }).fill('Projekt abgeschlossen');
  await shot('project-archive-dialog');
  await archiveDialog.getByRole('button', { name: 'Archivieren' }).click();

  await expect.poll(async () => {
    const all = await invokeDesktopIpc(page, 'projects:list', { includeArchived: true });
    return Boolean(all.find((project) => project.id === created.id)?.archivedAt);
  }).toBe(true);
  await shot('project-archived');

  // Archived projects must drop out of the default list (also what the invoice editor offers per client).
  const stillListed = await invokeDesktopIpc(page, 'projects:list', { includeArchived: false });
  expect(stillListed.some((project) => project.id === created.id)).toBe(false);
  await expect(page.getByRole('row').filter({ hasText: projectName })).toHaveCount(0);
});
