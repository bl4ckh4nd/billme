import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, seedBankTransactions, useRegularVat } from './lite-support.mjs';

/**
 * Lite Auswertungen, UStVA and import history as a user reads them.
 *
 * How this can fail:
 * - "Ø Rechnungswert" divides the paid revenue by the invoices that received money, so it neither
 *   says what the average invoice is worth nor matches its label
 * - a month with a refund (negative revenue) leaves no bar in "Umsatzentwicklung"
 * - the UStVA "Datenstand" shows the raw ISO timestamp
 * - a re-import that books a pending line reads "0 importiert" in the import history
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await seedBankTransactions(desktop.page);
  await useRegularVat(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const euroIn = (text) => {
  const match = text.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/);
  return Number(match[0].replace(/\./g, '').replace(',', '.'));
};

test('Auswertungen: average invoice is the net invoiced per invoice, a refund month gets a bar below zero', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const year = new Date().getFullYear();
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  const paidMonths = new Set(invoices.flatMap((inv) => inv.payments ?? []).filter((p) => p.date.startsWith(String(year))).map((p) => Number(p.date.slice(5, 7))));
  const refundMonth = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((month) => !paidMonths.has(month));
  const refunded = invoices.find((inv) => inv.status === 'paid' && (inv.payments ?? []).some((p) => p.amount >= 100));
  expect(refunded, 'the seed has a paid invoice').toBeTruthy();
  await invokeDesktopIpc(page, 'invoices:savePayment', { invoiceId: refunded.id, payment: { id: 'refund-e2e', date: `${year}-${String(refundMonth).padStart(2, '0')}-20`, amount: -100, method: 'Erstattung' }, reason: 'Erstattung' });
  const issued = (await invokeDesktopIpc(page, 'invoices:list', {})).filter((inv) => inv.status !== 'draft' && (inv.documentKind ?? 'invoice') === 'invoice' && inv.date.startsWith(String(year)) && inv.amount > 0);
  expect(issued.length).toBeGreaterThan(0);
  const expected = Math.round((issued.reduce((sum, inv) => sum + (inv.taxSnapshot?.netAmount ?? inv.amount), 0) / issued.length) * 100) / 100;
  await page.reload();

  await page.goto(appUrl(baseUrl, '/statistics'));
  const kpis = page.getByRole('region', { name: 'Kennzahlen' });
  const tile = kpis.locator('div.rounded-tile', { hasText: 'Ø Rechnungswert netto' });
  await expect(tile).toContainText('Gestellte Rechnungen');
  await expect.poll(async () => euroIn(await tile.innerText())).toBe(expected);

  const chart = page.getByRole('img', { name: /Umsatzentwicklung/ });
  await expect(chart).toBeVisible();
  const monthName = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][refundMonth - 1];
  await expect(page.getByRole('row', { name: new RegExp(`^${monthName}`) })).toContainText('-100,00');
  // The bar of a negative month hangs below the zero line, so the chart draws that line and one mark per month with a value.
  await expect(chart.locator('line.stroke-foreground')).toHaveCount(1);
  const marks = await chart.locator('path.fill-foreground, path.fill-accent').count();
  const monthsWithValue = await page.getByRole('table', { name: /Umsatzentwicklung/ }).locator('tbody tr').filter({ hasNotText: /(^|\D)0,00\s€/ }).count();
  expect(marks).toBe(monthsWithValue);
  await shot('statistics-refund');
});

test('UStVA: the data state reads as a German date and time', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/statistics?view=ust'));
  const line = page.getByText(/^Datenstand /);
  await expect(line).toBeVisible();
  await expect(line).toContainText(/Datenstand \d{1,2}\.\d{1,2}\.\d{4}, \d{1,2}:\d{2}:\d{2} · Prüfsumme/);
  await expect(line).not.toContainText(/\d{4}-\d{2}-\d{2}T/);
  await shot('ustva-datenstand');
});

test('Import history: a re-import that books a pending line says "aktualisiert", not just "0 importiert"', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const mapping = { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck', statusColumn: 'Status' };
  const date = `${new Date().getFullYear()}-02-10`;
  const write = (name, status) => {
    const file = path.join(os.tmpdir(), `billme-e2e-${process.pid}-${Date.now()}-${name}.csv`);
    fs.writeFileSync(file, `Datum,Betrag,Gegenpartei,Verwendungszweck,Status\n${date},-42.00,Kaffeelieferant,Bestellung 77,${status}\n`, 'utf8');
    return file;
  };
  for (const [name, status] of [['pending', 'vorgemerkt'], ['booked', 'gebucht']]) {
    const file = write(name, status);
    const result = await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping });
    fs.rmSync(file, { force: true });
    if (name === 'booked') expect([result.imported, result.updated]).toEqual([0, 1]);
  }
  await page.goto(appUrl(baseUrl, '/accounts'));
  await page.getByRole('button', { name: 'Import-Historie' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('1 aktualisiert').first()).toBeVisible();
  await shot('import-history-updated');
});
