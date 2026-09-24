import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('creates and archives a project with an audit reason', async () => {
  const { page, baseUrl } = desktop;
  const projectName = `Browser Test Projekt ${Date.now()}`;
  await page.goto(appUrl(baseUrl, '/projects'));

  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible();
  await page.getByRole('button', { name: 'Neues Projekt' }).click();

  await expect(page.getByRole('heading', { name: 'Neues Projekt' })).toBeVisible();
  await page.locator('label:has-text("Kunde (Pflicht)")').locator('xpath=following-sibling::select[1]').selectOption('c2');
  await page.locator('label:has-text("Projektname (Pflicht)")').locator('xpath=following-sibling::input[1]').fill(projectName);
  await page.locator('label:has-text("Grund (Pflicht)")').locator('xpath=following-sibling::textarea[1]').fill('Testprojekt fuer E2E-Suite');
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(page.getByText(projectName)).toBeVisible();

  const projects = await invokeDesktopIpc(page, 'projects:list', { includeArchived: false });
  const created = projects.find((project) => project.name === projectName);
  expect(created).toBeTruthy();
  const archivedBefore = (await invokeDesktopIpc(page, 'projects:list', { includeArchived: true })).filter(
    (project) => Boolean(project.archivedAt),
  ).length;

  const createdRow = page.getByRole('row').filter({ hasText: projectName }).first();
  await createdRow.getByRole('button', { name: `Aktionen für ${projectName}` }).click();
  await page.getByRole('menuitem', { name: 'Archivieren' }).click();

  await expect(page.getByRole('heading', { name: 'Projekt archivieren' })).toBeVisible();
  await page.locator('label:has-text("Grund (Pflicht)")').locator('xpath=following-sibling::textarea[1]').fill('Projekt abgeschlossen');
  await page.getByRole('button', { name: 'Archivieren' }).last().click();

  const archivedAfter = (await invokeDesktopIpc(page, 'projects:list', { includeArchived: true })).filter(
    (project) => Boolean(project.archivedAt),
  ).length;
  expect(archivedAfter).toBeGreaterThan(archivedBefore);
});
