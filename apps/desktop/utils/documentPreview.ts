import type { AppSettings, Invoice, InvoiceElement } from '../types';
import { ElementType } from '../types';
import { replacePlaceholders } from './placeholders';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const getPreviewElements = (
  invoice: Invoice,
  template: InvoiceElement[],
  settings: AppSettings,
): InvoiceElement[] => {
  return template.map((el) => {
    if (el.label === 'items_table' || el.type === ElementType.TABLE) {
      const rows = invoice.items.map((item, idx) => ({
        id: idx.toString(),
        cells: [
          (idx + 1).toString(),
          item.description,
          `${item.quantity}`,
          formatCurrency(item.price),
          formatCurrency(item.total),
        ],
      }));
      return {
        ...el,
        tableData: {
          columns: el.tableData?.columns || [
            { id: 'pos', label: 'Pos.', width: 40, visible: true, align: 'left' },
            { id: 'desc', label: 'Bezeichnung', width: 280, visible: true, align: 'left' },
            { id: 'qty', label: 'Menge', width: 60, visible: true, align: 'right' },
            { id: 'price', label: 'Einzelpreis', width: 90, visible: true, align: 'right' },
            { id: 'total', label: 'Gesamt', width: 90, visible: true, align: 'right' },
          ],
          rows,
        },
      };
    }

    if (el.type === ElementType.TEXT && el.content) {
      return {
        ...el,
        content: replacePlaceholders(el.content, invoice, settings),
      };
    }

    return el;
  });
};

