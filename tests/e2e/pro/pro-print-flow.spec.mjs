import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { getDesktopSettings, invokeDesktopIpc, launchDesktopApp, readEmbeddedFacturX, seedDesktopData, setDesktopSettings } from '../support.mjs';

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

test('Pro prints invoices and offers through the flow layout with ZUGFeRD', async () => {
  const { page, baseUrl } = desktop;
  const artifactDir = process.env.PRINT_ARTIFACT_DIR ?? test.info().outputPath('print');
  fs.mkdirSync(artifactDir, { recursive: true });
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, eInvoice: { ...settings.eInvoice, enabled: true } });

  const invoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.id === 'inv-open-1');
  const result = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: invoice.id });
  const bytes = fs.readFileSync(result.path);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(path.basename(result.path)).toBe(`Rechnung-${invoice.number}-${invoice.client}.pdf`);
  expect(await readEmbeddedFacturX(bytes)).toContain(`<ram:ID>${invoice.number}</ram:ID>`);
  fs.copyFileSync(result.path, path.join(artifactDir, 'pro-invoice.pdf'));

  const offer = await invokeDesktopIpc(page, 'pdf:export', { kind: 'offer', id: 'offer-open-1' });
  expect(await readEmbeddedFacturX(fs.readFileSync(offer.path))).toBeNull();
  fs.copyFileSync(offer.path, path.join(artifactDir, 'pro-offer.pdf'));

  await page.goto(`${baseUrl}/?__print=1&kind=offer&id=offer-open-1`);
  await page.waitForFunction(() => globalThis.__PDF_READY__ === true);
  await expect(page.locator('.bf-page').getByText('Angebot ANG-2026-001', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, 'pro-offer.png'), fullPage: true });
});
