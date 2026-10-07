import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { calculateInvoiceTaxSnapshot, isCorrectionDocumentKind, isReceivableDocumentKind, resolveInvoiceTaxMode } from '@billme/server-core/services';

export interface MonthVatEstimate {
  periodLabel: string;
  net: number;
  vat: number;
  gross: number;
  /** Voranmeldung deadline: the 10th of the following month (no Dauerfristverlängerung). */
  dueDate: Date;
  dueLabel: string;
}

/**
 * Output VAT of one calendar month from the invoices alone (no Vorsteuer).
 * Soll: issued invoices dated in the month, corrections subtracted; order
 * confirmations and delivery notes bill nothing. Ist, and advance invoices
 * under Soll too (Mindest-Ist): payments received in the month, capped at
 * the invoice gross and split by the invoice's VAT ratio.
 */
export const estimateMonthVat = (
  invoices: Invoice[],
  settings: AppSettings,
  method: 'soll' | 'ist',
  year: number,
  month: number,
): MonthVatEstimate => {
  const periodLabel = new Date(year, month, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const dueDate = new Date(year, month + 1, 10);
  const dueLabel = dueDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' });
  const inMonth = (iso: string) => {
    const d = new Date(iso);
    return d.getFullYear() === year && d.getMonth() === month;
  };
  const snapshotFor = (inv: Invoice) =>
    inv.taxSnapshot ??
    calculateInvoiceTaxSnapshot(
      { items: inv.items ?? [], taxMode: resolveInvoiceTaxMode(inv.taxMode, settings), taxMeta: inv.taxMeta },
      settings,
    );

  const billing = invoices.filter((inv) => inv.status !== 'draft' && (isReceivableDocumentKind(inv.documentKind) || isCorrectionDocumentKind(inv.documentKind)));
  const cashBasis = (inv: Invoice) => method === 'ist' || inv.documentKind === 'advance_invoice';
  let gross = 0;
  let vat = 0;
  // ponytail: an advance still unpaid when the final invoice is issued is not added at the final's date here;
  // the dashboard is an estimate, the Voranmeldung itself comes from the accounting engine.
  for (const inv of billing.filter((candidate) => cashBasis(candidate) && isReceivableDocumentKind(candidate.documentKind))) {
    const paid = (inv.payments ?? []).filter((p) => inMonth(p.date)).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
    if (paid <= 0) continue;
    const snap = snapshotFor(inv);
    const grossCap = Math.max(0, Number(snap.grossAmount) || 0);
    const applied = Math.min(paid, grossCap > 0 ? grossCap : paid);
    gross += applied;
    vat += applied * (grossCap > 0 ? Math.max(0, (Number(snap.vatAmount) || 0) / grossCap) : 0);
  }
  let net = gross - vat;
  if (method === 'soll') {
    // Corrections of an advance tax nothing back: the advance was taxed only as it was paid.
    const advanceIds = new Set(billing.filter((inv) => inv.documentKind === 'advance_invoice').map((inv) => inv.id));
    for (const inv of billing.filter((candidate) => !cashBasis(candidate) && inMonth(candidate.date) && !advanceIds.has(candidate.sourceDocumentId ?? ''))) {
      const snap = snapshotFor(inv);
      const sign = isCorrectionDocumentKind(inv.documentKind) ? -1 : 1;
      net += sign * Math.abs(Number(snap.netAmount) || 0);
      vat += sign * Math.abs(Number(snap.vatAmount) || 0);
      gross += sign * Math.abs(Number(snap.grossAmount) || 0);
    }
  }
  return { periodLabel, net, vat, gross, dueDate, dueLabel };
};
