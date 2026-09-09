import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { readServerHarnessState } from '../harness.mjs';
import {
  createOwnerCredentials,
  ensureHarnessSession,
  openProShell,
  requestJson,
  seedHarnessProTenant,
} from './helpers.mjs';

const owner = createOwnerCredentials('pro');
const invoiceId = 'playwright-incoming-document-archive-invoice';
const vendorId = 'playwright-incoming-document-archive-vendor';
const invoiceNumber = 'ER-DOC-ARCHIVE-001';

const screenshotDirectory = async () => {
  const directory = process.env.E2E_SCREENSHOT_DIR?.trim()
    || path.join(process.cwd(), 'docs', 'audit', 'screenshots', '2026-09-04-acceptance');
  await fs.mkdir(directory, { recursive: true });
  return directory;
};

const capture = async (page, directory, name) => {
  await page.getByTestId('opos-workspace').screenshot({
    path: path.join(directory, `${name}.png`),
  });
};

const pdfContent = Buffer.from('%PDF-1.7\nBillme incoming document archive E2E\n', 'utf8');
const pngContent = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const configurePosting = async (state, session) => {
  for (const [role, accountNumber] of [
    ['accounts_receivable', '1200'],
    ['accounts_payable', '1600'],
    ['input_vat', '1576'],
    ['output_vat', '1776'],
    ['revenue', '8400'],
  ]) {
    await requestJson(state, session, '/api/v1/pro/accounting/mappings', undefined, {
      method: 'POST',
      body: {
        reason: 'Playwright incoming document archive setup',
        chart: 'SKR03',
        role,
        accountNumber,
      },
    });
  }
};

const createSavedInvoice = async (state, session) => {
  await requestJson(state, session, '/api/v1/pro/accounting/vendors', undefined, {
    method: 'POST',
    body: {
      reason: 'Playwright incoming document archive setup',
      vendor: {
        id: vendorId,
        vendorNumber: 'V-DOC-ARCHIVE-001',
        name: 'Playwright Dokumentenarchiv Kreditor',
        defaultExpenseAccount: '3125',
      },
    },
  });

  const saved = await requestJson(state, session, '/api/v1/pro/accounting/incoming-invoices', undefined, {
    method: 'POST',
    body: {
      reason: 'Playwright incoming document archive setup',
      invoice: {
        id: invoiceId,
        vendorId,
        number: invoiceNumber,
        invoiceDate: '2026-09-01',
        dueDate: '2026-09-30',
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119,
        status: 'open',
        taxRate: 19,
        taxCaseKey: 'DE_STD_19',
        notes: 'Playwright incoming document archive E2E',
        accountingStatus: 'unposted',
        lines: [{
          id: `${invoiceId}-line-1`,
          incomingInvoiceId: invoiceId,
          position: 0,
          description: 'Dokumentenarchiv E2E',
          quantity: 1,
          unitPrice: 100,
          netAmount: 100,
          taxRate: 19,
          taxAmount: 19,
          grossAmount: 119,
          accountNumber: '3125',
        }],
      },
    },
  });
  expect(saved).toMatchObject({ id: invoiceId, number: invoiceNumber, accountingStatus: 'unposted' });
};

const openOpos = async (page, state, session) => {
  await openProShell(page, state, { route: 'accounting', session });
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Buchhaltungsbereiche' }).getByRole('button', { name: 'OPOS', exact: true }).click();
  const workspace = page.getByTestId('opos-workspace');
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'Eingangsrechnungen' })).toBeVisible();
  return workspace;
};

const selectInvoice = async (workspace) => {
  const selector = workspace.getByLabel('Gespeicherten Beleg wählen');
  await expect(selector).toBeVisible();
  await selector.selectOption(invoiceId);
  await expect(workspace.getByTestId('incoming-invoice-summary')).toContainText('1 Position gespeichert');
};

const fillReason = async (workspace) => {
  await workspace.getByLabel('Begründung').nth(1).fill('Playwright incoming document archive review');
};

const upload = async (workspace, file) => {
  await workspace.getByLabel('Datei archivieren').setInputFiles(file);
  await workspace.getByRole('button', { name: 'Original archivieren' }).click();
};

export const runProIncomingDocumentArchiveScenario = async (page) => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, { product: 'pro', ...owner });
  await seedHarnessProTenant(state, {
    tenantId: session.tenantId,
    namespace: 'incoming-document-archive',
    includeEurCashFixtures: true,
  });
  await configurePosting(state, session);
  await createSavedInvoice(state, session);

  const directory = await screenshotDirectory();
  await page.setViewportSize({ width: 1440, height: 1200 });
  const workspace = await openOpos(page, state, session);
  await selectInvoice(workspace);
  await fillReason(workspace);
  await expect(workspace.getByText('Noch kein Originalbeleg archiviert.')).toBeVisible();
  await capture(page, directory, '01-empty');

  await upload(workspace, {
    name: 'rechnung-original.pdf',
    mimeType: 'application/pdf',
    buffer: pdfContent,
  });
  await expect(page.getByRole('status')).toContainText('Originalbeleg archiviert.');
  const pdfRow = workspace.locator('tbody tr').filter({ hasText: 'rechnung-original.pdf' });
  await expect(pdfRow).toContainText('Ausstehend');
  await capture(page, directory, '02-pdf-pending');

  await upload(workspace, {
    name: 'duplicate.pdf',
    mimeType: 'application/pdf',
    buffer: pdfContent,
  });
  await expect(page.getByRole('alert')).toContainText('Diese Datei ist im Mandanten bereits als Originalbeleg archiviert.');
  await capture(page, directory, '03-duplicate-error');

  await upload(workspace, {
    name: 'mismatch.png',
    mimeType: 'image/png',
    buffer: pdfContent,
  });
  await expect(page.getByRole('alert')).toContainText('Der Dateiinhalt passt nicht zum angegebenen Dateityp.');
  await capture(page, directory, '04-invalid-mime-error');

  await upload(workspace, {
    name: 'too-large.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x25),
  });
  await expect(page.getByRole('alert')).toContainText('höchstens 10 MiB');
  await capture(page, directory, '05-oversize-error');

  await pdfRow.getByRole('button', { name: 'Als geprüft markieren' }).click();
  await expect(page.getByRole('status')).toContainText('als geprüft markiert');
  await expect(pdfRow).toContainText('Geprüft');
  await capture(page, directory, '06-pdf-accepted');

  await upload(workspace, {
    name: 'rechnung-original.png',
    mimeType: 'image/png',
    buffer: pngContent,
  });
  await expect(page.getByRole('status')).toContainText('Originalbeleg archiviert.');
  const pngRow = workspace.locator('tbody tr').filter({ hasText: 'rechnung-original.png' });
  await expect(pngRow).toContainText('Ausstehend');
  await capture(page, directory, '07-png-pending');

  await pngRow.getByRole('button', { name: 'Ablehnen' }).click();
  await expect(page.getByRole('status')).toContainText('zur Prüfung abgelehnt');
  await expect(pngRow).toContainText('Abgelehnt');
  await capture(page, directory, '08-png-rejected');

  const documentsBeforePosting = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/incoming-invoices/${encodeURIComponent(invoiceId)}/documents`,
  );
  expect(documentsBeforePosting).toEqual(expect.arrayContaining([
    expect.objectContaining({
      originalFilename: 'rechnung-original.pdf',
      byteLength: pdfContent.byteLength,
      sha256: crypto.createHash('sha256').update(pdfContent).digest('hex'),
      reviewStatus: 'accepted',
    }),
    expect.objectContaining({
      originalFilename: 'rechnung-original.png',
      byteLength: pngContent.byteLength,
      sha256: crypto.createHash('sha256').update(pngContent).digest('hex'),
      reviewStatus: 'rejected',
    }),
  ]));

  await workspace.getByRole('button', { name: 'Buchen' }).click();
  await expect(page.getByText('Eingangsrechnung gebucht.', { exact: true })).toBeVisible();
  await expect(pdfRow).toContainText('Journal');
  await expect(pngRow).toContainText('Journal');
  await capture(page, directory, '09-posted-journal');

  const documentsAfterPosting = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/incoming-invoices/${encodeURIComponent(invoiceId)}/documents`,
  );
  expect(documentsAfterPosting).toEqual(expect.arrayContaining([
    expect.objectContaining({ originalFilename: 'rechnung-original.pdf', journalEntryId: expect.any(String) }),
    expect.objectContaining({ originalFilename: 'rechnung-original.png', journalEntryId: expect.any(String) }),
  ]));

  const pdfDownload = page.waitForEvent('download');
  await pdfRow.getByRole('button', { name: 'Herunterladen' }).click();
  const downloadedPdf = await pdfDownload;
  expect(downloadedPdf.suggestedFilename()).toBe('rechnung-original.pdf');
  const pdfPath = path.join(directory, 'downloaded-rechnung-original.pdf');
  await downloadedPdf.saveAs(pdfPath);
  expect(await fs.readFile(pdfPath)).toEqual(pdfContent);
  await fs.rm(pdfPath, { force: true });

  const pngDownload = page.waitForEvent('download');
  await pngRow.getByRole('button', { name: 'Herunterladen' }).click();
  const downloadedPng = await pngDownload;
  expect(downloadedPng.suggestedFilename()).toBe('rechnung-original.png');
  const pngPath = path.join(directory, 'downloaded-rechnung-original.png');
  await downloadedPng.saveAs(pngPath);
  expect(await fs.readFile(pngPath)).toEqual(pngContent);
  await fs.rm(pngPath, { force: true });

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Buchhaltungsbereiche' }).getByRole('button', { name: 'OPOS', exact: true }).click();
  const reloadedWorkspace = page.getByTestId('opos-workspace');
  await selectInvoice(reloadedWorkspace);
  const reloadedPdfRow = reloadedWorkspace.locator('tbody tr').filter({ hasText: 'rechnung-original.pdf' });
  const reloadedPngRow = reloadedWorkspace.locator('tbody tr').filter({ hasText: 'rechnung-original.png' });
  await expect(reloadedPdfRow).toContainText('Geprüft');
  await expect(reloadedPdfRow).toContainText('Journal');
  await expect(reloadedPngRow).toContainText('Abgelehnt');
  await expect(reloadedPngRow).toContainText('Journal');
  await capture(page, directory, '10-reloaded-persisted');
};
