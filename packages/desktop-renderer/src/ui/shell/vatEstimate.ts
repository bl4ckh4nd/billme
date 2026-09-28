import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';

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
 * Soll: issued invoices dated in the month. Ist: payments received in the
 * month, capped at the invoice gross and split by the invoice's VAT ratio.
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

  if (method === 'ist') {
    let gross = 0;
    let vat = 0;
    for (const inv of invoices) {
      const paid = (inv.payments ?? []).filter((p) => inMonth(p.date)).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
      if (paid <= 0) continue;
      const snap = snapshotFor(inv);
      const grossCap = Math.max(0, Number(snap.grossAmount) || 0);
      const applied = Math.min(paid, grossCap > 0 ? grossCap : paid);
      gross += applied;
      vat += applied * (grossCap > 0 ? Math.max(0, (Number(snap.vatAmount) || 0) / grossCap) : 0);
    }
    vat = Math.max(0, vat);
    return { periodLabel, net: Math.max(0, gross - vat), vat, gross, dueDate, dueLabel };
  }

  const issued = invoices.filter((inv) => inv.status !== 'draft' && inMonth(inv.date));
  const sum = (pick: (s: ReturnType<typeof snapshotFor>) => number) => issued.reduce((acc, inv) => acc + (pick(snapshotFor(inv)) || 0), 0);
  return { periodLabel, net: sum((s) => s.netAmount), vat: sum((s) => s.vatAmount), gross: sum((s) => s.grossAmount), dueDate, dueLabel };
};
