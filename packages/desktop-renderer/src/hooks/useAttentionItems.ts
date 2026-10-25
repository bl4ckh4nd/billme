import React from 'react';
import { isReceivableDocumentKind } from '@billme/server-core/services';
import { useInvoicesQuery } from './useInvoices';
import { useLiteVatReport, vatMonthPeriod } from '../components/eur/LiteVatPanel';
import type { ShellAttentionItem } from '../ui/shell/DashboardLayout';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const formatCurrency = (amount: number) => amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/**
 * Open work for the bell: unbooked payments (the "Buchen" queue), overdue invoices and the coming
 * Umsatzsteuer-Voranmeldung. Derived from the same queries as the dashboard, so the numbers agree.
 */
export const useLiteAttentionItems = (options: { enabled: boolean; openEurCount: number }): ShellAttentionItem[] => {
  const invoicesQuery = useInvoicesQuery();
  const now = new Date();
  const vatQuery = useLiteVatReport(vatMonthPeriod(now.getFullYear(), now.getMonth()), options.enabled);
  const invoices = invoicesQuery.data;
  const vat = vatQuery.data;
  const monthLabel = MONTHS[now.getMonth()];
  return React.useMemo(() => {
    if (!options.enabled) return [];
    const items: ShellAttentionItem[] = [];
    const overdue = (invoices ?? []).filter((invoice) => invoice.status === 'overdue' && isReceivableDocumentKind(invoice.documentKind));
    if (overdue.length > 0) {
      const open = overdue.reduce((sum, invoice) => sum + Math.max(0, invoice.amount - (invoice.payments ?? []).reduce((paid, payment) => paid + (Number(payment.amount) || 0), 0)), 0);
      items.push({ key: 'overdue', tone: 'error', title: overdue.length === 1 ? '1 Rechnung überfällig' : `${overdue.length} Rechnungen überfällig`, message: `${formatCurrency(open)} seit Fälligkeit offen`, to: '/documents', search: { kind: 'invoice', status: 'overdue' } });
    }
    if (options.openEurCount > 0) {
      items.push({ key: 'eur', tone: 'info', title: options.openEurCount === 1 ? '1 Zahlung nicht gebucht' : `${options.openEurCount} Zahlungen nicht gebucht`, message: 'In „Buchen“ Kategorie, Rechnung, Privat oder Geldtransit wählen', to: '/eur' });
    }
    if (vat && vat.filingRequired && vat.dueDate) {
      const today = new Date();
      const days = Math.round((new Date(`${vat.dueDate}T00:00:00`).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
      const due = new Date(`${vat.dueDate}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      items.push({
        key: 'vat',
        tone: days <= 7 ? 'warning' : 'info',
        title: `Umsatzsteuer-Voranmeldung ${monthLabel}`,
        message: `Fällig am ${due}${days >= 0 ? ` (in ${days} ${days === 1 ? 'Tag' : 'Tagen'})` : ''}${vat.preparationComplete ? '' : '; Prüfpunkte offen'}`,
        to: '/statistics',
        search: { view: 'ust' },
      });
    }
    return items;
  }, [options.enabled, options.openEurCount, invoices, vat, monthLabel]);
};
