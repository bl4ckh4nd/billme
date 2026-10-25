import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import { startPro, type ProHarness } from './harness.js';
import { today } from './fixtures.js';
import { bankCsv, draft, issue, journal } from './pro-fixtures.js';

const stableJson = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
};

/**
 * The Pro renderer's own client (`createProHttpBillmeApi`, the object the
 * Pro screens call) against the real embedded backend. Raw-route tests prove
 * the server; these prove that the client's request mapping and its Zod
 * contract (a response that no longer parses throws) still fit the server it
 * talks to, route by route.
 *
 * How this can fail (each one has a test below):
 * - a contract route that maps to the wrong URL, method, query or body name
 *   (reportType vs statement, invoiceId vs documentId, reason in the query)
 * - posted drafts overwritten, correction runs rejected after committing, or EÜR actors lost
 * - a Storno of a bank booking that leaves the draft "Gebucht", or a re-posting that hands back the reversed entry as booked
 * - canonical GuV amounts/range lost while projecting the IPC report
 * - a server response the client's schema no longer accepts
 * - the UStVA Kennzahlen or a tax preparation that do not parse through the client
 * - a mutation sent without the reason / allocation event id / reservation id
 *   the server requires, instead of being refused before the request leaves
 * - an error body the client swallows instead of showing its message
 * - a client path that skips the receipt check of a DATEV export
 * - the Prüferpaket in the browser (a client with `downloadBlob`) answering "nicht verfügbar"
 *   or downloading files whose bytes differ from the manifest hashes
 */
describe('pro renderer client against the embedded backend', () => {
  let h: ProHarness;
  const api = () => h.api;
  const ids = { vendor: `v-${randomUUID().slice(0, 6)}`, incoming: `in-${randomUUID().slice(0, 6)}`, bank: 'bank-client' };
  before(async () => { h = await startPro(null, 'pro-client'); });
  after(async () => { await h.close(); });

  test('catalog and configuration reads parse: ledger, tax cases, policy, mappings, SKR import', async () => {
    const stats = await api().pro.getLedgerStats();
    assert.ok(stats.byChart.SKR03 > 1000 && stats.byChart.SKR04 > 1000);
    const accounts = await api().pro.listLedgerAccounts({ chart: 'SKR03', search: '1400', limit: 10 });
    assert.ok(accounts.some((account) => account.accountNumber === '1400'));
    const cases = await api().pro.listTaxCases({});
    assert.ok(cases.some((taxCase) => taxCase.key === 'DE_STD_19' && taxCase.mechanism === 'standard_vat'));
    assert.ok((await api().pro.listTaxCases({ activeOnly: true })).every((taxCase) => taxCase.active));
    const saved = await api().pro.upsertTaxCaseAccountMapping({ chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'output_tax', accountNumber: '1771', reason: 'USt 7 %' });
    assert.deepEqual([saved.taxCaseKey, saved.accountNumber], ['DE_STD_7', '1771']);
    assert.ok((await api().pro.listTaxCaseAccountMappings({ chart: 'SKR03', taxCaseKey: 'DE_STD_7' })).some((mapping) => mapping.id === saved.id));
    assert.equal((await api().pro.getAccountingPolicy()).activeChart, 'SKR03');
    const policy = await api().pro.setAccountingPolicy({ activeChart: 'SKR03', vatMethod: 'soll' });
    assert.deepEqual([policy.activeChart, policy.vatMethod], ['SKR03', 'soll']);
    const mapping = await api().pro.upsertAccountingAccountMapping({ chart: 'SKR03', role: 'revenue', accountNumber: '8400' });
    assert.ok((await api().pro.listAccountingAccountMappings({ chart: 'SKR03' })).some((row) => row.id === mapping.id));
    const imported = await api().pro.importSkr({});
    assert.equal(imported.source, 'none', 'the chart is migration-owned, the import is an honest no-op');
    assert.equal(imported.total, stats.total);
    assert.equal((await api().pro.getOpenRouterVlmConfig()).configured, false);
    assert.equal((await api().pro.getAccountingHealth()).draftCount >= 0, true);
  });

  test('the invoice lifecycle through the client: issue, preview, post replay, vendors and incoming invoices, open items, payments, reversal', async () => {
    const invoice = await issue(h, { client: 'Client GmbH' });
    const preview = await api().pro.previewOutgoingInvoiceAccounting({ invoiceId: invoice.id });
    assert.equal(preview.status, 'ready');
    assert.deepEqual(preview.snapshot?.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['1400', 238, 0], ['8400', 0, 200], ['1776', 0, 38]]);
    const reservation = await api().numbers.reserve({ kind: 'invoice' });
    await api().numbers.release({ reservationId: reservation.reservationId });
    const entries = (await journal(h)).length;
    const replay = await api().pro.postOutgoingInvoiceAccounting({ invoiceId: invoice.id, reservationId: reservation.reservationId });
    assert.equal(replay.status, 'ready', 'an issued invoice is already posted: posting it again is a replay');
    assert.equal((await journal(h)).length, entries, 'and books nothing');

    const vendor = await api().pro.upsertVendor({ reason: 'Lieferant', vendor: { id: ids.vendor, tenantId: 'x', name: 'Client Lieferant', createdAt: '', updatedAt: '' } as never });
    assert.equal(vendor.id, ids.vendor);
    assert.ok((await api().pro.listVendors()).some((candidate) => candidate.id === ids.vendor));
    const unposted = await h.api.invoices.upsert({ reason: 'Entwurf', invoice: { ...(await (await import('./fixtures.js')).draftInvoice(h.api as never, { client: 'Client Entwurf' })) } as never });
    await assert.rejects(api().pro.postOutgoingInvoiceAccounting({ invoiceId: unposted.id, reservationId: 'not-a-finalized-reservation' }), /FINALIZED_RESERVATION_REQUIRED/, 'a draft cannot be posted with a made-up reservation');
    const incoming = await api().pro.upsertIncomingInvoice({ reason: 'Eingang', invoice: { id: ids.incoming, tenantId: 'x', vendorId: ids.vendor, number: 'ER-C1', invoiceDate: '2026-03-02', dueDate: '2026-03-30', netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, accountingStatus: 'unposted', createdAt: '', updatedAt: '', lines: [{ id: `l-${ids.incoming}`, incomingInvoiceId: ids.incoming, position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] } });
    assert.equal(incoming.accountingStatus, 'unposted');
    const incomingPreview = await api().pro.previewIncomingInvoiceAccounting({ invoiceId: ids.incoming });
    assert.deepEqual(incomingPreview.snapshot?.lines.map((line) => line.accountNumber), ['4900', '1576', '1600']);
    const postedIncoming = await api().pro.postIncomingInvoiceAccounting({ invoiceId: ids.incoming, reason: 'Eingang gebucht' });
    assert.equal(postedIncoming.status, 'ready');
    assert.equal((await api().pro.listIncomingInvoices()).find((candidate) => candidate.id === ids.incoming)!.accountingStatus, 'posted');

    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(randomUUID())]);
    const doc = await api().pro.uploadIncomingInvoiceDocument({ invoiceId: ids.incoming, originalFilename: 'client.pdf', mimeType: 'application/pdf', data: pdf.toString('base64'), reason: 'Beleg' });
    assert.equal(doc.reviewStatus, 'pending');
    assert.equal((await api().pro.listIncomingInvoiceDocuments({ invoiceId: ids.incoming })).length, 1);
    assert.ok((await api().pro.listIncomingInvoiceDocuments({})).some((candidate) => candidate.id === doc.id));
    assert.equal((await api().pro.reviewIncomingInvoiceDocument({ documentId: doc.id, reviewStatus: 'accepted', reason: 'geprüft' })).reviewStatus, 'accepted');
    const download = await api().pro.downloadIncomingInvoiceDocument({ documentId: doc.id });
    assert.ok(Buffer.from(download.data, 'base64').equals(pdf));

    const items = await api().pro.listOpenItems();
    const debtor = items.find((item) => item.sourceId === invoice.id)!;
    const eventId = `event-${randomUUID()}`;
    const payment = { sourceType: 'manual' as const, sourceId: `pay-${randomUUID()}`, partyType: 'debtor' as const, paymentDate: today(), amount: 300, bankAccountNumber: '1200', allocations: [{ openItemId: debtor.id, amount: 100 }], reason: 'Zahlungseingang', allocationEventId: eventId };
    const first = await api().pro.allocateOpenItemPayment({ payment });
    assert.deepEqual([first.allocatedAmount, first.residualAmount, first.status], [100, 200, 'partially_allocated']);
    assert.equal((await api().pro.allocateOpenItemPayment({ payment })).id, first.id, 'the stable event id makes the retry a replay');
    const rest = await api().pro.allocateRemainingPayment({ paymentId: first.id, allocations: [{ openItemId: debtor.id, amount: 138 }], reason: 'Rest', allocationEventId: `event-${randomUUID()}` });
    assert.deepEqual([rest.allocatedAmount, rest.residualAmount], [238, 62]);
    assert.equal((await api().pro.listOpenItems()).find((item) => item.id === debtor.id)!.status, 'paid');

    const second = await issue(h, { client: 'Client Storno' });
    const reversal = await api().pro.reverseDocumentAccounting({ documentType: 'outgoing_invoice', documentId: second.id, reason: 'Falsch gebucht' });
    assert.equal(reversal.ok, true);
    assert.equal((await api().pro.getJournalEntryById({ entryId: reversal.reversalEntryId }))!.status, 'posted');
  });

  test('the bank workbench through the client: import, transactions, drafts, workflow, posting, reversal, rules', async () => {
    await api().accounts.upsert({ account: { id: ids.bank, name: 'Client Konto', iban: 'DE02120300000000202051', balance: 0, transactions: [], type: 'bank', color: '#000000', defaultSkrAccountNumber: '1200' } });
    // Not the 119 of the open ER-C1 from the same vendor: that line would settle the open item (1600), this one is booked by the rule.
    const csv = bankCsv([{ date: '2026-03-02', amount: -59.5, counterparty: 'Client Lieferant', purpose: 'Rechnung Server' }]);
    const preview = await api().finance.importPreview({ fileName: `client-${randomUUID().slice(0, 6)}.csv`, contentBase64: Buffer.from(csv).toString('base64'), profile: 'generic' });
    assert.equal(preview.stats.validRows, 1);
    const commit = await api().finance.importCommit({ path: preview.path, accountId: ids.bank, profile: 'generic', mapping: preview.suggestedMapping });
    assert.equal(commit.imported, 1);
    const rule = await api().pro.upsertAccountSuggestionRule({ chart: 'SKR03', priority: 1, field: 'counterparty', operator: 'contains', value: 'client lieferant', targetAccountNumber: '4930', flowType: 'expense', reason: 'Regel' });
    assert.ok((await api().pro.listAccountSuggestionRules({ chart: 'SKR03' })).some((candidate) => candidate.id === rule.id));
    const tx = (await api().pro.listBankTransactions()).find((candidate) => candidate.counterparty === 'Client Lieferant')!;
    assert.deepEqual([tx.suggestionLayer, tx.suggestedAccountNumber], ['rule', '4930']);
    const draft = (await api().pro.getDraftByTransactionId({ transactionId: tx.id }))!;
    assert.equal(draft.lines[0]!.accountNumber, '4930');
    const saved = await api().pro.saveDraft({ draft: { ...draft, workflowStatus: 'suggested' } });
    assert.deepEqual(saved.validationIssues, []);
    assert.equal((await api().pro.dispatchDraftAction({ transactionId: tx.id, action: 'submit_for_review' })).workflowStatus, 'pending_approval');
    assert.equal((await api().pro.dispatchDraftAction({ transactionId: tx.id, action: 'approve' })).workflowStatus, 'approved');
    const posted = await api().pro.postDraft({ draftId: draft.id, postingDate: '2026-03-02' });
    assert.deepEqual(posted.issues, []);
    assert.ok(posted.entry.id);
    const postedDraft = (await api().pro.getDraftByTransactionId({ transactionId: tx.id }))!;
    await assert.rejects(api().pro.saveDraft({ draft: { ...postedDraft, workflowStatus: 'incomplete', bookingText: 'überschrieben', lines: [] } }), /POSTED_DRAFT_IMMUTABLE/);
    assert.deepEqual(await api().pro.getDraftByTransactionId({ transactionId: tx.id }), postedDraft, 'a rejected overwrite preserves the posted draft');
    assert.equal((await api().pro.getJournalEntryById({ entryId: posted.entry.id }))!.sourceType, 'booking_draft');
    assert.ok((await api().pro.listJournalEntries({ accountNumbers: ['4930'], limit: 5 })).some((entry) => entry.id === posted.entry.id));
    assert.ok((await api().pro.getLedgerBalances({ asOfDate: '2026-12-31' })).some((row) => row.accountNumber === '4930'));
    const reversed = await api().pro.reverseJournalEntry({ entryId: posted.entry.id, reason: 'Falsch kontiert', postingDate: '2026-03-31' });
    assert.equal(reversed.ok, true);
    // A Storno from the journal (not only from the draft) marks the bank booking reversed in the workspace.
    const afterStorno = (await api().pro.getDraftByTransactionId({ transactionId: tx.id }))!;
    assert.equal(afterStorno.workflowStatus, 'reversed', 'the draft follows the reversed journal entry');
    assert.equal((await api().pro.getJournalEntryById({ entryId: posted.entry.id }))!.status, 'reversed');
    await assert.rejects(api().pro.reverseJournalEntry({ entryId: posted.entry.id, reason: 'zweimal' }), 'a reversed entry is not reversed twice');
    // After the Storno the line is kontiert and booked again: a new entry; the reversed original and its Storno stay.
    await api().pro.dispatchDraftAction({ transactionId: tx.id, action: 'create_correction' });
    const corrected = (await api().pro.getDraftByTransactionId({ transactionId: tx.id }))!;
    await api().pro.saveDraft({ draft: { ...corrected, workflowStatus: 'suggested' } });
    await api().pro.dispatchDraftAction({ transactionId: tx.id, action: 'submit_for_review' });
    await api().pro.dispatchDraftAction({ transactionId: tx.id, action: 'approve' });
    const rebooked = await api().pro.postDraft({ draftId: draft.id, postingDate: '2026-03-31' });
    assert.ok(rebooked.entry.id && rebooked.entry.id !== posted.entry.id, 'a new posting, not the reversed one handed back');
    assert.equal((await api().pro.getJournalEntryById({ entryId: posted.entry.id }))!.status, 'reversed', 'the original stays reversed');
    await assert.rejects(api().pro.postDraft({ draftId: draft.id, postingDate: '2026-03-31', idempotencyKey: 'other' } as never), /PAYMENT_SOURCE_ALREADY_BOOKED|bereits gebucht|schon gebucht/i, 'the line is booked once at a time');
    // Leave the ledger as the following cases expect it: the second round is reversed as well.
    assert.equal((await api().pro.reverseJournalEntry({ entryId: rebooked.entry.id, reason: 'Testlauf zurück', postingDate: '2026-03-31' })).ok, true);
    await api().pro.deleteAccountSuggestionRule({ id: rule.id });
    assert.ok(!(await api().pro.listAccountSuggestionRules({})).some((candidate) => candidate.id === rule.id));
    const checked = await api().pro.validateTaxCompliance({ transactionId: tx.id });
    assert.equal(typeof checked.ok, 'boolean');
    const vat = await api().pro.getVatSummary({});
    assert.ok(vat.rows.length > 0);
    assert.ok(vat.kennzahlen!.rows.some((row) => row.kennziffer === '83'), 'the UStVA Kennzahlen parse through the client');
    const month = today().slice(0, 7);
    const prepared = await api().pro.prepareTaxExport({ kind: 'ustva', period: month, idempotencyKey: `client-${randomUUID()}`, reason: 'UStVA über den Client' });
    assert.deepEqual([prepared.artifact.kind, prepared.artifact.submissionReady], ['ustva', false]);
    assert.equal((await api().pro.getTaxExportArtifact({ kind: 'ustva', id: prepared.run.id })).sourceHash, prepared.artifact.sourceHash);
    await assert.rejects(api().pro.prepareTaxExport({ kind: 'ustva', period: month, idempotencyKey: 'x', reason: ' ' } as never), 'a blank reason is refused before the request');
    assert.deepEqual(await api().pro.listWorkflowEntries(), []);
    const matches = await api().transactions.list({});
    assert.ok(matches.some((candidate) => candidate.counterparty === 'Client Lieferant'));
  });

  test('reports through the client: SuSa, GuV, Bilanz, reporting kinds, mapping health, overrides and snapshots', async () => {
    const settings = await api().settings.get();
    await api().settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } } as never);
    const susa = await api().pro.getSusaReport({ from: '2026-01-01', to: '2026-12-31' });
    assert.equal(susa.totals.balance, 0);
    assert.equal(susa.totals.debit, susa.totals.credit);
    // HGB GuV accounts fall to their SKR03 range default; the management GuV still needs its own mapping.
    assert.deepEqual((await api().pro.getReportMappingHealth({ statement: 'hgb-guv', asOfDate: '2026-12-31' })).unmapped, []);
    const unmapped = await api().pro.getReportMappingHealth({ statement: 'management-guv', asOfDate: '2026-12-31' });
    assert.ok(unmapped.unmapped.length > 0 && unmapped.unmapped.every((row) => row.statement === 'management-guv'), JSON.stringify(unmapped));
    const positions = await api().pro.listReportMappingPositions({ statement: 'hgb-guv', asOfDate: '2026-12-31' });
    assert.ok(positions.some((position) => position.key === 'revenue'));
    for (const account of ['8400', '4900', '4930']) {
      await api().pro.upsertReportMappingOverride({ chart: 'SKR03', asOfDate: '2025-01-01', accountNumber: account, statement: 'hgb-guv', position: account === '8400' ? 'revenue' : 'other-operating-expense', label: account, reason: 'Zuordnung' });
      await api().pro.upsertReportMappingOverride({ chart: 'SKR03', asOfDate: '2025-01-01', accountNumber: account, statement: 'management-guv', position: account === '8400' ? 'revenue' : 'fixed-costs', label: account, reason: 'Zuordnung' });
    }
    for (const [account, position, side] of [['1200', 'assets.current.cash', 'asset'], ['1400', 'assets.current.receivables', 'asset'], ['1576', 'assets.current.receivables', 'asset'], ['1600', 'liabilities', 'liability'], ['1776', 'liabilities', 'liability']] as const) {
      await api().pro.upsertReportMappingOverride({ chart: 'SKR03', asOfDate: '2025-01-01', accountNumber: account, statement: 'hgb-bilanz', position, label: account, side, reason: 'Zuordnung' });
    }
    assert.equal((await api().pro.getReportMappingHealth({ statement: 'hgb-guv', asOfDate: '2026-12-31' })).unmapped.length, 0);
    assert.equal((await api().pro.getReportMappingHealth({ statement: 'management-guv', asOfDate: '2026-12-31' })).unmapped.length, 0);
    const bilanz = await api().pro.getBilanzReport({ asOfDate: '2026-12-31' });
    assert.equal(bilanz.totals.delta, 0);
    for (const kind of ['management-guv', 'hgb-guv', 'hgb-bilanz'] as const) {
      const report = await api().pro.getReportingReport({ kind, from: '2026-01-01', to: '2026-12-31', asOfDate: '2026-12-31' });
      assert.equal(report.kind, kind);
    }
    const snapshot = await api().pro.saveReportSnapshot({ reportType: 'management-guv', args: { from: '2026-01-01', to: '2026-12-31' }, payload: {}, reason: 'Quartalsbericht' } as never);
    assert.equal(snapshot.reportType, 'management-guv');
    assert.ok((await api().pro.listReportSnapshots({ reportType: 'management-guv' })).some((candidate) => candidate.id === snapshot.id));
    await api().settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll' } } } as never);
  });

  test('the client reads the management GuV (dashboard result and GuV screen) from the server', async () => {
    const guv = await api().pro.getGuvReport({ from: '2026-01-01', to: '2026-12-31' });
    assert.ok(guv.rows.some((row) => row.positionKey === 'revenue'));
    const canonical = await api().pro.getReportingReport({ kind: 'management-guv', from: '2026-01-01', to: '2026-12-31' });
    assert.equal(guv.netResult, canonical.kind === 'management-guv' ? canonical.netResult : NaN);
    assert.equal(guv.from, '2026-01-01');
    assert.equal(guv.to, '2026-12-31');
    assert.equal(guv.netResult, 100, 'issued revenue less the incoming invoice expense');
    const month = await api().pro.getGuvReport({ from: '2026-03-01', to: '2026-03-31' });
    assert.equal(month.netResult, -100, 'only the March expense remains after reversing the manual draft');
    assert.equal(month.blocking, false);
  });

  test('assets, DATEV and accounting sources through the client', async () => {
    const asset = await api().pro.upsertAsset({ reason: 'Anlage', asset: { assetNumber: 'A-CLIENT', name: 'Notebook', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-05-01', acquisitionCost: 1200, usefulLifeYears: 3, depreciationMethod: 'linear', costCenter: 'IT', location: 'Berlin', receiptLinked: true, assetAccountNumber: '0440' } });
    assert.equal(asset.annualDepreciation, 400);
    assert.equal((await api().pro.listAssets()).filter((candidate) => candidate.id === asset.id).length, 1);
    assert.equal((await api().pro.getDepreciationSchedule({ assetId: asset.id })).length, 4);
    const run = await api().pro.runDepreciation({ assetId: asset.id, year: 2026, postingDate: '2026-12-31', reason: 'AfA' });
    assert.equal(run.scheduleEntry.amount, 266.67);
    const sold = await api().pro.disposeAsset({ assetId: asset.id, disposalDate: '2026-12-31', proceeds: 100, taxRate: 0, proceedsAccountNumber: '1200', reason: 'Verkauf' });
    assert.deepEqual([sold.residualBookValue, sold.asset.status], [933.33, 'verkauft']);
    // A sale with its outgoing invoice: the client must send saleInvoiceId, or the disposal books the proceeds a second time.
    const forSale = await api().pro.upsertAsset({ reason: 'Anlage', asset: { assetNumber: 'A-CLIENT-SALE', name: 'Drucker', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-01-01', acquisitionCost: 1200, usefulLifeYears: 1, depreciationMethod: 'linear', costCenter: '', location: '', receiptLinked: true, assetAccountNumber: '0440' } });
    const saleInvoice = await draft(h, { client: 'Käufer GmbH', date: '2026-01-31', items: [{ kind: 'item', description: 'Verkauf Anlage A-CLIENT-SALE Drucker', quantity: 1, price: 1500, total: 1500, taxRate: 19 }], taxMeta: { assetSaleAssetId: forSale.id } as never });
    const viaInvoice = await api().pro.disposeAsset({ assetId: forSale.id, disposalDate: '2026-01-31', proceeds: 1500, saleInvoiceId: saleInvoice.id, reason: 'Verkauf an Kunden' });
    const saleEntry = (await journal(h)).find((entry) => entry.id === viaInvoice.journalEntryId)!;
    assert.deepEqual(saleEntry.lines.map((line) => line.accountNumber).sort(), ['0440', '2315'], 'only the book value: no bank or VAT line');

    const receipt = await api().pro.exportDatevBuchungsstapel({ from: '2026-03-01', to: '2026-03-31', consultantNumber: '1234567', clientNumber: '12345', fiscalYearStart: '2026-01-01', accountLength: 4 });
    assert.ok(receipt.recordCount > 0);
    assert.ok((await api().pro.listDatevExports({ limit: 10 })).some((entry) => entry.id === receipt.id));
    const opening = await api().pro.exportDatevBuchungsstapel({ from: '2026-03-01', to: '2026-03-31', consultantNumber: '1234567', clientNumber: '12345', fiscalYearStart: '2026-01-01', accountLength: 4, kind: 'opening_balances' });
    assert.deepEqual([opening.recordCount, opening.id === receipt.id], [0, false], 'the EB stack is its own export: March carries no balances forward');
    await assert.rejects(api().pro.exportDatevBuchungsstapel({ from: '2026-03-01', to: '2026-04-30', consultantNumber: '1234567', clientNumber: '12345', fiscalYearStart: '2026-01-01', accountLength: 4 }), /Periode/, 'the server message reaches the caller');
    await assert.rejects(api().pro.exportDatevBuchungsstapel({ from: '2026-03-01', to: '2026-03-31' } as never), /Beraternummer/, 'an incomplete export is refused before the request');

    const sourceId = `client-fact-${randomUUID()}`;
    const fact = { sourceType: 'standalone_source' as const, sourceId, sourceRevision: 'v1', effectiveDate: '2026-03-31', postingDate: '2026-03-31', period: '2026-03', fiscalYear: 2026, currency: 'EUR', bookingText: 'Client Sonderbuchung', lines: [{ accountNumber: '4930', debitAmount: 15, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 15 }] };
    const postedSource = await api().pro.postAccountingSource({ source: fact, reason: 'Sonderbuchung' });
    assert.equal(postedSource.status, 'posted');
    assert.equal((await api().pro.postAccountingSource({ source: fact, reason: 'Sonderbuchung' })).status, 'duplicate', 'the same fact is a replay');
    const runs = await api().pro.listAccountingSourceRuns();
    const stored = runs.find((candidate) => candidate.sourceId === sourceId)!;
    assert.equal(stored.status, 'posted');
    assert.equal((await api().pro.getAccountingSourceRun({ id: stored.id }))!.id, stored.id);
    await assert.rejects(api().pro.postAccountingSource({ source: { ...fact, lines: [{ accountNumber: '4930', debitAmount: 15, creditAmount: 0 }] }, reason: 'unausgeglichen' }), /Debit and credit must match/, 'an unbalanced fact never leaves the client');
    await assert.rejects(api().pro.postAccountingCommand({ kind: 'skonto', source: { ...fact, lines: [] }, reason: 'ohne Fakten' }), /Domain facts/, 'a workflow without facts never leaves the client');
  });

  test('a committed correction returns and lists its typed source run, including a replay', async () => {
    const original = (await api().pro.listIncomingInvoices()).find((invoice) => invoice.id === ids.incoming)!;
    const snapshot = original.accountingSnapshot!;
    const sourceId = `client-correction-${randomUUID()}`;
    const command = {
      kind: 'correction' as const,
      source: { sourceType: 'standalone_source' as const, sourceId, sourceRevision: 'v1', effectiveDate: '2026-03-31', postingDate: '2026-03-31', period: '2026-03', fiscalYear: 2026, currency: 'EUR', bookingText: 'Teilkorrektur', lines: [{ accountNumber: '4900', debitAmount: 10, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 10 }] },
      domainFacts: { id: sourceId, idempotencyKey: sourceId, correctionDate: '2026-03-31', documentType: 'incoming_invoice', original: { documentId: original.id, documentNumber: original.number, revision: snapshot.sourceVersion, snapshotHash: createHash('sha256').update(stableJson(snapshot)).digest('hex'), taxEffectiveDate: original.invoiceDate, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, deltas: [{ rate: 19, grossAmount: 11.9 }] },
      chart: 'SKR03' as const, reason: 'Teilkorrektur',
    };
    const posted = await api().pro.postAccountingCommand(command);
    assert.equal(posted.status, 'posted');
    assert.equal(posted.sourceRun!.sourceType, 'correction');
    assert.equal((await api().pro.listAccountingSourceRuns()).find((run) => run.id === posted.sourceRun!.id)!.sourceType, 'correction');
    assert.equal((await api().pro.postAccountingCommand(command)).status, 'duplicate');
  });

  test('the client refuses mutations the server would reject, and shows the server message for the ones it sends', async () => {
    await assert.rejects(api().pro.allocateOpenItemPayment({ payment: { sourceType: 'manual', sourceId: 's', partyType: 'debtor', paymentDate: today(), amount: 5, bankAccountNumber: '1200', allocations: [], reason: 'x', allocationEventId: '   ' } }), /allocationEventId|Zuordnungs-ID|String must contain/);
    await assert.rejects(api().pro.allocateRemainingPayment({ paymentId: 'p', allocations: [], reason: 'x', allocationEventId: '' }));
    await assert.rejects(api().pro.postOutgoingInvoiceAccounting({ invoiceId: 'x', reservationId: '' }));
    await assert.rejects(api().pro.postDraft({ draftId: 'no-such-draft' }), /Draft not found/);
    await assert.rejects(api().pro.runDepreciation({ assetId: 'no-asset', year: 2026, postingDate: '2026-12-31', reason: 'x' }), /not found|NOT_FOUND/i);
    await assert.rejects(api().pro.upsertReportMappingOverride({ chart: 'SKR04', asOfDate: '2025-01-01', accountNumber: '8400', statement: 'hgb-guv', position: 'revenue', label: 'x', reason: 'x' }), /REPORT_CHART_MISMATCH/);
    assert.ok((await journal(h)).length > 0);
  });

  test('the EÜR and audit-export routes of the Pro client parse', async () => {
    const items = await api().eur.listItems({ taxYear: 2026 });
    assert.ok(Array.isArray(items));
    assert.deepEqual(await api().eur.listCashFacts({ taxYear: 2026 }), []);
    assert.deepEqual(await api().eur.listAnnexFacts({ taxYear: 2026 }), []);
    const source = items.find((item) => item.sourceType === 'transaction')!;
    assert.ok(source, 'the imported bank transaction is an EÜR cash source');
    const cash = await api().eur.saveCashFact({ sourceType: source.sourceType, sourceId: source.sourceId, taxYear: 2026, kind: 'private-withdrawal', amountNet: 25, reason: 'Privatanteil', idempotencyKey: 'client-cash' });
    assert.ok(cash.actorId);
    assert.deepEqual((await api().eur.listCashFacts({ taxYear: 2026 })).find((fact) => fact.id === cash.id), cash);
    const annex = await api().eur.saveAnnexFact({ taxYear: 2026, annex: 'SZ', lineId: 'SZ_2026_L05', amount: 250, reason: 'Schuldzinsen', idempotencyKey: 'client-annex' });
    assert.ok(annex.actorId);
    assert.deepEqual((await api().eur.listAnnexFacts({ taxYear: 2026, annex: 'SZ' })).find((fact) => fact.id === annex.id), annex);
    if (items.length > 0) {
      const classification = await api().eur.upsertClassification({ sourceType: items[0]!.sourceType, sourceId: items[0]!.sourceId, taxYear: 2026, excluded: true, reason: 'privat' });
      assert.equal(classification.excluded, true);
    }
    const backfill = await api().pro.previewAccountingBackfill();
    assert.equal(backfill.status, 'preview');
    const done = await api().pro.confirmAccountingBackfill({ runId: backfill.runId, confirmationHash: backfill.confirmationHash, reason: 'bestätigt' });
    assert.equal(done.status, 'completed');
    const pkg = await api().tax.auditExportPackage({ from: '2026-01-01', to: '2026-12-31' });
    assert.ok(pkg);
  });

  test('in the browser the Prüferpaket arrives as downloads whose bytes match the manifest', async () => {
    const downloads: Array<{ name: string; bytes: Buffer }> = [];
    const pending: Promise<void>[] = [];
    const browserApi = createProHttpBillmeApi({
      baseUrl: h.connection.baseUrl,
      embeddedConnectionResolver: async () => h.connection,
      downloadBlob: (blob, name) => { pending.push(blob.arrayBuffer().then((buffer) => { downloads.push({ name, bytes: Buffer.from(buffer) }); })); },
    });
    const pkg = await browserApi.tax.auditExportPackage({ from: '2026-01-01', to: '2026-12-31', includeDocuments: true });
    await Promise.all(pending);
    assert.equal(pkg.bundleDir, 'Downloads');
    assert.ok(pkg.fileCount > 1);
    assert.equal(downloads.length, pkg.fileCount + 1, 'every file plus the manifest');
    const manifest = downloads.find((file) => file.name === pkg.manifestPath);
    assert.equal(pkg.manifestPath, 'Prüferpaket_2026-01-01_2026-12-31_manifest.json');
    assert.deepEqual(JSON.parse(manifest!.bytes.toString('utf8')).files, pkg.files);
    for (const file of pkg.files) {
      const download = downloads.find((entry) => entry.name === file.path);
      assert.ok(download, `${file.name} downloaded`);
      assert.equal(createHash('sha256').update(download.bytes).digest('hex'), file.sha256, `${file.name} bytes match the manifest`);
    }
  });

  test('after the whole walk the ledger balances and the audit chain verifies', async () => {
    for (const entry of await journal(h)) assert.equal(entry.lines.reduce((sum, line) => sum + Math.round(line.debitAmount * 100) - Math.round(line.creditAmount * 100), 0), 0, `entry ${entry.entryNumber}`);
    assert.equal((await api().audit.verify()).ok, true);
  });
});
