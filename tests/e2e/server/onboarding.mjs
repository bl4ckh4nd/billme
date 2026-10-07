import { expect } from '@playwright/test';

/** Types the server's setup code when the bootstrap form asks for it (BILLME_SETUP_TOKEN). */
export const fillSetupCodeIfAsked = async (page, state) => {
  const field = page.getByLabel('Einrichtungscode');
  if (!(await field.isVisible().catch(() => false))) return;
  const token = state.env?.BILLME_SETUP_TOKEN;
  if (!token) throw new Error('The stack asks for a setup code but the harness state has no BILLME_SETUP_TOKEN');
  await field.fill(token);
};

/**
 * Completes the business onboarding wizard a fresh tenant opens with. Waits for
 * either the wizard or the product's ready heading first: authentication only
 * starts loading settings, so deciding too early lets the wizard cover the page later.
 */
export const completeBusinessOnboardingIfVisible = async (page, {
  scenarioKey,
  readyHeading,
  company = 'Billme',
  taxNumber = { label: 'Steuernummer', value: '12/345/67890' },
}) => {
  const heading = page.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' });
  const ready = page.getByRole('heading', { name: readyHeading, level: 1 });

  await expect.poll(async () => {
    if (await heading.isVisible().catch(() => false)) return 'onboarding';
    if (await ready.isVisible().catch(() => false)) return 'ready';
    return 'loading';
  }, { timeout: 30_000 }).toMatch(/^(onboarding|ready)$/);

  if (!(await heading.isVisible().catch(() => false))) return false;

  const slug = scenarioKey.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

  await page.getByLabel('Firmenname').fill(`${company} ${slug}`);
  await page.getByLabel('Inhaber oder Geschäftsführung').fill(`${company} Owner`);
  await page.getByLabel('Straße und Hausnummer').fill('Teststrasse 1');
  await page.getByLabel('PLZ').fill('10115');
  await page.getByLabel('Stadt').fill('Berlin');
  await page.getByLabel('E-Mail für Angebote und Rechnungen').fill(`owner+${slug}@billme-e2e.local`);
  await page.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();

  await page.getByLabel(taxNumber.label, { exact: true }).fill(taxNumber.value);
  await page.getByLabel('Zahlungsziel in Tagen').fill('14');
  await page.getByLabel('Rechnungs-Präfix').fill('RE-%Y-');
  await page.getByLabel('Angebots-Präfix').fill('ANG-%Y-');
  await page.getByRole('button', { name: 'Weiter zu Weitere Angaben' }).click();

  await page.getByLabel('Bankname').fill('Berliner Testbank');
  await page.getByLabel('IBAN').fill('DE02120300000000202051');
  await page.getByRole('button', { name: /^(Arbeitsbereich einrichten|Einrichtung abschließen)$/ }).click();
  await expect(heading).toHaveCount(0);
  await expect(ready).toBeVisible();
  return true;
};
