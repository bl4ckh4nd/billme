import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { addDays, today } from './fixtures.js';
import {
  addBankAccount, approveDraft, assertLedgerConsistent, bankTx, draft, draftAction, entryFor, get, getDraft, importCsv, invoiceEntry, issue,
  journal, money, openItems, payOpenItem, periods, postDraft, saveDraft, setPeriod, shape, statusOf, type JournalEntry,
} from './pro-fixtures.js';

/**
 * Accounting periods and the second chart/VAT mode of Billme Pro, through the
 * HTTP surface of the embedded backend.
 *
 * How this can fail (each one has a test below):
 * - period route: a festgeschriebener (closed) month that can be reopened or
 *   soft-locked again, a change without a written reason, a change that is not
 *   audited, an unknown month or status accepted, a status that is lost across
 *   a restart, a month before a closed one that still takes postings
 *   (Festschreibung is cumulative), a reopened soft lock that still blocks
 * - closed period: an invoice, a manual draft, a free entry (Buchungssatz), a
 *   payment, a Zahlungsstorno or a reversal that still posts into it; a refused issue that leaves the invoice half-issued
 *   (number lost, no entry); a correction that is only possible by rewriting the
 *   closed month instead of posting in an open one; an asset activation or a
 *   journal reversal that still posts into it
 * - soft lock: an override without a (non-blank) written reason, an override
 *   flag on the wrong request, a reason that is not kept in the audit trail
 * - restart: entries, open items, the audit chain, vendors, the receipts
 *   archive (bytes and hash) or posting state that changes across a restart
 * - SKR04 / Ist-VAT: SKR03 accounts used on an SKR04 tenant, output VAT reported
 *   before it is paid, VAT recognised without a payment or beyond the invoice
 *   (overpayment), a chart switch after the first posting, a report of the other
 *   chart
 * - Ist-VAT accounts and corrections: not-yet-due VAT on the USt-Vorauszahlungen
 *   account (1780) or all rates on one account; a Skonto, a Forderungsausfall or
 *   a Storno of a paid invoice reducing the due VAT (1776) that was never due, or
 *   leaving a rest on the not-yet-due account, in either order of payment and
 *   correction; a Skonto derived from the payment that survives the reversal of
 *   that payment
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

  // The accountant festschreibt January and soft-locks February through the period route.
  const closedJanuary = await setPeriod(first, '2026-01', 'closed', 'Januar festgeschrieben nach UStVA');
  assert.equal(closedJanuary.status, 200, closedJanuary.text);
  assert.deepEqual([closedJanuary.body.period, closedJanuary.body.status], ['2026-01', 'closed']);
  assert.ok(closedJanuary.body.changedPeriods.includes('2026-01'));
  assert.equal((await setPeriod(first, '2026-02', 'soft_locked', 'Februar vorläufig gesperrt')).status, 200);
  await first.close({ keepData: true });
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

  await t.test('the month statuses survive the restart; a festgeschriebener month never changes again', async () => {
    const months = await periods(h, 2026);
    assert.equal(months.length, 12);
    assert.deepEqual(months.slice(0, 3).map((row) => [row.period, row.status]), [['2026-01', 'closed'], ['2026-02', 'soft_locked'], ['2026-03', 'open']]);
    assert.ok(months[0]!.entryCount >= 2, 'January shows its entries');
    assert.ok((await periods(h, 2025)).every((row) => row.status === 'closed'), 'closing January closes every month before it');
    for (const status of ['open', 'soft_locked', 'closed'] as const) {
      const refused = await setPeriod(h, '2026-01', status, 'doch wieder öffnen');
      assert.equal(refused.status, 409, `${status}: ${refused.text}`);
      assert.match(refused.body.message, /PERIOD_CLOSED/);
    }
    const earlier = await setPeriod(h, '2025-12', 'soft_locked', 'Dezember sperren');
    assert.equal(earlier.status, 409, earlier.text);
    assert.equal(await statusOf(h, '2026-01'), 'closed');
    assert.ok((await h.api.audit.exportCsv()).includes('Januar festgeschrieben nach UStVA'), 'the reason of the Festschreibung is audited');
  });

  await t.test('the period route needs a written reason, a real month and a known status', async () => {
    assert.equal((await setPeriod(h, '2026-03', 'soft_locked', null)).status, 400, 'no reason');
    assert.equal((await setPeriod(h, '2026-03', 'soft_locked', '   ')).status, 400, 'a blank reason');
    assert.equal((await setPeriod(h, '2026-13', 'soft_locked')).status, 400, 'no such month');
    assert.equal((await h.raw('POST', '/accounting/periods/2026-03/status', { status: 'locked', reason: 'x' })).status, 400, 'unknown status');
    assert.equal((await h.raw('GET', '/accounting/periods?year=20x6')).status, 400, 'a malformed year');
    assert.equal(await statusOf(h, '2026-03'), 'open', 'nothing was changed');
    const again = await setPeriod(h, '2026-02', 'soft_locked', 'nochmal sperren');
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.body.changedPeriods, [], 'locking a locked month changes nothing');
  });

  await t.test('a posting dated before a festgeschriebener month is refused, the month itself was never touched', async () => {
    const unposted = await draft(h, { client: 'Dezember', date: '2025-12-15', dueDate: '2025-12-29' });
    const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
  });

  await t.test('an asset activated in a closed period is refused and posts nothing', async () => {
    const entries = (await journal(h)).length;
    const refused = await h.raw('POST', '/accounting/assets', { reason: 'Anlage erfasst', asset: { assetNumber: `A-${randomUUID().slice(0, 6)}`, name: 'Notebook', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-01-15', acquisitionCost: 1200, usefulLifeYears: 3, depreciationMethod: 'linear', costCenter: 'IT', location: 'Berlin', receiptLinked: true, assetAccountNumber: '0440' } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal((await journal(h)).length, entries);
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
    const paid = await payOpenItem(h, item, 50);
    assert.equal(paid.status, 200, paid.text);
    const before = (await journal(h)).length;
    const storno = await h.raw('POST', `/accounting/open-items/payments/${paid.body.id}/reverse`, { reason: 'Zahlung falsch zugeordnet', postingDate: '2026-01-31' });
    assert.equal(storno.status, 409, storno.text);
    assert.match(storno.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal((await journal(h)).length, before, 'the refused Zahlungsstorno posted nothing');
    assert.equal((await openItems(h)).find((candidate) => candidate.id === item.id)!.allocatedAmount, 50, 'the payment stays allocated');
  });

  await t.test('a free entry (Buchungssatz) into a closed month is refused, a soft-locked one needs an override with a reason', async () => {
    const entries = (await journal(h)).length;
    const body = (documentDate: string, extra: Record<string, unknown> = {}) => ({ reason: 'Buchungssatz', documentDate, reference: `M-${randomUUID().slice(0, 6)}`, bookingText: 'Privatentnahme bar', idempotencyKey: randomUUID(),
      lines: [{ accountNumber: '1800', debitAmount: 20, creditAmount: 0 }, { accountNumber: '1000', debitAmount: 0, creditAmount: 20 }], ...extra });
    const closed = await h.raw('POST', '/accounting/journal', body('2026-01-15'));
    assert.equal(closed.status, 409, closed.text);
    assert.match(closed.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    const soft = await h.raw('POST', '/accounting/journal', body('2026-02-15'));
    assert.equal(soft.status, 409, soft.text);
    assert.match(soft.body.message, /SOFT_LOCK_OVERRIDE_REQUIRED/);
    assert.equal((await journal(h)).length, entries);
    const allowed = await h.raw('POST', '/accounting/journal', body('2026-02-15', { softLockOverride: true, overrideReason: 'Kassenbeleg nachgereicht' }));
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await journal(h)).length, entries + 1);
  });

  await t.test('a payment recorded on the invoice into a closed month is refused and books nothing', async () => {
    const invoice = await issue(h, { client: 'Rechnungszahlung Januar' });
    const entries = (await journal(h)).length;
    const refused = await h.raw('POST', `/invoices/${invoice.id}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date: '2026-01-31', amount: 50, method: 'Überweisung' } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal((await journal(h)).length, entries);
    assert.deepEqual((await h.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!.payments ?? [], [], 'the invoice does not list the refused payment');
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
    const intoClosed = await h.raw('POST', `/accounting/journal/${allowed.body.entry.id}/reverse`, { reason: 'Storno', postingDate: '2026-01-31' });
    assert.equal(intoClosed.status, 409, intoClosed.text);
    assert.match(intoClosed.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
    assert.equal((await get<JournalEntry>(h, `/accounting/journal/${allowed.body.entry.id}`)).status, 'posted');
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

  await t.test('reopening a soft-locked month needs a reason and is audited; festschreiben closes every open month before it', async () => {
    const fact = (id: string) => ({
      command: 'source_fact', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, reason: 'Sonderbuchung',
      input: { sourceType: 'standalone_source', sourceId: id, sourceRevision: 'v1', effectiveDate: '2026-02-27', postingDate: '2026-02-27', period: '2026-02', fiscalYear: 2026, currency: 'EUR', bookingText: 'Nachtrag Februar', lines: [{ accountNumber: '4930', debitAmount: 10, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 10 }] },
    });
    assert.equal((await h.raw('POST', '/accounting/closing', fact(`feb-${randomUUID()}`))).status, 409, 'still soft-locked');
    assert.equal((await setPeriod(h, '2026-02', 'open', null)).status, 400, 'reopening needs a reason');
    const reopened = await setPeriod(h, '2026-02', 'open', 'Belege von Februar nachgereicht');
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(await statusOf(h, '2026-02'), 'open');
    assert.ok((await h.api.audit.exportCsv()).includes('Belege von Februar nachgereicht'), 'the reopening is audited with its reason');
    const posted = await h.raw('POST', '/accounting/closing', fact(`feb-${randomUUID()}`));
    assert.equal(posted.status, 200, posted.text);

    const closed = await setPeriod(h, '2026-03', 'closed', 'März festgeschrieben');
    assert.equal(closed.status, 200, closed.text);
    assert.ok(closed.body.changedPeriods.includes('2026-02') && closed.body.changedPeriods.includes('2026-03'), JSON.stringify(closed.body));
    assert.deepEqual((await periods(h, 2026)).slice(0, 4).map((row) => row.status), ['closed', 'closed', 'closed', 'open']);
    const late = await h.raw('POST', '/accounting/closing', fact(`feb-${randomUUID()}`));
    assert.equal(late.status, 409, late.text);
    assert.match(late.body.message, /POSTING_DATE_IN_CLOSED_PERIOD/);
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
    assert.deepEqual(shape(entry), [['1200', GROSS, 0], ['4400', 0, 200], ['3815', 0, 38]], 'Umsatzsteuer nicht fällig 19 %');
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
    assert.deepEqual(shape(recognised[0]!), [['3815', 15.97, 0], ['3806', 0, 15.97]], 'VAT is recognised pro rata: 38 × 100 / 238');
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

  test('a payment recorded on the invoice recognises the Ist-VAT, a refund and a Zahlungsstorno take it back', async () => {
    const invoice = await issue(h, { client: 'Ist Rechnungszahlung' });
    const vat = async () => money((await journal(h)).filter((entry) => entry.sourceType === 'payment_vat' || entry.sourceType === 'reversal')
      .reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountNumber === '3806').reduce((s, line) => s + line.creditAmount - line.debitAmount, 0), 0));
    const before = await vat();
    const paid = await h.raw('POST', `/invoices/${invoice.id}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date: today(), amount: GROSS, method: 'Überweisung' } });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual(shape((await entryFor(h, `payment:invoice_payment:${paid.body.payments[0].id}`))!), [['1800', GROSS, 0], ['1200', 0, GROSS]]);
    assert.equal(money(await vat() - before), 38, 'the VAT is due once the invoice is paid');
    const refund = await h.raw('POST', `/invoices/${invoice.id}/payments`, { reason: 'Teilerstattung', payment: { id: randomUUID(), date: today(), amount: -119, method: 'Überweisung' } });
    assert.equal(refund.status, 200, refund.text);
    assert.equal(money(await vat() - before), 19, 'a refund of half takes back half the VAT');
    const payment = refund.body.payments.find((entry: { amount: number }) => entry.amount === -119);
    const reversed = await h.raw('POST', `/invoices/${invoice.id}/payments/${payment.id}/reverse`, { reason: 'Erstattung storniert', expectedPayment: payment });
    assert.equal(reversed.status, 200, reversed.text);
    assert.equal(money(await vat() - before), 38);
    await assertLedgerConsistent(h);
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


describe('SKR03 with Ist-VAT: not-yet-due VAT per rate, Skonto, Forderungsausfall and Storno', () => {
  let h: ProHarness;
  before(async () => {
    h = await startPro(null, 'pro-ist-skr03');
    const saved = await h.raw('PUT', '/accounting/policy', { reason: 'Ist-Versteuerung', activeChart: 'SKR03', vatMethod: 'ist' });
    assert.equal(saved.status, 200, saved.text);
  });
  after(async () => { await h.close(); });
  const net = async (account: string) => money((await journal(h)).reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountNumber === account).reduce((s, line) => s + line.debitAmount - line.creditAmount, 0), 0));
  /** What a step moved on the not-yet-due (1765) and the due (1776) VAT account. */
  const vatMoves = async (step: () => Promise<unknown>) => {
    const before = [await net('1765'), await net('1776')];
    await step();
    return [money(await net('1765') - before[0]!), money(await net('1776') - before[1]!)];
  };
  const pay = async (invoiceId: string, amount: number, date = today()) => {
    const response = await h.raw('POST', `/invoices/${invoiceId}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date, amount, method: 'Überweisung' } });
    assert.equal(response.status, 200, response.text);
    return response.body;
  };
  const closing = async (body: Record<string, unknown>) => {
    const response = await h.raw('POST', '/accounting/closing', { reason: 'Abschlussbuchung', ...body });
    assert.equal(response.status, 200, response.text);
    return response.body;
  };
  const breakdown = (gross: number) => [{ rate: 19, netAmount: money(gross / 1.19), taxAmount: money(gross - gross / 1.19), grossAmount: gross }];
  const skonto = (invoiceId: string, amount: number) => { const id = `skonto-${randomUUID()}`; const date = today(); return closing({ commandType: 'skonto', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { effectiveDate: date, postingDate: date, period: date.slice(0, 7), fiscalYear: Number(date.slice(0, 4)), currency: 'EUR', taxBreakdown: breakdown(GROSS), skontoAmount: amount, originalDocumentId: invoiceId } }); };
  const itemOf = async (invoiceId: string) => (await openItems(h)).find((candidate) => candidate.sourceId === invoiceId)!;

  test('19 % and 7 % VAT wait on their own not-yet-due accounts and move to 1776 / 1771 when paid', async () => {
    const invoice = await issue(h, { client: 'Ist Mischsatz', items: [
      { kind: 'item', description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 },
      { kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 },
    ] });
    const entry = (await invoiceEntry(h, invoice.id))!;
    assert.deepEqual(entry.lines.filter((line) => line.memo?.startsWith('USt ')).map((line) => [line.accountNumber, line.creditAmount]), [['1765', 19], ['1760', 3.5]]);
    assert.ok(!entry.lines.some((line) => line.accountNumber === '1780'), '1780 is the USt-Vorauszahlungen account');
    await pay(invoice.id, invoice.amount);
    const recognised = (await journal(h)).filter((candidate) => candidate.sourceType === 'payment_vat').at(-1)!;
    assert.deepEqual(shape(recognised).sort(), [['1760', 3.5, 0], ['1765', 19, 0], ['1771', 0, 3.5], ['1776', 0, 19]]);
  });

  test('a Skonto after the payment books the not-yet-due VAT, nothing stays on 1765 and 1776 carries the VAT of the money received', async () => {
    let invoice!: Awaited<ReturnType<typeof issue>>;
    const moved = await vatMoves(async () => { invoice = await issue(h, { client: 'Ist Skonto danach' }); await pay(invoice.id, 226.1); await skonto(invoice.id, 11.9); });
    assert.deepEqual(moved, [0, -36.1]);
    assert.equal((await itemOf(invoice.id)).status, 'paid');
  });

  test('a Skonto before the payment ends the same', async () => {
    assert.deepEqual(await vatMoves(async () => { const invoice = await issue(h, { client: 'Ist Skonto vorher' }); await skonto(invoice.id, 11.9); await pay(invoice.id, 226.1); }), [0, -36.1]);
  });

  test('a Forderungsausfall writes off the VAT that was never due, the paid half stays due', async () => {
    const moved = await vatMoves(async () => {
      const invoice = await issue(h, { client: 'Ist Ausfall' });
      await pay(invoice.id, 119);
      const id = `baddebt-${randomUUID()}`; const date = today();
      await closing({ commandType: 'bad_debt', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { effectiveDate: date, postingDate: date, period: date.slice(0, 7), fiscalYear: Number(date.slice(0, 4)), currency: 'EUR', taxBreakdown: breakdown(119), writeOffGrossAmount: 119, originalDocumentId: invoice.id, badDebtExpenseAccount: '2400', facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: invoice.id, originalDocumentNumber: invoice.number, originalTaxEffectiveDate: invoice.date, adjustmentDate: date, evidenceReference: 'Insolvenz 1' } } });
    });
    assert.deepEqual(moved, [0, -19]);
  });

  test('a Storno of a paid invoice keeps the VAT due until the money goes back; the refund takes it back', async () => {
    const invoice = await issue(h, { client: 'Ist Storno bezahlt' });
    await pay(invoice.id, GROSS);
    const cancelled = await vatMoves(async () => { await h.api.documents.chainIssue({ id: randomUUID(), date: today(), dueDate: today(), operation: 'correction', invoiceId: invoice.id, kind: 'cancellation_invoice', reason: 'Storno' } as never); });
    assert.deepEqual(cancelled, [38, 0], 'the reduction waits on 1765 until the refund (§17 with Ist-Versteuerung)');
    const refunded = await vatMoves(async () => { await pay(invoice.id, -GROSS); });
    assert.deepEqual(refunded, [-38, 38], 'the refund moves the reduction into the due VAT');
    await assertLedgerConsistent(h);
  });

  test('a payment within the Skonto days with the Skonto deducted settles the invoice and books the Skonto with its not-yet-due VAT', async () => {
    const plain = await draft(h, { client: 'Ist Skonto aus Zahlung' });
    let invoice!: Awaited<ReturnType<typeof issue>>;
    const moved = await vatMoves(async () => { invoice = await h.api.invoices.upsert({ reason: 'stellen', invoice: { ...plain, skonto: { percent: 2, days: 10 }, status: 'open' } as never }); await pay(invoice.id, 233.24); });
    assert.deepEqual(moved, [0, -37.24]);
    const listed = (await h.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!;
    assert.equal(listed.status, 'paid');
    assert.equal(listed.payments?.find((payment) => payment.method === 'Skonto')?.amount, 4.76);
    const skontoEntry = (await journal(h)).find((entry) => entry.sourceType === 'skonto' && entry.reference === invoice.number)!;
    assert.deepEqual(shape(skontoEntry), [['8736', 4, 0], ['1765', 0.76, 0], ['1400', 0, 4.76]]);
    const cash = listed.payments!.find((payment) => payment.method === 'Überweisung')!;
    const back = await vatMoves(async () => {
      const reversed = await h.raw('POST', `/invoices/${invoice.id}/payments/${cash.id}/reverse`, { reason: 'Rücklastschrift', expectedPayment: cash });
      assert.equal(reversed.status, 200, reversed.text);
    });
    assert.deepEqual(back, [-38, 37.24], 'no money, no Skonto: the whole VAT waits again on 1765');
    const reopened = (await h.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!;
    assert.equal(reopened.status, 'open');
    assert.ok(!reopened.payments?.some((payment) => payment.method === 'Skonto'));
    assert.deepEqual([(await itemOf(invoice.id)).allocatedAmount, (await itemOf(invoice.id)).residualAmount], [0, GROSS]);
    await assertLedgerConsistent(h);
  });
});
