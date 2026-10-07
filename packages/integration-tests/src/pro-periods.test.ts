import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { addDays, today } from './fixtures.js';
import {
  addBankAccount, approveDraft, assertLedgerConsistent, bankTx, draft, draftAction, entryFor, get, getDraft, importCsv, invoiceEntry, issue,
  journal, money, openItems, payOpenItem, postDraft, PRO_TENANT, saveDraft, setPeriodStatus, shape, withDatabase, type JournalEntry,
} from './pro-fixtures.js';

/**
 * Accounting periods and the second chart/VAT mode of Billme Pro, through the
 * HTTP surface of the embedded backend.
 *
 * How this can fail (each one has a test below):
 * - closed period: an invoice, a manual draft, a payment or a reversal that
 *   still posts into it; a refused issue that leaves the invoice half-issued
 *   (number lost, no entry); a correction that is only possible by rewriting the
 *   closed month instead of posting in an open one
 * - soft lock: an override without a (non-blank) written reason, an override
 *   flag on the wrong request, a reason that is not kept in the audit trail
 * - restart: entries, open items, the audit chain, vendors, the receipts
 *   archive (bytes and hash) or posting state that changes across a restart
 * - SKR04 / Ist-VAT: SKR03 accounts used on an SKR04 tenant, output VAT reported
 *   before it is paid, VAT recognised without a payment or beyond the invoice
 *   (overpayment), a chart switch after the first posting, a report of the other
 *   chart
 */

const GROSS = 238;
test('closed and soft-locked periods stop every posting path, and ledger, open items and archive survive the restart', async (t) => {
  const first = await startPro(null, 'pro-accounting-periods-before-restart');
  const vendorId = `v-${randomUUID().slice(0, 6)}`;
  await first.raw('POST', '/accounting/vendors', { reason: 'Lieferant', vendor: { id: vendorId, name: 'Archiv GmbH' } });
  const incomingId = `in-${randomUUID().slice(0, 6)}`;
  await first.raw('POST', '/accounting/incoming-invoices', { reason: 'Eingang', invoice: { id: incomingId, vendorId, number: 'ER-1', invoiceDate: '2026-01-05', dueDate: '2026-01-30', netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, lines: [{ id: `l-${incomingId}`, incomingInvoiceId: incomingId, position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] } });
  assert.equal((await first.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: incomingId, reason: 'gebucht' })).body.status, 'ready');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(randomUUID())]);
  const upload = await first.raw('POST', `/accounting/incoming-invoices/${incomingId}/documents`, { reason: 'Beleg', originalFilename: 'beleg.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') });
  assert.equal(upload.status, 200, upload.text);

  const january = await issue(first, { client: 'Januar GmbH', date: '2026-01-10', dueDate: '2026-01-24' });
  const bank = await addBankAccount(first, 'bank-lock');
  await importCsv(first, bank, [
    { date: '2026-01-20', amount: -119, counterparty: 'Januar Lieferant', purpose: 'Januar' },
    { date: '2026-02-10', amount: -50, counterparty: 'Februar Lieferant', purpose: 'Februar' },
    { date: '2026-03-10', amount: -60, counterparty: 'März Lieferant', purpose: 'März' },
  ]);
  const before = { entries: await journal(first), items: await openItems(first) };
  assert.ok(before.entries.length >= 2);
  await first.close({ keepData: true });

  // The accountant closes January and soft-locks February. No route does that, so the test writes the period rows.
  await withDatabase(first.userDataPath, async (database) => {
    await setPeriodStatus(database, PRO_TENANT, '2026-01', 'closed');
    await setPeriodStatus(database, PRO_TENANT, '2026-02', 'soft_locked');
  });
  const h = await startPro(t, 'pro-accounting-periods', first.userDataPath);

  await t.test('what was booked before the restart is unchanged', async () => {
    assert.deepEqual(await journal(h), before.entries);
    assert.deepEqual(await openItems(h), before.items);
    assert.equal((await h.api.audit.verify()).ok, true);
    assert.equal((await h.raw('GET', `/accounting/journal/${before.entries[0]!.id}`)).body.id, before.entries[0]!.id);
    const archive = await h.raw('GET', `/accounting/incoming-invoice-documents/${upload.body.id}/download`);
    assert.ok(Buffer.from(archive.body.data, 'base64').equals(pdf), 'the archived original survives');
    assert.equal(archive.body.document.sha256, createHash('sha256').update(pdf).digest('hex'));
    assert.equal((await get<any[]>(h, '/accounting/incoming-invoices')).find((invoice) => invoice.id === incomingId).accountingStatus, 'posted');
    assert.equal((await get<any[]>(h, '/accounting/vendors')).length, 1);
    await assertLedgerConsistent(h);
  });

  await t.test('an invoice dated in a closed period is refused and stays a draft with its number', async () => {
    const unposted = await draft(h, { client: 'Zu spät', date: '2026-01-15', dueDate: '2026-01-29' });
    const entries = (await journal(h)).length;
    const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    const stored = (await h.api.invoices.list()).find((invoice) => invoice.id === unposted.id)!;
    assert.deepEqual([stored.status, stored.number], ['draft', unposted.number]);
    assert.equal((await journal(h)).length, entries);
    const reissued = await h.api.invoices.upsert({ reason: 'im offenen Monat gestellt', invoice: { ...unposted, date: today(), dueDate: addDays(today(), 14), status: 'open' } });
    assert.equal(reissued.number, unposted.number, 'the number is still the draft\'s');
    assert.equal((await invoiceEntry(h, reissued.id))!.postingDate, today());
  });

  await t.test('a manual draft in a closed period is locked and cannot be posted', async () => {
    const tx = await bankTx(h, 'Januar Lieferant');
    const d = await getDraft(h, tx.id);
    assert.equal(d.period, '2026-01');
    const saved = await saveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 119, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 119 }]);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.workflowStatus, 'period_locked');
    assert.ok(saved.body.validationIssues.some((issue: any) => issue.code === 'POSTING_DATE_IN_CLOSED_PERIOD' && issue.blocking));
    assert.equal((await draftAction(h, tx.id, 'approve')).status, 409);
    const entries = (await journal(h)).length;
    const attempt = await postDraft(h, d.id, { postingDate: d.postingDate });
    assert.equal(attempt.body.entry.id, '');
    assert.ok(attempt.body.issues.some((issue: any) => issue.code === 'POSTING_DATE_IN_CLOSED_PERIOD'));
    assert.equal((await journal(h)).length, entries);
    assert.equal((await bankTx(h, 'Januar Lieferant')).status, 'pending');
  });

  await t.test('a posted January entry is corrected with a reversal in an open month, never inside the closed one', async () => {
    const entry = (await invoiceEntry(h, january.id))!;
    assert.equal(entry.postingDate, '2026-01-10');
    const inside = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'outgoing_invoice', documentId: january.id, postingDate: '2026-01-31' });
    assert.equal(inside.status, 409, inside.text);
    assert.match(inside.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'posted', 'nothing was changed by the refused reversal');
    const open = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno im laufenden Monat', documentType: 'outgoing_invoice', documentId: january.id, postingDate: today() });
    assert.equal(open.status, 200, open.text);
    assert.equal((await journal(h)).find((candidate) => candidate.id === open.body.reversalEntryId)!.postingDate, today());
    assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'reversed');
  });

  await t.test('a payment dated in a closed period is refused, one dated today is booked', async () => {
    const late = await issue(h, { client: 'Zahlung Januar' });
    const item = (await openItems(h)).find((candidate) => candidate.sourceId === late.id)!;
    const entries = (await journal(h)).length;
    const refused = await payOpenItem(h, item, 50, { paymentDate: '2026-01-31' });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal((await journal(h)).length, entries);
    assert.equal((await openItems(h)).find((candidate) => candidate.id === item.id)!.allocatedAmount, 0, 'the refused payment allocated nothing');
    assert.equal((await payOpenItem(h, item, 50)).status, 200);
  });

  await t.test('a soft-locked period needs an override with a written reason, and the reason is audited', async () => {
    const tx = await bankTx(h, 'Februar Lieferant');
    const d = await getDraft(h, tx.id);
    assert.equal(d.period, '2026-02');
    const lines = [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 50, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 50 }];
    await approveDraft(h, d, lines);
    const entries = (await journal(h)).length;
    for (const body of [{}, { softLockOverride: true }, { softLockOverride: true, overrideReason: '   ' }, { softLockOverride: false, overrideReason: 'Nachtrag' }]) {
      const blocked = await postDraft(h, d.id, { postingDate: '2026-02-10', ...body });
      assert.equal(blocked.body.entry.id, '', JSON.stringify(body));
      assert.ok(blocked.body.issues.some((issue: any) => issue.code === 'SOFT_LOCK_OVERRIDE_REQUIRED'), JSON.stringify(body));
    }
    assert.equal((await journal(h)).length, entries);
    assert.equal((await bankTx(h, 'Februar Lieferant')).status, 'pending');
    const allowed = await postDraft(h, d.id, { postingDate: '2026-02-10', softLockOverride: true, overrideReason: 'Nachtrag nach Belegprüfung 4711' });
    assert.equal(allowed.status, 200, allowed.text);
    assert.ok(allowed.body.entry.id);
    assert.equal(allowed.body.entry.postingDate, '2026-02-10');
    assert.equal((await bankTx(h, 'Februar Lieferant')).status, 'booked');
  });

  await t.test('the written reason of a soft-lock override is kept in the audit trail', async () => {
    assert.ok((await h.api.audit.exportCsv()).includes('Nachtrag nach Belegprüfung 4711'), 'the override reason is in the audit trail');
  });

  await t.test('issuing into a soft-locked period fails cleanly, the invoice route has no override', async () => {
    const unposted = await draft(h, { client: 'Februar Rechnung', date: '2026-02-12', dueDate: '2026-02-26' });
    const entries = (await journal(h)).length;
    const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.message, /SOFT_LOCK_OVERRIDE_REQUIRED/);
    assert.equal((await journal(h)).length, entries);
    assert.equal((await h.api.invoices.list()).find((invoice) => invoice.id === unposted.id)!.status, 'draft');
  });

  await t.test('a standalone posting follows the same locks: refused in a closed period, an override with a reason in a soft-locked one', async () => {
    const fact = (id: string, date: string, over: Record<string, unknown> = {}) => ({
      command: 'source_fact', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, reason: 'Sonderbuchung',
      input: { sourceType: 'standalone_source', sourceId: id, sourceRevision: 'v1', effectiveDate: date, postingDate: date, period: date.slice(0, 7), fiscalYear: 2026, currency: 'EUR', bookingText: 'Sonderbuchung', lines: [{ accountNumber: '4930', debitAmount: 25, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 25 }] },
      ...over,
    });
    const runs = async () => (await get<unknown[]>(h, '/accounting/source-runs')).length;
    const entries = (await journal(h)).length;
    const runsBefore = await runs();
    const closed = await h.raw('POST', '/accounting/closing', fact(`closed-${randomUUID()}`, '2026-01-31'));
    assert.equal(closed.status, 409, closed.text);
    assert.match(closed.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    const soft = await h.raw('POST', '/accounting/closing', fact(`soft-${randomUUID()}`, '2026-02-28'));
    assert.equal(soft.status, 409, soft.text);
    assert.match(soft.body.message, /SOFT_LOCK_OVERRIDE_REQUIRED/);
    assert.equal((await h.raw('POST', '/accounting/closing', fact(`soft-${randomUUID()}`, '2026-02-28', { softLockOverride: true, overrideReason: '  ' }))).status, 409, 'a blank override reason does not count');
    assert.equal((await journal(h)).length, entries, 'nothing was posted');
    assert.equal(await runs(), runsBefore, 'and no run was recorded');
    const allowed = await h.raw('POST', '/accounting/closing', fact(`soft-ok-${randomUUID()}`, '2026-02-28', { softLockOverride: true, overrideReason: 'Nachtrag Sonderbuchung' }));
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await journal(h)).length, entries + 1);
  });

  await t.test('after all of this the ledger is still consistent', async () => {
    await assertLedgerConsistent(h);
    assert.equal((await h.api.audit.verify()).ok, true);
  });
});

describe('SKR04 with Ist-VAT', () => {
  let h: ProHarness;
  before(async () => { h = await startPro(null, 'pro-accounting-skr04'); });
  after(async () => { await h.close(); });
  const setPolicy = (body: Record<string, unknown>) => h.raw('PUT', '/accounting/policy', { reason: 'Kontenrahmen gewählt', ...body });

  test('the policy picks chart and VAT method on an empty ledger and validates its input', async () => {
    assert.equal((await setPolicy({ activeChart: 'SKR05', vatMethod: 'ist' })).status, 400);
    assert.equal((await setPolicy({ activeChart: 'SKR04', vatMethod: 'monthly' })).status, 400);
    assert.equal((await h.raw('PUT', '/accounting/policy', { activeChart: 'SKR04', vatMethod: 'ist' })).status, 400, 'reason required');
    const saved = await setPolicy({ activeChart: 'SKR04', vatMethod: 'ist' });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual([saved.body.activeChart, saved.body.vatMethod], ['SKR04', 'ist']);
    assert.deepEqual((await get(h, '/accounting/policy')).activeChart, 'SKR04');
    assert.ok((await h.api.audit.exportCsv()).includes('accounting_policy'));
  });

  test('an issued invoice posts the SKR04 accounts and defers its VAT until it is paid', async () => {
    const invoice = await issue(h, { client: 'Ist GmbH' });
    const entry = (await invoiceEntry(h, invoice.id))!;
    assert.deepEqual(shape(entry), [['1200', GROSS, 0], ['4400', 0, 200], ['3810', 0, 38]]);
    assert.equal(entry.lines[1]!.memo, 'UStBasis DE_STD_19');
    const vat = (await get<{ rows: Array<{ taxCaseKey: string; taxAmount: number }> }>(h, '/accounting/vat/summary')).rows;
    assert.equal(vat.reduce((sum, row) => sum + row.taxAmount, 0), 0, 'no output VAT reported before payment (Ist)');

    const item = (await openItems(h)).find((candidate) => candidate.sourceId === invoice.id)!;
    const partial = await payOpenItem(h, item, 100, { bankAccountNumber: '1800' });
    assert.equal(partial.status, 200, partial.text);
    const entries = await journal(h);
    assert.deepEqual(shape(entries.find((candidate) => candidate.id === partial.body.journalEntryId)!), [['1800', 100, 0], ['1200', 0, 100]]);
    const recognised = entries.filter((candidate) => candidate.sourceType === 'payment_vat');
    assert.equal(recognised.length, 1);
    assert.deepEqual(shape(recognised[0]!), [['3810', 15.97, 0], ['3806', 0, 15.97]], 'VAT is recognised pro rata: 38 × 100 / 238');
    assert.equal((await payOpenItem(h, item, 138, { bankAccountNumber: '1800' })).status, 200);
    const all = (await journal(h)).filter((candidate) => candidate.sourceType === 'payment_vat');
    assert.equal(money(all.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountNumber === '3806').reduce((s, line) => s + line.creditAmount, 0), 0)), 38, 'the full VAT is recognised once the invoice is paid');
    assert.equal((await get<{ rows: Array<{ taxAmount: number }> }>(h, '/accounting/vat/summary')).rows.reduce((sum, row) => sum + row.taxAmount, 0), 38);
    await assertLedgerConsistent(h);
  });

  test('an overpayment never recognises more VAT than the invoice carries', async () => {
    const invoice = await issue(h, { client: 'Ist Überzahler' });
    const item = (await openItems(h)).find((candidate) => candidate.sourceId === invoice.id)!;
    const before = (await journal(h)).filter((entry) => entry.sourceType === 'payment_vat').length;
    assert.equal((await payOpenItem(h, item, 400, { bankAccountNumber: '1800' }, GROSS)).status, 200);
    const recognised = (await journal(h)).filter((entry) => entry.sourceType === 'payment_vat');
    assert.equal(recognised.length, before + 1);
    assert.equal(recognised[0]!.lines.find((line) => line.accountNumber === '3806')!.creditAmount, 38);
  });

  test('manual bookings and incoming invoices use the SKR04 roles; the chart is locked once something is posted', async () => {
    const bank = await addBankAccount(h, 'bank-skr04', '1800');
    await importCsv(h, bank, [{ date: '2026-03-02', amount: -119, counterparty: 'Lieferant SKR04', purpose: 'Rechnung' }]);
    const d = await getDraft(h, (await bankTx(h, 'Lieferant SKR04')).id);
    assert.equal(d.lines[1]!.accountNumber, '1800', 'the bank role of SKR04');
    assert.equal(d.lines[1]!.creditAmount, 119);

    const vendorId = `v-${randomUUID().slice(0, 6)}`;
    await h.raw('POST', '/accounting/vendors', { reason: 'Lieferant', vendor: { id: vendorId, name: 'SKR04 Lieferant' } });
    const id = `in-${randomUUID().slice(0, 6)}`;
    await h.raw('POST', '/accounting/incoming-invoices', { reason: 'Eingang', invoice: { id, vendorId, number: 'ER-04', invoiceDate: '2026-03-02', dueDate: '2026-03-30', netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Leistung', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] } });
    assert.equal((await h.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: id, reason: 'gebucht' })).body.status, 'ready');
    assert.deepEqual(shape((await entryFor(h, `incoming-invoice:${id}`))!), [['6300', 100, 0], ['1406', 19, 0], ['3300', 0, 119]]);

    const locked = await setPolicy({ activeChart: 'SKR03', vatMethod: 'ist' });
    assert.equal(locked.status, 409, locked.text);
    assert.match(locked.body.message, /Kontenrahmen/);
    assert.equal((await get(h, '/accounting/policy')).activeChart, 'SKR04');
    assert.equal((await h.raw('GET', '/accounting/reports/susa?chart=SKR03')).status, 409, 'a report of the other chart is refused');
  });
});

