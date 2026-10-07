import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('creates, updates, toggles and deletes pro account suggestion rules', async () => {
  const { page, baseUrl } = desktop;
  const value = `e2e-telekom-${Date.now()}`;
  const updatedValue = `${value}-updated`;
  const rules = () => invokeDesktopIpc(page, 'pro:listAccountSuggestionRules', { chart: 'SKR03' });

  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  await expect(page.getByRole('heading', { name: 'Buchen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Regeln' }).click();
  const modal = page.getByRole('dialog', { name: 'Kontierungsvorschlag-Regeln' });
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Keine Regeln vorhanden')).toBeVisible();

  await modal.getByRole('button', { name: 'Neue Regel' }).click();
  await modal.getByLabel('Wert').fill(value);
  const targetAccount = modal.getByLabel('Zielkonto');
  const firstSelectableValue = await targetAccount.locator('option').nth(1).getAttribute('value');
  expect(firstSelectableValue).toBeTruthy();
  await targetAccount.selectOption(firstSelectableValue);
  await modal.getByRole('button', { name: 'Regel erstellen' }).click();

  await expect(modal.getByText(`"${value}"`)).toBeVisible();
  let createdRuleId = null;
  await expect.poll(async () => {
    createdRuleId = (await rules()).find((rule) => rule.value === value)?.id ?? null;
    return createdRuleId;
  }).not.toBeNull();
  expect((await rules()).find((rule) => rule.id === createdRuleId)).toMatchObject({ targetAccountNumber: firstSelectableValue, active: true });
  await page.screenshot({ path: test.info().outputPath('01-rule-created.png') });

  await modal.getByRole('button', { name: 'Aktiv', exact: true }).click();
  await expect(modal.getByRole('button', { name: 'Inaktiv', exact: true })).toBeVisible();
  await expect.poll(async () => (await rules()).find((rule) => rule.id === createdRuleId)?.active ?? true).toBe(false);

  await modal.getByRole('button', { name: 'Bearbeiten' }).click();
  await modal.getByLabel('Wert').fill(updatedValue);
  await modal.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(modal.getByText(`"${updatedValue}"`)).toBeVisible();
  await expect.poll(async () => (await rules()).find((rule) => rule.id === createdRuleId)?.value ?? null).toBe(updatedValue);
  await page.screenshot({ path: test.info().outputPath('02-rule-updated.png') });

  await modal.getByRole('button', { name: 'Regel löschen' }).click();
  await expect(modal.getByText('Keine Regeln vorhanden')).toBeVisible();
  await expect.poll(async () => (await rules()).some((rule) => rule.id === createdRuleId)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('03-rule-deleted.png') });
});
