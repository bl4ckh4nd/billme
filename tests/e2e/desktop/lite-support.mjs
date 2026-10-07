import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import { getDesktopSettings, invokeDesktopIpc, setDesktopSettings } from '../support.mjs';

/** Numbered screenshots in the test's output folder: `01-name.png`, `02-name.png`, ... */
export const createShooter = (page) => {
  let count = 0;
  return async (name) => {
    count += 1;
    await page.screenshot({ path: test.info().outputPath(`${String(count).padStart(2, '0')}-${name}.png`), fullPage: true });
  };
};

/** Regular VAT instead of the seeded small-business rule, so 19 % and 7 % lines are priced. */
export const useRegularVat = async (page) => {
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, legal: { ...settings.legal, smallBusinessRule: false, defaultVatRate: 19 } });
  await page.reload();
};

const SEED_TRANSACTIONS = [
  { date: '2026-02-02', amount: 3450.5, counterparty: 'StartUp Berlin AG', purpose: 'Gutschrift' },
  { date: '2026-02-05', amount: -49.9, counterparty: 'Adobe Systems', purpose: 'Creative Cloud Abo' },
];

const CSV_MAPPING = {
  dateColumn: 'Datum',
  amountColumn: 'Betrag',
  counterpartyColumn: 'Gegenpartei',
  purposeColumn: 'Verwendungszweck',
};

/** Writes a bank statement CSV (generic profile) and returns its path. */
export const writeBankCsv = (rows, name = `billme-e2e-statement-${process.pid}-${Date.now()}.csv`) => {
  const file = path.join(os.tmpdir(), name);
  const lines = rows.map((row) => `${row.date},${row.amount.toFixed(2)},${row.counterparty},${row.purpose}`);
  fs.writeFileSync(file, `Datum,Betrag,Gegenpartei,Verwendungszweck\n${lines.join('\n')}\n`, 'utf8');
  return file;
};

/**
 * The account's `transactions` array is ignored by `accounts:upsert`; bank rows only enter through
 * the CSV import. Imports the two rows the old seed used (an income that matches the open invoice, an expense).
 */
export const seedBankTransactions = async (page) => {
  const file = writeBankCsv(SEED_TRANSACTIONS, `billme-e2e-seed-${process.pid}-${Date.now()}.csv`);
  try {
    const result = await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: CSV_MAPPING });
    if (result.imported !== SEED_TRANSACTIONS.length) throw new Error(`Bank seed imported ${result.imported} of ${SEED_TRANSACTIONS.length} rows`);
  } finally {
    fs.rmSync(file, { force: true });
  }
};

/**
 * The CSV picker is a native dialog. The renderer still calls `dialog:pickCsv` through the real IPC
 * path; only the OS file chooser in the Electron main process answers with the given file.
 */
export const answerNextFilePicker = (desktop, filePath) =>
  desktop.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, filePath);

/** The totals block of the open document editor as `[label, value]` pairs (whitespace normalized). */
export const readEditorTotals = async (page) => {
  const rows = await page.locator('[data-document-totals] .bf-total-line').evaluateAll((lines) =>
    lines.map((line) => [...line.children].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())),
  );
  return rows;
};
