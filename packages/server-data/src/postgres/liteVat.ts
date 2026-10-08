import { createHash } from 'node:crypto';
import { invoiceSchema, liteReceiptSchema, liteVatPeriodSchema, liteVatReportSchema, serviceDateOf, type Invoice, type LiteReceipt, type LiteVatReport, type TenantScope } from '@billme/server-core';
import { createPostgresInvoiceRepository } from './billing.js';
import { listLiteCashEntries, listLiteReceipts } from './liteCash.js';
import { runInTransaction, type PostgresQueryable } from './connection.js';

const cents = (amount: number) => Math.round(amount * 100);
const clamp = (amount: number, max: number) => Math.max(0, Math.min(max, amount));
const calendarDate = (value?: string): string | undefined => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : undefined;
const cappedInvoiceDate = (issued: string, performance: string) => {
  const nextMonth = new Date(`${performance}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 2, 0);
  return maxDate(performance, issued < nextMonth.toISOString().slice(0, 10) ? issued : nextMonth.toISOString().slice(0, 10));
};
const taxCodes: Record<string, string> = { '46': '47', '84': '85' };
const maxDate = (a: string, b: string) => a > b ? a : b;
type Part = { rate: number; net: number; vat: number };
type Cash = { id: string; date: string; amount: number };
const labels: Record<string, string> = { '81': 'Umsätze 19 %', '86': 'Umsätze 7 %', '87': 'Umsätze 0 %', '41': 'Innergemeinschaftliche Lieferungen', '43': 'Ausfuhr und weitere steuerfreie Umsätze mit Vorsteuerabzug', '48': 'Steuerfreie Umsätze ohne Vorsteuerabzug', '60': 'Umsätze mit Steuerschuld des Leistungsempfängers', '21': 'Nicht steuerbare EU-Dienstleistungen', '45': 'Übrige nicht steuerbare Umsätze', '89': 'Innergemeinschaftlicher Erwerb 19 %', '93': 'Innergemeinschaftlicher Erwerb 7 %', '90': 'Innergemeinschaftlicher Erwerb 0 %', '46': 'EU-Dienstleistung: eigene Steuerschuld (§ 13b)', '84': 'Andere Leistungen: eigene Steuerschuld (§ 13b)', '66': 'Vorsteuer aus inländischen Rechnungen', '61': 'Vorsteuer aus innergemeinschaftlichem Erwerb', '62': 'Einfuhrumsatzsteuer', '67': 'Vorsteuer aus § 13b' };
const outgoingCodes = { reverse_charge_13b: '60', intra_eu_supply_6a: '41', intra_eu_service_reverse_charge: '21', export_third_country: '43', vat_exempt_4_ustg: '48', non_taxable_outside_scope: '45' } as const;

export const getServerLiteVatReport = (database: PostgresQueryable, scope: TenantScope, period: { from: string; to: string }): Promise<LiteVatReport> => runInTransaction(database, async (db) => {
  const { from, to } = liteVatPeriodSchema.parse(period);
  const settingsRow = (await db.query<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id=$1', [scope.tenantId])).rows[0];
  if (!settingsRow) throw new Error('LITE_VAT_SETTINGS_REQUIRED');
  const settings = JSON.parse(settingsRow.settings_json);
  const current = settings.legal?.taxAccountingMethod ?? settings.businessReportingProfile?.vatMethod ?? 'soll';
  // ponytail: only the last change is remembered; a period before an earlier change uses the method in between.
  const since: string | undefined = settings.legal?.taxAccountingMethodSince;
  const method = since && from < since ? settings.legal?.previousTaxAccountingMethod ?? current : current;
  const smallBusiness = settings.legal?.smallBusinessRule === true;
  const invoices = await createPostgresInvoiceRepository(db).list(scope);
  const entries = await listLiteCashEntries(db, scope);
  const receipts = await listLiteReceipts(db, scope);
  const report: LiteVatReport = { from, to, method, smallBusiness, generatedAt: new Date().toISOString(), sourceHash: '', preparationComplete: false, submissionReady: false, positions: [], sources: [], issues: [], outputVatCents: 0, inputVatCents: 0, payableCents: 0, reconciliation: { paymentCashCents: 0, paymentRecognizedCents: 0, paymentResidualCents: 0 } };
  const inPeriod = (date: string) => date >= from && date <= to;
  const NEVER = '9999-12-31';
  const advanceIds = new Set(invoices.filter((invoice) => invoice.documentKind === 'advance_invoice').map((invoice) => invoice.id));
  /** The service date of the issued final invoice that settles an advance's order, if any. */
  const finalServiceDate = (advance: Invoice): string | undefined => {
    const final = invoices.find((invoice) => invoice.documentKind === 'final_invoice' && invoice.sourceDocumentId === advance.sourceDocumentId && !['draft', 'cancelled'].includes(invoice.status));
    return final ? calendarDate(serviceDateOf(final.servicePeriod)) ?? final.date : undefined;
  };
  const issue = (code: string, message: string, sourceId?: string) => {
    if (!report.issues.some((item) => item.code === code && item.sourceId === sourceId)) report.issues.push({ code, message, sourceId });
  };
  const add = (type: 'invoice' | 'receipt', id: string, label: string, date: string, code: string, direction: 'output' | 'input' | 'information', part: Part) => {
    if (!inPeriod(date) || (!part.net && !part.vat)) return;
    report.sources.push({ sourceType: type, sourceId: id, label, date, code, taxCode: taxCodes[code], direction, rate: part.rate, basisCents: part.net, taxCents: part.vat });
  };
  const scaled = (parts: Part[], gross: number, amount: number): Part[] => {
    let assignedGross = 0;
    return parts.map((part, index) => {
      const allocated = index === parts.length - 1 ? amount - assignedGross : Math.round(amount * (part.net + part.vat) / gross);
      assignedGross += allocated;
      const vat = Math.round(amount * part.vat / gross);
      return { rate: part.rate, net: allocated - vat, vat };
    });
  };
  const delta = (parts: Part[], gross: number, before: number, after: number) => {
    const old = scaled(parts, gross, before); const next = scaled(parts, gross, after);
    return next.map((part, index) => ({ rate: part.rate, net: part.net - old[index].net, vat: part.vat - old[index].vat }));
  };
  const recognizeOutgoing = (invoice: Invoice, type: 'invoice' | 'receipt' = 'invoice') => {
    if (invoice.status === 'draft' || ['order_confirmation', 'delivery_note'].includes(invoice.documentKind ?? 'invoice')) return;
    const snapshot = invoice.taxSnapshot;
    const relevant = inPeriod(invoice.date) || (invoice.payments ?? []).some((payment) => inPeriod(payment.date)) || (calendarDate(serviceDateOf(invoice.servicePeriod)) && inPeriod(serviceDateOf(invoice.servicePeriod)!));
    if (!snapshot || !Number.isFinite(snapshot.grossAmount) || snapshot.grossAmount === 0) { if (relevant) issue('TAX_SNAPSHOT_REQUIRED', 'Steueraufteilung des gestellten Belegs fehlt.', invoice.id); return; }
    const parts: Part[] = (snapshot.vatBreakdown?.length ? snapshot.vatBreakdown : [{ rate: snapshot.vatRateApplied, netAmount: snapshot.netAmount, vatAmount: snapshot.vatAmount }]).map((part) => ({ rate: part.rate, net: cents(part.netAmount), vat: cents(part.vatAmount) }));
    const gross = cents(snapshot.grossAmount);
    if (gross <= 0 || parts.some((part) => ![0, 7, 19].includes(part.rate) || !Number.isSafeInteger(part.net) || !Number.isSafeInteger(part.vat)) || parts.reduce((sum, part) => sum + part.net + part.vat, 0) !== gross) { if (relevant) issue('TAX_BREAKDOWN_REVIEW', 'Beträge oder Steuersätze des Belegs stimmen nicht überein.', invoice.id); return; }
    const mode = invoice.taxMode;
    if (mode !== 'standard_vat' && parts.some((part) => part.vat !== 0) && relevant) issue('TAX_MODE_AMOUNT_CONFLICT', 'Steuerfreie oder besondere Steuerbehandlung passt nicht zu den ausgewiesenen Steuerbeträgen. Bitte prüfen.', invoice.id);
    if (mode === 'standard_vat' && parts.some((part) => part.rate === 0) && !snapshot.taxRuleConfirmed && relevant) issue('ZERO_RATE_REVIEW', 'Nullsteuersatz bitte anhand der Voraussetzungen und des Originalbelegs bestätigen.', invoice.id);
    const correction = ['credit_note', 'cancellation_invoice'].includes(invoice.documentKind ?? 'invoice');
    // An advance invoice bills a service not yet rendered: its VAT arises when it is paid (Mindest-Ist,
    // §13 Abs. 1 Nr. 1a S. 4 UStG), an unpaid rest only with the service, i.e. the final invoice's date.
    const advance = invoice.documentKind === 'advance_invoice';
    // A correction of an advance taxes nothing back: the advance was taxed only as it was paid, and a refund is a payment of it.
    if (correction && advanceIds.has(invoice.sourceDocumentId ?? '')) return;
    const service = advance ? finalServiceDate(invoice) : calendarDate(serviceDateOf(invoice.servicePeriod));
    if (!service && !advance && relevant) issue('SERVICE_DATE_REQUIRED', 'Das genaue Leistungsdatum fehlt; vorläufig wird das Belegdatum verwendet.', invoice.id);
    let performance = advance ? service ?? NEVER : service ?? invoice.date;
    if (correction) performance = invoice.date;
    if (mode === 'intra_eu_supply_6a') {
      const nextMonth = new Date(`${performance}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 2, 0);
      const latest = nextMonth.toISOString().slice(0, 10);
      performance = invoice.date < performance ? performance : invoice.date < latest ? invoice.date : latest;
    }
    if (mode !== 'standard_vat' && !snapshot.taxRuleConfirmed && relevant) issue('TAX_TREATMENT_REVIEW', 'Besondere Steuerbehandlung bitte anhand des Belegs und der erforderlichen Nachweise prüfen.', invoice.id);
    const sign = correction ? -1 : 1;
    const emit = (date: string, amounts: Part[]) => {
      // A Kleinunternehmer files no Voranmeldung; its §19 turnover belongs in no Kennziffer.
      if (mode === 'small_business_19_ustg') return;
      for (const part of amounts) {
        const code = mode === 'standard_vat' ? (part.rate === 19 ? '81' : part.rate === 7 ? '86' : '87') : outgoingCodes[mode];
        add(type, invoice.id, invoice.number, date, code, mode === 'standard_vat' ? 'output' : 'information', { ...part, net: sign * part.net, vat: mode === 'standard_vat' ? sign * part.vat : 0 });
      }
    };
    if (correction) {
      // Ist tax was recognized on the original's cash events. Its recorded
      // refund reverses that tax; an unpaid cancellation has nothing to reverse.
      if (method === 'soll') emit(performance, parts);
      return;
    }
    const payments: Cash[] = [...invoice.payments].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((payment) => ({ id: payment.id, date: payment.date, amount: cents(payment.amount) }));
    let raw = 0; let recognized = 0;
    for (const payment of payments) {
      const previous = clamp(raw, gross); raw += payment.amount; const next = clamp(raw, gross);
      if (inPeriod(payment.date)) report.reconciliation.paymentCashCents += payment.amount;
      if (inPeriod(payment.date)) report.reconciliation.paymentRecognizedCents += next - previous;
      if (method === 'ist' || payment.date < performance) {
        if (mode === 'standard_vat') emit(payment.date, delta(parts, gross, previous, next)); recognized = next;
      }
      if (inPeriod(payment.date) && (raw < 0 || raw > gross)) issue('PAYMENT_RESIDUAL', 'Nicht zuordenbarer Zahlungsrest oder Überzahlung bleibt ohne zusätzliche Umsatzsteuer; bitte prüfen.', invoice.id);
      if (method === 'soll' && payment.amount < 0 && payment.date >= performance && inPeriod(payment.date)) issue('REFUND_CORRECTION_REQUIRED', 'Bei Soll-Versteuerung benötigt eine Entgeltminderung einen Korrekturbeleg; eine Rückzahlung allein ändert die Rechnung nicht.', invoice.id);
    }
    if (mode !== 'standard_vat') emit(performance, parts);
    else if (method === 'soll') emit(performance, delta(parts, gross, recognized, gross));
  };
  for (const invoice of invoices) recognizeOutgoing(invoiceSchema.parse(invoice));
  for (const rawReceipt of receipts) {
    const receipt = liteReceiptSchema.parse(rawReceipt);
    const cash = entries.filter((entry) => entry.receiptId === receipt.id);
    const income = cash.length > 0 && cash.every((entry) => entry.flowType === 'income');
    const date = maxDate(receipt.receivedDate ?? receipt.documentDate, receipt.serviceDate ?? receipt.documentDate);
    const relevant = inPeriod(date) || cash.some((entry) => inPeriod(entry.cashDate));
    if (!receipt.reviewed || !receipt.receivedDate || !receipt.serviceDate || !receipt.taxBreakdown.length || !receipt.fileCount) { if (relevant) issue('RECEIPT_REVIEW_REQUIRED', 'Originalbeleg, Leistungs-/Eingangsdatum und geprüfte Steueraufteilung werden benötigt.', receipt.id); if (!receipt.reviewed || !receipt.receivedDate || !receipt.serviceDate || !receipt.taxBreakdown.length) continue; }
    if (income) {
      if (!['domestic', 'exempt', 'small_business'].includes(receipt.taxMode)) { if (relevant) issue('INCOME_TAX_MODE_REQUIRED', 'Diese Steuerart gehört zu Eingangsbelegen. Barumsatz bitte mit passender Rechnung belegen.', receipt.id); continue; }
      if (smallBusiness && receipt.taxBreakdown.some((line) => line.vatAmountCents !== 0)) {
        if (relevant) issue('KU_INCOME_VAT_REVIEW', 'Barumsatz eines Kleinunternehmers enthält ausgewiesene Umsatzsteuer. Original und mögliche Steuerschuld bitte prüfen; der Zahlungsbetrag bleibt erhalten.', receipt.id);
        continue;
      }
      if (receipt.grossAmountCents <= 0) { if (relevant) issue('INCOME_CREDIT_REVIEW', 'Eine Barumsatzkorrektur benötigt eine zugeordnete ursprüngliche Rechnung.', receipt.id); continue; }
      recognizeOutgoing(invoiceSchema.parse({ kind: 'invoice', tenantId: scope.tenantId, id: receipt.id, number: receipt.number, client: receipt.counterparty, clientEmail: '', date: receipt.documentDate, dueDate: receipt.documentDate, servicePeriod: receipt.serviceDate, amount: receipt.grossAmountCents / 100, status: 'open', payments: cash.map((entry) => ({ id: entry.id, date: entry.cashDate, amount: entry.amountCents / 100, method: 'Manuell' })), taxMode: receipt.taxMode === 'small_business' ? 'small_business_19_ustg' : receipt.taxMode === 'exempt' ? 'vat_exempt_4_ustg' : smallBusiness ? 'small_business_19_ustg' : 'standard_vat', taxSnapshot: { vatRateApplied: receipt.taxBreakdown[0].rate, grossAmount: receipt.grossAmountCents / 100, netAmount: receipt.taxBreakdown.reduce((sum, line) => sum + line.netAmountCents, 0) / 100, vatAmount: receipt.taxBreakdown.reduce((sum, line) => sum + line.vatAmountCents, 0) / 100, einvoiceCategoryCode: 'S', taxRuleConfirmed: true, vatBreakdown: receipt.taxBreakdown.map((line) => ({ rate: line.rate, netAmount: line.netAmountCents / 100, vatAmount: line.vatAmountCents / 100 })) } }), 'receipt');
      continue;
    }
    const fraction = smallBusiness ? 0 : receipt.deductiblePercent / 100;
    const selfAssessed = ['reverse_charge', 'eu_service', 'intra_eu_acquisition'].includes(receipt.taxMode);
    const emitInput = (at: string, before: number, after: number) => {
      for (const line of receipt.taxBreakdown) {
        const part = { rate: line.rate, net: Math.round(line.netAmountCents * after) - Math.round(line.netAmountCents * before), vat: Math.round(line.vatAmountCents * after) - Math.round(line.vatAmountCents * before) };
        if (selfAssessed) add('receipt', receipt.id, receipt.number, at, receipt.taxMode === 'eu_service' ? '46' : receipt.taxMode === 'reverse_charge' ? '84' : line.rate === 19 ? '89' : line.rate === 7 ? '93' : '90', 'output', part);
        const inputCode = receipt.taxMode === 'import' ? '62' : selfAssessed ? receipt.taxMode === 'intra_eu_acquisition' ? '61' : '67' : '66';
        if (!['exempt', 'small_business'].includes(receipt.taxMode)) add('receipt', receipt.id, receipt.number, at, inputCode, 'input', { ...part, vat: Math.round(line.vatAmountCents * fraction * after) - Math.round(line.vatAmountCents * fraction * before) });
      }
    };
    if (receipt.grossAmountCents < 0) {
      if (!receipt.correctionOfReceiptId || !receipt.adjustmentDate || !receipt.correctionReason) {
        if (relevant) issue('RECEIPT_CORRECTION_REQUIRED', 'Ein negativer Beleg benötigt Originalbezug, Korrekturgrund und das Datum der Entgeltänderung.', receipt.id);
        continue;
      }
      emitInput(receipt.adjustmentDate, 0, 1);
    } else if (receipt.taxMode === 'import') {
      if (!receipt.importTaxDate) { if (relevant) issue('IMPORT_TAX_DATE_REQUIRED', 'Bitte Entstehungsdatum der Einfuhrumsatzsteuer anhand des Zollbelegs erfassen.', receipt.id); continue; }
      emitInput(receipt.importTaxDate, 0, 1);
    } else if (selfAssessed) {
      const performance = receipt.serviceDate;
      const at = receipt.taxMode === 'eu_service' ? performance : cappedInvoiceDate(receipt.documentDate, performance);
      let paid = 0;
      if (receipt.taxMode !== 'intra_eu_acquisition') {
        for (const entry of [...cash].sort((a, b) => a.cashDate.localeCompare(b.cashDate) || a.id.localeCompare(b.id))) {
          if (entry.cashDate >= performance) continue;
          const before = clamp(paid, receipt.grossAmountCents); paid -= entry.amountCents; const after = clamp(paid, receipt.grossAmountCents);
          emitInput(entry.cashDate, before / receipt.grossAmountCents, after / receipt.grossAmountCents);
        }
      }
      emitInput(at, clamp(paid, receipt.grossAmountCents) / receipt.grossAmountCents, 1);
    } else if (receipt.advancePayment && !selfAssessed && receipt.taxMode === 'domestic' && receipt.grossAmountCents > 0) {
      let paid = 0; const limit = receipt.grossAmountCents;
      for (const entry of [...cash].sort((a, b) => a.cashDate.localeCompare(b.cashDate) || a.id.localeCompare(b.id))) {
        if (entry.cashDate >= receipt.serviceDate) continue;
        const before = clamp(paid, limit); paid -= entry.amountCents; const after = clamp(paid, limit);
        emitInput(maxDate(entry.cashDate, receipt.receivedDate), before / limit, after / limit);
      }
      emitInput(date, clamp(paid, limit) / limit, 1);
    } else emitInput(date, 0, 1);
    if (cash.some((entry) => entry.flowType !== 'expense')) issue('RECEIPT_DIRECTION_REVIEW', 'Ein Beleg ist Einnahmen und Ausgaben zugeordnet. Bitte die Zuordnung prüfen.', receipt.id);
  }
  const unmatched = await db.query<{ id: string }>(`SELECT t.id FROM transactions t WHERE t.tenant_id=$1 AND t.status='booked' AND t.deleted_at IS NULL AND t.date BETWEEN $2 AND $3 AND (t.linked_invoice_id IS NULL OR t.linked_invoice_id='') AND NOT EXISTS (SELECT 1 FROM lite_cash_entries m WHERE m.tenant_id=t.tenant_id AND m.matched_transaction_id=t.id AND m.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM eur_classifications c WHERE c.tenant_id=t.tenant_id AND c.source_type='transaction' AND c.source_id=t.id AND c.excluded=TRUE) AND NOT EXISTS (SELECT 1 FROM eur_cash_facts f WHERE f.tenant_id=t.tenant_id AND f.source_type='transaction' AND f.source_id=t.id AND f.kind IN ('private-withdrawal','private-contribution','pass-through'))`, [scope.tenantId, from, to]);
  for (const row of unmatched.rows) issue('BANK_TAX_EVIDENCE_REQUIRED', 'Bankzahlung benötigt einen Rechnungs-/Belegbezug oder eine geprüfte private/neutrale Zuordnung.', row.id);
  for (const entry of entries) if (!entry.receiptId && inPeriod(entry.cashDate)) issue('CASH_RECEIPT_REQUIRED', 'Manuelle Zahlung benötigt einen Beleg für die Steuervorbereitung.', entry.id);
  if (settings.businessReportingProfile?.jurisdiction !== 'DE') issue('DE_PROFILE_REQUIRED', 'Die Umsatzsteuer-Vorbereitung benötigt ein deutsches Unternehmensprofil.');
  const positions = new Map<string, LiteVatReport['positions'][number]>();
  for (const source of report.sources) {
    const key = `${source.code}:${source.direction}`;
    const position = positions.get(key) ?? { code: source.code, taxCode: source.taxCode, label: labels[source.code] ?? source.code, direction: source.direction, basisCents: 0, taxCents: 0, basisWholeEuros: 0 };
    position.basisCents += source.basisCents; position.taxCents += source.taxCents; position.basisWholeEuros = Math.trunc(position.basisCents / 100); positions.set(key, position);
  }
  report.positions = [...positions.values()].sort((a, b) => Number(a.code) - Number(b.code));
  report.outputVatCents = report.positions.filter((position) => position.direction === 'output').reduce((sum, position) => sum + position.taxCents, 0);
  report.inputVatCents = report.positions.filter((position) => position.direction === 'input').reduce((sum, position) => sum + position.taxCents, 0);
  report.payableCents = report.outputVatCents - report.inputVatCents;
  report.reconciliation.paymentResidualCents = report.reconciliation.paymentCashCents - report.reconciliation.paymentRecognizedCents;
  report.preparationComplete = report.issues.length === 0;
  report.sourceHash = createHash('sha256').update(JSON.stringify({ invoices, entries, receipts, from, to, method, smallBusiness })).digest('hex');
  return liteVatReportSchema.parse(report);
}, { serializable: true });
