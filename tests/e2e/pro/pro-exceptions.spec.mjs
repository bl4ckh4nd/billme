import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

let desktop;
let source;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  source = await importPendingProTransaction(desktop.page, 'exception');
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('an exception is assigned and resolved with feedback, "Beleg anfordern" answers, and the changes are stored (B22)', async () => {
  const { page, baseUrl } = desktop;
  const exceptionOf = async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).exceptionCase;

  await page.goto(appUrl(baseUrl, '/'));
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Ausnahmen' }).click();
  await expect(page.getByRole('heading', { name: 'Ausnahmen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Ohne Beleg', exact: true }).click();
  await page.getByRole('button', { name: /E2E exception/ }).click();
  await expect(page.getByText('Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Beleg anfordern' }).click();
  await expect(page.getByTestId('exception-notice')).toHaveText(/Beleg angefordert/);
  await page.screenshot({ path: test.info().outputPath('01-receipt-requested.png') });

  await page.getByLabel('Verantwortliche Person').fill('Mara Buchhaltung');
  await page.getByRole('button', { name: 'Zuweisen' }).click();
  await expect(page.getByTestId('exception-notice')).toHaveText('Zugewiesen an Mara Buchhaltung.');
  await expect.poll(async () => (await exceptionOf())?.owner).toBe('Mara Buchhaltung');

  await page.getByLabel('Lösungsnotiz').fill('Rechnung per Mail erhalten');
  await page.getByRole('button', { name: 'Als gelöst markieren' }).click();
  await expect.poll(async () => (await exceptionOf())?.state).toBe('resolved');
  expect((await exceptionOf()).resolutionNote).toBe('Rechnung per Mail erhalten');
  await expect(page.getByText(/Invalid workflow transition|Error:/)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('02-exception-resolved.png') });
});
