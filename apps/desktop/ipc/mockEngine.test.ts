import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ipcRoutes } from './contract';
import { createMockInvoke } from './mockEngine';

describe('mockEngine route coverage', () => {
  it('contains handlers for all IPC routes', () => {
    const contractRoutes = Object.keys(ipcRoutes).sort();
    const switchCases = [
      ...new Set(
        readFileSync(path.resolve(process.cwd(), 'ipc/mockEngine.ts'), 'utf8')
          .match(/case '[-a-zA-Z0-9:]+'/g)
          ?.map((line) => line.slice(6, -1)) ?? [],
      ),
    ].sort();

    expect(switchCases).toEqual(contractRoutes);
  });

  it('supports browser/demo critical routes', async () => {
    const invoke = createMockInvoke();

    const txList = await invoke('transactions:list', { type: 'income', unlinkedOnly: true });
    expect(Array.isArray(txList)).toBe(true);

    const firstTx = txList[0];
    expect(firstTx?.id).toBeTruthy();

    const invoices = await invoke('invoices:list', undefined);
    expect(invoices.length).toBeGreaterThan(0);

    const matches = await invoke('transactions:findMatches', { transactionId: firstTx!.id });
    expect(matches.transaction.id).toBe(firstTx!.id);

    const link = await invoke('transactions:link', {
      transactionId: firstTx!.id,
      invoiceId: invoices[0]!.id,
    });
    expect(link.success).toBe(true);

    const unlink = await invoke('transactions:unlink', { transactionId: firstTx!.id });
    expect(unlink.success).toBe(true);

    const email = await invoke('email:send', {
      documentType: 'invoice',
      documentId: invoices[0]!.id,
      recipientEmail: 'demo@example.com',
      recipientName: 'Demo',
      subject: 'Test',
      bodyText: 'Body',
    });
    expect(email.success).toBe(true);

    const emailCheck = await invoke('email:testConfig', {
      provider: 'smtp',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: true,
      smtpUser: 'demo@example.com',
      smtpPassword: 'secret',
    });
    expect(emailCheck.success).toBe(true);

    const importPreview = await invoke('finance:importPreview', {
      path: 'mock://imports/sample.csv',
      profile: 'generic',
      mapping: {
        dateColumn: 'date',
        amountColumn: 'amount',
      },
    });
    expect(importPreview.rows.length).toBeGreaterThan(0);

    const accountId = (await invoke('accounts:list', undefined))[0]!.id;
    const importCommit = await invoke('finance:importCommit', {
      path: 'mock://imports/sample.csv',
      accountId,
      profile: 'generic',
      mapping: {
        dateColumn: 'date',
        amountColumn: 'amount',
      },
    });
    expect(importCommit.batchId).toBeTruthy();

    const batches = await invoke('finance:listImportBatches', { accountId });
    expect(batches.length).toBeGreaterThan(0);

    const details = await invoke('finance:getImportBatchDetails', { batchId: importCommit.batchId });
    expect(details.batch.id).toBe(importCommit.batchId);

    const rollback = await invoke('finance:rollbackImportBatch', {
      batchId: importCommit.batchId,
      reason: 'Rollback for test validation',
    });
    expect(rollback.success).toBe(true);

    const dunningRun = await invoke('dunning:manualRun', undefined);
    expect(dunningRun.success).toBe(true);

    const dunningStatus = await invoke('dunning:getInvoiceStatus', { invoiceId: invoices[0]!.id });
    expect(typeof dunningStatus.currentLevel).toBe('number');

    const offers = await invoke('offers:list', undefined);
    const converted = await invoke('documents:convertOfferToInvoice', { offerId: offers[0]!.id });
    expect(converted.id).toBeTruthy();

    const pdf = await invoke('pdf:export', { kind: 'invoice', id: invoices[0]!.id });
    expect(pdf.path.startsWith('mock://pdf/')).toBe(true);
  });
});
